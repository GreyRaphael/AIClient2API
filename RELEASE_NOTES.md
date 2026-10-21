# AIClient-2-API 发布说明 (v4.1.1)

> **v4.1.1** 是 v4.1.0 的补丁版本，无破坏性变更。
>
> 本次发布基于 v4.1.0 最新代码的跨协议转译复评，重点修复 Codex 非流式工具链、Claude 多模态与 usage 统计、OpenAI 流式 usage、Gemini 截断保真等 P0/P1 问题。

---

## 🌟 核心修复

### 1. Codex 非流式工具链（P0）

- 修复 **Codex → OpenAI Chat / Responses 非流式工具调用** 触发 `ReferenceError: requestId is not defined` 的问题。
- 修复 **Codex → OpenAI Responses 非流式 `function_call`** 缺少 `call_id`、item id 形状不合法的问题，恢复 `function_call_output` 回传链路。
- 非流式转换现在会正确还原请求侧缩短过的长工具名。

### 2. Claude 多模态与请求保真（P0/P1）

- 修复 **Claude → Codex URL 图片** 被静默丢弃、最终产生空 `input` 的问题。
- URL document 现在保留可追踪的 URL 文本兜底，并输出告警日志。
- **Claude → Gemini** 补齐 `stop_sequences → generationConfig.stopSequences` 映射。
- **Claude → OpenAI / Responses** 的 `prompt_tokens` / `input_tokens` 计入 `cache_read_input_tokens` 与 `cache_creation_input_tokens`。
- **OpenAI / Responses → Claude** 的 `input_tokens` 扣除 `cached_tokens`，避免与 `cache_read_input_tokens` 重复计数。

### 3. 流式收尾与 usage（P1）

- **Responses → Claude** 在 `response.completed` / `response.incomplete` 时补齐未关闭 text / reasoning / tool 块的 `content_block_stop`，不再依赖上游一定发送 done 事件。
- **Claude / Responses 下游 + OpenAI 上游** 流式场景自动请求 `stream_options.include_usage`。
- Provider 层暂存 finish 帧并与后续 usage-only 帧合并，解决“finish 先于 usage”的时序问题。
- 不识别的兼容上游可通过 `OPENAI_STREAM_INCLUDE_USAGE=off` 关闭该行为。

### 4. 结束原因与截断保真（P1）

- OpenAI `content_filter` → Anthropic 结束原因由 `stop_sequence` 修正为 `refusal`。
- **Gemini → Responses** 非流式保留 `MAX_TOKENS` / 安全类截断状态，输出 `incomplete` 与对应 `incomplete_details`。
- **Gemini → Claude** 非流式保留截断前的部分正文，不再因 `finishReason !== STOP` 整段丢弃。

---

## ✅ 验证

- `npm test -- --runInBand`：**25 suites / 356 tests 全绿**。
- 新增 `tests/cross-protocol-v4-1-0-p0-p1.test.js`，覆盖 Codex 非流式工具、Claude URL 媒体、stop 序列、终止块收尾、缓存 usage、截断状态与 OpenAI finish/usage 分帧合并。
- 现有 golden stream、Emitter、Schema Polyfill、Signature Vault 等测试全部通过。

---

## 📦 升级建议

本次为兼容性补丁，建议所有 v4.1.0 用户升级：

```bash
docker pull greyraphael/aiclient-2-api:latest
# 或固定版本
docker pull greyraphael/aiclient-2-api:4.1.1
```

无需修改现有配置或客户端协议；下游仍为 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 三种。

---

## 📚 相关文档

- [跨协议转译架构](docs/CROSS_PROTOCOL_ARCHITECTURE.md)
- [v4.1.1 跨协议转译复评与整改结果](docs/CROSS_PROTOCOL_EVALUATION_V4_1_1.md)
- [变更日志](CHANGELOG.md)

---

## ⚠️ 已知边界

- Prompt Caching 的 `cache_control` 仍无法完整跨协议保留。
- Responses → Gemini 的 `input_file` 仍退化为 `[File: name]`；Gemini URL 媒体的 `fileData.fileUri` 仍需真实上游验证。
- Responses → OpenAI / Claude 非流式仍不处理 `custom_tool_call`。
- OpenAI → Claude 仍会把 `reasoning_effort` 透传到 Claude 请求体，官方 Anthropic 上游存在兼容性风险。
- Grok 文本模拟链路仍存在思考内容重复；Kiro / Zed / Trae 等 provider 特例继续由各自适配层处理。
