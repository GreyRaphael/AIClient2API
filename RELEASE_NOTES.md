# AIClient-2-API 发布说明 (v4.1.0)

> **v4.1.0** 是跨协议转译质量的收敛版本，无破坏性变更。
>
> 本次发布基于 v4.0.1 的再次复评，重点修复流式工具身份、Claude 目标参数、custom tool、多模态与 incomplete 收尾等长尾问题。

---

## 🌟 核心修复

### 1. 流式工具调用可靠性

- 修复 **Gemini → OpenAI Chat** 跨 chunk 工具索引归零的问题，工具序号改为请求级递增。
- 修复 **Gemini → OpenAI Responses** 跨 chunk 工具调用丢失的问题，改用 `callId` 作为工具身份。
- 修复 **Responses → OpenAI** 流式状态按事件泄漏的问题：按 `requestId` 隔离状态，chunk `id/created` 保持稳定。
- 修复 **Grok → OpenAI Responses** 非流式 `function_call` 缺少 `call_id` 的问题，恢复工具结果回传链路。

### 2. Claude 目标请求与 usage

- **Responses → Claude** 补齐 `temperature` / `top_p`。
- **OpenAI → Claude** 补齐 `stop → stop_sequences`、`metadata.user_id` / `user`。
- 未显式提供的采样参数不再注入默认值，避免改变上游采样行为。
- `max_tokens` 默认值与显式值统一收敛到 Anthropic 64K 输出上限。
- Claude 流式最终 usage 合并 `message_start` 的输入/缓存 token，修复 `prompt_tokens` 归零。

### 3. custom tool 与流式收尾

- **Responses → OpenAI / Claude** 支持 `custom_tool_call_input.delta/done`，custom tool 参数折叠为 `{"input": "..."}`。
- **Codex → OpenAI / Claude** 正确映射 `response.incomplete`，分别输出 `length` / `content_filter` 与 `max_tokens` / `refusal`。
- Claude → Responses 在 `content_block_stop` 时关闭 text 块，修正 `output_item.done` 顺序。
- Codex reasoning done 不再向客户端注入人工换行。

### 4. 多模态保真

- Claude → Responses 的 `input_image.image_url` 统一为字符串。
- URL 图片改为保留 Anthropic 原生 `source.url`，不再降级为文本。
- OpenAI → Claude 的 `file` 映射为 `image` / `document`。
- OpenAI → Responses 的 `file` 映射为 `input_file`。
- Responses → Claude 的 `input_file.file_data` 映射为图片/文档。
- Responses → OpenAI 的 `input_file` 映射为 Chat `file` content part。

### 5. 其他边界修复

- OpenAI → Gemini 仅包含 system 消息时，保留 `system_instruction` 语义，不再降级为 user。
- 共享 MIME / data URL 解析与 `max_tokens` 收敛工具，减少各转换器重复实现。

---

## ✅ 验证

- `npm test -- --runInBand`：**24 suites / 344 tests 全绿**。
- 新增 17 个 v4.1 回归测试，覆盖真实 Responses delta 形状、跨 chunk 工具、custom tool、usage 合并、多模态与 incomplete 收尾。
- 每个 P1 / P2 / P3 提交均在独立 worktree 中通过全量测试。

---

## 📦 升级建议

本次为兼容性版本，建议所有 v4.0.x 用户升级：

```bash
docker pull greyraphael/aiclient-2-api:latest
# 或固定版本
docker pull greyraphael/aiclient-2-api:4.1.0
```

无需修改现有配置或客户端协议；下游仍为 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 三种。

---

## 📚 相关文档

- [跨协议转译架构](docs/CROSS_PROTOCOL_ARCHITECTURE.md)
- [v4.0.1 复评与 v4.1 修复清单](docs/CROSS_PROTOCOL_EVALUATION_V4_1.md)
- [变更日志](CHANGELOG.md)

---

## ⚠️ 已知边界

- Prompt Caching 的 `cache_control` 仍无法完整跨协议保留。
- OpenAI Chat 上游的 `stream_options.include_usage` 注入暂未默认开启，需处理 finish 帧先于 usage 帧的时序。
- Kiro 历史图片裁剪、Zed 请求重写、Trae 参数序列化、Grok 文本模拟等 provider 特例仍按各自适配层处理。
