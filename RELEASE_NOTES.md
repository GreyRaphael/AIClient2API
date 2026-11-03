# AIClient-2-API 发布说明 (v8.0.0)

> ## 🚨 破坏性变更：**移除 Kiro provider**
>
> `claude-kiro-oauth`（AWS CodeWhisperer 反向代理）已从代码库**完整移除**。
> 该 provider 不再可用，相关代码、UI 入口、OAuth 流程与用量查询一并删除。
>
> **升级前请检查**：
> - 若 `configs/provider_pools.json` 中仍配置了 `claude-kiro-oauth` 节点，
>   这些节点将不再被加载，请在升级前迁移到其他 provider
>   （如 `claude-custom`、`gemini-antigravity`、`openai-codex-oauth`、`zed`）。
> - 若 `configs/config.json` 的 `providerFallbackChain` 中引用了
>   `claude-kiro-oauth`，请一并移除该引用，否则该链路将失效。
> - 若 `PROXY_ENABLED_PROVIDERS` 中包含 `claude-kiro-oauth`，可直接删除该项。
>
> **本版本无新增配置项、无 API 契约变更**：除 Kiro 相关路径外，
> 其余 provider 的行为与 v7.0.0 完全一致。

---

## 一、Kiro provider 完整移除

### 1.1 移除专有实现（10 个文件）

| 文件 | 职责 |
|---|---|
| `src/providers/claude/claude-kiro.ts` | 核心服务：CodeWhisperer 请求构建、流式解析、token 刷新、用量查询 |
| `src/auth/kiro-oauth.ts` | Google / GitHub / AWS Builder ID 三种 OAuth 流程、批量 refreshToken 导入、AWS SSO 凭据导入 |
| `src/providers/claude/kiro-request-builder.ts` | Anthropic → CodeWhisperer 协议转换 |
| `src/providers/claude/kiro-stream-parser.ts` | CodeWhisperer 流事件解析 |
| `src/providers/claude/kiro-claude-stream-state.ts` | 流式状态机 |
| `static/ui/sections/providers/auth/KiroAwsImportModal.js` | AWS 凭据导入弹窗 |
| `static/ui/lib/aws-credentials.js` | AWS 凭据合并 / 校验 / 脱敏纯函数 |
| `tests/kiro-parser.test.js` | 流解析器测试 |
| `tests/kiro-request-stream.test.js` | 请求与流式回归测试 |
| `tests/webui-aws-credentials.test.js` | AWS 凭据函数测试 |

### 1.2 后端清理

- **常量与注册**：`constants.ts` 移除 `KIRO_API`；`provider-registry.ts` 移除
  provider 定义（含 15 项 `staticModels` 与 `providerUtils` 配置）。
- **适配器**：`adapter.ts` 移除 `KiroApiServiceAdapter` 类及 `registerAdapter` 调用。
- **OAuth**：`oauth-api.ts` 移除 `handleBatchImportKiroTokens`、
  `handleImportAwsCredentials`；`ui-manager.ts` 移除
  `/api/kiro/batch-import-tokens`、`/api/kiro/import-aws-credentials` 两条路由；
  `oauth-shared.ts` 移除仅为 Kiro 服务的 `showDebugHint` / `logMessage` 选项。
- **用量统计**：`usage-service.ts` 移除 handler / formatter 映射、
  `getKiroUsage` 与 `formatKiroUsage`（124 行）；`usage-api.ts` 移除支持列表项。
- **健康检查**：`provider-pool-manager.ts` 移除 Kiro 专属的
  `max_tokens: 1` 特例分支。
- **配置扫描**：`config-scanner.ts` / `event-broadcast.ts` 移除 Kiro 路径识别
  与上传文件的子目录包裹分支。
- **API 文档数据**：`docs-data.ts` 移除已废弃的 AWS 凭据导入端点条目。

### 1.3 WebUI 清理

