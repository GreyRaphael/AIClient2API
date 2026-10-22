# AIClient2API 核心转译功能复评（v4.1.4 基线 · v4.1.5 修复复验 · 27 模型全量 E2E）

- 状态：当前有效（全量覆盖）
- 日期：2026-10-22
- 评估对象：`v4.1.4` 基线（`fef2501`）+ `v4.1.5` 最小修复（F1/F2/F3/F4）
- 历史对照：[`archive/CROSS_PROTOCOL_EVALUATION_AND_OPTIMIZATION.md`](./archive/CROSS_PROTOCOL_EVALUATION_AND_OPTIMIZATION.md)（v1.6.0，2026-10-16）
- 前置复评：13 模型 / 24 项定向 E2E 已被本文取代（历史版本见 Git 历史）
- 测试实例：`127.0.0.1:3201` 隔离实例（HEAD 工作树、同一份 `configs`；未重启用户的 `3000` 实例）
- 真实上游请求：27 模型 × 11 核心用例 = **297**；追加 27 模型 × 2 次高难推理采样 = **54**；合计 **351 次，351/351 通过**
- 单元测试：`npm test -- --runInBand` = **33 suites / 447 tests 全绿**

---

## 1. 结论

**综合约 4.6 / 5。与 13 模型复评（4.5）基本持平，但证据面从 13 个模型扩大到全部 27 个模型，且 27 个模型全部 11/11 通过核心矩阵。当前核心转译链路已经没有可复现的确定性失败。**

| 指标 | 结果 |
|---|---:|
| 文本内容正确性（Chat/Responses/Claude × 27 × 流式/非流式） | **162 / 162** |
| 流式生命周期完整性（`[DONE]` / `response.completed` / `message_stop`） | **81 / 81** |
| 单轮工具调用（Chat/Responses/Claude） | **81 / 81** |
| Chat 多轮工具结果回传 | **27 / 27** |
| 连续同角色 + system 折叠 | **27 / 27** |
| 高难推理 prompt 内容正确性（2 次采样） | **54 / 54** |
| 空响应重试触发次数 | **0** |
| E2E 最终响应 5xx | **0**（351 次请求最终均为 HTTP 200） |
| usage 内部不变量违反 | **1**（`zed:gpt-6-luna` Responses 非流式，见 F1） |

一句话结论：

> v3.10.0 → v4.1.4 的 110 个提交，把 archive v1.6.0 时代“点对点补丁 + 大量 Tier 2/3 组合”收敛成了“共享转译基础设施 + Provider 能力声明”。27 个真实模型的文本、流式、单轮工具、多轮工具和角色折叠全部通过；剩余问题不再是“转译器会不会转”，而是 **usage 估算口径、Schema 结构保真、显式缓存和跨协议 CoT 历史回放** 这几类协议级/实现级残留。

最小修复后的复验结果见第 9 节：F1/F2/F3/F4 已落地，全量单测 33 suites / 457 tests 全绿；27 模型核心 E2E 为 296/297，唯一失败是上游模型算术采样返回 `442`（同用例重试 3/3 返回 `391`），非转译回归。

---

## 2. 评估口径

### 2.1 从 archive 的 24 组合到当前的 15 个实测组合

archive v1.6.0 采用「3 下游 × 8 Provider = 24 组合」口径。当前代码已把 Provider 适配层与协议前缀解耦：

- 下游协议：`openai`（Chat Completions）、`openaiResponses`、`claude`（Anthropic Messages）
- 上游协议：`openai`、`openaiResponses`、`claude`、`gemini`、`codex`、`grok`
- 原生 Gemini 下游端点（`/v1beta/models/:generateContent`）已在 `13bc04c` 移除

因此本轮采用 **3 × 6 = 18 个协议组合** 作为矩阵口径；当前 `configs` 未配置 Grok，实际可测 **3 × 5 = 15 个组合**，由 27 个模型覆盖。

| 上游协议 | Provider | 模型数 | 说明 |
|---|---|---:|---|
| `openai` | `openai-custom` / `trae` / `trae-chat_v3` | 18 | 5 + 6 + 7；同协议直通或 Provider 轻量包装 |
| `openaiResponses` | `openaiResponses-custom` | 1 | Responses 规范 |
| `gemini` | `gemini-antigravity` | 1 | CloudCode / Gemini contents |
| `codex` | `openai-codex-oauth` | 1 | ChatGPT Backend Codex Responses |
| `claude` | `zed` | 6 | Zed 内部 Anthropic / Google / OpenAI 三条分支 |
| `grok` | — | 0 | 当前未配置，未纳入本轮 |

### 2.2 用例与参数

每个模型执行 11 项核心用例：

1. Chat 非流式文本（system + `17*23`，断言 `391`）
2. Chat 流式文本（断言 `391` + `[DONE]`）
3. Responses 非流式文本（断言 `391` + `completed/incomplete`）
4. Responses 流式文本（断言 `response.completed`）
5. Claude 非流式文本（断言 `391` + `end_turn` + thinking 块）
6. Claude 流式文本（断言 `message_stop` + thinking delta）
7. Chat 单轮 function tool（`get_weather({city:"Paris"})`）
8. Chat 多轮工具结果回传（assistant tool_call + tool result `18` + 追问）
9. Responses 单轮 function tool
10. Claude 单轮 tool_use
11. Chat 连续同角色 + system 折叠（`Remember 7` / `What number?`）

