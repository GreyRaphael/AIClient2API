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

/**
 * 有界等待：尽量等到这些选择器都出现，但任何单个失败都不抛错。
 * 目的只是消除"异步渲染没跟上"的假阴性，不改变"元素确实不存在"的语义。
 */
async function waitForSelectors(page, selectors, timeout) {
    // 在一个浏览器 round-trip 里轮询全部选择器，直到都出现或超时。
    // 逐个 await waitForSelector 会在"元素本就该不存在"时白白吃满超时
    // （某些 section 的组合选择器在空数据下永远不出现），把整个 spec 拖到十几分钟。
    await page.waitForFunction(
        (sels) => sels.every((sel) => document.querySelector(sel)),
        selectors,
        { timeout, polling: 100 }
    ).catch(() => {});
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

// 这个 spec 要跑 10 个 section × 每次有界等待，默认 30s 不够（尤其窄视口 + 慢机器）
test.describe.configure({ timeout: 90_000 });

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

                    // 各 section 的内容是通过 fetch 异步加载的，慢机器/窄视口下渲染会晚到。
                    // 只等固定时长会偶发"元素还没出现"，被误判成"元素消失"。
                    // 因此逐个等本 section 要断言的选择器出现后再采样（元素本就可能不存在，
                    // 例如空数据时列表不渲染，这类只做有界等待，不阻塞）。
                    const key = comboKey(vp, theme, section);
                    const spec = selectorsFor(section);
                    // 只等"基线里确实存在"的选择器：其余在空数据下永远不渲染，
                    // 对它们做有界等待等于每次白等满超时（曾把整个 spec 拖到 11 分钟）。
                    const expectedSelectors = UPDATE
                        ? Object.keys(spec)
                        : Object.keys(baseline[key] || {});
                    await waitForSelectors(page, expectedSelectors, 5000);
                    // 等 CSS 过渡结束再过一遍：侧边栏 active 态、按钮 hover 都有 transition，
                    // 在动画中途采样会读到 545.5 这种非整数 font-weight 的中间值，
                    // 被误判成样式回归。这里只等位移/过渡自然收敛，不做人为延时。
                    await page.waitForFunction(
                        () => document.getAnimations().every((a) => a.playState !== 'running'),
                        undefined,
                        { timeout: 3000, polling: 100 }
                    ).catch(() => {});
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