# AIClient2API 核心转译功能复评（2026-10-22）

- 状态：当前有效
- 评估对象：分支 `fix/cross-protocol-v4.1.3`，工作树 `077d234`（`fix(providers): 适配 Zed Google 通道 tool_choice 小写枚举模式`）
- 测试实例：独立端口 `127.0.0.1:3201`（使用当前工作树与同一份 `configs`；未重启用户 `3000` 实例；仅产生 provider 健康状态/usage 缓存更新，tracked 文件未改动）
- 自动化测试：`npm test -- --runInBand` = **28 suites / 413 tests 全绿**
- 历史对照：[`docs/archive/CROSS_PROTOCOL_EVALUATION_AND_OPTIMIZATION.md`](./archive/CROSS_PROTOCOL_EVALUATION_AND_OPTIMIZATION.md)（v1.6.0，2026-10-16）
- 历史复评：v4.1.1 ~ v4.1.3 文档已清理；关键对照结论保留在本文第 6 节与 Git 历史
- 修复计划：[`CROSS_PROTOCOL_FIX_PLAN_V4_1_4.md`](./CROSS_PROTOCOL_FIX_PLAN_V4_1_4.md)
- 修复进展：Phase 1（F1 + F2）已落地——`f366433`（Zed `is_error`）、`2aa4829`（Gemini usage）；Phase 2/3 待实施。Phase 1 后单测 **29 suites / 422 tests 全绿**，13 模型全量 E2E **125 / 143**（Zed haiku 多轮回传已修复；Codex/Zed gpt 的 reasoning 采样波动 ±1）

---

## 1. 结论

**综合约 4.3 / 5，与 v4.1.3 的 4.3 持平，但分布发生了明显变化：文本与单轮工具主链路接近满分，扣分集中在 reasoning 流式能力、usage 口径、Zed 多轮工具契约与显式缓存。**

| 维度 | 分数 | 实测依据 |
|---|---:|---|
| 文本主链路（3 下游 × 13 模型 × 流式/非流式） | **4.9 / 5** | 78 / 78 条文本响应内容正确（均返回 `391`）；39 / 39 条流式响应生命周期完整 |
| 单轮工具与强制 `tool_choice` | **4.6 / 5** | 39 / 39 单轮工具、18 / 18 流式工具、26 / 26 强制 `tool_choice` 通过 |
| 多轮工具 / Agent 循环 | **4.4 / 5** | Chat 多轮工具 11 / 13；Claude 与 Responses 补充测试 6 / 6；Zed 多轮 `tool_result` 契约缺陷 |
| 思考 / Reasoning | **4.0 / 5** | 11 / 13 模型至少一个方向返回思考；Gemini 流式无思考文本、Zed 两模型无思考、Gemini usage 口径错误、Zed `high→max` |
| 多模态 | **4.1 / 5** | 32×32 红色 PNG：5 / 7 模型正确识别；Zed OpenAI 通道丢图；`openai-custom:glm-5.3` 上游无视觉 |
| Prompt Caching | **3.0 / 5** | 显式 `cache_control` 仍跨协议丢弃（仅 warn）；隐式缓存 `cached_tokens` 可回填 |
| **综合** | **4.3 / 5** | 内容与工具主链路强于 archive 时代；剩余问题以 provider 契约和能力上限为主 |

一句话结论：

> 当前项目的跨协议转译已经从 archive v1.6.0 描述的“点对点补丁 + 多个 Tier 2/3 组合”，收敛为“共享转译基础设施 + provider 能力声明”的稳定形态；13 个真实模型的文本、流式收尾、单轮工具与多轮角色折叠均达到可用水平；custom tool 与签名回放在代表性模型上通过。剩余的主要问题不是“转译器不会转”，而是 **Zed 的 Anthropic/OpenAI/Google 三条 provider 分支与转换器之间的契约仍不完整**，以及 **Gemini 的 usage / 流式思考受上游能力限制**。

---

## 2. 评估口径

### 2.1 协议面变化

archive v1.6.0 使用「3 下游 × 8 Provider = 24 组合」口径。当前代码已经把 Provider 适配层与协议前缀解耦：

- 下游协议：`openai`（Chat Completions）、`openaiResponses`、`claude`（Anthropic Messages）
- 上游协议：`openai`、`openaiResponses`、`claude`、`gemini`、`codex`、`grok`
- Provider（`gemini-antigravity`、`zed`、`trae`、`trae-chat_v3`、`openai-custom`、`openaiResponses-custom`、`openai-codex-oauth` 等）映射到上述协议前缀，再叠加各自的能力约束

因此本轮采用 **3 × 6 = 18 个协议组合** 作为矩阵口径，并用 13 个真实模型覆盖 7 个 Provider 节点。

### 2.2 测试模型

`/auto/v1/models` 当前共 28 个模型，本轮选取用户指定的 13 个：