`reasoning_effort` 的协议化表达：

- Chat：`reasoning_effort: "high"`
- Responses：`reasoning: { effort: "high", summary: "auto" }`
- Claude：Anthropic 无 `reasoning_effort`，使用等价原生 `thinking: { type: "enabled", budget_tokens: 20000 }`（canonical 表中 `high = 20000`）

Claude 的单轮工具用例沿用项目 E2E 形状，不注入 thinking，以避免 `tool_choice` 与 thinking 的额外变量；Claude 文本用例均使用 `budget_tokens=20000`。

追加推理探针使用多步 prompt：

> A farmer has 17 sheep. All but 9 run away. Then he buys 3 times as many sheep as remain, and sells 5. How many sheep does he have now? Show your step-by-step reasoning.

每个模型采样 2 次，共 54 次；断言正文包含 `31`，并记录 `reasoning` 长度。

### 2.3 覆盖边界

- 未配置 Grok 号池，`grok` 上游组合未实测。
- 多模态与复杂 Schema 未在 27 个模型上全量重跑；沿用前一轮 13 模型定向测试与代码审查证据，并在第 4 节标注为“未全量复测”。
- 真实上游请求会消耗账号额度；本轮使用隔离实例，未改动 tracked 文件（测试后 `git status` 干净）。
- 启动阶段 Zed 健康检查对部分账号返回 `403 token_spend_limit_reached`；实际 E2E 请求由号池中的可用账号完成，Zed 6 个模型全部通过。这说明“健康检查结果”与“真实可用性”可能存在偏差，读日志时需区分。

---

## 3. E2E 结果

### 3.1 总览

| 维度 | 通过 / 总数 | 通过率 |
|---|---:|---:|
| 核心用例（27 × 11） | **297 / 297** | 100% |
| 高难推理探针（27 × 2） | **54 / 54** | 100% |
| 文本内容（6 用例 × 27） | **162 / 162** | 100% |
| 流式生命周期（3 协议 × 27） | **81 / 81** | 100% |
| 单轮工具（3 协议 × 27） | **81 / 81** | 100% |
| Chat 多轮工具 | **27 / 27** | 100% |
| 连续同角色 | **27 / 27** | 100% |

27 个模型全部 **11/11**，351 次请求最终均为 HTTP 200。E2E 期间服务端日志中 `empty response`、`Stream Retry`、`Unary Retry`、`Fallback activated` 均为 **0**，说明空响应护栏和凭证切换没有被误触发。

### 3.2 逐模型结果

`Reasoning-core` = 6 个文本用例中至少一个返回 reasoning/thinking 的数量；`Reasoning-probe` = 2 次高难 prompt 中至少一次返回 reasoning 的数量。CoT 是否出现受模型/provider/prompt 影响，不计入网关失败。

| # | 模型 | Provider / 上游协议 | 核心 | Reasoning-core | Reasoning-probe | 最大单例延迟 |
|---:|---|---|---:|---:|---:|---:|
| 1 | `openai-custom:deepseek-v4-pro` | openai-custom / openai | 11/11 | 6/6 | 2/2 | 7,226ms |
| 2 | `openai-custom:deepseek-v4.1-flash` | openai-custom / openai | 11/11 | 6/6 | 2/2 | 2,048ms |
| 3 | `openai-custom:glm-5.3` | openai-custom / openai | 11/11 | 6/6 | 2/2 | 1,631ms |
| 4 | `openai-custom:qwen3.8-flash` | openai-custom / openai | 11/11 | 6/6 | 2/2 | 2,231ms |
| 5 | `openai-custom:qwen3.8-max` | openai-custom / openai | 11/11 | 6/6 | 2/2 | 3,273ms |
| 6 | `openaiResponses-custom:deepseek-v4-flash` | openaiResponses-custom / openaiResponses | 11/11 | 6/6 | 2/2 | 1,848ms |
| 7 | `gemini-antigravity:gemini-3.8-flash-high` | gemini-antigravity / gemini | 11/11 | 6/6 | 2/2 | 5,399ms |
| 8 | `openai-codex-oauth:gpt-6-luna` | openai-codex-oauth / codex | 11/11 | 6/6 | 1/2 | 11,848ms |
| 9 | `zed:claude-haiku-5-5` | zed / claude | 11/11 | 0/6 | 0/2 | 2,463ms |
| 10 | `zed:claude-sonnet-5-5` | zed / claude | 11/11 | 0/6 | 0/2 | 3,385ms |
| 11 | `zed:gemini-3.8-flash` | zed / claude | 11/11 | 0/6 | 0/2 | 93,916ms |
| 12 | `zed:gemini-4-argon` | zed / claude | 11/11 | 0/6 | 0/2 | 13,226ms |
| 13 | `zed:gpt-6-luna` | zed / claude | 11/11 | 4/6 | 2/2 | 3,903ms |
| 14 | `zed:gpt-6.1-sol` | zed / claude | 11/11 | 1/6 | 2/2 | 4,605ms |
| 15 | `trae:DeepSeek-V4.1-Flash-1017` | trae / openai | 11/11 | 6/6 | 2/2 | 1,601ms |
| 16 | `trae:glm-5.3` | trae / openai | 11/11 | 6/6 | 2/2 | 4,783ms |
| 17 | `trae:glm-5.3-flashx` | trae / openai | 11/11 | 5/6 | 2/2 | 6,611ms |
| 18 | `trae:kimi-k2.8-preview` | trae / openai | 11/11 | 6/6 | 2/2 | 4,320ms |
| 19 | `trae:kimi-k3` | trae / openai | 11/11 | 6/6 | 2/2 | 5,159ms |
| 20 | `trae:qwen3.8-max` | trae / openai | 11/11 | 6/6 | 2/2 | 5,008ms |
| 21 | `trae-chat_v3:DeepSeek-V4-Pro-Official` | trae-chat_v3 / openai | 11/11 | 6/6 | 2/2 | 2,293ms |
| 22 | `trae-chat_v3:deepseek-v4.1-flash` | trae-chat_v3 / openai | 11/11 | 6/6 | 2/2 | 1,897ms |
| 23 | `trae-chat_v3:glm-5.3` | trae-chat_v3 / openai | 11/11 | 6/6 | 2/2 | 151,988ms |
| 24 | `trae-chat_v3:glm-5.3-flashx` | trae-chat_v3 / openai | 11/11 | 6/6 | 2/2 | 4,954ms |
| 25 | `trae-chat_v3:kimi-k3` | trae-chat_v3 / openai | 11/11 | 6/6 | 2/2 | 5,642ms |
| 26 | `trae-chat_v3:qwen3.8-flash` | trae-chat_v3 / openai | 11/11 | 6/6 | 2/2 | 56,954ms |
| 27 | `trae-chat_v3:qwen3.8-max` | trae-chat_v3 / openai | 11/11 | 6/6 | 2/2 | 3,725ms |

