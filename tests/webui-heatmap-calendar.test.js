/**
 * `buildCalendarDays` 的日期域与网格几何。
 *
 * 这个函数是日历热力图的全部逻辑，但此前**零测试** —— 于是三个真 bug 一起出海：
 *  1. 日期键取浏览器本地字段（后端按 Asia/Shanghai 聚合），UTC+8 以西的浏览器
 *     把上海当天判成「未来」：格子置灰且不可点，年度累计还漏一天；
 *  2. 2028 这类「闰年且 1 月 1 日是周六」的年份要 54 列，文档却写「52~53 周」；
 *  3. 月份刻度与日期格子是两个独立 grid，标签能漂到别的列上（由 CSS 那侧修）。
 *
 * 这里锁住的是**纯函数契约**：格子数、行号 = 星期几、1 月 1 日落位、跨年边界、
 * 上海时区。CSS 的几何由 ui-design-scale / ui-css-* 那几组护栏负责。
 */

import { describe, test, expect } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import {
    buildCalendarDays,
    shanghaiDateKey,
    shanghaiTodayKey
} from '@ui/lib/stats.js';

/** 用 UTC 正午构造「某一天」，与 stats.js 内部的表示一致 */
const day = (iso) => new Date(`${iso}T12:00:00Z`);

/** 把 days 压成 dateKey 列表，便于断言连续性 */
const keysOf = (result) => result.days.map((d) => d.dateKey);

describe('buildCalendarDays：网格形状', () => {
    test('格子数恒为 7 的整数倍，且 weeks 与之一致', () => {
        for (const year of [2000, 2024, 2025, 2026, 2027, 2028, 2100]) {
            const result = buildCalendarDays({}, year);
            expect({ year, mod: result.days.length % 7 }).toEqual({ year, mod: 0 });
            expect({ year, weeks: result.weeks }).toEqual({ year, weeks: result.days.length / 7 });
        }
    });

    test('多数年份 53 列；1 月 1 日为周六的闰年必须 54 列', () => {
        for (const year of [2024, 2025, 2026, 2027]) {
            expect({ year, weeks: buildCalendarDays({}, year).weeks }).toEqual({ year, weeks: 53 });
        }
        // Sunday-start 网格：闰年且 1 月 1 日是周六时，12 月 31 日落在第 54 列
        for (const year of [2000, 2028, 2056, 2084]) {
            expect({ year, weeks: buildCalendarDays({}, year).weeks }).toEqual({ year, weeks: 54 });
        }
    });

    test('行号恒等于星期几（0=周日），每列 7 天', () => {
        for (const year of [2025, 2026, 2028]) {
            const { days } = buildCalendarDays({}, year);
            const offsets = days
                .map((d, index) => (d.dayOfWeek === index % 7 ? null : `${d.dateKey}@${index}`))
                .filter(Boolean);
            expect({ year, offsets }).toEqual({ year, offsets: [] });
        }
    });

    test('1 月 1 日落在它真实的那一行，且前一格是去年', () => {
        const { days } = buildCalendarDays({}, 2026);
        const jan1 = days.find((d) => d.dateKey === '2026-01-01');
        // 2026-01-01 是周四
        expect(jan1.dayOfWeek).toBe(4);
        expect(jan1.inSelectedYear).toBe(true);
        expect(jan1.outOfYear).toBe(false);

        // 网格首格是补满整周的去年日期：2025-12-28（周日）
        expect(days[0].dateKey).toBe('2025-12-28');
        expect(days[0].outOfYear).toBe(true);
        expect(days[0].level).toBe(-1);
    });

    test('日期连续：无重复、无缺口，跨年也不断档', () => {
        for (const year of [2024, 2026, 2028]) {
            const keys = keysOf(buildCalendarDays({}, year));
            expect({ year, dup: new Set(keys).size === keys.length }).toEqual({ year, dup: true });

            const gaps = keys
                .map((key, index) => (index === 0 ? null : String(Date.parse(`${key}T00:00:00Z`)
                    - Date.parse(`${keys[index - 1]}T00:00:00Z`))))
                .slice(1)
                .filter((delta) => delta !== String(24 * 3600 * 1000));
            expect({ year, gaps }).toEqual({ year, gaps: [] });
        }
    });

    test('月标签按列递增，且首尾都落在真实列上', () => {
        const { weeks, monthLabels } = buildCalendarDays({}, 2026);
        expect(monthLabels.map((m) => m.label)).toEqual(
            Array.from({ length: 12 }, (_, i) => `${i + 1}月`)
        );
        const weekIndexes = monthLabels.map((m) => m.weekIndex);
        expect(weekIndexes).toEqual([...weekIndexes].sort((a, b) => a - b));
        expect(weekIndexes[0]).toBeGreaterThanOrEqual(0);
        expect(weekIndexes.at(-1)).toBeLessThan(weeks);
    });
});