| # | 模型 | 上游协议 / 节点 |
|---|---|---:|
| 1 | `gemini-antigravity:gemini-3.8-flash-high` | `gemini` / antigravity |
| 2 | `openai-codex-oauth:gpt-6-luna` | `codex` / codex-oauth |
| 3 | `openaiResponses-custom:deepseek-v4-flash` | `openaiResponses` / custom |
| 4 | `trae-chat_v3:deepseek-v4.1-flash` | `openai` / trae-chat_v3 |
| 5 | `trae:DeepSeek-V4.1-Flash-1017` | `openai` / trae |
| 6 | `openai-custom:glm-5.3` | `openai` / custom（alias → `glm-5.3-prime`） |
| 7 | `openai-custom:deepseek-v4-pro` | `openai` / custom |
| 8 | `openai-custom:deepseek-v4.1-flash` | `openai` / custom |
| 9 | `openai-custom:qwen3.8-flash` | `openai` / custom |
| 10 | `openai-custom:qwen3.8-max` | `openai` / custom |
| 11 | `zed:claude-haiku-5-5` | `claude` / zed |
| 12 | `zed:gemini-3.8-flash` | `claude`（Zed 内部转发 Google） / zed |
| 13 | `zed:gpt-6-luna` | `claude`（Zed 内部转发 OpenAI） / zed |

### 2.3 reasoning_effort=high 的协议化表达

- Chat 下游：`reasoning_effort: "high"`
- Responses 下游：`reasoning: { effort: "high", summary: "auto" }`
- Claude 下游：Anthropic 协议没有 `reasoning_effort` 字段，使用等价的原生 `thinking: { type: "enabled", budget_tokens: 20000 }`（项目 canonical 表中 `high = 20000`）

### 2.4 用例矩阵

每个模型执行 11 个核心用例：

1. Chat 非流式文本（system + user，校验内容、usage、reasoning）
2. Chat 流式文本（校验增量、`[DONE]`、reasoning 增量）
3. Responses 非流式文本（校验 `output` 形状、`status`、reasoning item）
4. Responses 流式文本（校验 `response.completed` 生命周期）
5. Claude 非流式文本（校验 `thinking` / `text` 块、`stop_reason`、usage）
6. Claude 流式文本（校验 `message_start` / `message_stop`、thinking 增量）
7. Chat 单轮 function tool
8. Chat 工具结果回传（多轮 Agent 循环）
9. Responses 单轮 function tool
10. Claude 单轮 function tool
11. Chat 连续同角色消息 + system（角色折叠）

另加针对性探针：

- 强制 `tool_choice`（Chat 与 Claude 下游，13 模型 × 2）
- 复杂 JSON Schema（`$ref` 风格嵌套、`pattern`、`oneOf`）
- Claude thinking signature 回放
- Responses custom tool（Gemini / Codex / Trae）
- 截断映射（`max_tokens` / `max_output_tokens = 8`）
- 多模态（32×32 红色 PNG）
- 多 system + 连续 user
- Chat 历史 `reasoning_content` + tool_calls 回放
- Claude / Responses 多轮工具结果回传
- 1×1 与 32×32 图片对比（排除“模型看不清小图”的误判）

---

## 3. 核心 E2E 结果

### 3.1 总览

| 指标 | 结果 |
|---|---:|
| 核心用例 | **125 / 143 通过（87.4%）** |
| 文本内容正确性（Chat/Responses/Claude × 13 模型 × 流式/非流式） | **78 / 78（100%）** |
| 流式生命周期完整性（`[DONE]` / `response.completed` / `message_stop`） | **39 / 39（100%）** |
| 单轮工具调用（Chat/Responses/Claude） | **39 / 39（100%）** |
| 流式工具调用（6 个代表模型 × 3 协议） | **18 / 18（100%）** |
| 强制 `tool_choice`（Chat/Claude） | **26 / 26（100%）** |
| Chat 多轮工具结果回传 | **11 / 13** |
| Claude / Responses 多轮工具结果回传（补充） | **6 / 6** |
| 连续同角色 + 多 system | **17 / 17** |
| 复杂 Schema 被上游接受 | **6 / 6** |
| Responses custom tool | **3 / 3** |
| 签名回放 | **2 / 2** |

> 18 条未通过的核心用例中，16 条是 **思考元数据缺失** 或 **上游能力限制**；另有 2 条是 500（Zed 多轮工具），其中 `zed:claude-haiku-5-5` 是网关侧 `is_error` 契约缺陷，`zed:gemini-3.8-flash` 更像 Zed Google 通道限制。

### 3.2 逐模型结果

| 模型 | 核心通过 | 文本内容 | 单轮工具 | Chat 多轮回传 | 连续同角色 | 思考可用性 | 备注 |
|---|---:|---:|---:|---:|---:|---|---|
| `gemini-antigravity:gemini-3.8-flash-high` | 8 / 11 | 6 / 6 | 3 / 3 | ✅ | ✅ | 非流式有，流式无 | 流式上游不返回 thought text |
| `openai-codex-oauth:gpt-6-luna` | **11 / 11** | 6 / 6 | 3 / 3 | ✅ | ✅ | 有 | — |
| `openaiResponses-custom:deepseek-v4-flash` | **11 / 11** | 6 / 6 | 3 / 3 | ✅ | ✅ | 有 | — |
| `trae-chat_v3:deepseek-v4.1-flash` | **11 / 11** | 6 / 6 | 3 / 3 | ✅ | ✅ | 有 | — |
| `trae:DeepSeek-V4.1-Flash-1017` | **11 / 11** | 6 / 6 | 3 / 3 | ✅ | ✅ | 有 | — |
| `openai-custom:glm-5.3` | **11 / 11** | 6 / 6 | 3 / 3 | ✅ | ✅ | 有 | — |
| `openai-custom:deepseek-v4-pro` | **11 / 11** | 6 / 6 | 3 / 3 | ✅ | ✅ | 有 | — |
| `openai-custom:deepseek-v4.1-flash` | **11 / 11** | 6 / 6 | 3 / 3 | ✅ | ✅ | 有 | — |
| `openai-custom:qwen3.8-flash` | **11 / 11** | 6 / 6 | 3 / 3 | ✅ | ✅ | 有 | — |
| `openai-custom:qwen3.8-max` | **11 / 11** | 6 / 6 | 3 / 3 | ✅ | ✅ | 有 | — |
| `zed:claude-haiku-5-5` | 4 / 11 | 6 / 6 | 3 / 3 | ❌ 500 | ✅ | 无 | 多轮 `tool_result` 缺 `is_error` |
| `zed:gemini-3.8-flash` | 4 / 11 | 6 / 6 | 3 / 3 | ❌ 500 | ✅ | 无 | Zed Google 多轮工具历史 500 |
| `zed:gpt-6-luna` | 10 / 11 | 6 / 6 | 3 / 3 | ✅ | ✅ | 有（不稳定） | Responses 非流式 reasoning 偶发缺失 |