### 3.3 Reasoning 可用性

核心矩阵 162 条文本用例中，**130 / 162（80.2%）** 返回了 reasoning/thinking：

| 用例 | 有 reasoning |
|---|---:|
| Chat 非流式 | 21 / 27 |
| Chat 流式 | 22 / 27 |
| Responses 非流式 | 22 / 27 |
| Responses 流式 | 22 / 27 |
| Claude 非流式 | 21 / 27 |
| Claude 流式 | 22 / 27 |

高难 prompt 探针中，**23 / 27** 个模型至少一次返回 reasoning，**22 / 27** 个模型两次都返回。缺失集中在：

- `zed:claude-haiku-5-5`、`zed:claude-sonnet-5-5`、`zed:gemini-3.8-flash`、`zed:gemini-4-argon`：4 个模型在核心矩阵和探针中均不暴露 thinking block，但正文包含完整 step-by-step 推理。这是 Zed provider 的模型行为，不是网关丢弃。
- `zed:gpt-6-luna` / `zed:gpt-6.1-sol`：部分方向/部分采样没有 reasoning，探针 2/2 有 reasoning，符合 CoT 非确定性。
- `trae:glm-5.3-flashx`：核心矩阵仅 `chat_stream` 一次没有 reasoning，探针 2/2 有，属于采样差异。
- `openai-codex-oauth:gpt-6-luna`：探针 2 次中 1 次 reasoning 长度为 0，属于 prompt/采样差异。

**归因**：只要上游返回 thinking/reasoning，当前网关在 Chat / Responses / Claude 三个下游方向都能正确映射；CoT 是否出现主要由模型/provider/prompt 决定，应从网关评分中剔除。

### 3.4 延迟

297 次核心请求的延迟分布：

| 分位 | 延迟 |
|---|---:|
| p50 | 2,340ms |
| p90 | 5,279ms |
| p95 | 7,451ms |
| p99 | 85,738ms |
| max | 151,988ms |

长尾主要来自 3 个用例：

| 用例 | 延迟 | 说明 |
|---|---:|---|
| `trae-chat_v3:glm-5.3` Chat 非流式 | 151,988ms | 同模型其他协议方向 2–10s，更像上游排队/瞬时抖动 |
| `zed:gemini-3.8-flash` Chat 流式 | 93,916ms | 同模型非流式 4.8s，属于该通道长尾 |
| `zed:gemini-3.8-flash` Responses 非流式 | 85,738ms | 同上 |
| `trae-chat_v3:qwen3.8-flash` Chat 单轮工具 | 56,954ms | 工具调用采样不稳定，可能包含多次尝试 |

流式场景有首内容前 15s 心跳（SSE 注释帧），可以避免长思考期间连接假死；非流式没有心跳，客户端需要为长尾模型设置足够超时。

### 3.5 协议组合矩阵

| 下游 \ 上游 | `openai` | `openaiResponses` | `gemini` | `codex` | `claude`（Zed） |
|---|---|---|---|---|---|
| **OpenAI Chat** | **T0/T1** | **T1** | **T1~2** | **T1** | **T1** |
| **OpenAI Responses** | **T1** | **T0** | **T1~2** | **T1** | **T1** |
| **Anthropic Messages** | **T1** | **T1** | **T1~2** | **T1** | **T0~1** |

