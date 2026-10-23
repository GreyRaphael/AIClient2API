# 跨协议转译架构与评估

- 状态：当前有效
- 更新：2026-10-23
- 范围：`src/converters/**`、`src/handlers/request-pipeline.js`、`src/providers/**`
- 目标：给出当前跨协议转译架构、模型代际策略、已知限制与详细文档入口

---

## 1. 架构总览

请求进入后由 `request-pipeline` 统一编排，核心链路：

```text
客户端协议
  → request-pipeline（鉴权、模型解析、路由、重试、usage）
  → ConverterFactory.createConverter(fromProtocol → toProtocol)
  → Provider Adapter
  → 上游协议
```

支持的协议前缀（`src/utils/constants.js`）：

| 方向 | 协议 | 前缀 | Converter |
|---|---|---|---|
| 下游（客户端） | OpenAI Chat Completions | `openai` | `OpenAIConverter` |
| 下游（客户端） | OpenAI Responses | `openaiResponses` | `OpenAIResponsesConverter` |
| 下游（客户端） | Anthropic Messages | `claude` | `ClaudeConverter` |
| 上游（Provider） | Gemini | `gemini` | `GeminiConverter` |
| 上游（Provider） | Codex | `codex` | `CodexConverter` |
| 上游（Provider） | Grok | `grok` | `GrokConverter` |

下游只暴露 OpenAI Chat、OpenAI Responses、Anthropic Messages 三种客户端协议；Gemini/Codex/Grok 仅作为上游协议参与请求与响应转换。原生 Gemini 下游端点 `/v1beta/models` 与 `:generateContent` 已移除。

转换器注册入口：`src/converters/register-converters.js`。  
转换器工厂：`src/converters/ConverterFactory.js`。

---

## 2. 模型代际策略

当前项目只保证以下模型家族的新代际：

- OpenAI：GPT-5+
- Anthropic：Claude 4+
- Google：Gemini 3+

对应的思考配置规则：

```text
GPT-5+      → reasoning_effort / reasoning.effort
Claude 4/5  → thinkingBudget / adaptive thinking
Gemini 3+   → thinkingConfig.thinkingLevel（LOW/MEDIUM/HIGH）
```

Gemini 已删除 2.5 的 `thinkingBudget` 双轨，统一使用 `thinkingLevel`。  
具体实现：`src/converters/thinking-budget.js`。

其他模型家族（DeepSeek、GLM、Kimi、Qwen、Doubao、Grok 等）仍由各自 provider 的模型清单与请求适配层处理，不受上述三家代际规则限制。

---

## 3. 流式状态架构

流式转换不再使用全局单例或 Converter 实例上的裸状态，而是按请求隔离：

| 组件 | 作用 |
|---|---|
| `src/converters/stream-session.js` | `StreamSessionStore`，按 key 隔离会话状态，带 TTL 自动回收 |
| `src/converters/anthropic-sse-emitter.js` | Anthropic SSE 事件发射器，多转换器复用 |
| `src/converters/responses-sse-emitter.js` | OpenAI Responses SSE 事件发射器，状态挂载到 `StreamSessionStore` |
| `src/providers/openai/openai-responses-events.js` | Responses 事件生成器，保留为纯生成函数 |

设计目标：

- 每个请求一份状态，避免跨请求污染；
- 异常中断后由 TTL 兜底回收；
- 状态所有权从全局单例收编到 Converter 的 `StreamSessionStore`。

详细设计见 [`docs/CONVERTER_STREAM_DESIGN.md`](./CONVERTER_STREAM_DESIGN.md)。

---

## 4. 转译护栏

| 机制 | 位置 | 作用 |
|---|---|---|
| Schema Polyfill | `src/converters/schema-polyfill.js` | 将复杂 JSON Schema 降级为 Gemini 可接受的纯 Schema（Trae 原生接受序列化 JSON 字符串 Schema，`dialect: 'trae'` 为预留接口），并把约束注入 description |
| Custom Tool Registry | `src/converters/custom-tool-registry.js` | 请求级记录 `type: "custom"` 工具；在 OpenAI/Claude/Gemini 侧降级为 function，响应侧还原为 `custom_tool_call`，Codex 侧原生保留 |
| Signature Vault | `src/converters/signature-vault.js` | 对跨协议 thinking signature 做虚拟签名/剥离，避免上游 400 |
| Usage Normalizer | `src/utils/usage-normalizer.js` | 统一各协议 usage 字段与缓存 token 统计 |
| Retry / Fallback | `src/handlers/request-pipeline.js`、`src/services/service-manager.js` | 空响应重试（含墙钟预算）、终态 finishReason 处理、凭证切换、跨 provider fallback |
| Model Capability | `src/providers/model-capability.js` | 节点/分组模型候选、选择集与路由守卫 |
| Provider Capabilities | `src/providers/provider-capabilities.js` | 统一声明模型级参数兼容性（temperature / 强制 tool_choice / thinking / 非流式 / maxOutputTokens / 多轮工具历史 / 流式思考），支持全局配置、节点配置与上游元数据覆盖 |

---

## 5. 已知硬约束

跨协议转译不可能做到字面意义上的“零损耗”，当前明确接受以下限制：