> `文本内容` 列统计的是内容是否正确返回 `391`，而不是“所有断言都通过”。Zed 两个模型的 6 条文本响应内容全部正确，失败的是 thinking 相关断言与多轮工具。

### 3.3 流式生命周期

39 条文本流（Chat 13 + Responses 13 + Claude 13）全部满足：

- Chat：收到 `[DONE]`，`finish_reason` 正确；
- Responses：收到 `response.completed`（截断时为 `response.incomplete`）；
- Claude：收到 `message_start` → `content_block_*` → `message_delta` → `message_stop`；
- 未出现重复终止事件、`write after end` 或跨请求状态污染。

这与 v4.1.3 引入的 `AnthropicSseEmitter` / `ResponsesSseEmitter` + `StreamSessionStore` 设计一致，说明流式状态所有权收编是有效的。

---

## 4. 新发现的问题

### P1-1（已修复 `f366433`）：Zed Anthropic 通道多轮工具历史缺 `is_error`，直接 400/500

**现象**

`zed:claude-haiku-5-5` 与 `zed:claude-sonnet-5-5` 在 Chat 多轮工具回传（assistant `tool_use` + user `tool_result`）时失败。直连 Zed 的复现结果是：

```text
Zed API error (400): failed to parse Anthropic request: missing field `is_error`
```

给 `tool_result` 补上 `is_error: false` 后，同一请求返回 `200`，内容为 `18`。

**根因**

- `OpenAIConverter.toClaudeRequest()` 生成 `tool_result` 时只写 `type` / `tool_use_id` / `content`，没有写 `is_error`
  （`src/converters/strategies/OpenAIConverter.js:165-169`）。
- `zed-core.buildPayload()` 只对“原始 OpenAI `role: 'tool'` 消息”补 `is_error`
  （`src/providers/zed/zed-core.js:870-877`）；对于已经是 Claude 形状、由 converter 生成的 user 消息，它直接 `content = [...m.content]` 透传
  （`src/providers/zed/zed-core.js:845`），不会补字段。
- Zed 的 Anthropic 反序列化器把 `is_error` 视为必填字段；原生 Anthropic API 则把它当可选字段。

**影响**

所有 Chat/Responses → Zed Claude 模型的多轮工具 Agent 循环都会在第二次请求失败；这是当前最明确的网关侧转译契约缺陷。

**建议**

在 `zed-core.buildPayload()` 里对所有 `tool_result` 块做一次归一化：

```js
block.is_error = block.is_error === true;
```

或者在 `OpenAIConverter.toClaudeRequest()` / `OpenAIResponsesConverter.toClaudeRequest()` 生成 `tool_result` 时统一补 `is_error: false`。前者更稳，因为它同时覆盖未来新增的转换路径。

---

### P1-2（已修复 `2aa4829`）：Gemini usage 把 `thoughtsTokenCount` 只放进 `reasoning_tokens`，导致 `completion_tokens < reasoning_tokens`

**现象**

`gemini-antigravity:gemini-3.8-flash-high` 的真实响应：

| 用例 | completion/output | reasoning_tokens | total |
|---|---:|---:|---:|
| Chat 非流式 | `completion_tokens=3` | `reasoning_tokens=186` | `217` |
| Chat 流式 | `completion_tokens=3` | `reasoning_tokens=184` | `215` |
| Responses 非流式 | `output_tokens=2` | `reasoning_tokens=243` | `273` |
| Responses 流式 | `output_tokens=3` | `reasoning_tokens=169` | `200` |

这违反 OpenAI 的 usage 语义：`completion_tokens` 应包含 `reasoning_tokens`；也违反 Anthropic 的 `output_tokens` 应包含 thinking token 的语义。

**根因**

`GeminiConverter` 把 `candidatesTokenCount` 直接映射为 `completion_tokens` / `output_tokens`，把 `thoughtsTokenCount` 只放到 `reasoning_tokens`：

- 非流式 Chat：`src/converters/strategies/GeminiConverter.js:300`
- 流式 Chat：`src/converters/strategies/GeminiConverter.js:429`
- 非流式 Responses：`src/converters/strategies/GeminiConverter.js:932`
- 流式 Responses：`src/converters/strategies/GeminiConverter.js:967`、`:1081`
- Claude 侧：`anthropicUsageFromInclusiveInput()` 只用 `candidatesTokenCount`（`src/converters/utils.js:47`）