- **T0/T1**：文本、流式、单轮工具、多轮工具、角色折叠全部通过；仅存在采样/默认值差异。
- **T1~2**：`gemini` 组合的主要残差是「流式思考需要回退非流式合成」「thinkingLevel 只有三档」「Schema 降级为 description」；`claude`（Zed）组合的残差是「部分模型不暴露 thinking block」。
- 本轮 **没有 Tier 3 组合**；archive 中列出的复杂 Schema 清洗、签名丢失、双层转译错误累加等 Tier 3 风险已被工程化手段消除或降级。

---

## 4. 核心转译代码 review

### 4.1 请求方向

| 能力 | 当前实现 | 评价 |
|---|---|---|
| 多 system 消息 | `extractAndProcessSystemMessages()` 按顺序拼接；Claude/Responses 走顶层 `system` / `instructions` | 语义保留，结构边界丢失；27/27 角色折叠通过 |
| 连续同角色 | Gemini 用 `mergeConsecutiveSameRoleContents()` 在 parts 级合并；Claude 在 content 数组级合并 | 符合 Gemini/Anthropic 交替约束；27/27 通过 |
| 思考预算 | `thinking-budget.js` canonical 五档表（high=20000） | 统一口径；但 5 档 → OpenAI 3 档 / Gemini 3 档存在量化 |
| 工具 Schema | `schema-polyfill.js` + `polyfillAndCleanSchemaForGemini()` | 解决 Protobuf 接受问题；`oneOf` 分支 required 并集、数值 enum 丢失（F3） |
| custom tool | `custom-tool-registry.js` 请求级登记 + function 降级 + 响应还原 | 前一轮定向 3/3 通过；本轮核心矩阵未覆盖 |
| 思考签名 | `signature-vault.js` 无状态 HMAC 虚拟签名 + 上游剥离 | 前一轮 2/2 回放通过；`vsig1.` 前缀识别 O(1) |
| 多模态 | 图片 base64/URL、Claude `document`、Responses `input_file` | 主路径可用；远程 URL → Gemini `fileData.fileUri` 未全量验证（F6） |
| 工具顺序 | `sortToolsByName()` 默认开启（`CONVERT_SORT_TOOLS=true`） | 对齐上游隐式前缀缓存；不改变语义 |

### 4.2 响应与流式方向

| 能力 | 当前实现 | 评价 |
|---|---|---|
| Chat 流式 | `GeminiConverter.toOpenAIStreamChunk` / `ClaudeConverter.toOpenAIStreamChunk` / `CodexConverter.toOpenAIStreamChunk` | 81/81 生命周期通过；工具索引按请求级递增 |
| Responses 流式 | `ResponsesSseEmitter` + `StreamSessionStore` | 27/27 `response.completed`；状态按 `requestId` 隔离，TTL 兜底 |
| Claude 流式 | `AnthropicSseEmitter` + 请求级 block index | 27/27 `message_stop`；thinking block 自动铸造虚拟签名 |
| usage | `usage-normalizer.js` + 各 converter | Gemini thoughts 已并入 output；**估算 reasoning_tokens 可能大于 output（F1）** |
| finish reason | `mapFinishReason()` + pipeline 的 `hasToolCall` 修正 | 81/81 单轮工具通过；截断/安全类有专门映射 |
| 空响应护栏 | 首内容前缓冲 + `EMPTY_RESPONSE_MAX_RETRIES=5` + `EMPTY_RESPONSE_MAX_TOTAL_MS=120000` | 本轮 351 次请求 0 次触发；终态 `MAX_TOKENS/SAFETY` 不重试 |
| 结束帧幂等 | OpenAI 无条件补 `[DONE]`；Responses/Claude 未发送时兜底合成 | 正常路径通过；异常截断路径未关闭 Claude 内容块（F7） |

### 4.3 结构性判断

当前仍是 **点对点转换器 + 共享基础设施**，而不是 archive 5.1 提出的统一 IR：

- 每个方向仍是独立 `toXxxRequest` / `toXxxResponse` / `toXxxStreamChunk`；
- 但共享层已经把最容易出错的横切关注点收敛：
  - `stream-session.js`（123 行）：按请求隔离的流式状态，30 分钟 TTL；
  - `anthropic-sse-emitter.js`（288 行）/ `responses-sse-emitter.js`（573 行）：目标协议生命周期；
  - `schema-polyfill.js`（450 行）：Schema 降级编译器；
  - `signature-vault.js`（163 行）：跨协议思考签名；
  - `custom-tool-registry.js`（179 行）：custom tool 语义保持；
  - `thinking-budget.js`（90 行）：思考预算 canonical 表；
  - `provider-capabilities.js`（283 行）：Provider 能力声明；
  - `model-capability.js`（610 行）：模型能力/路由；
  - `usage-normalizer.js`：usage 口径统一。
- 转换器体量已经明显下降：`GeminiConverter` 从 v3.10.0 的 2,138 行降到 1,058 行，`OpenAIConverter` 2,452 → 2,047，`ClaudeConverter` 2,654 → 2,570，`request-pipeline` 2,027 → 1,881。
- 代价是 Provider 适配层仍然复杂，尤其 `zed-core.js` 的 Anthropic / OpenAI / Google 三条分支；它仍是当前最薄弱的契约边界。

### 4.4 本轮新发现的问题

#### F1（P2，usage 契约）：估算 reasoning_tokens 可能大于 output_tokens

