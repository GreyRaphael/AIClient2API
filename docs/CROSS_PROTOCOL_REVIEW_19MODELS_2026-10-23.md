# AIClient2API 核心转译复评（2026-10-23 · 19 模型全量 E2E · 残留问题收口）

- 状态：当前有效
- 评估对象：`87a8d95`（含 `524cdb7` / `9c93bf0` / `e41c35f` / `13f8e09` 四个残留问题修复，以及 `78d7089` / `87a8d95` 两个摘要/裁剪边界补丁）
- 对照基线：`4b8a42e3` 的 `docs/CROSS_PROTOCOL_EVALUATION_AND_OPTIMIZATION.md` v1.1.0（2026-10-16，已从工作树移除，经 `git show` 读取历史版本）
- 测试实例：隔离的 `http://127.0.0.1:3201/auto`
- 模型来源：`GET /auto/v1/models` 动态发现，共 **19 个模型**
- 测试参数：Chat `reasoning_effort: "high"`；Responses `reasoning: { effort: "high", summary: "auto" }`；Claude 使用等价原生 `thinking: { type: "enabled", budget_tokens: 20000 }`
- 单元测试：**29 suites / 489 tests 全绿**
- E2E：**35 / 35 通过**，总耗时 **1431.0s**；19 个模型核心矩阵全部 11/11

> 与上一轮 19 模型复评（`bacd6b2`）相比，本轮关闭了 6 个残留问题：非流式错误体语义、Gemini 错误帧、空数组错误帧、`allOf`/条件 Schema、system-only 请求、文档统计。E2E 定向用例从 14 项增加到 16 项。

---

## 1. 结论

**综合约 4.6 / 5。**

主链路（文本、流式生命周期、单轮工具、多轮工具、角色折叠、system 指令遵循）保持 **5.0** 水准，19 个真实模型全部通过；上一轮发现的 F1~F6/F11 残留问题已完成修复并通过单元测试/真实上游验收，没有 Tier 3 组合。剩余扣分集中在协议物理约束（显式缓存、Schema 结构保真、CoT 历史签名）和 E2E 覆盖边界，不再是确定性错误。

| 指标 | 结果 |
|---|---:|
| E2E Jest 用例 | **35 / 35** |
| 19 模型核心矩阵 | **19 / 19 模型 11/11** |
| 核心子用例 | **209 / 209** |
| 文本用例（6 类 × 19） | **114 / 114** |
| 流式生命周期（3 协议 × 19） | **57 / 57** |
| 单轮工具（3 协议 × 19） | **57 / 57** |
| Chat 多轮工具回传 | **19 / 19** |
| 连续同角色 + system 折叠 | **19 / 19** |
| 有 reasoning/thinking 的文本用例 | **69 / 114（60.5%）** |
| 定向 E2E | **16 / 16** |
| 最终 HTTP 5xx | **0** |
| 空响应重试 | **5 个请求（4 unary + 1 stream）；1 个 unary 耗尽 5 次后由 E2E 重试恢复** |
| `Failed to write completion marker` | **0** |
| 单元测试 | **29 suites / 489 tests** |

一句话结论：

> 当前转译器已经从“主链路可用”进入到“边缘语义收口”阶段：Responses→Gemini 的 system/结构化输出/多模态工具回传、同协议与跨协议流内错误、Schema 组合关键字都已补齐；剩余问题主要是协议物理限制、Provider 默认策略和覆盖边界，而不是“转错/转丢”。

---

## 2. 评估口径

### 2.1 模型与协议覆盖

19 个模型分布在 7 个 Provider、5 个上游协议家族：