Gemini 的 `totalTokenCount` 已经满足 `prompt + candidates + thoughts`，说明 `candidatesTokenCount` 本身不含 thoughts。

**影响**

- 客户端看到的 `completion_tokens` 被严重低估；
- 计费/配额插件如果直接读客户端 usage 会少算；
- 监控上会出现 `reasoning_tokens > completion_tokens` 的非法组合。

**建议**

在 Gemini 的三个响应方向统一：

```js
const outputTokens = candidatesTokenCount + thoughtsTokenCount;
```

保留 `reasoning_tokens` 作为明细字段；Claude 方向的 `output_tokens` 同样加 thoughts。

---

### P2-1：openai-custom 的“指定 function”强制 `tool_choice` 返回空 200，触发 5 次空响应重试

**现象**

对 `localhost:4003` 的 openai-custom 端点直连测试：

| `tool_choice` | 结果 |
|---|---|
| `"auto"` | HTTP 200，正常 SSE + tool_calls |
| `"required"` | HTTP 200，正常 SSE + tool_calls |
| `{ type: "function", function: { name: "get_weather" } }` | HTTP 200，**body 长度 0** |

5 个 openai-custom 模型（glm-5.3-prime / deepseek-v4-pro / deepseek-v4.1-flash / qwen3.8-flash / qwen3.8-max）全部复现。

网关把空 body 判为空响应，按 `EMPTY_RESPONSE_MAX_RETRIES=5` 重试；每次上游约 60 秒，因此一个请求可能挂起约 5 分钟。

**根因**

- `openai-core.js` 只消费 `supportsNonStream`，没有消费 `supportsForcedToolChoice`（`src/providers/openai/openai-core.js:185`）。
- `provider-capabilities.js` 默认 `supportsForcedToolChoice=true`（`src/providers/provider-capabilities.js:36`），且当前只有 `zed-core.js:820` 真正读取该能力。

**建议**

- 在 `openai-core.js` 中读取 `supportsForcedToolChoice`，当为 false 时把“指定 function”降级为 `required` 或 `auto`；
- 为 openai-custom 节点声明 `capabilities.models["*"].supportsForcedToolChoice=false`；
- 给空响应重试增加墙钟上限，避免“上游静默空 200”导致客户端长时间挂起。

---

### P2-2：Zed `reasoning_effort: high` 被二次量化为 `max`

**现象**

`zed:claude-haiku-5-5` 的 Chat 请求带 `reasoning_effort: "high"`，转换器先按 canonical 表生成 `thinking: { type: "enabled", budget_tokens: 20000 }`；`zed-core` 再把 20000 反解为：

```json
"thinking": { "type": "adaptive" },
"output_config": { "effort": "max" }
```

`high` 被放大成 `max`。

**根因**

`zed-core.buildPayload()` 的自适应模型分支使用：

```text
<=2048 low / <=4096 medium / <=8192 high / <=16384 xhigh / else max
```

（`src/providers/zed/zed-core.js:763-770`）

而 canonical 表是 `high=20000`、`xhigh/max=32000`（`src/converters/thinking-budget.js:7`）。20000 落入了 `else max`。

**建议**

- 统一使用 canonical 阈值（`high <= 20000`）；
- 或者对 adaptive 模型直接透传 `reasoning_effort`，不再经过 budget 反解，避免二次量化。

---

### P2-3：Zed OpenAI 分支丢弃图片内容

**现象**

用 32×32 红色 PNG 测试：

| 模型 | 回答 |
|---|---|
| `gemini-antigravity:gemini-3.8-flash-high` | Red ✅ |
| `openai-codex-oauth:gpt-6-luna` | Red ✅ |
| `zed:gemini-3.8-flash` | Red ✅ |
| `zed:claude-haiku-5-5` | Red ✅ |
| `trae:DeepSeek-V4.1-Flash-1017` | Red ✅ |
| `zed:gpt-6-luna` | Blue ❌ |
| `openai-custom:glm-5.3` | “I don't see an image” ❌ |

`openai-custom/glm-5.3-prime` 直连上游同样看不到图片，属于模型/端点能力，不是网关问题。
`zed:gpt-6-luna` 直连路径则明确丢了图片：`zed-core` 的 `open_ai` 分支在遍历 user content 时只处理 `text` 与 `tool_result`，没有处理 `image` / `input_image`（`src/providers/zed/zed-core.js:369-460`，其中 `:391` 只处理 `tool_result`）。

**建议**

在 `zed-core` 的 `open_ai` 分支补：

```js
else if (part.type === 'image' && part.source?.type === 'base64') {
  content.push({ type: 'input_image', image_url: `data:${part.source.media_type};base64,${part.source.data}` });
}
```

同时补 `input_image` 的 URL 形态。

---

### P2-4：Zed Google 通道多轮工具历史全量 500（通道限制）

**现象**

`zed:gemini-3.8-flash` 的多轮工具回传稳定 500。对以下变体逐一测试，全部 500：

- 带 / 不带 thinking
- 带 / 不带 `maxOutputTokens`
- `tool_result.content` 字符串 / 数组
- 给 `functionCall` / `functionResponse` 补 `id`
- 给 `functionCall` 补 `thoughtSignature: "skip_thought_signature_validator"`