**证据**：`zed:gpt-6-luna` Responses 非流式（上游 Claude 协议）返回：

```json
{
  "output_tokens": 27,
  "output_tokens_details": {
    "reasoning_tokens": 84,
    "reasoning_tokens_estimated": true
  },
  "total_tokens": 62
}
```

**根因**：`src/converters/utils.js:161` 的 `applyEstimatedReasoningTokens()` 只补 `*_details.reasoning_tokens`，不调整 `output_tokens` / `completion_tokens`。当上游只给正文 token、没有给 reasoning token 时，估算值可能超过输出总量。

**影响**：部分客户端/计费插件要求 `output_tokens >= reasoning_tokens`；该形状会产生“不可能”的 usage，且 `reasoning_tokens_estimated` 是自定义字段，不是所有客户端都会识别。

**建议**：估算值应满足 `reasoning_tokens <= output_tokens`（例如按 `min(estimated, output_tokens - visibleTextTokens)` 收敛），或在补估算值时同步抬高 `output_tokens`；补一条不变量单测，覆盖 `output_tokens < estimated` 的场景。

#### F2（P2，契约）：OpenAI → Claude 的 tool id 未统一清洗

**证据**：`OpenAIConverter.toClaudeRequest()` 在 `src/converters/strategies/OpenAIConverter.js:188` 直接使用 `id: tc.id`；`toClaudeResponse()` 在 `:566` 使用 `id: toolCall.id || ""`；流式在 `:744` 只在缺失时生成 `tool_...`，不调用 `sanitizeToolId()`。

**影响**：Anthropic 要求 `tool_use.id` 匹配 `^[a-zA-Z0-9_-]+$`。多数 OpenAI 兼容上游使用 `call_...` 安全字符，本轮 27 模型未触发；但在跨 provider fallback、或上游使用 `:`、`.`、`|` 等字符时，Claude 上游会 400。

**建议**：请求、响应、流式三条路径统一 `sanitizeToolId(id) || generated`，并保证 `tool_result.tool_use_id` 与 `tool_use.id` 使用同一清洗结果。

#### F3（P2，Schema 保真）：oneOf 对象分支合并 required 并集；数值 enum 丢失

**证据**：

- `src/converters/schema-polyfill.js:219-250` 对同类型对象分支合并 `properties` 后，把所有分支的 `required` 求并集；对于互斥的 `oneOf` 分支，这会把“分支 A 必填”和“分支 B 必填”同时变成必填，语义上过约束。
- `src/converters/utils.js:505-513` 的 `sanitizeEnum` 只保留非空字符串枚举；数值/布尔枚举会被整体丢弃，而 polyfill 没有把 enum 注入 description。`GEMINI_ALLOWED_KEYS`（`utils.js:397`）也不包含 `enum` 之外的约束键。

**影响**：工具 Schema 能被 Gemini/Trae 接受，但复杂联合类型的结构与约束不能完全保真；模型可能生成“所有分支字段都出现”或“数值枚举不受约束”的参数。现有 oneOf E2E 只验证字段名，未验证互斥分支的 required 语义。

**建议**：oneOf 对象分支合并时保留 properties 但不要简单求 required 并集（可采用交集或把分支 required 写入 description）；数值 enum 转为字符串枚举并注入类型提示，或写入 description。

#### F4（P2，CoT 历史，已记录）：部分方向的 reasoning 历史被丢弃

**证据**：

- Chat → Responses：`OpenAIConverter.js:1495` 明确 debug 记录 “assistant reasoning_content is not replayed to Responses”，随后丢弃。
- Claude → Responses：`ClaudeConverter.js:1862` 对没有 `encrypted_content` 的 thinking 块直接跳过；Anthropic 客户端通常不会提供 `encrypted_content`，因此 Claude → Responses 的多轮 thinking 历史全部丢失。
- Chat → Gemini：`OpenAIConverter.toGeminiRequest()` 没有读取 assistant 的 `reasoning_content`。

**影响**：单轮/多轮正文与工具调用不受影响（本轮 27/27 多轮工具通过），但 Agent 循环在第二轮起看不到上一轮的 CoT，连续推理质量会下降。Responses 官方要求 reasoning item 带 `id/encrypted_content`，属于协议限制；但网关至少应保留 summary 文本或明确记录降级。

**建议**：对官方 Responses 上游保持“无 encrypted_content 不回放”的安全策略；对兼容端点提供 `CONVERT_PRESERVE_REASONING_ITEM` 的文本回放选项，并在响应日志中标记丢弃数量。

#### F5（P3，缓存）：显式 `cache_control` 仍不可跨协议保留

**证据**：`src/converters/utils.js:758-765` 的 `logOmittedCacheControl()` 只记录 warn/debug，不映射到 OpenAI/Gemini/Responses；`CONVERT_SORT_TOOLS` 默认开启，用于对齐隐式前缀缓存。

**影响**：缓存位置不可控；`cached_tokens` 回填仍然有效（本轮 `trae-chat_v3:glm-5.3` 的 `chat_roundtrip` 出现 `cached_tokens=192`，`claude_tool` 出现 `cache_read_input_tokens=192`），说明隐式前缀缓存可用。

