# AIClient-2-API 发布说明 (v4.1.4)

> **v4.1.4** 是跨协议转译的稳定性与保真度版本，无破坏性协议变更。
>
> 本版本基于 13 个真实模型的跨协议 E2E（Chat / Responses / Claude × OpenAI / Responses / Gemini / Codex / Zed / Trae）重新评估转译质量，重点修复思考链（CoT）、输出上限、工具历史、Schema 保真、强制 `tool_choice` 与错误可观测性。

---

## 🌟 核心修复

### 1. Gemini 流式思考与输出上限

- **流式 thinking 不再丢失**：Antigravity 的 `streamGenerateContent` 不返回 thought 文本；当请求需要 thinking 时，网关自动回退非流式 `generateContent` 并合成 chunk，保证 reasoning 完整。
- **`maxOutputTokens` 标准透传**：取消非 Claude 模型的静默删除。实测上游会遵守上限；`max_tokens=8` 约 5 秒返回 `length`，不再触发 5 次空响应长重试。
- **终态 finishReason 处理**：`MAX_TOKENS` / `SAFETY` / `RECITATION` / `BLOCKLIST` 等终态即使没有正文也按合法截断/安全结果返回，不再误判为空响应。

### 2. CoT / Reasoning 口径修正

- GPT/Claude 上游的 CoT 受 prompt、effort 与 provider 策略影响；本版本把“是否生成 CoT”从失败门槛中拆出，改为诊断项。
- 当上游返回 reasoning 文本但缺少 `reasoning_tokens` 时，网关做保守估算并标记 `reasoning_tokens_estimated: true`，避免 usage 显示为 0。
- 新增 CoT-present 的 Chat / Claude 多轮工具回放覆盖，验证 `reasoning_content` / `thinking` + `tool_use` + `tool_result` 的完整链路。

### 3. Zed Provider 保真与契约

- **多轮工具 `is_error`**：Zed Anthropic 通道要求 `tool_result` 必带 `is_error`；网关在 provider 边界统一补齐，修复多轮工具 400/500。
- **effort 二次量化**：`reasoning_effort: high` 不再被反解为 `max`，按 canonical 表映射为 `high`。
- **OpenAI 通道图片**：Zed OpenAI 分支补齐 `input_image` 映射，`zed:gpt-6-luna` 可正确识别图片。
- **Google 多轮工具历史**：Zed Google 通道不支持 `functionCall/functionResponse` 历史；网关将历史工具调用/结果降级为文本，保留上下文并返回 200。
- **Google Schema Polyfill**：Zed Google 分支接入共享 Schema Polyfill，并保留 function call/response id。

### 4. 工具调用与 Schema

- **openai-custom 强制 `tool_choice`**：指定 function 的请求从“空 200 + 5 分钟长重试”降至约 **1.3 秒**返回工具调用。
- **空响应重试预算**：新增 `EMPTY_RESPONSE_MAX_TOTAL_MS`（默认 120 秒），避免上游静默空响应导致客户端长时间挂起。
- **oneOf/anyOf 保真**：对象分支合并 `properties` / `required` / 同名枚举，避免坍缩后生成 `shipping.type` 这类错误字段名。
- **工具前缀对齐**：`CONVERT_SORT_TOOLS` 默认开启，稳定工具顺序以提升上游隐式前缀缓存命中。
- **Codex 输出上限**：`max_output_tokens` 默认透传，不再无条件删除；上游若忽略则属于上游能力边界。

### 5. 错误与可观测性

- 4xx 错误响应现在会追加可读的上游错误信息（如 `missing field is_error`、Pydantic 校验详情），5xx 仍不泄露内部 body。
- Responses→Gemini、Chat→Responses 的 reasoning 丢弃点补充 debug 日志。
- Provider 能力声明新增：
  - `supportsToolResultHistory`
  - `supportsStreamingThoughts`

---

## ✅ 验证

- `npm test -- --runInBand`：**33 suites / 447 tests 全绿**。
- `npm run test:e2e`（真实上游、13 个模型）：**24 / 24 PASS**。
  - 13 模型 × 11 项核心用例全部通过；
  - 定向用例覆盖强制 `tool_choice`、图片、Gemini 流式 thinking 回退、`max_tokens` 截断、多步 prompt CoT 采样、三协议 reasoning 一致性、CoT 多轮工具、oneOf 字段名、4xx 错误细节。
- 确定性核心指标：
  - 文本内容 **78 / 78**
  - 流式生命周期 **39 / 39**
  - 单轮工具 **39 / 39**
  - Chat 多轮工具 **13 / 13**

---

## 📦 升级建议

```bash
docker pull greyraphael/aiclient-2-api:latest
# 或固定版本
docker pull greyraphael/aiclient-2-api:4.1.4
```

无需修改客户端协议；下游仍为 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages。

---

## ⚠️ 行为变化

- **Gemini 流式 thinking**：需要 thinking 时，网关可能回退非流式以保留完整 reasoning，流式粒度会降低；可通过 `GEMINI_STREAM_THOUGHTS_FALLBACK=off` 关闭。
- **工具排序**：默认开启稳定排序；如需保持客户端原始工具顺序，可设置 `CONVERT_SORT_TOOLS=off`。
- **Zed Google 多轮工具历史**：结构化 `functionCall/functionResponse` 历史会降级为文本表示。
- **Codex `max_output_tokens`**：网关不再删除该字段；上游可能忽略，客户端应使用超时/取消兜底。
- **reasoning_tokens**：当上游缺失时可能为估算值，并带 `reasoning_tokens_estimated: true`。

---

## 📚 相关文档

- [跨协议转译架构](docs/CROSS_PROTOCOL_ARCHITECTURE.md)
- [跨协议转译复评（v4.1.4）](docs/CROSS_PROTOCOL_EVALUATION_V4_1_4.md)
- [Provider 接入指南](docs/PROVIDER_ADAPTER_GUIDE.md)
- [变更日志](CHANGELOG.md)

---

## 🔭 已知边界

- `zed:claude-haiku-5-5` / `zed:gemini-3.8-flash` 不暴露 thinking block，只把推理写在正文；网关不能凭空拆出 thinking。
- 显式 `cache_control` 仍无跨协议等价字段，只能依赖隐式前缀缓存。
- Gemini 极小 `max_tokens` 可能只产出 thinking；现在会作为 `length` 正常返回。
- 真实 Claude 原生签名的多轮回放仍缺真实 E2E 样本；当前已有原生签名保留单测与 vsig1 虚拟签名验证。
- `oneOf` 合并能保留字段名，但复杂联合类型仍可能被模型简化。