describe('buildCalendarDays：Asia/Shanghai 日期域', () => {
    // 上海 2026-11-12 04:30，洛杉矶还是 11-11 12:30：按浏览器本地字段算会差一天。
    const now = new Date('2026-11-11T20:30:00Z');

    test('shanghaiDateKey / shanghaiTodayKey 都产出后端口径的日期键', () => {
        expect(shanghaiDateKey(now)).toBe('2026-11-12');
        // UTC 边界两侧必须落到不同的上海日期
        expect(shanghaiDateKey(new Date('2026-11-11T15:59:00Z'))).toBe('2026-11-11');
        expect(shanghaiDateKey(new Date('2026-11-11T16:00:00Z'))).toBe('2026-11-12');
        expect(shanghaiTodayKey()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    test('上海「今天」不是未来 —— 即使浏览器在 UTC-8', () => {
        // 西移 16 小时：本地日期退到 11-11，而上海已经是 11-12
        const { days } = buildCalendarDays({}, { year: 2026, now });
        const today = days.find((d) => d.dateKey === shanghaiDateKey(now));

        expect(today).toBeTruthy();
        expect(today.isFuture).toBe(false);
        expect(today.inSelectedYear).toBe(true);
        // 「今天之后」的格子仍然必须是未来：11-13 起
        expect(days.find((d) => d.dateKey === '2026-11-13').isFuture).toBe(true);
        expect(days.find((d) => d.dateKey === '2026-11-11').isFuture).toBe(false);
    });

    test('换到 America/Los_Angeles 进程时区后结论不变', () => {
        // 上面那条断言在 UTC+8 的 CI 上是恒真的，必须真的换时区跑一遍才有意义。
        // 子进程里 TZ 在 Date 缓存之前生效，避免 jest 改 process.env.TZ 不生效的坑。
        const script = `
            const { buildCalendarDays, shanghaiDateKey } = await import('./static/ui/lib/stats.js');
            const now = new Date('2026-11-11T20:30:00Z');
            const { days } = buildCalendarDays({}, { year: 2026, now });
            const today = days.find((d) => d.dateKey === shanghaiDateKey(now));
            // 本地日期确实比上海日期早一天，才证明这个用例真的在 UTC-8 下跑
            const localDay = [
                now.getFullYear(),
                String(now.getMonth() + 1).padStart(2, '0'),
                String(now.getDate()).padStart(2, '0')
            ].join('-');
            console.log(JSON.stringify({
                tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
                localDay,
                todayKey: today.dateKey,
                isFuture: today.isFuture
            }));
        `;
        const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
            cwd: path.join(process.cwd()),
            env: { ...process.env, TZ: 'America/Los_Angeles' },
            encoding: 'utf8'
        });
        const result = JSON.parse(stdout.trim().split('\n').at(-1));

        expect(result.tz).toBe('America/Los_Angeles');
        // 前提成立：浏览器本地还是 11-11，后端口径已是 11-12
        expect(result.localDay).toBe('2026-11-11');
        expect(result.todayKey).toBe('2026-11-12');
        // 旧实现（本地字段）到这一步会把今天判成未来
        expect(result.isFuture).toBe(false);
    });

    test('未来日期不计入年度累计', () => {
        // 上海 11-12 = 今天；11-13 及以后是未来
        const history = {
            '2026-11-12': { totalTokens: 100 },
            '2026-11-13': { totalTokens: 999 }
        };
        const { total } = buildCalendarDays(history, { year: 2026, now });
        expect(total).toBe(100);
    });

    test('历史年份整年都不算未来', () => {
        const { days } = buildCalendarDays({}, { year: 2024, now });
        expect(days.filter((d) => d.isFuture)).toEqual([]);
    });

    test('省略 now 时以当前时刻的上海日期为基准', () => {
        const { days, year } = buildCalendarDays({});
        const todayKey = shanghaiTodayKey();
        expect(year).toBe(Number(todayKey.slice(0, 4)));
        const today = days.find((d) => d.dateKey === todayKey);
        expect(today?.isFuture ?? false).toBe(false);
    });
});

describe('buildCalendarDays：热力分级', () => {
    test('level 0~4 按当年峰值等比划分，年外为 -1', () => {
        const history = {
            '2026-01-05': { totalTokens: 1000 }, // 峰值 -> 4
            '2026-01-06': { totalTokens: 100 },  // 1/10  -> 1
            '2026-01-07': { totalTokens: 400 },  // 2/5   -> 2
            '2026-01-08': { totalTokens: 600 },  // 3/5   -> 3
            '2026-01-09': { totalTokens: 800 },  // 4/5   -> 4
            '2026-01-10': { totalTokens: 0 }     // 无用量 -> 0
        };
        const { days } = buildCalendarDays(history, 2026);
        const levelOf = (key) => days.find((d) => d.dateKey === key).level;

        expect(levelOf('2026-01-05')).toBe(4);
        expect(levelOf('2026-01-06')).toBe(1);
        expect(levelOf('2026-01-07')).toBe(2);
        expect(levelOf('2026-01-08')).toBe(3);
        expect(levelOf('2026-01-09')).toBe(4);
        expect(levelOf('2026-01-10')).toBe(0);
        // 补位格子不参与热力
        expect(days[0].outOfYear).toBe(true);
        expect(days[0].level).toBe(-1);
    });

    test('当年没有数据时峰值下限 1000，不会除零', () => {
        const { days } = buildCalendarDays({ '2025-06-01': { totalTokens: 999999 } }, 2026);
        const jan5 = days.find((d) => d.dateKey === '2026-01-05');
        expect(jan5.totalTokens).toBe(0);
        expect(jan5.level).toBe(0);
        expect(Number.isNaN(jan5.level)).toBe(false);
    });

    test('空白/缺字段的 usageHistory 也能生成完整网格', () => {
        const result = buildCalendarDays(undefined, 2026);
        expect(result.days.length).toBe(371);
        expect(result.days.every((d) => ['dayOfWeek', 'dateKey', 'level'].every((k) => k in d))).toBe(true);
    });
});