| 上游协议 | Provider | 模型数 | 模型 |
|---|---|---:|---|
| `openai` | `openai-custom` | 5 | `deepseek-v4-pro`、`deepseek-v4.1-flash`、`glm-5.3`、`qwen3.8-flash`、`qwen3.8-max` |
| `openai` | `trae` | 1 | `DeepSeek-V4.1-Flash-1017` |
| `openai` | `trae-chat_v3` | 1 | `glm-5.3-flashx` |
| `openaiResponses` | `openaiResponses-custom` | 1 | `deepseek-v4-flash` |
| `gemini` | `gemini-antigravity` | 4 | `claude-opus-5-5-medium`、`claude-sonnet-5-5-medium`、`gemini-3.8-flash-high`、`gemini-4-argon-medium` |
| `codex` | `openai-codex-oauth` | 1 | `gpt-6-luna` |
| `claude` | `zed` | 6 | `claude-haiku-5-5`、`claude-sonnet-5-5`、`gemini-3.8-flash`、`gemini-4-argon`、`gpt-6-luna`、`gpt-6.1-sol` |

按协议家族计，覆盖 **3 × 5 = 15 个组合**（`openai` 家族含三个 Provider 适配层）。Grok 未配置，未纳入本轮。

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
11. Chat 连续同角色 + system 折叠（`Remember 7`）

16 项定向用例覆盖：强制 `tool_choice`、Zed GPT 图片、Zed Google 工具历史降级、非法 tool id 清洗、Gemini 流式 thinking 回退、Gemini 截断、GPT reasoning 采样、三协议 reasoning 一致性、Chat/Claude CoT 多轮回放、`oneOf` Schema、上游 4xx、`ZEBRA42` system、三下游流式工具生命周期，以及本轮新增的 **Responses→Gemini developer + text.format** 和 **system/developer-only 本地 400**。

### 2.3 覆盖边界

- Reasoning/thinking 存在性仍作为非阻塞 warning；Provider 不暴露 thought 文本不算网关失败。
- 复杂 Schema 只有 Zed Gemini 的 `oneOf` 与 Responses→Gemini 的 `text.format` 两个真实上游用例。
- 多模态只有 `zed:gpt-6-luna` 红图；PDF、远程 URL、工具结果图片未全量 E2E。
- 未覆盖并行工具调用、工具参数增量流式、custom tool 真实上游调用、显式 `cache_control` 断言。
- 同协议流内错误帧主要由单测覆盖，未构造真实上游 `response.failed` / `event: error`。

---

## 3. E2E 结果

### 3.1 逐模型结果

| # | 模型 | 上游协议 | 用例耗时 | Reasoning | 备注 |
|---:|---|---|---:|---:|---|
| 1 | `openai-custom:deepseek-v4-pro` | openai | 40.3s | 6/6 | 含 unary 空响应重试；1 次耗尽后由 E2E 重试恢复 |
| 2 | `openai-custom:deepseek-v4.1-flash` | openai | 18.7s | 6/6 | — |
| 3 | `openai-custom:glm-5.3` | openai | 14.3s | 6/6 | — |
| 4 | `openai-custom:qwen3.8-flash` | openai | 33.6s | 6/6 | — |
| 5 | `openai-custom:qwen3.8-max` | openai | 43.2s | 6/6 | — |
| 6 | `openaiResponses-custom:deepseek-v4-flash` | openaiResponses | 66.4s | 6/6 | — |
| 7 | `gemini-antigravity:claude-opus-5-5-medium` | gemini | 16.7s | 0/6 | Provider 不暴露 thought 文本 |
| 8 | `gemini-antigravity:claude-sonnet-5-5-medium` | gemini | 14.3s | 0/6 | 同上 |
| 9 | `gemini-antigravity:gemini-3.8-flash-high` | gemini | 115.0s | 6/6 | 流式 thinking 回退非流式 |
| 10 | `gemini-antigravity:gemini-4-argon-medium` | gemini | 65.6s | 6/6 | — |
| 11 | `openai-codex-oauth:gpt-6-luna` | codex | 30.3s | 6/6 | — |
| 12 | `zed:claude-haiku-5-5` | claude | 22.8s | 0/6 | Provider 不暴露 thinking |
| 13 | `zed:claude-sonnet-5-5` | claude | 25.4s | 0/6 | 同上 |
| 14 | `zed:gemini-3.8-flash` | claude | 230.8s | 0/6 | Zed Google 长尾；不回传 thought 文本 |
| 15 | `zed:gemini-4-argon` | claude | 228.4s | 0/6 | 同上 |
| 16 | `zed:gpt-6-luna` | claude | 58.6s | 1/6 | GPT 采样差异 |
| 17 | `zed:gpt-6.1-sol` | claude | 36.7s | 2/6 | GPT 采样差异 |
| 18 | `trae:DeepSeek-V4.1-Flash-1017` | openai | 17.3s | 6/6 | — |
| 19 | `trae-chat_v3:glm-5.3-flashx` | openai | 30.3s | 6/6 | — |