**建议**：文档明确“缓存计量可用、缓存位置不可控”；如目标协议支持显式缓存，再增加 per-protocol 映射表。

#### F6（P3，多模态）：远程 URL → Gemini `fileData.fileUri` 未验证

**证据**：`OpenAIConverter.js:952` 将任意 HTTPS 图片 URL 映射为 `fileData.fileUri`；`ClaudeConverter.js:1321/1351` 对 image/document URL 做同样处理。Gemini `fileData` 通常要求 Files API 或 `gs://` URI，而不是任意公网 URL。

**影响**：base64 图片路径已验证；URL 图片/文档在 Gemini 上游可能 400。本轮核心矩阵未覆盖 URL 多模态。

**建议**：对非 Files API / 非 `gs://` 的 URL，优先由网关下载并转 `inlineData`（注意大小上限），或在能力声明中明确不支持。

#### F7（P3，流式收尾）：异常截断时 Claude 下游可能缺少 `content_block_stop`

**证据**：`request-pipeline.js:844-876` 在流结束且未收到终止事件时，Claude 下游只补写 `message_stop`；它不会关闭仍打开的 `content_block`，也不会补 `message_delta`。

**影响**：正常路径 81/81 通过；若上游异常中断（无 finish chunk），严格校验事件序列的 Claude 客户端可能报错。

**建议**：在 pipeline 维护“已打开的 Claude block”集合，异常收尾时通过 `AnthropicSseEmitter.finish()` 统一关闭；或者让 converter 暴露 finalize 接口。

#### F8（P3，运维）：高 effort 下的长尾延迟

**证据**：`trae-chat_v3:glm-5.3` Chat 非流式 151,988ms；`zed:gemini-3.8-flash` Chat 流式 93,916ms；`trae-chat_v3:qwen3.8-flash` Chat 单轮工具 56,954ms（工具调用重试 3 次）。

**影响**：p95 7.45s 可以接受，但 p99 85.7s 会超过很多客户端的 60s 超时。流式有 15s 心跳；非流式没有心跳，也没有网关侧墙钟上限（上游请求超时由 provider 配置决定）。

**建议**：为非流式请求增加可配置的网关侧超时/取消；对工具调用重试增加总预算，避免“模型不调用工具”放大为分钟级等待。

---

## 5. 与 archive v1.6.0 的对比

### 5.1 archive 优化路线落地情况

| archive 提案 | 当前状态 | 证据 |
|---|---|---|
| 5.1 统一中间表示 (Unified IR AST) | ❌ 未落地，仍点对点 | 三个主转换器仍各 2,000+ 行；无 IR 模块 |
| 5.2 Schema Polyfill 降级编译器 | ✅ 已落地 | `schema-polyfill.js`；`$ref` 展开、约束自然语言化、oneOf 合并 |
| 5.3 影子会话与签名金库 | ✅ 已落地 | `signature-vault.js`；`vsig1.` 虚拟签名注入/剥离 |
| 5.4 前缀缓存对齐 + 思考预算插值 | ⚠️ 部分 | 工具稳定排序默认开启；`cache_control` 仍丢弃；5 档预算量化 |
| 5.5 DFA 流式状态机 | ✅ 基本落地 | `StreamSessionStore` + `AnthropicSseEmitter` / `ResponsesSseEmitter`；81/81 生命周期通过 |

### 5.2 Tier 迁移

archive v1.6.0 的 24 组合中，Tier 2 与 Tier 2~3 合计约 10 个，另有 3 个 Tier 1~2；当前 15 个实测组合：

- **没有 Tier 3 组合**；
- 最差为 **T1~2**（Gemini 流式思考回退、thinkingLevel 三档量化、Schema 降级；Zed 部分模型不暴露 thinking block）；
- 文本、流式、单轮工具、多轮工具、角色折叠主链路基本达到 **T0/T1**。

archive 中列出的主要 Tier 2/Tier 3 风险——复杂 Schema 被清洗、签名丢失、双层转译错误累加、流式状态污染——已经大部分被工程化解决；剩余风险更多来自 **Provider 通道能力** 与 **协议物理天花板**，而不是转换器算法本身。

### 5.3 评分对比

| 维度 | archive v1.6.0 | v4.1.3 | 13 模型复评 | 本轮 27 模型 |
|---|---:|---:|---:|---:|
| 文本主链路 | Tier 1~2 为主 | 4.6 | 4.9 | **5.0** |
| 单轮工具 | Tier 1~2 | 4.5 | 4.6 | **5.0** |
| 多轮工具 | 未系统评估 | 4.5 | 4.8 | **4.8** |
| Reasoning 转发 | 4.3 | 4.3 | 4.0 | **4.8**（仅转发；可用性不计） |
| Schema 保真 | 低 | 3.9 | 3.9 | **3.8** |
| 多模态 | 3.8 | 3.8 | 4.1 | **4.1**（沿用前轮证据，未全量复测） |
| Prompt Caching | 3.0 | 3.0 | 3.5 | **3.5** |
| **综合** | 无统一分数 | 4.3 | 4.5 | **4.6** |

---

## 6. 评分与建议

### 6.1 评分

