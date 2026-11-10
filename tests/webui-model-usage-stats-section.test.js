/**
 * 模型用量统计 section（主菜单）的 SSR 冒烟 + 纯函数契约。
 *
 * 这个页面从「插件独立页 + 用户自填凭证」迁成「控制台主菜单 section + session token」，
 * 迁移最容易悄悄退化的四点，这里逐条锁住：
 *  1. 根节点必须还是 `section#model-usage-stats.section.active` —— 控制台靠 id 挂载、
 *     e2e 靠 `.active` 判断路由生效；写成 `<div>` 或换 id 都会静默白屏。
 *  2. **不能再有凭证输入框**：它是迁进主菜单的核心收益（走 lib/api.js 的 session token）。
 *     一旦有人把 `#credentialValue` / `type="password"` 抄回来，这条断言会响。
 *  3. 两块卡片必须同时在：左侧「选择日期」（含历史累计 + 重置统计），右侧「用量汇总」
 *     （5 项 + 进度条）。spec §4 明确汇总信息放日期卡片右侧。
 *  4. 明细表格的表头列必须齐全且是 spec §4 的顺序。
 *
 * 说明：Jest 全局是 node 环境（无 jsdom），`useEffect` 不会在 SSR 里跑，因此这里断言的是
 * **首帧**（booting 态）。数据加载后的分组切换 / 排序 / 命中率药丸由
 * tests/webui-e2e/smoke.spec.js 的真实浏览器用例覆盖，纯逻辑部分由下面的 usage-utils 用例覆盖。
 */

import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import render from 'preact-render-to-string';
import { html } from '@ui/html.js';
import ModelUsageStatsSection from '@ui/sections/model-usage-stats/index.ts';
import {
    buildSummaryItems,
    buildTableRows,
    filterRows,
    hitRate,
    hitRateTone,
    sortRows,
    toNumber,
    toUsageHistory
} from '@ui/sections/model-usage-stats/usage-utils.ts';

const markup = render(html`<${ModelUsageStatsSection} />`);

/** 从 markup 里按顺序取出表格表头文案 */
function tableHeaders(source) {
    const thead = source.slice(source.indexOf('<thead>'), source.indexOf('</thead>'));
    return [...thead.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)]
        .map((m) => m[1].replace(/<[^>]*>/g, '').trim());
}