### 3.2 Reasoning 可用性

114 条文本用例中 **69 条（60.5%）** 返回 reasoning/thinking。缺失集中在：

- `gemini-antigravity:claude-*` 两个模型：12 条，Provider/模型不暴露 thought 文本；同一转换路径下 `gemini-3.8-flash-high` 6/6 正常。
- `zed:claude-*` 两个模型：12 条，Provider 不暴露 thinking block。
- `zed:gemini-*` 两个模型：12 条，Zed Google 通道不回传 thought 文本。
- `zed:gpt-6-luna` / `gpt-6.1-sol`：9 条，GPT 采样差异；多步 prompt 定向用例可通过。

这些是 Provider/模型行为，不是网关统一丢弃；只要上游返回 thought/reasoning，三个下游方向的映射都能正确产出。网关侧仍主动跳过的只有“无签名/无 encrypted_content 的历史思考”，见 4.4。

### 3.3 延迟

| 指标 | 数值 |
|---|---:|
| 核心矩阵总耗时 | **1108.7s** |
| 平均每模型（11 用例） | **58.4s** |
| 最长 | `zed:gemini-3.8-flash` **230.8s** |
| 最短 | `openai-custom:glm-5.3` / `gemini-antigravity:claude-sonnet-5-5-medium` **14.3s** |
| E2E 总耗时 | **1431.0s** |

### 3.4 服务端异常

| 事件 | 次数 | 性质 |
|---|---:|---|
| `[Unary Retry]` | 4 个请求（1 个耗尽 5 次） | `openai-custom` 空响应；耗尽请求由 E2E 重试恢复 |
| `[Stream Retry]` | 1 个请求（重试 3 次后恢复） | `openai-custom` 空响应 |
| `Failed to write completion marker` | 0 | 收尾链路正常 |
| 上游 4xx | 1 | 定向用例预期：错误细节保留 |
| Gemini `MAX_TOKENS` 空内容 | 1 | 定向用例预期：合法截断 |

---

## 4. 本轮修复验收

### 4.1 F1/F2/F3：Responses→Gemini 请求语义

| 问题 | 修复 | 验收 |
|---|---|---|
| input 内 system/developer 被降级为 user | 并入 `systemInstruction`，与顶层 `instructions` 按顺序合并 | 单测 + 真实上游 developer/text.format E2E 通过 |
| `text.format` 丢失 | `json_object` / `json_schema` 映射为 `responseMimeType` / `responseSchema`，复用 Schema Polyfill | 真实 Gemini 返回 `{"tag":"ORION99","product":42}` |
| 多模态 `function_call_output` 数组形状 | 文本归一化为 `{content}`，图片/文件追加为同轮 `inlineData` | 合成验证 + 真实 Gemini 探针返回 200 |

### 4.2 F5：Chat→Antigravity thinking gating

`OpenAIConverter.modelSupportsThinking()` 已覆盖 `gpt-*`、`-thinking`、`-high`、`-medium`、Claude 5.5。当前 19 模型没有 Antigravity GPT，无法 E2E；单测验证 `gpt-6-luna` 会下发 `thinkingLevel: HIGH`。

