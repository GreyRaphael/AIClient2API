# AIClient-2API 发布说明 (v8.9.6)

> ## 🛠️ 全仓架构精简、死代码清理与 WebUI 视觉美化
>
> **版本重点**：在保持 API 行为与兼容性不变的前提下，将严格 TypeScript 检查收口至单一主配置并启用 WebUI 未使用变量门禁；拆解 `provider-api`、Trae 协议层与 Antigravity 纯转换模块并抽取共享 SSE / HTTP 传输层；基于 Playwright 全菜单巡检完成桌面与移动端排版美化，同时清理确认死代码并整合精简测试套件。

---

## ⚠️ 升级与兼容性说明

- **运行时要求**：Node.js >= 26.0.0（与 v8.9.x 系列一致）。
- **兼容性**：聚焦内部模块解耦、死代码清理、WebUI 样式一致性和测试结构整理，无破坏性 HTTP API 或配置文件格式变更，可直接从 v8.9.x 平滑升级。

---

## 一、架构精简与代码质量收口

1. **全仓严格模式统一与 WebUI 未使用变量检查**
   - 将原 `tsconfig.strict.json` 严格检查选项收口并入主配置 `tsconfig.json`，移除冗余严格模式基线脚本并简化 CI / npm 门禁流程；`any` AST 节点计数进一步收敛至 `92`（`: any` / `as any` 保持 `0`）。
   - 为 `tsconfig.webui.json` 启用 `noUnusedLocals` 与 `noUnusedParameters`，由静态类型检查持续守护前端无用变量。

2. **`ui-modules` 模块拆分与共享 HTTP 辅助抽离**
   - 新增 `src/ui-modules/http-helpers.ts` 收敛通用请求解析与响应拼装逻辑。
   - 将原 `src/ui-modules/provider-api.ts` 按职责拆出 `provider-health-models.ts`、`provider-pools-store.ts` 与 `provider-secrets.ts`，同步清理周边接口模块的冗余样板与残留 JSDoc `any`。

3. **Provider 传输层复用与超大核心文件拆解**
   - 抽取共享 SSE 行解码与排空调度工具 `src/utils/sse-stream.ts` 及共享 HTTP transport / 错误辅助 `src/providers/provider-http.ts`，简化 Claude、OpenAI、Responses、Codex 与 Zed 5 个核心模块的流式与请求路径。
   - 将 Trae 协议组装与请求构造拆分至 `src/providers/trae/trae-protocols.ts`（并优化非流式响应构造），将 Antigravity 纯转换逻辑拆分至 `src/providers/gemini/antigravity-transforms.ts`。

4. **全仓死代码清理**
   - 移除确认无调用方的冗余代码与表结构，包括 `src/auth/codex-oauth.ts` 遗留 CLI 流程、`src/services/api-keys/key-db.ts` 无用 `api_key_meta` 表与 4 个方法、`src/utils/logger.ts` 空请求上下文实现、`usage-service.ts` / `stats-manager.ts` / `rate-tracker.ts` / `tls-sidecar.ts` / `type-guards.ts` 未使用导出，以及 `static/ui/` 多处死分支与空样式字典。

---

## 二、WebUI 排版美化与测试套件整理

1. **Playwright 全菜单巡检与视觉一致性美化**
   - 统一多个管理面板（自定义模型、配置管理、用量查询、日志、模型用量统计、提供商与 Playground）卡片边框、圆角、`highlight-note` 横幅、分段控件高度及按钮/输入框尺寸。
   - 优化 `mobile.css` 在 390px 小屏下的侧栏图标居中对齐、页面标题内边距与 Playground 输入栏间距；改进独立页面 `potluck-user.js` 与 `potluck-shared.css` 卡片内容对齐和日历横向滚动。

2. **单元测试轻量清理与超长回归文件拆分**
   - 精简 `tests/support/harness.mjs` 重复定时器键与零调用 Jest stub/matcher，清理过时 `jest.resetModules()` / `jest.doMock()` 用法与脆弱 CSS 正则源码测试。
   - 将 16 个高内聚小单测整合为 `error-handling.test.mjs`、`stream-utilities.test.mjs`、`webui-core-helpers.test.mjs`、`webui-section-helpers.test.mjs` 等文件（`.test.mjs` 文件总数由 115 收敛至 100）。
   - 将 2,651 行的 `cross-protocol-bridging.test.mjs`（109 条用例）按主题拆分为 `bridging-core-converters.test.mjs`、`bridging-edge-cases.test.mjs` 与 `bridging-stream-and-gating.test.mjs`。

---

## 三、全量验证结果

| 检查项 | 结果 |
|---|---|
| `typecheck` / `typecheck:webui` | 通过（0 错误；已启用 WebUI 未使用变量检查） |
| `check:any` | 0 `: any` 注解 / 0 断言（92 AST nodes） |
| `check:imports` / `check:cycles` | 150 个文件全部通过（0 循环依赖） |
| `lint:css` / `gen:webui-html:check` / `vendor:webui:check` / `vendor:fa:check` | 全部通过 |
| 核心单元测试与回归测试（`npm test`） | **1113 / 1113 通过**（249 个套件） |
| 运行时冒烟测试（`npm run test:runtime`） | 通过 |
| WebUI Playwright E2E（`tests/webui-e2e/playwright.config.js`） | **40 / 40 通过**（本地缓存 `chromium_headless_shell-1248`） |

---

**完整变更明细**：见 [CHANGELOG.md](https://github.com/GreyRaphael/AIClient2API/blob/main/CHANGELOG.md)
