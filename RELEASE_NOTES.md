# AIClient-2-API 发布说明 (v4.0.0)

> 本次 **v4.0.0** 是一次明确的破坏性发布：下游客户端协议收敛为 **OpenAI Chat Completions、OpenAI Responses、Anthropic Messages** 三种，原生 Gemini 下游端点被移除。
>
> Gemini、Antigravity、Codex、Grok、Kiro、Zed、Trae 等仍作为**上游 provider** 保留；网关会继续把上游原生响应转换为上述三种客户端协议。
>
> **OpenAI Images 下游入口保持不变**：`/v1/images/generations`、`/v1/images/edits` 与 Playground 图片页面继续可用。

---

## 🌟 核心更新亮点

### 1. 下游协议正式收敛为三种

客户端现在只需要支持以下协议：

| 协议 | 下游端点 |
|---|---|
| OpenAI Chat Completions | `POST /v1/chat/completions` |
| OpenAI Responses | `POST /v1/responses` |
| Anthropic Messages | `POST /v1/messages` |

模型列表继续通过 `GET /v1/models` 提供；Token 计数继续通过 `POST /count_tokens` 提供。

这样可以直接对接主流开源 harness 与 Agent 客户端，不再要求客户端理解 Gemini 原生协议。

### 2. Gemini 从“下游协议”调整为“上游来源”

以下能力保持不变：

- Gemini / Antigravity provider 的 OAuth、模型发现、账号池、健康检查。
- OpenAI / Claude / Responses 请求转换为 Gemini 上游请求。
- Gemini 上游响应转换回 OpenAI / Claude / Responses。
- Gemini 3+ 的 `thinkingLevel`、工具调用、Schema Polyfill、签名处理等跨协议逻辑。

移除的是“客户端直接发 Gemini 协议”这条入口，而不是 Gemini 模型能力本身。

### 3. 转换器不可达分支清理

在“下游只有三种协议”的约束下，响应、流式与模型列表的目标协议不可能再是 Gemini、Codex 或 Grok。本次删除了这些不可达分支及其独占 helper，约 **2.2k 行**：

- `OpenAIConverter`：目标 Gemini/Grok 响应与流、目标 Claude/Gemini 模型列表。
- `ClaudeConverter`：目标 Gemini/Codex 响应与流、目标 Gemini 模型列表。
- `OpenAIResponsesConverter`：目标 Gemini/Codex 响应与流、目标 Claude/Gemini 模型列表。
- `CodexConverter`：目标 Gemini 响应与流。
- `GrokConverter`：目标 Gemini/Codex 响应与流、目标 Gemini 模型列表。
- `GeminiConverter`：Gemini 作为客户端协议的请求转换、目标 Codex 响应与流。

同时保留并继续使用：

- OpenAI / Claude / Responses → Gemini、Codex、Grok 的上游请求转换。
- Gemini、Codex、Grok 作为上游来源 → OpenAI / Claude / Responses 的响应转换。

### 4. 工程清理

- 删除全仓未引用的 `getOpenAIStreamChunkStop`。
- 删除未被继承或引用的 `ContentProcessor`、`ToolProcessor` 抽象接口。
- 删除重构后失效的 import、重复常量和不再可达的模型列表格式。
- `mapFinishReason` 移除 `openai -> gemini` 映射，保留 `gemini -> openai/anthropic`。
- Antigravity 的 tool id 补齐保留为请求体安全兜底。

---

## ⚠️ 破坏性变更

### 已移除的端点

以下 Gemini 原生下游端点已删除：

```text
GET  /v1beta/models
POST /v1beta/models/{model}:generateContent
POST /v1beta/models/{model}:streamGenerateContent
```

调用上述端点将返回 `404 Not Found`。

### 已移除的常量与内部分支

- `ENDPOINT_TYPE.GEMINI_CONTENT`
- `ENDPOINT_TYPE.GEMINI_MODEL_LIST`
- `API_ACTIONS`
- `GeminiStrategy.extractModelAndStreamInfo`
- Provider 池的 Gemini 格式模型列表
- 转换器中目标 Gemini/Codex/Grok 的不可达响应侧分支

### 不受影响的入口

- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/messages`
- `GET /v1/models`
- `POST /count_tokens`
- `POST /v1/images/generations`
- `POST /v1/images/edits`
- `/api/*` 管理接口、WebUI、Provider 池与 OAuth 流程

---

## 🔄 迁移指南

### 使用 OpenCode / `@ai-sdk/google` 的客户端

原配置：

```json
{
  "npm": "@ai-sdk/google",
  "options": {
    "baseURL": "http://localhost:3000/gemini-antigravity/v1beta"
  }
}
```

迁移为 OpenAI 兼容入口：

```json
{
  "npm": "@ai-sdk/openai-compatible",
  "options": {
    "baseURL": "http://localhost:3000/gemini-antigravity/v1"
  }
}
```

模型名保持不变，Gemini 上游能力由网关负责转换。

### 直接调用 `/v1beta` 的脚本

- `GET /v1beta/models` → 改为 `GET /v1/models`。
- `POST /v1beta/models/{model}:generateContent` → 改为 `POST /v1/chat/completions`，请求体使用 OpenAI messages 格式。
- `POST /v1beta/models/{model}:streamGenerateContent` → 改为 `POST /v1/chat/completions` 并设置 `stream: true`。

### 仅使用 OpenAI/Claude 的客户端

无需修改配置；本次升级不会改变既有请求与响应行为。

---

## 🧪 验证结果

- `npm test -- --runInBand`：**20 suites / 309 tests 全绿**
- 所有修改的 JS 文件通过 `node --check`
- `request-pipeline` import smoke 通过
- `tests/api-integration.test.js` 在未设置 `TEST_API_KEY` 时按既有逻辑跳过（10 skipped）
- `git diff --check` 通过，无空白错误

本次没有实际连接上游 provider 跑端到端集成；集成套件仍需在配置 `TEST_API_KEY` / `TEST_PROVIDER` 后执行。

---

## 🐳 Docker

发布后 Docker 镜像标签：

- `docker.io/<DOCKERHUB_USERNAME>/aiclient-2-api:4.0.0`
- `docker.io/<DOCKERHUB_USERNAME>/aiclient-2-api:latest`

---

## 📚 相关文档

- [当前跨协议架构](docs/CROSS_PROTOCOL_ARCHITECTURE.md)
- [Provider 接入指南](docs/PROVIDER_ADAPTER_GUIDE.md)
- [流式转换设计](docs/CONVERTER_STREAM_DESIGN.md)
- [Antigravity 说明](docs/ANTIGRAVITY_NOTES.md)
- [OpenCode 配置示例](docs/OPENCODE_CONFIG_EXAMPLE.md)
- [历史方案归档](docs/archive/)

---

## 🙏 升级提示

升级前请确认：

1. 客户端不再直接依赖 `/v1beta` 路径。
2. OpenCode 等使用 `@ai-sdk/google` 的配置已切换为 `@ai-sdk/openai-compatible` + `/v1`。
3. 如有自建脚本调用 Gemini 原生端点，请按上述迁移指南改为 OpenAI Chat / Responses / Messages。
4. 升级后重启服务，并强制刷新 WebUI 静态资源。