而同样形状的请求走 `gemini-antigravity` 全部正常，简单的两轮文本对话走 Zed Google 也正常。

**判断**

这更像是 Zed Google provider 对“多轮 function call 历史”的通道限制，而不是网关转换器形状错误。`zed-core` 的 Google 分支确实也丢了 `functionCall.id` / `functionResponse.id`（`src/providers/zed/zed-core.js:583-597`），但补 id 后仍然 500，说明不是唯一原因。

**建议**

- 在 `provider-capabilities` 增加一个“多轮工具历史”能力位，或至少在 Zed Google 通道对 tool result 回传给出明确错误；
- 不要把 500 空 body 直接透传，至少把 `error.response.data` 带出来；
- 文档中明确：Zed Google 通道当前不适合多轮工具 Agent 循环。

---

### P2-5：Gemini 非 Claude 模型忽略 `maxOutputTokens`，`max_tokens=8` 仍生成 20,279 tokens

**现象**

对 `gemini-antigravity:gemini-3.8-flash-high` 发送 Chat 请求：

```json
{ "max_tokens": 8, "messages": [{ "role": "user", "content": "Write a very long essay about the history of computing." }] }
```

上游实际返回 `completion_tokens=20279`，客户端在 180 秒超时；服务端在约 198 秒后完成并记录 20,279 tokens。

**根因**

`antigravity-core` 对非 Claude 模型默认删除 `maxOutputTokens`：

- `src/providers/gemini/antigravity-core.js:489`
- 能力声明为 `supportsMaxOutputTokens=false`（`src/providers/provider-capabilities.js:64`）

**影响**

- 客户端设置的小输出上限无效；
- 高 reasoning + 长输出可能触发客户端超时；
- 计费/配额不可控。

**建议**

- 保持当前“默认删除”的安全策略，但在响应/日志中明确标记 `maxOutputTokens` 被忽略；
- 对声明 `supportsMaxOutputTokens=true` 的节点才透传；
- 文档中把该限制写成“物理上限”，不要承诺 `max_tokens` 生效。

---

### P3-1：Schema Polyfill 解决“能否被接受”，但不保证“结构完全保真”

复杂 Schema（嵌套对象 + `pattern` + `oneOf`）测试结果：

| 模型 | 结果 | 观察 |
|---|---|---|
| `gemini-antigravity:gemini-3.8-flash-high` | 工具被调用，JSON 可解析 | `shipping` 输出 `{"type":"standard"}`，原始 Schema 期望 `{"method":"standard"}` |
| `trae:DeepSeek-V4.1-Flash-1017` | ✅ | `shipping: {"method":"standard"}` |
| `trae-chat_v3:deepseek-v4.1-flash` | ✅ | `shipping: {"method":"standard"}` |
| `openai-custom:glm-5.3` | ✅ | `shipping: {"method":"standard"}` |
| `zed:gemini-3.8-flash` | 工具被调用，JSON 可解析 | `shipping: "standard"`（字符串，结构失真） |
| `zed:gpt-6-luna` | ✅ | `shipping: {"method":"standard"}` |

Gemini 的 `oneOf` 被 polyfill 降级后，模型仍可能生成“语义近似但结构不正确”的参数；Zed Google 分支则完全没有接入 Schema Polyfill（`src/providers/zed/zed-core.js:644` 直接使用 `input_schema`）。

**建议**

- 对 `oneOf` / `anyOf` 除了写入 description，还可以在 description 中明确“必须输出对象，字段名必须是 X”；
- 在 Zed Google 分支也调用 `polyfillAndCleanSchemaForGemini`；
- 在 E2E 中增加“结构合法性”断言，而不是只校验 JSON 可解析。

---

### P3-2：若干 reasoning 历史被静默丢弃

- **Responses → Gemini**：`toGeminiRequest` 的 input switch 没有 `reasoning` 分支，历史 reasoning item 被忽略（`src/converters/strategies/OpenAIResponsesConverter.js:1836`）。
- **Chat → Responses**：`toOpenAIResponsesRequest` 不读取 assistant 消息的 `reasoning_content`（`src/converters/strategies/OpenAIConverter.js:1491`）。
- **Claude → Responses**：thinking 块只有在带 `encrypted_content` 时才回放，否则 debug 跳过（`src/converters/strategies/ClaudeConverter.js:1838`）。这是为避免官方 Responses 400 的保守策略，但会丢失多轮思考上下文。

这些不是“内容错误”，但属于可观测的语义损失。建议至少像 `item_reference` 一样补 debug 日志，并在文档中明确“历史 reasoning 不保证回放”。

---

### P3-3：错误响应丢失上游细节

真实案例：

- Zed 400：上游明确说 `missing field is_error`，网关返回 `{"error":{"message":"Request failed with status code 400",...}}`；
- openaiResponses-custom 400：上游返回 248 条 Pydantic validation 详情，网关只返回 `Request failed with status code 400`。

根因在 `createErrorResponse()` 只使用 `error.message`（`src/handlers/request-pipeline.js:1671`），没有合并 `error.response.data`。

**建议**

在安全前提下把上游 `error.response.data.error.message` 或截断后的 `data` 放进 `error.details`，至少对 4xx 这样做；这对 Agent 客户端排障非常重要。

---

