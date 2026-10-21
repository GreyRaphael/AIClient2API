# AIClient-2-API 发布说明 (v4.0.1)

> **v4.0.1** 是 v4.0.0 的兼容性修复版本，无破坏性变更。
>
> 本次发布基于对 v4.0.0 跨协议转译代码的完整复评，集中修复了工具调用、多模态、思考配置、Codex 工具名映射与 Grok Responses 流式事件等质量问题。

---

## 🌟 核心修复

### 1. 工具调用可靠性

- 修复 **Claude → OpenAI Responses** 流式工具调用重复生成 `function_call` output item 的问题（统一 `ResponsesSseEmitter` 工具 key）。
- 修复 **Codex 长工具名**在请求/响应之间无法反向还原的问题：请求与响应共用 requestId，请求级工具名映射跨转换器实例共享。
- 补齐 OpenAI / Claude / Responses → Gemini 的 `required`、`any` 等 `tool_choice` 映射。
- 修复 Claude → OpenAI 的 `tool_choice` 被固定为 `auto` 的问题，并补齐 `stop_sequences`、`metadata`。

### 2. 请求参数与多模态保真

- 修复 **OpenAI Chat → Gemini** 多条 system/developer 消息只保留最后一条的问题，现在按顺序完整拼接。
- 补齐 **Responses → OpenAI** 的图像、文件占位、`text.format`、`tool_choice`、`max_completion_tokens` 映射。
- 补齐 **OpenAI → Responses** 的 `max_completion_tokens`、`response_format`、`metadata`、`service_tier`，并修正 `input_image.image_url` 形状。
- URL 图片/文档增加 `fileData` / `image_url` / 占位文本兜底，减少静默丢失。
- 修复 Claude → OpenAI 的 URL 图像导致整条消息消失的问题。

### 3. 思考与流式生命周期

- 修复 OpenAI → Claude 收到 usage-only 尾帧时重复发送 `message_start` 的问题。
- Claude → Gemini 统一使用 Gemini 3+ 的 `thinkingLevel`，并支持 `adaptive` thinking。
- Gemini → Responses 非流式响应现在输出标准 `reasoning` item。
- 映射 `response.incomplete`；`response.failed` / `error` 会向上抛出，不再被当作正常完成。
- 修正 reasoning / text 内容块的关闭顺序，减少下游 SSE 客户端解析异常。
- Responses → Claude 对无 Anthropic 签名的 reasoning 采取保守跳过策略，避免原生 Anthropic 上游 400。

### 4. Grok Responses 流式规范化

- Grok → OpenAI Responses 改用 `ResponsesSseEmitter`，输出标准 `response.output_item.added`、`response.function_call_arguments.delta`、`response.output_item.done`、`response.completed` 等生命周期事件。
- 移除 Grok 静态共享 UUID/baseUrl，改为请求级状态，降低多账号并发串扰风险。

### 5. 代码清理与测试

- 删除 Codex `if(true)` 死代码、Grok 占位解构、未使用的 Emitter API/常量、request-pipeline 不可达 Gemini 分支。
- 新增 `tests/cross-protocol-v4-fixes.test.js`，覆盖 18 个跨协议回归场景。
- 新增完整复评文档：[`docs/CROSS_PROTOCOL_EVALUATION_V4.md`](docs/CROSS_PROTOCOL_EVALUATION_V4.md)。

---

## ✅ 验证

- `npm test -- --runInBand`：**21 suites / 327 tests 全绿**。
- 所有修改的 JS 文件通过 `node --check`。
- `request-pipeline` / `register-converters` import smoke 通过。

---

## 📦 升级建议

本次为补丁版本，建议所有 v4.0.0 用户升级：

```bash
docker pull greyraphael/aiclient-2-api:latest
# 或固定版本
docker pull greyraphael/aiclient-2-api:4.0.1
```

无需修改现有配置或客户端协议；下游仍为 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 三种。

---

## 📚 相关文档

- [跨协议转译架构](docs/CROSS_PROTOCOL_ARCHITECTURE.md)
- [v4.0.0 跨协议转译复评与修复清单](docs/CROSS_PROTOCOL_EVALUATION_V4.md)
- [变更日志](CHANGELOG.md)