### 4.3 F1/F6/F11：本轮收口

| 问题 | 修复提交 | 验收 |
|---|---|---|
| 非流式 HTTP 200 错误体被当成成功 | `524cdb7`：在 `handleUnaryRequest()` 前置识别错误 payload，返回 502 | 单测：mock 上游 `{error}` → HTTP 502 |
| Gemini 错误帧被静默吞掉 | `524cdb7`：转换器返回 null/空数组时抛 502，由统一错误响应接管 | 单测：Gemini→Chat/Responses/Claude 均产出错误事件 |
| `choices: []` / `candidates: []` 错误帧识别不到 | `524cdb7`：改为 `(choices?.length ?? 0) === 0` | 单测覆盖空数组与有内容两种形状 |
| `allOf` 丢 type/enum，scalar allOf 生成空 properties | `9c93bf0`：提升一致 type/items，enum 取交集，按需保留 properties/required | Schema 单测 + 探针 |
| `dependentSchemas` / `if-then-else` / 布尔 `not` 丢失 | `9c93bf0` + `e41c35f`：递归展开并注入 description | Schema 单测 + 探针 |
| system/developer-only 请求导致 Gemini 400 | `13f8e09`：converter 返回本地 400，明确提示缺少 user/assistant turn | 新增 E2E：7ms 返回 400，未请求上游 |
| 子 Schema description 中的 min/maxLength 等约束在摘要中丢失 | `78d7089`：`summarizeSchemaForDescription()` 读取 `schema.description` | Schema 单测：patternProperties / additionalProperties / if 的 min/maxLength 进入父摘要 |
| 阶段 2 裁剪修改不可达分支，虚减总描述长度 | `87a8d95`：只统计 properties/items/根节点；按节点合并并以真实描述差值裁剪；allOf/oneOf/$ref 登记父节点 | Schema 单测：allOf 实际总长 ≤ 上限；dependentSchemas 不再虚减 |

### 4.4 仍保留的协议/策略限制

1. **显式缓存标记**：`cache_control` 仍不可跨协议保留，只做 `cached_tokens → cache_read_input_tokens` 计费回填；工具稳定排序只在 Converter 路径生效。
2. **CoT 历史回放**：Anthropic 需要真实签名、官方 Responses 需要 `encrypted_content`，这两个方向仍保守跳过；`CONVERT_REPLAY_COT_SUMMARY=true` 仅对 Gemini 目标生效，默认关闭。
3. **签名隔离**：真实 Claude 签名不传给 Gemini，Gemini 原生签名由 `vsig1` 虚拟签名替代；严格校验签名的客户端可能不接受非标准格式。
4. **Schema 结构保真**：不支持的关键字通过 description 表达，而不是结构等价；`allOf` 类型冲突、`const`、复杂 `additionalProperties` 仍只能摘要。
5. **Provider 默认注入**：Codex 默认 `web_search`/`store`/`include`，Gemini 默认采样参数，Claude↔OpenAI 的 `max_completion_tokens` 调整；属于通道约定，已在架构文档声明。
6. **Reasoning 可用性**：60.5% 的文本用例返回 CoT，主要由 Provider/模型/采样决定；Zed Claude/Gemini 与 Antigravity Claude 不暴露 thought 文本。
7. **system-only 请求**：现在明确返回 400；这是客户端错误，不再伪装成上游 400。

---

## 5. 核心转译代码 review

### 5.1 调度与架构

- 入口 `src/convert/convert.js` 按 `getProtocolPrefix(from)` 选择 Converter；同协议前缀直接透传，跨协议才转换。
- `ConverterFactory` 缓存单例，流式状态通过 `StreamSessionStore` 按 requestId 隔离。
- 仍是点对点转换器，不是统一 IR；`Responses → Chat → Trae` 双层路径仍存在，但本轮 19 模型主链路未暴露问题。