### P3-4：Codex 忽略输出长度上限，能力声明未参与

`CodexConverter.toOpenAIResponsesToCodexRequest()` 无条件删除 `max_output_tokens` / `max_completion_tokens`（`src/converters/strategies/CodexConverter.js:242`）。实测 `max_tokens=8` 与 `max_output_tokens=8` 均未截断，返回 `stop` / `completed`。

这不是新回归（Codex 上游本身不接受该字段），但说明新引入的 `supportsMaxOutputTokens` 能力声明还没有覆盖 Codex 分支。建议把“删除”改为能力驱动的显式降级，并在响应中给出 `max_output_tokens` 不生效的提示。

---

### P3-5：Zed 两模型的 thinking 缺失更像上游行为

`zed:claude-haiku-5-5` 与 `zed:gemini-3.8-flash` 在三种下游协议下都没有 thinking 块。Zed `/models` 元数据对两者均声明 `supports_thinking: true`，网关侧 `resolveModelCapabilities()` 也解析为 `supportsThinking: true`，`zed-core` 实际下发了 adaptive/thinkingLevel 配置；因此当前证据更支持“模型/通道不返回 thinking”，而不是转换器丢字段。

`zed:gpt-6-luna` 则表现为**不稳定**：3 次 Responses 非流式复测中 2 次只有 `message`、1 次出现 `reasoning`，属于上游采样行为，不宜按确定性缺陷处理。

### P3-6：显式 Prompt Caching 仍不可跨协议保留

`cache_control` 目前只在转换点记录 warn/debug（`src/converters/utils.js:644`），不会映射到 OpenAI/Gemini/Responses。响应侧 `cached_tokens → cache_read_input_tokens` 的回填仍然有效。结论与 v4.1.3 相同：**缓存计量可用，缓存位置不可控**。

---

## 5. 核心转译代码 review

### 5.1 请求方向

| 能力 | 当前实现 | 评价 |
|---|---|---|
| 多 system 消息 | `extractAndProcessSystemMessages()` 按顺序拼接；Claude/Responses 走顶层 system/instructions | 结构边界丢失，但语义保留；实测 4/4 多 system 用例通过 |
| 连续同角色 | Gemini 用 `mergeConsecutiveSameRoleContents()` 在 parts 级合并；Claude 在 content 数组级合并 | 符合 Gemini/Anthropic 交替约束；实测连续 user 13/13 通过 |
| 思考预算 | `thinking-budget.js` canonical 五档表 | 统一了口径；但 Zed adaptive 分支二次量化（P2-2） |
| 工具 Schema | `schema-polyfill.js` + `polyfillAndCleanSchemaForGemini()` | 解决 Protobuf 接受问题；`oneOf` 结构保真有限（P3-1） |
| custom tool | `custom-tool-registry.js` 请求级登记 + function 降级 + 响应还原 | 实测 Gemini/Codex/Trae 3/3 通过 |
| 思考签名 | `signature-vault.js` 无状态 HMAC 虚拟签名 + 上游剥离 | 实测 2/2 回放通过，`vsig1.` 前缀正确 |
| 多模态 | 图片 base64/URL、Claude document、Responses `input_file` | 主路径可用；Zed OpenAI 分支丢图（P2-3） |

### 5.2 响应与流式方向

| 能力 | 当前实现 | 评价 |
|---|---|---|
| Chat 流式 | `GeminiConverter.toOpenAIStreamChunk` / `ClaudeConverter.toOpenAIStreamChunk` / `CodexConverter.toOpenAIStreamChunk` | 生命周期完整；流式工具 18/18，参数按 index/call_id 正确拼接；Gemini thoughtSignature-only chunk 会保留空 delta，避免空流 |
| Responses 流式 | `ResponsesSseEmitter` + `StreamSessionStore` | 39/39 生命周期通过；截断 `response.incomplete` 正确 |
| Claude 流式 | `AnthropicSseEmitter` + 请求级 block index | 39/39 `message_stop` 通过；签名自动注入闭环 |
| usage | `usage-normalizer.js` + 各 converter | OpenAI/Claude/Codex 口径基本正确；Gemini thoughts 未并入 output（P1-2） |
| finish reason | `mapFinishReason()` + pipeline 的 `hasToolCall` 修正 | 单轮工具 39/39，截断映射 openai-custom 2/2 |
| 空响应护栏 | 首内容前缓冲 + 5 次小额重试 | 能避免“只有 thinking 的空 turn”；但面对上游静默空 200 会放大为 5 分钟挂起（P2-1） |

### 5.3 结构性判断

当前仍是 **点对点转换器 + 共享基础设施**，而不是 archive 5.1 提出的统一 IR：

- 每个方向仍是独立 `toXxxRequest` / `toXxxResponse`，OpenAIConverter / ClaudeConverter / OpenAIResponsesConverter 各自 2,000+ 行；
- 但共享层已经把最容易出错的横切关注点收敛：流式 emitter、session store、schema polyfill、signature vault、custom tool registry、usage normalizer、provider capabilities；
- 因此 archive 时代的“每修一个方向漏其他方向”问题明显缓解，但 provider 适配层（尤其 Zed 的三条分支）仍是最薄弱环节。

---

## 6. 与 archive v1.6.0 的对比

### 6.1 archive 优化路线的落地情况