/** 汇总卡片里每一项的 { label, value, width } */
function summaryItems(source) {
    const card = source.slice(source.indexOf('usage-stats-summary-card'));
    return [...card.matchAll(
        /usage-stats-summary-label">([^<]*)<\/span>\s*<span class="usage-stats-summary-value[^"]*">([^<]*)<\/span>[\s\S]*?usage-stats-bar-fill[^"]*" style="width: ([\d.]+)%"/g
    )].map((m) => ({ label: m[1], value: m[2], width: Number(m[3]) }));
}

/** 完整的一份 StatsPayload（spec §1 契约），用于纯函数用例 */
function payloadOf(overrides = {}) {
    const totals = {
        requestCount: 10,
        promptTokens: 1000,
        completionTokens: 200,
        cachedTokens: 300,
        totalTokens: 1500,
        lastUsedAt: '2026-01-02T03:04:05.000Z',
        qps: 1, tps: 2, rpm: 3, maxQps: 4, maxTps: 5, maxRpm: 6
    };
    return {
        updatedAt: '2026-01-02T03:04:05.000Z',
        range: {},
        summary: totals,
        byModel: [],
        byProvider: [],
        calendar: [],
        dates: [],
        ...overrides
    };
}

describe('模型用量统计 section：SSR 结构', () => {
    test('根节点是可路由的 section，并带上标题', () => {
        expect(markup).toContain('id="model-usage-stats"');
        expect(markup).toContain('class="section active"');
        expect(markup).toContain('aria-labelledby="model-usage-stats-title"');
        expect(markup).toContain('id="model-usage-stats-title"');
        expect(markup).toContain('模型用量统计');
    });

    test('不再有凭证输入框（迁进主菜单后走 session token）', () => {
        // 这是迁移的核心收益：独立页那套「自填凭证 + dual 鉴权」已随 dual 模式一起删除
        expect(markup).not.toContain('credentialValue');
        expect(markup).not.toContain('type="password"');
        expect(markup).not.toContain('访问凭证');
        expect(markup).not.toContain('连接并加载');
    });

    test('「选择日期」卡片：历史累计按钮 + 日历 + 重置统计', () => {
        expect(markup).toContain('usage-stats-calendar-card');
        expect(markup).toContain('选择日期');
        // 右上「历史累计」
        expect(markup).toContain('历史累计');
        // 日历（GitHub 风格热力图）：最近三个月，格子数远超 80
        expect(markup).toContain('class="calendar-grid"');
        expect((markup.match(/class="calendar-day/g) || []).length).toBeGreaterThan(80);
        // 传了 onSelect 才可点，这是「点某天看当天明细」的前提
        expect(markup).toContain('calendar-day-clickable');
        // 卡片内的「重置统计」走危险样式 + confirmDialog 二次确认
        expect(markup).toContain('btn btn-danger btn-sm');
        expect(markup).toContain('重置统计');
    });

    test('汇总卡片：5 项指标各带数值与进度条', () => {
        expect(markup).toContain('usage-stats-summary-card');
        expect(markup).toContain('用量汇总');

        const items = summaryItems(markup);
        expect(items.map((item) => item.label)).toEqual([
            '请求数', '输入 Token', '缓存 Token', '输出 Token', '总 Token'
        ]);
        // 首帧未加载数据：数值为 0、进度条宽度 0%（不出现 NaN / undefined）
        expect(items.map((item) => item.value)).toEqual(['0', '0', '0', '0', '0']);
        expect(items.map((item) => item.width)).toEqual([0, 0, 0, 0, 0]);
        expect(markup).not.toContain('NaN');
        // 每条都是 label + value + progress 三段结构
        expect((markup.match(/class="usage-stats-bar"/g) || []).length).toBe(5);
    });

    test('明细表格：表头列齐全且顺序符合契约', () => {
        expect(markup).toContain('class="usage-table"');
        expect(tableHeaders(markup)).toEqual([
            'Provider', 'Model', '请求数', '输入', '缓存', '输出', '总 Token', '命中率'
        ]);
    });

    test('明细表格：分组切换、搜索与排序控件都在', () => {
        expect(markup).toContain('role="tablist"');
        expect(markup).toContain('按模型');
        expect(markup).toContain('按 Provider');
        expect(markup).toContain('usage-stats-search');
        expect(markup).toContain('usage-stats-sort');
        // 排序下拉的 6 个选项（总 Token / 请求数 / 输入 / 缓存 / 命中率 升降序）
        expect((markup.match(/<option /g) || []).length).toBe(6);
    });

    test('首帧空数据不崩：表格给出加载态占位而非空 tbody', () => {
        // SSR 不跑 useEffect，booting=true → 表格里应有一行带 colspan 的占位
        expect(markup).toContain('empty-cell');
        expect(markup).toContain('colspan="8"');
        expect(() => render(html`<${ModelUsageStatsSection} />`)).not.toThrow();
    });
});

describe('日历热力图：方块形状与绿色深浅（迁移回归护栏）', () => {
    const shared = readFileSync(path.join(process.cwd(), 'static/ui/styles/shared.css'), 'utf8');
    const base = readFileSync(path.join(process.cwd(), 'static/ui/styles/base.css'), 'utf8');

    /** 取出某个选择器的声明块（去注释） */
    function rule(css, selector) {
        const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
        const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const m = new RegExp(escaped + '\\s*\\{([^}]*)\\}').exec(clean);
        return m ? m[1] : '';
    }

    test('格子是 11px 方块，圆角必须是小值（曾被误改成 --radius-sm(6px) 变成圆点）', () => {
        const block = rule(shared, '.calendar-day');
        expect(block).toContain('width: 11px');
        expect(block).toContain('height: 11px');
        // 6px 圆角作用在 11px 方块上会几乎变成圆形 —— 用户可见的视觉回归
        expect(block).toMatch(/border-radius:\s*2px/);
        expect(block).not.toMatch(/border-radius:\s*var\(--radius-sm\)/);
        expect(block).not.toMatch(/border-radius:\s*var\(--radius-full\)/);
    });

    test('四档 data-level 分别绑定不同的绿色令牌（token 消耗量深浅）', () => {
        for (const level of [1, 2, 3, 4]) {
            const block = rule(shared, `.calendar-day[data-level="${level}"]`);
            expect(block).toContain(`background: var(--calendar-level-${level})`);
        }
        // level 0（无用量）走背景色，不能是绿色
        expect(rule(shared, '.calendar-day[data-level="0"]')).toContain('background: var(--bg-secondary)');
    });

    test('四个绿色令牌在暗色主题下都有定义，且逐级提亮', () => {
        const tokens = [...base.matchAll(/--calendar-level-(\d):\s*(#[0-9a-fA-F]{6})/g)]
            .map((m) => ({ level: Number(m[1]), hex: m[2] }));
        expect(tokens.map((t) => t.level)).toEqual([1, 2, 3, 4]);

        // 相对亮度：暗色背景下 level 越高必须越亮（反向提亮）
        const luminance = (hex) => {
            const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
            return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        for (let i = 1; i < tokens.length; i += 1) {
            expect(luminance(tokens[i].hex)).toBeGreaterThan(luminance(tokens[i - 1].hex));
        }
    });

    test('日历规则归属 shared.css（控制台与 potluck 两页都加载它）', () => {
        // 这些页面都会加载 shared.css；塞回 plugin-shared.css 会让控制台丢失日历样式
        for (const page of ['index.html', 'potluck-user.html']) {
            const html = readFileSync(path.join(process.cwd(), 'static', page), 'utf8');
            expect({ page, loadsShared: html.includes('shared.css') }).toEqual({ page, loadsShared: true });
        }
        expect(shared).toContain('.calendar-grid');
        expect(shared).toContain('.calendar-day');
    });
});

describe('模型用量统计 usage-utils：命中率', () => {
    test('hitRate 是缓存/输入，输入为 0 时返回 0 而不是 NaN', () => {
        expect(hitRate({ promptTokens: 1000, cachedTokens: 800 })).toBe(80);
        expect(hitRate({ promptTokens: 100, cachedTokens: 0 })).toBe(0);
        // 0 输入是真实场景（只统计请求数），不能变成 NaN / Infinity
        expect(hitRate({ promptTokens: 0, cachedTokens: 50 })).toBe(0);
        expect(hitRate({})).toBe(0);
        expect(hitRate(null)).toBe(0);
        expect(hitRate(undefined)).toBe(0);
    });

    test('命中率分档阈值 80 / 50，与迁移前一致', () => {
        expect(hitRateTone(100)).toBe('high');
        expect(hitRateTone(80)).toBe('high');
        expect(hitRateTone(79.9)).toBe('mid');
        expect(hitRateTone(50)).toBe('mid');
        expect(hitRateTone(49.9)).toBe('low');
        expect(hitRateTone(0)).toBe('low');
    });

    test('汇总卡片的命中率与 hitRate 同源（都用缓存/输入）', () => {
        expect(hitRate({ promptTokens: 200, cachedTokens: 50 })).toBe(25);
        expect(hitRate(null)).toBe(0);
    });

    test('toNumber 把 null / undefined / NaN / 负数归零', () => {
        // 表格里出现 "NaN" 或负数是可读性事故
        expect(toNumber(null)).toBe(0);
        expect(toNumber(undefined)).toBe(0);
        expect(toNumber('abc')).toBe(0);
        expect(toNumber(Number.NaN)).toBe(0);
        expect(toNumber(-5)).toBe(0);
        expect(toNumber('12')).toBe(12);
        expect(toNumber(3.5)).toBe(3.5);
    });
});

describe('模型用量统计 usage-utils：表格行与维度', () => {
    const payload = payloadOf({
        byModel: [
            { provider: 'gemini-antigravity', model: 'gemini-3.8-flash', requestCount: 4, promptTokens: 400, cachedTokens: 200, completionTokens: 100, totalTokens: 500, lastUsedAt: null, qps: 0, tps: 0, rpm: 0, maxQps: 0, maxTps: 0, maxRpm: 0 },
            { provider: 'openai-custom', model: 'gpt-5', requestCount: 1, promptTokens: 100, cachedTokens: 10, completionTokens: 20, totalTokens: 120, lastUsedAt: null, qps: 0, tps: 0, rpm: 0, maxQps: 0, maxTps: 0, maxRpm: 0 }
        ],
        byProvider: [
            { provider: 'gemini-antigravity', modelCount: 2, requestCount: 4, promptTokens: 400, cachedTokens: 200, completionTokens: 100, totalTokens: 500, lastUsedAt: null, qps: 0, tps: 0, rpm: 0, maxQps: 0, maxTps: 0, maxRpm: 0 },
            { provider: 'openai-custom', modelCount: 1, requestCount: 1, promptTokens: 100, cachedTokens: 10, completionTokens: 20, totalTokens: 120, lastUsedAt: null, qps: 0, tps: 0, rpm: 0, maxQps: 0, maxTps: 0, maxRpm: 0 }
        ]
    });

    test('按模型：每行带 provider/model 与算好的命中率', () => {
        const rows = buildTableRows(payload, 'model');
        expect(rows).toHaveLength(2);
        expect(rows[0]).toMatchObject({
            provider: 'gemini-antigravity',
            model: 'gemini-3.8-flash',
            modelCount: 1,
            cacheHitRate: 50
        });
        expect(rows[0].key).toBe('model:gemini-antigravity:gemini-3.8-flash');
    });

    test('按 Provider：modelCount 取自后端，没有 model 列', () => {
        const rows = buildTableRows(payload, 'provider');
        expect(rows).toHaveLength(2);
        expect(rows[0]).toMatchObject({
            provider: 'gemini-antigravity',
            model: '',
            modelCount: 2,
            cacheHitRate: 50
        });
        expect(rows[0].key).toBe('provider:gemini-antigravity');
    });

    test('空 payload / 缺字段不崩', () => {
        expect(buildTableRows(null, 'model')).toEqual([]);
        expect(buildTableRows(undefined, 'provider')).toEqual([]);
        // 后端字段名对不上时按空处理，而不是抛错白屏
        expect(buildTableRows({ byModel: null, byProvider: null }, 'model')).toEqual([]);
    });

    test('行缺 provider/model 时回退 unknown（不产生空字符串单元格）', () => {
        const rows = buildTableRows(payloadOf({
            byModel: [{ requestCount: 1, promptTokens: 10, cachedTokens: 0, completionTokens: 0, totalTokens: 10, lastUsedAt: null }]
        }), 'model');
        expect(rows[0].provider).toBe('unknown');
        expect(rows[0].model).toBe('unknown');
    });
});

describe('模型用量统计 usage-utils：筛选与排序', () => {
    const rows = buildTableRows(payloadOf({
        byModel: [
            { provider: 'Gemini-Antigravity', model: 'gemini-3.8-flash', requestCount: 4, promptTokens: 400, cachedTokens: 200, completionTokens: 100, totalTokens: 500, lastUsedAt: null, qps: 0, tps: 0, rpm: 0, maxQps: 0, maxTps: 0, maxRpm: 0 },
            { provider: 'openai-custom', model: 'gpt-5', requestCount: 9, promptTokens: 900, cachedTokens: 10, completionTokens: 20, totalTokens: 120, lastUsedAt: null, qps: 0, tps: 0, rpm: 0, maxQps: 0, maxTps: 0, maxRpm: 0 }
        ]
    }), 'model');

    test('关键词大小写不敏感，provider 与 model 任一命中', () => {
        expect(filterRows(rows, 'GEMINI', 'model').map((row) => row.model)).toEqual(['gemini-3.8-flash']);
        expect(filterRows(rows, 'gpt', 'model').map((row) => row.provider)).toEqual(['openai-custom']);
        // 空关键词返回全部（且是副本，不改原数组）
        const all = filterRows(rows, '   ', 'model');
        expect(all).toHaveLength(2);
        expect(all).not.toBe(rows);
        expect(filterRows(rows, 'no-such-thing', 'model')).toEqual([]);
    });

    test('按数值列排序，降序为默认方向', () => {
        expect(sortRows(rows, 'totalTokens-desc').map((row) => row.totalTokens)).toEqual([500, 120]);
        expect(sortRows(rows, 'totalTokens-asc').map((row) => row.totalTokens)).toEqual([120, 500]);
        expect(sortRows(rows, 'requestCount-desc').map((row) => row.requestCount)).toEqual([9, 4]);
        expect(sortRows(rows, 'cacheHitRate-desc').map((row) => row.cacheHitRate)).toEqual([50, 1.1111111111111112]);
    });

    test('排序不改原数组，且同值时顺序稳定', () => {
        const before = rows.map((row) => row.key);
        sortRows(rows, 'requestCount-desc');
        expect(rows.map((row) => row.key)).toEqual(before);

        const tied = buildTableRows(payloadOf({
            byModel: [
                { provider: 'b-provider', model: 'b', requestCount: 1, promptTokens: 1, cachedTokens: 0, completionTokens: 0, totalTokens: 1, lastUsedAt: null },
                { provider: 'a-provider', model: 'a', requestCount: 1, promptTokens: 1, cachedTokens: 0, completionTokens: 0, totalTokens: 1, lastUsedAt: null }
            ]
        }), 'model');
        // 同值时按 provider/model 兜底，避免每次渲染顺序漂移
        expect(sortRows(tied, 'totalTokens-desc').map((row) => row.provider))
            .toEqual(['a-provider', 'b-provider']);
    });
});

describe('模型用量统计 usage-utils：汇总与日历', () => {
    test('5 项指标顺序固定，进度条按本组最大值归一', () => {
        const items = buildSummaryItems({
            requestCount: 10, promptTokens: 1000, cachedTokens: 500,
            completionTokens: 200, totalTokens: 1200, lastUsedAt: null
        });

        expect(items.map((item) => item.key)).toEqual([
            'requestCount', 'promptTokens', 'cachedTokens', 'completionTokens', 'totalTokens'
        ]);
        expect(items.map((item) => item.value)).toEqual([10, 1000, 500, 200, 1200]);

        // 最大项（总 Token 1200）宽度 100%，其余按比例
        expect(items[4].percent).toBe(100);
        expect(items[1].percent).toBeCloseTo((1000 / 1200) * 100, 5);
        for (const item of items) {
            expect(item.percent).toBeGreaterThanOrEqual(0);
            expect(item.percent).toBeLessThanOrEqual(100);
        }
    });

    test('全 0 数据：进度条宽度 0，不出现除零', () => {
        const items = buildSummaryItems(null);
        expect(items.map((item) => item.percent)).toEqual([0, 0, 0, 0, 0]);
        expect(items.map((item) => item.value)).toEqual([0, 0, 0, 0, 0]);
        expect(items.every((item) => Number.isFinite(item.percent))).toBe(true);
    });

    test('maxQps / 速率字段缺失不影响汇总（它们不落库）', () => {
        // spec §1：qps/tps/rpm/max* 来自内存 RateManager，不落库；汇总卡片不展示它们
        const items = buildSummaryItems({ requestCount: 1, promptTokens: 10, cachedTokens: 0, completionTokens: 1, totalTokens: 11, lastUsedAt: null });
        expect(items).toHaveLength(5);
        expect(items.map((item) => item.key)).not.toContain('qps');
    });

    test('toUsageHistory 把 calendar 数组转成日历需要的字典', () => {
        const history = toUsageHistory([
            { date: '2026-01-01', requestCount: 2, totalTokens: 200, promptTokens: 100, cachedTokens: 50, modelCount: 1 },
            { date: '2026-01-02', requestCount: 3, totalTokens: 300, promptTokens: 200, cachedTokens: 100, modelCount: 2 }
        ]);
        expect(Object.keys(history)).toEqual(['2026-01-01', '2026-01-02']);
        expect(history['2026-01-02'].totalTokens).toBe(300);
        // 非数组 / 缺 date 的项都安全跳过
        expect(toUsageHistory(null)).toEqual({});
        expect(toUsageHistory([{ requestCount: 1 }])).toEqual({});
    });
});
