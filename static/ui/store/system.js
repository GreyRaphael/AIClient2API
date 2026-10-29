/** 系统级状态（迁移期先承载服务模式，供 Header 的重启/重载按钮使用）。 */
import { signal } from '@preact/signals';

/** @type {import('@preact/signals').Signal<'worker'|'standalone'|string>} */
export const serviceMode = signal('worker');