| archive 提案 | 当前状态 | 证据 |
|---|---|---|
| 5.1 统一中间表示 (Unified IR AST) | ❌ 未落地，仍点对点 | 三个主转换器各 2,000+ 行；无 IR 模块 |
| 5.2 Schema Polyfill 降级编译器 | ✅ 已落地 | `src/converters/schema-polyfill.js`；复杂 Schema 6/6 被接受 |
| 5.3 影子会话与签名金库 | ✅ 已落地 | `src/converters/signature-vault.js`；`vsig1.` 回放 2/2 |
| 5.4 前缀缓存对齐 + 思考预算插值 | ⚠️ 部分 | `sortToolsByName` 存在但 `CONVERT_SORT_TOOLS` 默认关闭；`cache_control` 仍丢弃；Zed 预算二次量化 |
| 5.5 DFA 流式状态机 | ✅ 已落地 | `AnthropicSseEmitter` / `ResponsesSseEmitter` / `StreamSessionStore`；413 单测 + 39/39 流式生命周期 |

### 6.2 archive 24 组合 vs 当前 18 组合

archive 的 24 组合中，约 9 个 Tier 2、4 个 Tier 2~3；当前实测的 18 组合中：

- **没有 Tier 3 组合**；
- 最差为 **T1~2**（Gemini 流式思考、Zed Google 多轮工具、Zed 两模型无思考）；
- 文本与单轮工具组合基本达到 **T0/T1**。

这意味着 archive 中列出的主要 Tier 2/Tier 3 风险（复杂 Schema 被清洗、签名丢失、双层转译、流式状态污染）已经大部分被工程化解决；剩余风险更多来自 **provider 通道能力**，而不是转换器算法。

### 6.3 更新后的 18 组合矩阵

| 下游 \ 上游 | `openai` | `openaiResponses` | `claude` | `gemini` | `codex` | `grok` |
|---|---|---|---|---|---|---|
| **OpenAI Chat** | **T0** | **T1** | **T1~2** | **T1~2** | **T1** | 未测（号池空） |
| **OpenAI Responses** | **T1** | **T0/T1** | **T1~2** | **T1~2** | **T1** | 未测（号池空） |
| **Anthropic Messages** | **T1** | **T1** | **T1** | **T1~2** | **T1** | 未测（号池空） |

评级说明：

- **T1~2** 的共性原因：Gemini 流式思考不可得、Zed 两模型无思考、Zed 多轮工具契约/通道限制；
- `claude` 列主要代表 `zed`；`zed:gpt-6-luna` 的文本/工具/多轮正常，`zed:claude-haiku-5-5` / `zed:gemini-3.8-flash` 的思考与多轮工具仍有问题；
- `openai` 列覆盖 `openai-custom` / `trae` / `trae-chat_v3`；`trae-solo_work_lite` 不在本轮 13 个模型内，沿用 v4.1.3 结论；`openai-custom` 的“指定 function 强制 tool_choice”属于端点 quirk，已单独列为 P2-1。

---

## 7. 评分与建议

### 7.1 评分

| 维度 | v1.6.0 archive 时代 | v4.1.3 | 本轮（2026-10-22） |
|---|---|---|---:|
| 文本主链路 | Tier 1~2 为主 | 4.6 | **4.9** |
| 单轮工具 | Tier 1~2 | 4.5 | **4.6** |
| 多轮工具 | 未系统评估 | 4.5 | **4.4** |
| Reasoning | 4.3 | 4.3 | **4.0** |
| 多模态 | 3.8 | 3.8 | **4.1** |
| Prompt Caching | 3.0 | 3.0 | **3.0** |
| **综合** | 无统一分数 | 4.3 | **4.3** |

### 7.2 建议优先级

**P0 / 立即修**

1. `zed-core` 对所有 `tool_result` 块补 `is_error: false`（P1-1）。
2. `GeminiConverter` 的三个响应方向把 `thoughtsTokenCount` 并入 `completion_tokens` / `output_tokens`（P1-2）。

**P1 / 本迭代修**

3. `openai-core` 消费 `supportsForcedToolChoice`，对 openai-custom 的“指定 function”降级为 `required`/`auto`；为空响应重试增加墙钟上限（P2-1）。
4. `zed-core` adaptive 分支改用 canonical 阈值，避免 `high → max`（P2-2）。
5. `zed-core` `open_ai` 分支补图片映射（P2-3）。

**P2 / 后续增强**

6. Zed Google 多轮工具历史：显式能力位 + 明确错误 + 不透传空 500（P2-4）。
7. Gemini `maxOutputTokens`：保持删除策略，但在响应/日志中显式标记（P2-5）。
8. Schema Polyfill：Zed Google 分支接入；`oneOf` 结构约束增强（P3-1）。
9. 错误响应合并上游 `error.response.data` 的可读字段（P3-3）。
10. 为 reasoning 历史丢弃点补日志（P3-2）。

**测试建议**

- 把本轮 13 模型 × 11 用例矩阵固化为可选 E2E 脚本（真实账号、手动触发，不进 CI）；
- 单测补充：Zed `tool_result` 缺 `is_error` 的回归用例、Gemini thoughts usage 断言、Zed `high` 预算映射断言、Zed OpenAI 图片映射断言；
- 对 `max_tokens=8` 这类截断用例，区分“上游不支持上限”和“转换器丢字段”，避免把 provider 限制误判为回归。

---