1. **能力不对称**：不同协议的 thinking、工具调用、多模态、缓存控制字段并非一一对应。
2. **Schema 降级有损**：Gemini 的 Protobuf Schema 解析能力弱于 OpenAI / Claude。`$ref`、`oneOf/anyOf`、`allOf`、`patternProperties`、`additionalProperties`、`not`、`dependentRequired`、`dependentSchemas`、`if/then/else` 等会降级为 description 约束；Trae 原生接收 JSON 字符串化 Schema，不做白名单剥离。
3. **签名隔离与 `vsig1` 虚拟签名**：thinking signature 与上游协议强绑定。网关不把 Anthropic 真实签名透传给 Gemini，也不把 Gemini `thoughtSignature` 原样下发给 Claude，而是通过 `signature-vault.js` 统一铸造无状态 `vsig1.<payload>.<hmac>` 虚拟签名并在入站时剥离，以客户端状态机兼容优先。
4. **CoT 历史回放边界**：Anthropic 历史 `thinking` 块要求真实加密签名，Responses 历史 `reasoning` item 要求 `encrypted_content`，因此跨协议默认跳过无签名的历史思考块并记录 debug 计数；对不校验签名的 Gemini 目标，可通过 `CONVERT_REPLAY_COT_SUMMARY=true` 开启将 Chat `reasoning_content` 与 Responses `reasoning` 摘要回放为 `thought: true` part。
5. **模型可调用性不等于发现结果**：上游 `model_list` 可见不代表当前账号/Plan 一定可调用。
6. **流式事件顺序与流内错误终态**：上游 SSE 是单连接有序流，不承诺对乱序 chunk 做重排；流内 `response.failed`、`event: error`、`data.error`（含 `choices: []` / `candidates: []`）被识别为终态错误，转换器无法表达时返回 502，禁止触发空响应重试或补发 `response.completed` / `message_stop`。非流式 HTTP 200 错误体同样返回 502。
7. **Gemini 输出上限**：`maxOutputTokens` 现在按标准字段透传；上游会遵守上限，但 thinking token 也计入预算，极小 `max_tokens` 可能只产出 thinking。网关把 `MAX_TOKENS` / `SAFETY` 等终态视为合法截断，不再触发空响应重试。
8. **显式缓存标记**：`cache_control` 没有跨协议等价字段，网关仅做计费回填（`cached_tokens → cache_read_input_tokens`）而不保证跨协议缓存断点；默认开启工具稳定排序以对齐上游隐式前缀缓存。
9. **Provider 默认参数注入**：部分 Provider 适配层会注入通道级默认参数（如 Codex 默认注入 `web_search` 工具、`store: false`、`include: ['reasoning.encrypted_content']`、`parallel_tool_calls: true`；`OpenAIConverter → Gemini` 未指定时默认 `temperature=1`、`topP=0.95`、`maxOutputTokens=65534`；Claude↔OpenAI 在 thinking 开启时自动调整 `max_completion_tokens` / `max_tokens`）。
10. **Zed Google 多轮工具历史**：Zed Google 通道不支持 `functionCall` / `functionResponse` 历史；网关通过 `supportsToolResultHistory=false` 将历史工具调用/结果降级为文本，保留上下文并返回 200。
11. **Gemini 流式思考**：`streamGenerateContent` 不返回 thought 文本；当请求需要 thinking 时，网关默认回退到非流式 `generateContent` 并在本地合成 chunk（`GEMINI_STREAM_THOUGHTS_FALLBACK`，默认开启），以 reasoning 完整性优先于逐字流式。
12. **system/developer-only Responses 请求**：转换为 Gemini 时若没有 user/assistant turn，`contents` 必然为空；网关本地返回 400，不再把必然被上游拒绝的请求发出去。

---

## 6. 详细文档入口

| 文档 | 内容 |
|---|---|
| [`docs/PROVIDER_ADAPTER_GUIDE.md`](./PROVIDER_ADAPTER_GUIDE.md) | 新增 provider 的接入契约 |
| [`docs/CONVERTER_STREAM_DESIGN.md`](./CONVERTER_STREAM_DESIGN.md) | 流式共享层设计 |
| [`docs/CROSS_PROTOCOL_REVIEW_19MODELS_2026-10-23.md`](./CROSS_PROTOCOL_REVIEW_19MODELS_2026-10-23.md) | 2026-10-23 当前代码（`c031a55`）19 模型全量 E2E、残留问题收口与核心转译 review（当前） |
| [`docs/TRAE_CHANNELS_UPSTREAM_GUIDE.md`](./TRAE_CHANNELS_UPSTREAM_GUIDE.md) | Trae 三通道上游细节 |
| [`docs/ANTIGRAVITY_NOTES.md`](./ANTIGRAVITY_NOTES.md) | Antigravity 模型发现与思考机制 |

---

## 7. 维护约定

- 本文档是跨协议架构的当前入口；架构变化时优先更新本文。
- 历史评估/优化文档不再保留在仓库；需要追溯时查看 git 历史。
- 当前评估矩阵见 [`docs/CROSS_PROTOCOL_REVIEW_19MODELS_2026-10-23.md`](./CROSS_PROTOCOL_REVIEW_19MODELS_2026-10-23.md)，历史矩阵不再作为当前实现说明。
- 新增模型代际策略时，同步更新第 2 节与 `thinking-budget.js` 的测试。
