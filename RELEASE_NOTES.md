# AIClient-2-API 发布说明 (v5.0.2)

> **v5.0.2** 是 TypeScript 严格化（strict ratchet）重构的收尾版本。
>
> 本次重构不做功能变更，重点是把长期存在的隐式协议边界收敛为真实 DTO / 协议类型：
> 全仓显式 `any` 从 **2279 处降至 234 处（-90%）**，且仅剩的 234 处全部集中在
> `security-hardening.ts` 的 monkey-patch wrapper 边界，作为受控例外保留。

---

## ✨ 重构内容

### TypeScript 严格化

- `strict` 模式错误：**0**
- `@ts-nocheck`：**0 文件 / 0 行**
- 显式 `any`：**2279 → 234 annotations**，**135 → 6 assertions**
- 新增 `any` 棘轮基线（`scripts/any-baseline.json`），任何文件新增 `any` 都会导致 CI 失败

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
| 显式 `any` | **234 annotations / 6 assertions**（全部为受控例外） |
| 单元测试 | **30 suites / 494 tests 全绿** |
| 导入检查 | **128 文件通过** |
| 运行时冒烟 | **OK** |

---

## 📦 兼容性

- 无 API、配置或数据格式变更；
- 无 provider 增删，行为与 v5.0.1 保持一致；
- `security-hardening.ts` 的 wrapper 仍是唯一保留显式 `any` 的模块，属于有意设计。

## 🚀 升级建议

- 直接拉取 `v5.0.2` 镜像或代码即可，无需迁移配置；
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