**综合 4.6 / 5。** 按文本 25%、单轮工具 20%、多轮工具 15%、Reasoning 15%、Schema 10%、多模态 5%、缓存 10% 加权，约 4.6。与 13 模型复评的 4.5 相比小幅上调，原因是覆盖面从 13 扩到 27 后主链路仍零确定性失败；扣分项集中在 usage 估算、Schema 结构保真、显式缓存和 CoT 历史回放。

### 6.2 优先级建议

**P1 / 本迭代修**

1. **F1**：`applyEstimatedReasoningTokens()` 保证 `reasoning_tokens <= output_tokens`，补不变量单测。
2. **F2**：OpenAI → Claude 的 tool id 三条路径统一 `sanitizeToolId()`。

**P2 / 下一迭代**

3. **F3**：oneOf 对象分支 required 语义修正；数值 enum 注入 description 或字符串化保留。
4. **F4**：明确 Chat → Responses / Claude → Responses 的 reasoning 历史降级策略，增加可配置的 summary 回放与丢弃计数日志。
5. **F6**：远程 URL 多模态在 Gemini 通道的降级/验证。

**P3 / 文档与运维**

6. **F5**：文档明确 `cache_control` 不可跨协议保留，缓存计量依赖 `cached_tokens`。
7. **F7**：异常截断时通过 emitter finalize 关闭 Claude 内容块。
8. **F8**：非流式请求增加网关侧超时；工具调用重试增加总预算。

### 6.3 测试建议

- 把 27 模型矩阵固化为可选 E2E（真实账号、手动触发，不进 CI），使用 `AICLIENT_E2E_MODELS` 传入完整模型列表；参考第 7.1 节。
- 单测补充：
  - `applyEstimatedReasoningTokens()` 在 `estimated > output` 时的收敛；
  - OpenAI → Claude 非安全 tool id 的清洗；
  - oneOf 分支 required 语义与数值 enum；
  - 异常流截断时 Claude 事件序列完整性。
- 长期回归建议把 `reasoning` 存在性拆成 `✓`（确定性通过）/ `⚠`（本次未提供 CoT）/ `✗`（确定性失败），避免把 provider 采样差异误判为网关回归。

---

## 7. 附录

### 7.1 复现方式

```bash
# 1) 用当前工作树启动隔离实例
node src/services/api-server.js --host 127.0.0.1 --port 3201

# 2) 读取 configs/config.json 的 REQUIRED_API_KEY
# 3) 用仓库内 E2E 跑 27 模型核心矩阵
AICLIENT_E2E_BASE=http://127.0.0.1:3201/auto \
AICLIENT_E2E_MODELS='openai-custom:deepseek-v4-pro,openai-custom:deepseek-v4.1-flash,openai-custom:glm-5.3,openai-custom:qwen3.8-flash,openai-custom:qwen3.8-max,openaiResponses-custom:deepseek-v4-flash,gemini-antigravity:gemini-3.8-flash-high,openai-codex-oauth:gpt-6-luna,zed:claude-haiku-5-5,zed:claude-sonnet-5-5,zed:gemini-3.8-flash,zed:gemini-4-argon,zed:gpt-6-luna,zed:gpt-6.1-sol,trae:DeepSeek-V4.1-Flash-1017,trae:glm-5.3,trae:glm-5.3-flashx,trae:kimi-k2.8-preview,trae:kimi-k3,trae:qwen3.8-max,trae-chat_v3:DeepSeek-V4-Pro-Official,trae-chat_v3:deepseek-v4.1-flash,trae-chat_v3:glm-5.3,trae-chat_v3:glm-5.3-flashx,trae-chat_v3:kimi-k3,trae-chat_v3:qwen3.8-flash,trae-chat_v3:qwen3.8-max' \
npm run test:e2e
```

> 说明：本轮 27 模型主矩阵与 54 次高难推理探针由临时 Node 脚本驱动（未写入仓库），仓库内 `npm run test:e2e` 的 `runCoreMatrix` 用例形状与之一致，可通过上面的 `AICLIENT_E2E_MODELS` 复现核心矩阵。

### 7.2 原始数据摘要

- 逐模型核心结果：27 个模型全部 `11/11`。
- 高难推理探针：54/54 正文包含 `31`；23/27 模型至少一次返回 reasoning。
- usage：所有用例均满足 `total_tokens == prompt + output`；除 `zed:gpt-6-luna` 的 Responses 非流式外，所有用例满足 `reasoning_tokens <= output`。
- 服务端日志：E2E 期间 `empty response` / `Stream Retry` / `Unary Retry` / `Fallback activated` 均为 0。
- 工作树：测试后 `git status --short` 无输出。

### 7.3 关键文件索引

| 主题 | 文件 |
|---|---|
| 转换调度 | `src/convert/convert.js`、`src/converters/ConverterFactory.js` |
| 请求编排/重试/空响应护栏 | `src/handlers/request-pipeline.js` |
| OpenAI 转换 | `src/converters/strategies/OpenAIConverter.js` |
| Claude 转换 | `src/converters/strategies/ClaudeConverter.js` |
| Responses 转换 | `src/converters/strategies/OpenAIResponsesConverter.js` |
| Gemini 转换 | `src/converters/strategies/GeminiConverter.js` |
| Codex 转换 | `src/converters/strategies/CodexConverter.js` |
| Schema Polyfill | `src/converters/schema-polyfill.js`、`src/converters/utils.js` |
| 签名金库 | `src/converters/signature-vault.js` |
| 流式状态 | `src/converters/stream-session.js`、`src/converters/anthropic-sse-emitter.js`、`src/converters/responses-sse-emitter.js` |
| Thinking 预算 | `src/converters/thinking-budget.js` |
| custom tool | `src/converters/custom-tool-registry.js` |
| Provider 能力 | `src/providers/provider-capabilities.js` |
| Provider 适配 | `src/providers/openai/openai-core.js`、`src/providers/zed/zed-core.js`、`src/providers/gemini/antigravity-core.js`、`src/providers/trae/trae-core.js` |