### 5.2 请求方向

| 能力 | 当前实现 | 评价 |
|---|---|---|
| System / instructions | Chat→Gemini 多 system part 保留；Responses→Gemini 顶层 instructions + input system/developer 合并；Claude/Responses 多 system 拼接 | 内容保留；作用域边界仍有语义折叠 |
| 连续同角色 | `mergeConsecutiveSameRoleContents()` 在 parts/content 级合并 | 19/19 通过 |
| 思考预算 | canonical 五档表；Gemini 3 `thinkingLevel`；Claude budget↔effort | 5 档→3 档量化仍存在 |
| 工具 Schema | `polyfillSchemaForGemini()` + 白名单清洗 | `$ref`、`oneOf/anyOf`、`allOf`、`patternProperties`、`additionalProperties`、`not`、`dependentRequired`、`dependentSchemas`、`if/then/else` 已覆盖；复杂结构仍降级为 description |
| custom tool | 请求级登记 + function 降级 + 响应还原 | 单测覆盖；真实上游未全量验证 |
| 思考签名 | `vsig1` 虚拟签名 + 上游剥离 | 客户端兼容优先；原生签名链不可恢复 |
| 多模态 | 图片 base64/URL、Claude document、Responses input_file、Gemini inlineData/fileData | 主路径可用；工具结果多模态仅提取文本/图片 |
| 结构化输出 | Chat→Responses/Gemini、Responses→Gemini 均映射 | 真实 E2E 通过 |
| 显式缓存 | 仅 warn/debug + 计费回填 | 协议无等价字段 |

### 5.3 响应与流式方向

| 能力 | 当前实现 | 评价 |
|---|---|---|
| Chat 流式 | 各 Converter `toOpenAIStreamChunk` | 57/57 生命周期通过 |
| Responses 流式 | `ResponsesSseEmitter` + `StreamSessionStore` | `.done` 无 delta 时补正文；35/35 通过 |
| Claude 流式 | `AnthropicSseEmitter` + 请求级 block index | thinking 自动铸造 `vsig1` |
| usage | `usage-normalizer.js` + 各 Converter | Gemini thoughts 并入 output；`reasoning_tokens <= output_tokens` |
| finish reason | `mapFinishReason()` + pipeline `hasToolCall` 修正 | 截断/安全类有专门映射 |
| 空响应护栏 | 首内容前缓冲 + 5 次预算 + 2MB/2000 帧上限 | 本轮 4 次重试均恢复 |
| 流内错误 | `isInStreamErrorPayload()` 识别 `response.failed` / `error` / `data.error`；转换器无法表达时抛 502 | 同协议/跨协议单测覆盖；错误帧不再触发空响应重试或补完成帧 |
| 结束帧幂等 | OpenAI 无条件 `[DONE]`；Responses/Claude 兜底合成 | 正常与错误路径均通过 |

### 5.4 Provider 适配层

| Provider | 关键改写 | 评价 |
|---|---|---|
| `gemini-antigravity` | 模型过滤、Claude 5.5/GPT thinking、流式 thinking 回退、Schema Polyfill、工具 id 兜底 | 覆盖完整 |
| `openai-codex-oauth` | 展开 body + 删除清单 + 强制注入、长工具名映射、默认 `web_search` | 工具链可靠 |
| `zed` | Anthropic/OpenAI/Google 三分支；Google 工具历史降级文本；adaptive thinking | 三分支复杂但稳定 |
| `trae` / `trae-chat_v3` | 3 档 effort、parameters 字符串化、ToB/个人分支 | 与上游结构贴合 |
| `openai-custom` | 强制 `tool_choice` 降级、SSE 假非流式聚合、空响应重试 | 实测有效 |

### 5.5 测试与覆盖

