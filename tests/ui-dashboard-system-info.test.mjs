import { describe, test } from 'node:test';
import { expect, jest } from './support/harness.mjs';
/**
 * 仪表盘「系统信息」面板的结构与数据契约。
 *
 * 面板在 P2 之后做过一次精简：去掉「CPU 使用」，剩 6 项并重排为
 *   上排：运行时间 / Node.js 版本 / 版本号
 *   下排：内存使用 / 运行模式 / 进程 PID
 *
 * 列数由容器查询决定（宽面板 3 列、窄面板 2 列、超窄 1 列），会随视口变化，
 * 不适合用计算样式锁；这里锁的是**与布局无关的结构**：
 *  - 项数与顺序；
 *  - CPU 使用彻底移除（DOM 无节点、`/api/system` 无 cpuUsage 字段、locale 无 key）；
 *  - 每项都能取到非占位值。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

const SYSTEM_INFO = read('static/ui/sections/dashboard/SystemInfo.js');

/** 从 SystemInfo.js 的 JSX 里按出现顺序取 .info-value 的 id */
function infoValueIds() {
    const grid = SYSTEM_INFO.slice(SYSTEM_INFO.indexOf('<div class="info-grid">'));
    const end = grid.indexOf('</div>\n        </div>`');
    const scope = end > 0 ? grid.slice(0, end) : grid;
    return [...scope.matchAll(/class="info-value" id="([\w]+)"/g)].map((m) => m[1]);
}

describe('仪表盘系统信息面板', () => {
    test('固定 6 项，顺序为 运行时间/Node.js版本/版本号/内存使用/运行模式/PID', () => {
        expect(infoValueIds()).toEqual([
            'uptime', 'nodeVersion', 'appVersion', 'memoryUsage', 'serviceMode', 'processPid'
        ]);
    });

    test('CPU 使用已从 DOM 移除', () => {
        expect(SYSTEM_INFO).not.toContain('cpuUsage');
        expect(SYSTEM_INFO).not.toContain('dashboard.cpuUsage');
    });

    test('CPU 使用已从后端 /api/system 移除，且不再做 CPU 采样', () => {
        const api = read('src/ui-modules/system-api.ts');
        expect(api).not.toContain('cpuUsage');
        expect(api).not.toContain('getCpuUsagePercent');
    });

    test('CPU 使用已从两份 locale 移除', () => {
        for (const file of ['static/ui/locales/zh-CN.js', 'static/ui/locales/en-US.js']) {
            expect({ file, has: read(file).includes('dashboard.cpuUsage') })
                .toEqual({ file, has: false });
        }
    });

    test('宽面板下是 3 列（容器查询 >= 470px），窄面板退化', () => {
        const css = read('static/ui/styles/components/section-dashboard.css');
        // 3 列定在 >=470px 容器查询里
        const wide = /@container \(min-width: 470px\) \{\s*\.info-grid \{\s*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/.test(css);
        expect(wide).toBe(true);
        // 默认 2 列、超窄 1 列
        expect(css).toContain('grid-template-columns: repeat(2, minmax(0, 1fr));');
        const single = (css.match(/@container \(max-width: 299px\) \{\s*\.info-grid \{\s*grid-template-columns: 1fr;/g) || []).length;
        expect({ single, atLeastOne: single >= 1 }).toEqual({ single, atLeastOne: true });
    });
});