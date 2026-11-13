# AIClient-2API 发布说明 (v8.9.5)

> ## ✨ WebUI 用量统计增强与令牌管理视觉优化
>
> **版本重点**：为 WebUI「模型用量统计」表格新增**上次请求时间**列与对应排序支持，
> 并针对「令牌管理 (API Keys)」页面卡片密度、间距尺度与弹窗作用域样式进行视觉重整，
> 同步修复 WebUI E2E 测试中的接口匹配与日历断言边界问题。

---

## ⚠️ 升级与兼容性说明

- **运行时要求**：Node.js >= 26.0.0（与 v8.9.x 系列一致）。
- **兼容性**：纯前端 WebUI 与测试增强，无破坏性 HTTP API 或配置文件格式变更，可直接从 v8.9.0 ~ v8.9.4 平滑升级。

---

## 一、功能新增与交互优化（WebUI）

1. **模型用量统计表格新增「上次请求时间」列与排序**
   - 在 `static/ui/sections/model-usage-stats/index.ts` 中将明细表格由 8 列扩展为 9 列，新增「上次请求时间 / Last Request」（`.col-last-used`），悬停展示原始 ISO 时间戳。
   - 在 `static/ui/lib/stats.js` 增强 `formatDateTime` 对 `null` / `undefined` / 空字符串 / 非法日期的 `--` 安全兜底，并在中英文语言包补齐词条。
   - 在 `static/ui/sections/model-usage-stats/usage-utils.ts` 扩展 `SortField` 支持 `lastUsedAt`，表格排序下拉新增「上次请求时间 ↓」（按毫秒时间戳降序，缺省或无效时间戳统一归零排后）。

2. **令牌管理（API Keys）页面排版与视觉美化**
   - 收敛 `static/ui/sections/api-keys/index.ts` 页面结构：采用 `.api-keys-stats-grid` 4 栏均衡 KPI 统计卡片、优化配额/汇率提示横幅（`.rates-banner`）、清理空白日历图例，并将 Key 卡片重构为清晰的身份信息头与左右操作栏。
   - 修正 `static/ui/styles/components/section-api-keys.css` 间距尺度，解决搜索图标与输入文本重叠问题，完善分布条、`.key-card.disabled` 禁用态对比度、图标按钮对齐，以及基于 `#modal-root` 的 `.api-keys-modal` 弹窗作用域和移动端响应式布局。

3. **E2E 测试稳定性修复**
   - 在 `tests/webui-e2e/smoke.spec.js` 将 `/api/model-usage-stats` mock 匹配规则修正为 `/\/api\/model-usage-stats(\?|$)/`，并将日历首格可见性断言限定为 `.calendar-day:not(.out-of-year)`。

---

## 二、全量验证结果

| 检查项 | 结果 |
|---|---|
| `typecheck` / `typecheck:webui` | 通过（0 错误） |
| `check:strict` / `check:any` | 0 严格错误；0 `any` 注解（94 AST nodes） |
| `check:imports` / `check:cycles` | 142 个文件全部通过（0 循环依赖） |
| `lint:css` / `gen:webui-html:check` / `vendor:webui:check` / `vendor:fa:check` | 全部通过 |
| 核心单元测试与回归测试（`npm test`） | **1124 / 1124 通过**（250 个套件） |
| 运行时冒烟测试（`npm run test:runtime`） | 通过 |
| WebUI Playwright E2E（`tests/webui-e2e/smoke.spec.js`） | **40 / 40 通过** |

---

**完整变更明细**：见 [CHANGELOG.md](https://github.com/GreyRaphael/AIClient2API/blob/main/CHANGELOG.md)
