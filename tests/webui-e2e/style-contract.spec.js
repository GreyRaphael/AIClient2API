import { test, expect } from './fixtures.js';
import { SECTIONS, VIEWPORTS, THEMES, selectorsFor, comboKey } from './style-contract.mjs';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

/**
 * CSS 计算样式契约——全局 CSS 重构的安全网。
 *
 * 无构建步骤的全局 CSS 最容易踩的坑是"改完某一页，另一页悄悄崩了"。
 * 截图对比对字体度量和抗锯齿敏感、跨机器不稳定；这里改为锁定**关键选择器的
 * 计算样式**：跨机器确定、失败信息可读，覆盖 4 断点 × 明暗 2 主题 × 10 个 section。
 *
 * 有意调整样式后更新基线：
 *   UPDATE_STYLE_CONTRACT=1 npx playwright test -c tests/webui-e2e/playwright.config.js -g 计算样式契约
 * 然后在 code review 里逐条看 style-contract.json 的 diff —— 这就是改动前后的样式变更清单。
 */

const BASELINE_PATH = new URL('./style-contract.json', import.meta.url);
const UPDATE = process.env.UPDATE_STYLE_CONTRACT === '1';

/** 跨机器不稳定的属性：像素值受字体度量影响，不纳入契约 */
const UNSTABLE_PROPS = new Set(['grid-template-columns', 'grid-template-rows']);

function loadBaseline() {
    if (!existsSync(BASELINE_PATH)) return {};
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
}

async function measure(page, targets) {
    return page.evaluate((spec) => {
        const out = {};
        for (const [sel, props] of Object.entries(spec)) {
            const el = document.querySelector(sel);
            if (!el) { out[sel] = null; continue; }
            const cs = getComputedStyle(el);
            const row = {};
            for (const p of props) row[p] = cs.getPropertyValue(p);
            out[sel] = row;
        }
        return out;
    }, targets);
}

test.describe('计算样式契约', () => {
    for (const vp of VIEWPORTS) {
        for (const theme of THEMES) {
            test(`${vp.name} / ${theme}`, async ({ authedPage: page, problems }) => {
                await page.setViewportSize({ width: vp.width, height: vp.height });
                // 只写 localStorage：主题由应用自身的初始化逻辑应用。
                // 不能在这里碰 document.documentElement —— addInitScript 在文档创建前执行，可能还是 null。
                await page.addInitScript((value) => {
                    localStorage.setItem('theme', value);
                }, theme);

                const baseline = loadBaseline();
                const collected = {};
                const mismatches = [];

                await page.goto('/index.html', { waitUntil: 'networkidle' });

                for (const section of SECTIONS) {
                    await page.evaluate((s) => { window.location.hash = '#' + s; }, section);
                    await page.waitForTimeout(450);

                    const key = comboKey(vp, theme, section);
                    const spec = selectorsFor(section);
                    const actual = await measure(page, spec);

                    // 记录基线（剔除不稳定属性与不存在的元素）
                    const row = {};
                    for (const [sel, props] of Object.entries(actual)) {
                        if (!props) continue;
                        const kept = {};
                        for (const [p, v] of Object.entries(props)) {
                            if (UNSTABLE_PROPS.has(p)) continue;
                            kept[p] = v;
                        }
                        if (Object.keys(kept).length) row[sel] = kept;
                    }
                    collected[key] = row;

                    if (UPDATE) continue;

                    const expected = baseline[key];
                    expect(expected, `基线缺少 ${key}；请用 UPDATE_STYLE_CONTRACT=1 重新生成 style-contract.json`).toBeTruthy();
                    for (const [sel, exp] of Object.entries(expected)) {
                        const act = row[sel];
                        if (!act) {
                            mismatches.push(`${key} :: ${sel} 消失了（基线中该元素存在）`);
                            continue;
                        }
                        for (const [prop, expVal] of Object.entries(exp)) {
                            if (act[prop] !== expVal) {
                                mismatches.push(`${key} :: ${sel} { ${prop} }  期望 ${expVal}  →  实际 ${act[prop]}`);
                            }
                        }
                    }
                }

                if (UPDATE) {
                    // 合并进现有基线（其他视口/主题的用例可能还没跑）
                    const merged = { ...loadBaseline(), ...collected };
                    writeFileSync(BASELINE_PATH, JSON.stringify(merged, null, 2, ) + '\n');
                }

                expect(mismatches).toEqual([]);
                expect(problems).toEqual([]);
            });
        }
    }
});