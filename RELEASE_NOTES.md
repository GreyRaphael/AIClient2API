# AIClient-2-API 发布说明 (v5.0.2)

> **v5.0.2** 是 TypeScript 严格化（strict ratchet）重构的收尾版本。
>
> 本次重构不做功能变更，重点是把长期存在的隐式协议边界收敛为真实 DTO / 协议类型。
> 按 `: any` / `as any` 注解口径，`src` 下显式 `any` 从 **2279 处降至 234 处（-90%）**；
> 这 234 处均位于 `security-hardening.ts` 的 monkey-patch wrapper 边界，作为受控例外保留。
> 若按 TypeScript AST 统计所有 `AnyKeyword` 节点（含 `Record<string, any>`、`Promise<any>`
> 等泛型位置及 `types/` 声明），当前为 **395 处（src=333 / types=62）**，其中
> `security-hardening.ts` 占 239 处，其余集中在动态 payload 与第三方边界。

---

## ✨ 重构内容

### TypeScript 严格化

- `strict` 模式错误：**0**
- `@ts-nocheck`：**0 文件 / 0 行**
- 显式 `any`（`: any` / `as any` 正则口径）：**2279 → 234 annotations**，**135 → 6 assertions**
- AST `any` 节点（含泛型位置与 `types/`）：**395 处（src=333 / types=62）**
- 新增 `any` 棘轮基线（`scripts/any-baseline.json`），同时校验 **234 annotations / 6 assertions / 395 AST nodes**；新增 `: any`、`as any` 或 `Record<string, any>` 等泛型 any 都会导致 CI 失败

### Provider 层

- `antigravity-core`、`zed-core`、`codex-core`、`claude-kiro`、`trae-core`、`openai-core` 全部使用真实请求/响应结构与错误边界类型；
- `model-capability` 能力层、`adapter` 注册表、provider registry / capabilities / strategies / channel helpers 全部类型化；
- 流式响应、SSE 事件、模型发现、凭据刷新与错误重试路径保持原有运行时行为。

### 转换器层

- `ClaudeConverter`、`OpenAIConverter`、`OpenAIResponsesConverter`、`CodexConverter` 的公共入口与内部 payload 全部类型化；
- `GeminiConverter` 与各 provider strategy 同步收敛；
- 空响应、终止帧、tool_calls 聚合等边界逻辑未做行为变更。

### Handlers 与 UI API

- `request-pipeline` 引入统一的 `PipelineError` 边界，流式/非流式重试逻辑类型化；
- `request-handler`、`usage-api`、`oauth-api`、`update-api`、`custom-models-api`、`upload-config-api`、`config-api`、`event-broadcast` 等 UI API handler 全部使用 `IncomingMessage` / `ServerResponse` / `DynamicPayload` 类型；
- SSE 批量导入、WebSocket 广播、配置扫描与缓存访问路径保持兼容。

### Core 与 Services

- `config-manager`、`plugin-manager`、`plugin-security`、`master-core`、`api-manager`、`service-manager`、`usage-service`、`file-lock` 等模块完成类型收敛；
- `security-hardening.ts` 保持受控例外，仅保留 wrapper 所需的动态签名。

---

## ✅ 验证结果

| 项目 | 结果 |
|---|---:|
| TypeScript strict | **0 errors** |
| `@ts-nocheck` | **0 文件 / 0 行** |
| 显式 `any`（正则口径） | **234 annotations / 6 assertions** |
| AST `any` 节点（含泛型与 `types/`） | **395（src=333 / types=62）** |
| 单元测试 | **30 suites / 494 tests 全绿** |
| 导入检查 | **128 文件通过** |
| 运行时冒烟 | **OK** |

---

## 📦 兼容性

- 无 API、配置或数据格式变更；
- 无 provider 增删；
- **运行要求：Node.js >= 22.18.0**（服务端直接运行 `.ts` 源码，依赖原生类型擦除；Node 20 及更早版本无法启动）；
- `security-hardening.ts` 是正则口径下唯一保留 `: any` 的模块；AST 口径下的动态 payload / 第三方边界 any 也已纳入棘轮基线。

## 🚀 升级建议

- 升级前请确认 `node -v` >= 22.18.0，其余无需迁移配置；
- Docker：
  ```bash
  docker pull <dockerhub-username>/aiclient-2-api:5.0.2
  ```
- 源码：
  ```bash
  git fetch --tags
  git checkout v5.0.2
  npm install
  npm start
  ```

---

## 📚 相关文档

- [配置分层与优先级](docs/CONFIG_PRECEDENCE.md)
- [跨协议架构](docs/CROSS_PROTOCOL_ARCHITECTURE.md)
- [Provider 适配指南](docs/PROVIDER_ADAPTER_GUIDE.md)
- [E2E 测试说明](tests/e2e/README.md)