## 8. 附录：关键用例与证据

### 8.1 核心用例请求摘要

- Chat 文本：system + `What is 17*23? Reply with the number only.`，`reasoning_effort=high`，`max_tokens=2048`
- Responses 文本：`instructions` + `input`，`reasoning={effort:high,summary:auto}`，`max_output_tokens=4096`
- Claude 文本：`system` + `messages`，`thinking={type:enabled,budget_tokens:20000}`，`max_tokens=24000`
- 工具：`get_weather({city:"Paris"})`
- 多轮工具：assistant tool_call + tool result `{"temperature":18,...}` + “What is the temperature?”
- 多 system：两条 system + 两条连续 user（“Remember 7” / “What number?”）
- 复杂 Schema：`create_order`，含嵌套 object、`pattern`、`minimum/maximum`、`oneOf`
- 多模态：32×32 纯红 PNG，`data:image/png;base64,...`

### 8.2 复现方式

本轮 E2E 由临时 Node 脚本驱动（不写入仓库，避免把真实账号 E2E 固化进 CI）：

```bash
# 1) 用当前工作树启动独立实例
node src/services/api-server.js --port 3201

# 2) 从 configs/config.json 读取 REQUIRED_API_KEY
# 3) 分别请求：
#    POST /auto/v1/chat/completions
#    POST /auto/v1/responses
#    POST /auto/v1/messages
```

请求形状见 8.1；如需长期回归，建议把脚本移入 `src/scripts/` 并加 `--dry-run`/白名单开关。

### 8.3 关键原始证据

- Zed 400：`failed to parse Anthropic request: missing field is_error`；补 `is_error:false` 后返回 `18`。
- Gemini 流式原始 SSE 只有最终文本 + `thoughtSignature`，`thoughtsTokenCount` 有值但无 thought text；非流式 `generateContent` 才包含 thought parts。
- openai-custom 直连：`tool_choice` 指定 function → HTTP 200 + 空 body；`required` → 正常 tool_calls。
- Gemini 截断：`max_tokens=8` → `completion_tokens=20279`，服务端约 198 秒完成。
- Zed 32×32 红图：`zed:gpt-6-luna` 回答 `Blue`，其余 5 个有视觉能力的模型回答 `Red`。

### 8.4 逐用例矩阵

列含义：C=Chat，R=Responses，A=Anthropic；T=非流式文本，S=流式文本，tool=单轮工具，loop=多轮工具回传，role=连续同角色。

| 模型 | C-T | C-S | R-T | R-S | A-T | A-S | C-tool | R-tool | A-tool | C-loop | C-role |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| `gemini-antigravity:gemini-3.8-flash-high` | ✓ | ✗ | ✓ | ✗ | ✓ | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `openai-codex-oauth:gpt-6-luna` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `openaiResponses-custom:deepseek-v4-flash` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `trae-chat_v3:deepseek-v4.1-flash` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `trae:DeepSeek-V4.1-Flash-1017` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `openai-custom:glm-5.3` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `openai-custom:deepseek-v4-pro` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `openai-custom:deepseek-v4.1-flash` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `openai-custom:qwen3.8-flash` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `openai-custom:qwen3.8-max` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `zed:claude-haiku-5-5` | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ | ✓ | ✗ | ✓ |
| `zed:gemini-3.8-flash` | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ | ✓ | ✗ | ✓ |
| `zed:gpt-6-luna` | ✓ | ✓ | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

> `gemini-antigravity` 的 6 个文本 `✗` 均为流式 reasoning 断言失败，文本内容 `391` 均正确；`zed:claude-haiku-5-5` / `zed:gemini-3.8-flash` 的 6 个文本 `✗` 均为 thinking 缺失，文本内容 `391` 均正确；`zed:claude-haiku-5-5` / `zed:gemini-3.8-flash` 的 `C-loop ✗` 为 500；`zed:gpt-6-luna` 的 `R-T ✗` 为本次采样未返回 reasoning。

---

## 9. 最终评价

当前项目的核心转译功能已经进入“**文本与单轮工具稳定可用、流式生命周期可靠、Agent 多轮在多数通道可用**”的阶段。与 archive v1.6.0 相比，最大的进步不是某一个转换函数，而是共享基础设施的收敛：

- 流式状态不再依赖全局单例，而是按请求隔离；
- Schema、签名、custom tool、usage、provider capability 都有了统一入口；
- 真实 13 模型 E2E 的文本内容正确率达到 100%，单轮工具与强制 tool_choice 全部通过。

但距离“零损耗网关”仍有明确差距，且当前差距主要集中在三类：

1. **Provider 契约**：Zed 的 Anthropic / OpenAI / Google 三条分支与转换器的字段契约不一致（`is_error`、图片、多轮 function history、预算二次量化）。
2. **上游能力上限**：Gemini 流式不返回 thought text、非 Claude 模型忽略 `maxOutputTokens`；Zed 两模型不返回 thinking；Codex 不接受输出上限。
3. **协议语义不可完全对齐**：显式 `cache_control`、历史 reasoning 回放、`oneOf` 结构保真。

这三类问题中，第 1 类是本轮最值得立即修复的工程缺陷；第 2 类应在文档与能力声明中明确，而不是继续用转换器代码“假装支持”；第 3 类属于协议物理天花板，适合通过降级策略、日志和客户端提示来管理预期。
