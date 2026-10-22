# AIClient-2-API 发布说明 (v4.1.2)

> **v4.1.2** 是 v4.1.1 的兼容性补丁版本，无破坏性变更。
>
> 本版本基于 v4.1.1 最新代码的跨协议转译复评，重点修复 custom tool 全链路、Gemini 流式终止语义、thinking signature 隔离、缓存 usage 口径，以及 OpenAI/Claude 请求参数与并行工具映射。

---

## 🌟 核心修复

### 1. custom tool 全链路打通（重点）

此前只有 Responses → Responses 能完整使用 `type: "custom"` 工具，跨协议后会出现工具定义丢失、类型降级或事件类型错误。v4.1.2 统一了 custom tool 的请求登记、降级与响应还原：

- 新增请求级 `custom-tool-registry`，在请求转换时记录哪些工具原本是 custom。
- **Responses → Codex**：原生保留 `type: "custom"` 与 `format`，不再降级为无参数 function。
- **Responses → OpenAI / Claude / Gemini**：将 custom tool 降级为带 `input` / `patch` 自由文本参数的 function，响应侧再还原为 `custom_tool_call`。
- **Codex → OpenAI / Claude / Responses**：补齐非流式与流式的 `custom_tool_call` 输出。
- **Responses SSE**：custom tool 现在发送规范的 `response.custom_tool_call_input.delta/done`，不再错误使用 `response.function_call_arguments.*`。
- 移除按工具名 `apply_patch` 硬编码推断 custom 的逻辑；普通 function 工具即使同名也不会再被误判。
- 非流式 `custom_tool_call` 已补齐 OpenAI Chat 与 Anthropic Messages 输出。

### 2. Gemini 流式终止语义

- Gemini → OpenAI Chat 的工具 chunk 不再提前写 `finish_reason=tool_calls`。
- 只有上游明确给出 `candidate.finishReason` 时才写终止原因，避免 Agent 客户端在第一个工具 chunk 后提前停止读取。
- 最终 `STOP` 帧仍由 pipeline 的 `hasToolCall` 逻辑正确覆盖为 `tool_calls`。

### 3. thinking signature 跨协议隔离

- **Gemini → Claude**：不再把 Gemini 的 `thoughtSignature` 原样作为 Anthropic `thinking.signature`，统一铸造 `vsig1.*` 虚拟签名。
- **Claude → Gemini**：不再把 Claude 真实 signature 当作 Gemini `thoughtSignature` 透传，避免 Gemini 3 因签名非法返回 400。
- 同一会话在 Gemini / Claude 上游之间切换时，虚拟签名可被安全剥离。

### 4. Claude 目标 usage 缓存口径

- 新增共享的 `anthropicUsageFromInclusiveInput`。
- **Gemini → Claude**：`input_tokens` 现在从 `promptTokenCount` 中扣除 `cachedContentTokenCount`。
- **Codex → Claude**：`input_tokens` 现在从 `input_tokens` 中扣除 `cached_tokens`。
- 修复此前缓存 token 在 Anthropic 侧被重复计数的问题。

### 5. OpenAI / Claude 请求参数保真

- **OpenAI → Claude**：
  - `reasoning_effort` 映射为 `thinking` 后不再透传到 Claude 请求体，避免官方 Anthropic 400。
  - 显式 `thinking.type = "disabled"` 现在优先于 `reasoning_effort`。
- **Claude → OpenAI**：
  - 不再默认注入 `max_tokens = 128000`、`temperature = 1`、`top_p = 0.95`；未显式传参时使用上游默认值。
  - `parallel_tool_calls: false` → Anthropic `tool_choice.disable_parallel_tool_use: true`。
  - Anthropic `disable_parallel_tool_use` → OpenAI / Responses / Codex 的 `parallel_tool_calls: false`。
  - Codex 请求不再硬编码 `parallel_tool_calls: true`。
- **strict**：Chat ↔ Responses 双向保留 function tool 的 `strict` 属性。
- **工具索引**：Claude → OpenAI Chat 流式的 `tool_calls.index` 改为请求级从 0 递增，不再复用 Anthropic content block index。

### 6. 多模态与 Grok

- **Responses → Gemini `input_file`**：
  - base64 `file_data` 映射为 Gemini `inlineData`。
  - `file_url` 映射为 `fileData.fileUri`。
  - 仅 `file_id` 且无内容时保留可追踪文本占位。
- **Grok**：
  - 流式思考内容只写入 `reasoning_content`，不再同时写入 `<think>` 正文。
  - Grok → Responses 非流式补充 reasoning item。

### 7. 其他响应形状修复

- Claude → Responses 非流式输出顺序修正为 `reasoning → message → function_call`。
- Responses → Claude 终止时补齐 custom tool 的未完成 input。
- Responses → OpenAI 非流式补齐 `custom_tool_call` 折叠输出。

---

## ✅ 验证

- `npm test -- --runInBand`：**26 suites / 376 tests 全绿**。
- 新增 `tests/cross-protocol-v4-1-1-fixes.test.js`，覆盖 20 个回归场景：
  - Gemini 流式工具终止原因；
  - custom tool 的 Codex / OpenAI / Claude / Gemini 全链路；
  - `apply_patch` function 与 custom 的类型区分；
  - thinking signature 隔离；
  - Gemini / Codex → Claude 缓存 usage；
  - Claude → OpenAI 工具索引；
  - `reasoning_effort` 清理与 disabled 优先级；
  - 默认采样参数、`strict`、`parallel_tool_calls`；
  - `input_file → inlineData`；
  - Grok 思考内容去重。

---

## 📦 升级建议

本次为兼容性补丁，建议所有 v4.1.1 用户升级：

```bash
docker pull greyraphael/aiclient-2-api:latest
# 或固定版本
docker pull greyraphael/aiclient-2-api:4.1.2
```

无需修改现有配置或客户端协议；下游仍为 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 三种。

---

## ⚠️ 行为变化

- Gemini → Claude 的 thinking signature 由原始 Gemini 签名改为 `vsig1.*` 虚拟签名。
- Claude → Gemini 不再回放 Claude 真实 thinking signature。
- Claude → OpenAI 未显式传参时不再注入 `max_tokens` / `temperature` / `top_p`。
- custom tool 在 OpenAI / Claude / Gemini 上游会以 function 形式出现，响应侧再还原为 `custom_tool_call`。

---

## 📚 相关文档

- [跨协议转译架构](docs/CROSS_PROTOCOL_ARCHITECTURE.md)
- [跨协议转译复评（当前）](docs/CROSS_PROTOCOL_EVALUATION_V4_1_4.md)
- [变更日志](CHANGELOG.md)

---

## 🔭 已知边界

- Prompt Caching 的 `cache_control` 仍无法完整跨协议保留。
- Gemini → Responses 流式的 `SAFETY` / `RECITATION` 等安全收尾仍标记为 `completed`，非流式路径已正确标记 `incomplete`。
- Responses → Claude 流式仅处理 `reasoning_summary_text`，`reasoning_text.delta` 尚未映射。
- Codex 非流式 `response.incomplete` 仍会被 provider 解析层合成为 `completed`。
- 非 Claude 上游 → Claude 流式的 `message_start.usage.input_tokens` 仍可能为 0，完整 usage 在终止帧交付。
- Anthropic `source.type = "file"`（Files API）尚未映射。
- Responses → Gemini 的 `file_id` 仅保留文本占位，需网关先拉取文件才能转为 `inlineData`。