| 位置 | 变更 |
|---|---|
| `AuthDialog.js` | 移除 5 种认证方式（Google / GitHub / AWS Builder ID / AWS 导入 / 批量导入）、批量导入配置与 `aws-import` 步骤分支 |
| `provider-registry.js` | 移除 Kiro 节点定义与凭据路径识别 |
| `provider-fields.js` | 移除 4 个 `KIRO_*` 字段与标签映射 |
| `routing.js` | 移除路由卡片条目与 curl 示例分支 |
| `providers-utils.js` / `ProviderManagerModal.js` | 移除 Kiro 字段与专属提示 |
| `locale` `zh-CN` / `en-US` | 各移除 54 个 i18n key |
| `section-providers.css` | 移除 334 行 AWS 导入样式（`aws-import-*` / `aws-dropzone` / `aws-file-*` / `aws-validation` / `aws-preview` / `aws-result`） |
| `section-upload-config.css` | 移除 `.tag-kiro-oauth` 徽章样式 |

### 1.4 文档与配置模板

- `README.md` / `README-ZH.md`：删除「Kiro API 配置」与「Kiro 扩展思考」两章
  （各 46 行），清理全部行级引用（示例表述改用 Zed / claude-custom）。
- `docs/OPENCODE_CONFIG_EXAMPLE.md`：配置示例由 `kiro` 改为 `claude-custom`。
- `docs/PROVIDER_ADAPTER_GUIDE.md`：静态 provider 表述去 Kiro 化。
- `configs/provider_pools.json.example`：移除 28 行 Kiro 节点模板。

### 1.5 刻意保留的内容

以下文件包含 **Kiro 的历史记录**，本次不改写，以免篡改历史事实：

- `CHANGELOG.md`（10 处）、`RELEASE_NOTES.md`（1 处）— 历史发布记录。
- `docs/webui_refactor.md`（6 处）— 重构过程归档，含当时的模块路径。
- `tests/webui-e2e/smoke.spec.js`（2 行断言）— 用于回归验证
  `.kiro-video-link` / `.kiro-buy-link` 已不存在，删除会丢失该保护。

---

## 二、测试调整

移除 Kiro 用例后，原先依赖 Kiro 的测试改用仍在维护的 provider，
保证覆盖意图不变：

| 测试 | 调整 |
|---|---|
| `webui-e2e/modal.spec.js` | 焦点保持 / 叠加弹窗场景改用 Codex `batch-import` |
| `provider-pool-manager.test.js` | 跨类型 fallback 改用 `claude-custom` ↔ `zed`；删除 Kiro 健康检查用例 |
| `model-capability.test.js` | 静态 provider 用例改用 `claude-custom`；去掉「模型数 > 0」断言（现存静态 provider 的 `staticModels` 均为空，关键语义是「未知模型必须放行」） |
| `webui-routing.test.js` | Claude 协议不带 `Authorization` 的用例改用 `claude-custom` |
| `webui-upload-config.test.js` | 路径样例由 `configs/kiro/` 改为 `configs/zed/`，并补充 `zed` 过滤断言 |
| `webui-secret-reveal-ui.test.js` | provider 列表移除 Kiro |
| `webui-components-ssr.test.js` | 移除 `KiroAwsImportModal` 渲染用例 |
| `oauth-shared.test.js` | 移除已下线选项对应的用例 |

**测试规模**：85 suites / 862 tests（移除 3 个测试文件与若干 Kiro 用例）。
代码净减少约 **7,500 行**（54 个文件，+86 / −7632）。

---

## 三、验证

| 检查项 | 结果 |
|---|---|
| TypeScript（`tsconfig.json` / `webui` / `strict`） | 全部 0 error |
| `npm run verify` | 全链路通过 |
| 单元测试 | 85 suites / 862 tests 全绿 |
| any 棘轮 / imports / cycles | 通过（129 文件，0 运行时循环） |
| 覆盖率门槛 | 未低于基线 |
| WebUI HTML 产物 | 与真源一致 |
| 悬空 import 检查 | 无引用已删除模块 |

---

## 四、升级建议

1. **备份配置**：`cp configs/provider_pools.json configs/provider_pools.json.bak`
2. **清理 Kiro 节点**：从 `provider_pools.json` 删除 `claude-kiro-oauth` 键；
   若整个文件只有 Kiro 节点，可参考 `configs/provider_pools.json.example` 重建。
3. **清理引用**：检查 `configs/config.json` 中的 `providerFallbackChain`
   与 `PROXY_ENABLED_PROVIDERS`，移除 Kiro 相关项。
4. **重启服务**：`systemctl --user restart aiclient2api`（或对应的启动方式）。
5. **验证**：访问 `/#providers` 确认 Kiro 已不在 provider 列表中，
   其余 provider 的授权与模型列表功能正常。

---

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)