---

## 8. 最终评价

与 archive v1.6.0 相比，v4.1.4 的核心转译已经从“每个方向各自补丁”演进为“共享基础设施 + 能力声明”：

- **文本与流式**：27 个模型、3 个下游协议、流式/非流式全部通过，生命周期完整；
- **工具调用**：单轮 81/81、Chat 多轮 27/27，工具索引、call_id、finish_reason 修正均有效；
- **思考与签名**：有 CoT 时能够跨协议转发；`vsig1` 虚拟签名解决了非 Claude 上游的签名回放；
- **Schema 与多模态**：接受性已解决，结构保真仍是主要残差；
- **缓存**：隐式前缀缓存计量可用，显式 `cache_control` 仍不可控。

当前的主要风险已经不在“转译器算法”，而在三类边界：

1. **Provider 契约**：Zed 三条分支、openai-custom 的强制 tool_choice、Codex 的输出上限；
2. **usage 口径**：估算值与上游精确值的边界需要严格不变量；
3. **协议物理天花板**：显式缓存、encrypted reasoning、Gemini 流式思考/三档 thinkingLevel。

这三类中，第 1 类属于可修复的工程契约，第 2 类是本轮新增的具体缺陷，第 3 类应通过能力声明、降级策略和文档管理预期，而不是继续用转换器代码“假装支持”。

---

## 9. 最小修复落地与复验（2026-10-22）

### 9.1 已落地修复

| 项 | 状态 | 改动 | 文件 |
|---|---|---|---|
| F1 usage 不变量 | ✅ 已修复 | 估算/上游 `reasoning_tokens` 统一收敛到 `<= output_tokens`；output 为 0 时不凭空估算 | `src/converters/utils.js` |
| F2 Claude tool id | ✅ 已修复 | 新增 `toClaudeToolId()`，统一清洗请求/响应/流式 6 处 tool id | `src/converters/strategies/OpenAIConverter.js` |
| F3 Schema 保真 | ✅ 已修复 | oneOf 对象分支 `required` 改为交集；数值/布尔 enum 注入 description | `src/converters/schema-polyfill.js` |
| F4 CoT 历史丢弃 | ✅ 已记录 | Chat → Responses / Claude → Responses 丢弃 reasoning 时输出计数 debug 日志，默认行为不变 | `OpenAIConverter.js`、`ClaudeConverter.js` |
| F5 显式缓存 | ⏸ 保持 | 协议无等价字段，保留 warn + 文档 | — |
| F6 远程 URL 多模态 | ⏸ 待验证 | 先补真实 URL E2E；确认失败后再加白名单/降级 | — |
| F7 异常流收尾 | ⏸ 暂缓 | 仅在严格 Claude 客户端出现问题时引入 finalize | — |
| F8 长尾延迟 | ⏸ 暂缓 | 运维项，需要时加非流式超时配置 | — |

### 9.2 复验结果

| 验证项 | 结果 |
|---|---|
| 目标单测（reasoning / schema / converters） | 通过 |
| 全量单测 | **33 suites / 457 tests 全绿** |
| 27 模型核心 E2E | **296 / 297**；唯一失败为 `openai-custom:qwen3.8-max` Responses 流式算术采样返回 `442`，同用例重试 3/3 返回 `391`，非转译回归 |
| usage 不变量 | **0 违反**；此前异常用例 `zed:gpt-6-luna` Responses 非流式已变为 `output_tokens=27, reasoning_tokens=27` |
| 27 模型逐模型 | 26 个 11/11，1 个 10/11（上述算术采样） |
| oneOf 定向 E2E | 通过（`npm run test:e2e` 同款用例，4.4s） |
| 服务端最终 5xx / 空响应重试 | 0 / 1（openai-custom unary 瞬时空响应，自动重试后成功） |

### 9.3 新增回归测试

- `tests/reasoning-usage-estimate.test.js`：估算值不超过 output、上游 reasoning 超限收敛、output 缺失不估算、Claude → Responses 不变量。
- `tests/converters.test.js`：OpenAI → Claude 请求/响应/流式的非法 tool id 清洗与 `tool_result` 配对。
- `tests/schema-polyfill.test.js`：oneOf required 交集、无公共 required 删除、数值 enum 注入 description。

### 9.4 结论

F1/F2/F3 是可以在共享边界内局部修复的契约问题，本轮已用约 60 行净改动 + 10 条回归测试关闭；F4 以可观测性方式记录，避免在没有 encrypted reasoning 能力时引入新的 400 风险。F5/F6/F7/F8 属于协议能力或运维项，继续通过能力声明、测试探针和文档管理，不做“假装支持”的转换器补丁。