- 单元测试 29 suites / 489 tests，覆盖 F1~F6/F11 与摘要/裁剪边界的新增分支。
- E2E 35 项：19 模型核心矩阵 + 16 定向；真实上游验证 developer/text.format、system-only 400、三协议流式工具、CoT 回放、Schema `oneOf`。
- 仍缺：并行工具、工具参数增量流式、custom tool 真实调用、PDF/远程图片、显式 cache_control、真实流内错误帧。

---

## 6. 评分

| 维度 | 分数 | 依据 |
|---|---:|---|
| 文本与流式主链路 | **5.0** | 114/114 文本、57/57 流式生命周期 |
| 单轮工具 | **5.0** | 57/57；强制 `tool_choice` 定向通过 |
| 多轮工具 | **4.9** | 19/19；CoT 历史仍有物理约束 |
| Reasoning 转发 | **4.5** | 上游提供时映射正确；69/114 可用性由 Provider/采样决定 |
| System / 角色语义 | **4.8** | `ZEBRA42`、developer/text.format、system-only 400 均通过 |
| Schema 保真 | **4.4** | 组合关键字已覆盖；结构仍降级为 description |
| 多模态 | **4.3** | 图片/PDF 主路径可用；覆盖不足 |
| Prompt Caching | **3.5** | 显式 `cache_control` 不可保留 |
| 流式/重试健壮性 | **4.8** | 错误终态、空响应护栏、收尾幂等均收口 |
| **综合** | **4.6** | 主链路满分，剩余为协议物理限制与覆盖边界 |

---

## 7. 建议

### 已完成（本轮）

1. 非流式错误体 502；Gemini 错误帧下游化；空数组错误帧识别。
2. `allOf` type/enum/items；`dependentSchemas` / `if-then-else` / 布尔 `not`。
3. system/developer-only 请求本地 400。
4. 文档与 E2E 统计同步。

### 后续可选

1. 为真实上游构造 `response.failed` / `event: error` 定向用例；目前只有 mock 单测。
2. 增加并行工具调用、工具参数增量流式、custom tool 真实调用、PDF/远程图片用例。
3. 评估是否对 Gemini 目标默认开启 `CONVERT_REPLAY_COT_SUMMARY`（需要更多真实上游样本）。
4. 若未来需要保留 Gemini 原生签名链，可在 `vsig1` 中封装原始签名（有状态或加密）。
5. 复杂 Schema 可继续补充 `const` 合并、`additionalProperties` 深层摘要、`minProperties` / `maxProperties`。

---

## 8. 复现方式

```bash
# 1) 启动隔离实例
node src/services/api-server.js --port 3201

# 2) 确认模型列表
curl -H "Authorization: Bearer <REQUIRED_API_KEY>" \
  http://127.0.0.1:3201/auto/v1/models

# 3) 19 模型全量 E2E（reasoning high）
AICLIENT_E2E_BASE=http://127.0.0.1:3201/auto npm run test:e2e

# 4) 单元测试
npx jest --runInBand --silent
```

本次结果：

```text
Test Suites: 1 passed, 1 total
Tests:       35 passed, 35 total
Time:        1430.953 s

单元测试：29 suites / 489 tests 全绿
```

---

## 9. 关键文件索引

| 主题 | 文件 |
|---|---|
| 转换调度 | `src/convert/convert.js`、`src/converters/ConverterFactory.js` |
| 请求编排 / 重试 / 错误终态 | `src/handlers/request-pipeline.js` |
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
| Provider 能力 | `src/providers/provider-capabilities.js`、`src/providers/model-capability.js` |
| Provider 适配 | `src/providers/openai/openai-core.js`、`src/providers/openai/codex-core.js`、`src/providers/zed/zed-core.js`、`src/providers/gemini/antigravity-core.js`、`src/providers/trae/trae-core.js` |
| E2E | `tests/e2e/cross-protocol.e2e.test.js`、`tests/e2e/e2e-helpers.js` |
