/**
 * 迁移期兼容层：旧 HTML 片段加载逻辑已移至 `static/ui/lib/legacy-components.js`。
 * Phase 1 起页面装配由 static/ui/ 接管，本文件不再做 DOM 插入。
 * Phase 6 删除。
 */
export { loadComponentHtml, clearComponentCache } from '../ui/lib/legacy-components.js';
