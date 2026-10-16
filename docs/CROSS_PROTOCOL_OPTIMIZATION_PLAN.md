# AIClient2API 跨协议转译优化实施方案

> **版本**：v1.0.0（方案定稿，待实施）
> **制定日期**：2026-10-16
> **上游依据**：[CROSS_PROTOCOL_EVALUATION_AND_OPTIMIZATION.md](./CROSS_PROTOCOL_EVALUATION_AND_OPTIMIZATION.md) v1.1.0（源码核查定稿版）
> **方案性质**：将评估文档第五节的理论优化体系落地为可分阶段执行的工程方案；全部代码位置已于制定当日对照 `main` 分支（v3.10.0）源码逐一核实
> **当前状态**：本文档仅包含方案设计，**不含任何代码改动**

---

## 目录

- [一、现状诊断：已核实的损耗点清单](#一现状诊断已核实的损耗点清单)
- [二、总体策略：为什么价值优先于架构](#二总体策略为什么价值优先于架构)
- [三、Phase 0：定点修复包（5-7 人日）](#三phase-0定点修复包5-7-人日)
- [四、Phase 1：Schema Polyfill 降级编译器（6-8 人日）](#四phase-1schema-polyfill-降级编译器6-8-人日)
- [五、Phase 2：签名金库（3-5 人日）](#五phase-2签名金库3-5-人日)
- [六、Phase 3：Responses SSE Emitter 收编（6-9 人日）](#六phase-3responses-sse-emitter-收编6-9-人日)
- [七、Phase 4：可选增强（2-3 人日）](#七phase-4可选增强2-3-人日)
- [八、Phase 5：IR AST 长期演进（25-40 人日，暂不启动）](#八phase-5ir-ast-长期演进25-40-人日暂不启动)
- [九、不建议实施清单（含理由）](#九不建议实施清单含理由)
- [十、收益汇总与落地节奏](#十收益汇总与落地节奏)
- [附录 A：关键代码位置索引](#附录-a关键代码位置索引)

---

## 一、现状诊断：已核实的损耗点清单

下表 7 项损耗均已对照源码确认（非文档转述），构成 Phase 0-2 的直接修复对象。架构层面的三项结构债（换算表四份漂移、Responses 流式状态分散、合并逻辑三处重复）列入 Phase 3-4。

| # | 损耗点 | 代码位置 | 影响组合 | 现状行为 |
| :---: | --- | --- | :---: | --- |
| L1 | **预算阈值失效** | `src/converters/utils.js:385-407` `determineReasoningEffortFromBudget`，阈值 `LOW=50 / HIGH=200` | 17/18/19 | 常规预算（如 3072）全部坍缩为 `high`，`medium` 档名存实亡 |
| L2 | **Responses→Gemini 思考配置丢失** | `src/converters/strategies/OpenAIResponsesConverter.js:1117` `toGeminiRequest` 全程不读取 `reasoning.effort`（生成配置段 :1270-1281 仅处理 temperature/maxOutputTokens/topP） | 12 | 思考配置静默丢失 |
| L3 | **Responses→OpenAI 思考项蒸发** | `OpenAIResponsesConverter.js:169-243` `toOpenAIRequest` 的 switch（:173）仅 4 个 case，无 `reasoning`/`item_reference` 分支且无 default；响应侧 `toOpenAIResponse`（:299-331）同样丢弃 reasoning output item | 09 | `reasoning` 思考项与 `item_reference` 引用项被静默丢弃 |
| L4 | **Claude document 块全方向静默丢弃** | `ClaudeConverter.js` →Gemini :997-1133、→OpenAI :797-909、→Responses :1894-1944、→Codex :2441-2479，均无 `document` case、无 default、无日志 | 17/18/19/20 | PDF 块整块蒸发，客户端无任何感知 |
| L5 | **签名闭环三处残余缺口** | ① <50 字符签名静默丢弃：`ClaudeConverter.js:1011-1014`（请求）、`:1364-1367`/`:1385-1387`（响应）；② 流式去程 `signature_delta` 直接 `return null`：`:1509-1514`；③ `redacted_thinking` 降级无日志：`:1019-1027` | 20 | 流式路径下签名根本到不了 Gemini；短签名与 redacted 块无声降级 |
| L6 | **Claude→非 Claude 上游思考签名断裂** | Claude→OpenAI/Responses/Codex 方向 thinking 块 `signature` 无处存放，多轮回传链断裂 | 17/18/19 | Claude Code CLI 多轮 + 工具调用场景客户端侧报错风险 |
| L7 | **JSON Schema 7 键白名单硬清洗** | `src/converters/utils.js:319-329` `cleanJsonSchemaProperties`（白名单 :164-172）；调用点 `OpenAIConverter.js:1286,1299`、`src/providers/gemini/antigravity-core.js:501-516` | 04/12/20 | `pattern`/`$ref`/`oneOf`/`format`/`default`/数值边界直接剥除，复杂工具调用失败主因 |

**结构债（非静默丢失，但放大维护成本）**：

- D1 **预算换算表四份漂移**：OpenAI→Gemini 2.5（`OpenAIConverter.js:1401-1414`：1024/8192/24576）、OpenAI→Claude（`:386-394`：2048/4096/8192）、Responses→Claude（`OpenAIResponsesConverter.js:647-667`：1024/2048/8192/20000/32000）、zed 通道（`zed-core.js:622-628, 708-714`：2048/4096/8192）——同一 effort 语义在不同路径数值不一。
- D2 **Responses 流式状态所有权分散**：Claude 事件链已收编进 `AnthropicSseEmitter`（`src/converters/anthropic-sse-emitter.js`，225 行，三转换器复用），而 Responses 事件输出仍是「全局单例 `streamStateManager` + 生成器函数（`src/providers/openai/openai-responses-events.js`，399 行）+ 各转换器自建状态对象」混合体。
- D3 **parts 级同角色合并逻辑三处重复**：`OpenAIConverter.js:1140-1153`、`ClaudeConverter.js:1152-1165`、`OpenAIResponsesConverter.js:1325-1341` 近乎逐字相同；另有 `OpenAIConverter.js:285-324`、`OpenAIResponsesConverter.js:190-191`、`trae-core.js:606-625` 三处相关合并。

---

## 二、总体策略：为什么价值优先于架构

评估文档第五节的理论路线为「IR AST → Schema Polyfill → 签名金库 → DFA」，本方案**调整执行顺序**，理论结论全部保留：

| 阶段 | 内容 | 性质 | 风险 | 工作量 |
| :---: | --- | --- | :---: | :---: |
| **Phase 0** | 定点修复包（L1-L5 + D1） | 纯增量修复 | 低 | 5-7 人日 |
| **Phase 1** | Schema Polyfill 降级编译器（L7） | 独立新模块 | 低-中 | 6-8 人日 |
| **Phase 2** | 签名金库（L6，修正为无状态 HMAC） | 独立新模块 | 中 | 3-5 人日 |
| **Phase 3** | Responses SSE Emitter 收编（D2） | 重构 | 中 | 6-9 人日 |
| **Phase 4** | 可选增强（D3 去重、tools 稳定排序、cache_control 日志化） | 增量 | 低 | 2-3 人日 |
| **Phase 5** | IR AST strangler-fig 长期演进 | 架构级 | 高 | 25-40 人日 |

**与理论路线偏离的三点理由**：

1. **Phase 0 先于一切**：预算坍缩、`reasoning.effort` 丢失、document 蒸发属于「正确性 bug」而非「架构债」，行级修复即可拿到 Tier 提升，无需等待任何架构前置。
2. **IR AST 降为长期演进**：全量重写 11k 行 N×M 转换器的回归面是 24 组合 × 流式/非流式 × golden 事件序列，性价比极低。改为 strangler-fig 模式——新转换路径强制走 IR，存量组合按需逐对迁移（见第八节）。
3. **DFA 全量重构降级为 Emitter 收编**：上游 SSE 本身是单连接有序流，「无序/断裂 chunk 防抖重排」的需求在本架构中不成立；真正痛点是状态所有权分散，Phase 3 以 AnthropicSseEmitter 为模板收编即可解决主要问题，成本约为 DFA 重构的 1/4。

---

## 三、Phase 0：定点修复包（5-7 人日）[已落地 v1.2.0]

### 0.1 统一思考预算换算（1.5 人日）

**新增模块**：`src/converters/thinking-budget.js`

```js
// @ts-check
// 导出：
//   budgetTokensToEffort(budget) -> 'low'|'medium'|'high'     // Claude → OpenAI 系
//   effortToClaudeBudget(effort) -> number                    // OpenAI/Responses → Claude 五档规范表
//   effortToGeminiThinking(effort, { modelFamily })           // Gemini 3: thinkingLevel / 2.5: thinkingBudget 双轨
//   isGemini3Model(model) -> boolean                          // 从 OpenAIConverter 提取，供两处复用
//   EFFORT_LEVELS = ['minimal','low','medium','high','xhigh','max']
```

**关键决策**：

- **`budgetTokensToEffort` 新阈值**：`low ≤ 2048`、`medium ≤ 8192`、`high > 8192`。依据：与 Responses→Claude 既有五档表互为逆映射、可往返（round-trip）自洽；旧阈值 50/200 无任何模型语义依据。
- **规范五档表**：采纳 `OpenAIResponsesConverter.js:647-667` 既有表为 canonical——`minimal→1024 / low→2048 / medium→8192 / high→20000 / xhigh·max→32000`。`OpenAIConverter.js:386-394` 与 `zed-core.js:622-628, 708-714` 改为引用此表。
- **Gemini 双轨表不动**：2.5 系 `low→1024 / medium→8192 / high→24576 / max·xhigh→32768` 是 Gemini 侧约束而非 bug，仅迁移进新模块统一管理。

**改动点**：

- `src/converters/utils.js:385` — `determineReasoningEffortFromBudget` 改为委托 `budgetTokensToEffort`（保留旧导出名做兼容 wrapper，标 `@deprecated`）。
- `OpenAIConverter.js:386-394`、`:1398-1415` — 替换为新模块调用；`isGemini3Model`（`:1371-1375`）提取至新模块。
- `OpenAIResponsesConverter.js:647-667` — 替换。
- `src/providers/zed/zed-core.js:622-628, 708-714` — 替换。

**测试**：新增 `tests/thinking-budget.test.js`——五档往返映射、`budget→effort` 边界值（2047/2048/2049、8192/8193）、null 默认行为、Gemini 3 vs 2.5 分流。`tests/converters.test.js` 中对旧阈值有断言的用例同步更新。

**回滚**：调用点集中在 4 个文件，git revert 单 commit 即可。

### 0.2 Responses→Gemini 思考配置丢失修复（0.5 人日）

**改动**：`OpenAIResponsesConverter.toGeminiRequest`（:1117）generationConfig 组装处调用 0.1 的 `effortToGeminiThinking(responsesRequest.reasoning?.effort, { modelFamily })`，`modelFamily` 判定复用新模块提取的 `isGemini3Model`。

**测试**：`tests/converters.test.js` 增加 Responses→Gemini 带 `reasoning: { effort: 'low' }` 用例，断言 `generationConfig.thinkingConfig` 存在且档位正确。

### 0.3 Responses→OpenAI 的 reasoning / item_reference 保留（1 人日）

**设计决策**：

- 请求侧 `reasoning` item → 折入紧随其后的 assistant 消息；若无后续 assistant 消息则自建 `{ role: 'assistant', content: '', reasoning_content: <summary 拼接> }`。`encrypted_content` 无法翻译，丢弃但 debug 日志记录一次。
- **风险与开关**：部分严格 OpenAI 兼容上游对 messages 内未知字段报 400——用 env 开关 `CONVERT_PRESERVE_REASONING_ITEM`（默认开，遇上游报错可关）。
- `item_reference` → 无法解析（网关无服务端 item 存储），**显式 debug 日志 + 跳过**。消灭静默是本次修复的底线要求。
- 响应侧 reasoning output item → `choices[0].message.reasoning_content = summary 文本拼接`；流式侧 reasoning summary 增量帧补齐 `.done` 合流。

**测试**：`converters.test.js` 加 reasoning item 双向用例；item_reference 断言日志调用（mock logger）。

### 0.4 Claude document 块全方向处理（1.5 人日）

**各方向降级策略**：

| 目标方向 | 策略 | 保真度 |
| --- | --- | --- |
| →Gemini | `{ inlineData: { mimeType: block.source.media_type, data: block.source.data } }`（Gemini 原生支持 application/pdf inlineData）；>20MB 走 debug 日志 + 文本占位降级 | **无损** |
| →Responses | `{ type: 'input_file', file_data: 'data:application/pdf;base64,...' }`（Responses API 原生支持） | 接近无损 |
| →Codex | Codex 后端对 input_file 支持不确定 → 默认文本占位 + env 开关 `CODEX_PDF_AS_INPUT_FILE=1` 允许尝鲜 | 有损兜底 |
| →OpenAI chat | chat completions 无标准文档载体 → 文本占位 `[Document: <title‖'untitled'> (application/pdf, <bytes> bytes) omitted — upstream cannot receive files]`，**且必须 logger.warn**（每请求每块一次） | 有损兜底 |

**测试**：`converters.test.js` 四个方向各一个 document 块用例（Gemini 断 inlineData、Responses 断 input_file、OpenAI 断占位符 + warn）。

### 0.5 思考签名闭环加固（1.5 人日）

1. **<50 字符签名**：改为原样传递（无证据表明 Gemini 校验 thoughtSignature 最小长度），加 debug 日志记录短签名事件；若后续实测 Gemini 拒收，再改为丢弃 + warn。
2. **流式 `signature_delta` 缓冲转发**（本阶段技术含量最高点）：Claude 流中 signature_delta 紧跟 thinking_delta 序列之后。在 Claude→Gemini 流式转换的会话状态（`StreamSessionStore`）中缓冲最后一个 thinking part，收到 signature_delta 时补发一个 Gemini chunk：`{ parts: [{ text: '', thought: true, thoughtSignature: sig }] }`（空文本 part 仅携带签名）。回程还原逻辑（`GeminiConverter.js:798-814`）读取 `part.thoughtSignature` 与 text 无关，自洽；实施时需验证 Gemini 流式消费端对空 text part 的容忍度。
3. **redacted_thinking**：占位符保留，加 logger.warn（含块大小）。

**测试**：扩展 `tests/gemini-claude-stream.test.js` golden 序列——thinking_delta* → signature_delta 场景断言出现带 thoughtSignature 的 chunk。

### Phase 0 预期收益

| 组合 | 变化 |
| --- | --- |
| 12（Responses→Gemini） | Tier 2~3 → **Tier 2**（effort 映射恢复） |
| 09（Responses→OpenAI） | Tier 2 → **Tier 1~2**（reasoning 不再蒸发） |
| 17/18/19（Claude→OpenAI/Responses/Codex） | 预算坍缩修复，medium 档复活 |
| 20（Claude→Gemini） | document 无损化 + 流式签名闭环，Tier 2~3 → **Tier 2** |

---

## 四、Phase 1：Schema Polyfill 降级编译器（6-8 人日）[已落地 v1.3.0]

**新增模块**：`src/converters/schema-polyfill.js`

```js
// @ts-check
// 导出：
//   polyfillSchemaForGemini(schema, options) -> { schema, report }
//   options: { injectConstraints?: boolean (默认 true),
//              maxDescriptionLength?: number (默认 1000),
//              maxRefDepth?: number (默认 10),
//              dialect?: 'gemini' | 'trae' }
//   report:  { expandedRefs: number,
//              injectedConstraints: [{ path, kinds }],
//              collapsedOneOf: [{ path }],
//              truncated: boolean }
```

**内部流水线（纯函数，三段式）**：

1. **`$ref` 静态展开**：以 root schema 的 `$defs`/`definitions`/`$ref: '#/...'` 为解析域做内联展开；带循环检测（路径栈）+ 深度上限 10，超限坍缩为 `{ type: 'object', description: '[recursive schema collapsed]' }`。展开后剥离 `$defs`/`definitions`/`$schema`/`$id`。
2. **约束自然语言化注入**：对被白名单剥除的键（`pattern`/`format`/`default`/`const`/`minimum`/`maximum`/`exclusive*`/`minLength`/`maxLength`/`minItems`/`maxItems`/`uniqueItems`/`multipleOf`），不丢弃，转为 description 后缀：
   - **注入格式**：`原描述 [Constraints: pattern=^[A-Z]{3}-[0-9]{4}$; format=date-time; min=1; max=100]`。英文 `Constraints:` 前缀 + 分号分隔 `key=value`，模型无关、token 经济（约 8-15 token/字段）。
   - **长度控制**：单字段注入串上限 200 字符，整 schema description 总量上限 1000 字符；超限按「叶子字段优先保留、根级 aggregate 字段优先裁剪」丢弃注入，置 `report.truncated` + debug 日志。**原始 description 文本永不裁剪**，只裁注入部分。
3. **组合关键字降级**：
   - `oneOf`/`anyOf` 各分支 type 一致 → 保留该 type，description 注入 `One of: <各分支摘要>`（分支摘要 = enum 值列表或 type+关键约束，截断 120 字符）；
   - type 不一致 → 删除 type 字段（比宽松 `type: 'object'` 更不易误导 Gemini Protobuf 校验），description 注入分支摘要；
   - `allOf` 做浅合并（properties/required 并集）。

**接入点**（不改 `cleanJsonSchemaProperties` 本体，在其调用点前置 polyfill；description 在白名单内，注入结果天然通过清洗）：

- `OpenAIConverter.js:1286, 1299`
- `src/providers/gemini/antigravity-core.js:501-516`
- Trae 通道（`trae-core.js:657-678` parameters 字符串化处）留 `dialect: 'trae'` 接口，**本期不接入**。

**Env 开关**：`CONVERT_SCHEMA_POLYFILL`（默认 on）、`CONVERT_SCHEMA_POLYFILL_MAX_DESC`（默认 1000）。在 `src/core/config-manager.js` 参照 `REQUEST_BODY_MAX_BYTES`（:29-42）的 env 解析模式注册。

**测试**：新增 `tests/schema-polyfill.test.js`（约 20 用例）——$ref 展开/循环/超深、pattern/format 注入格式、长度截断顺序、oneOf 同型/异型、allOf 合并、与 `cleanJsonSchemaProperties` 串联后的端到端断言、真实 Claude Code 工具集 fixture（含 oneOf 的 Edit/Write 工具 schema）。

**风险与回滚**：注入约束轻微增加 prompt token（每工具约 50-150 token），长工具列表场景有成本——env 开关可整体回退到纯清洗；`report` 结构保留以便未来接 IR。

**预期收益**：组合 04/20 复杂工具场景 Tier 2~3 → **Tier 1~2**；组合 22-24 间接受益。

---

## 五、Phase 2：签名金库（3-5 人日）[已落地 v1.4.0]

### 对评估文档 §5.3 提案的两点关键修正

**修正一：虚拟签名不需要「伪装成合法 Claude 签名」**。Claude Code CLI **不在本地校验签名**——签名校验只发生在 api.anthropic.com 服务端，CLI 对 thinking 块的行为是原样回传。因此虚拟签名只需：(a) 非空不透明字符串，让 CLI 回传路径不报错；(b) 网关自己能识别「这是我签的」以便安全剥离。伪造 Anthropic 服务端签名在密码学上不可能，也无必要。

**修正二：存储金库降级为无状态 HMAC**。HMAC 自校验，无需带 TTL 的签名存储，省掉状态一致性难题。

### 风险边界

若会话中途切换到真 Anthropic 上游（`claude-custom`/`zed`/`kiro`），虚拟签名会被 Anthropic 服务端拒收（400 invalid signature）——**必须在发往 Claude 协议前缀上游的方向无条件剥离虚拟签名**；反之真签名永不剥离（Gemini 方向 thoughtSignature 闭环依赖真签名）。

### 设计

**新增模块**：`src/converters/signature-vault.js`

```js
// @ts-check
// 导出：
//   mintVirtualSignature({ sessionKey, blockIndex, thinkingText }) -> string
//     格式: "vsig1.<base64url(sessionKeyHash|blockIndex|textHash)>.<base64url(HMAC-SHA256)>"
//   isVirtualSignature(sig) -> bool        // 前缀识别，O(1)
//   verifyVirtualSignature(sig) -> bool    // HMAC 重算
//   stripVirtualSignatures(messages) -> { messages, stripped: number }
```

**关键决策**：

- **密钥来源**：进程级 secret——优先 env `SIGNATURE_VAULT_SECRET`；缺省时启动时 `crypto.randomBytes(32)` 生成（进程内自洽，与 `StreamSessionStore` 同为进程内语义，一致）。不做持久化、不做多实例共享。
- **无状态、无 TTL**。
- **注入点**：X→Claude 响应转换中，凡 thinking 块无 signature 且目标客户端为 Claude 协议时（AnthropicSseEmitter 输出侧 / 非流式组装侧），调用 `mintVirtualSignature`；`sessionKey` 取管道层已有的 `streamRequestId`。
- **剥离点**：`ClaudeConverter` 各 `toXxxRequest` 入口统一 `stripVirtualSignatures`——凡 `isVirtualSignature` 的 thinking 块**整块移除**（非 Claude 上游不需要思考回放，避免脏数据干扰）；真签名块原样保留。
- **降级策略**：`isVirtualSignature` 为 true 但 HMAC 校验失败（进程重启换密钥）→ 仍按虚拟签名剥离（前缀识别足够，HMAC 仅防客户端伪造前缀注入垃圾）。**永不因签名问题让请求失败**。

**Env 开关**：`SIGNATURE_VAULT=off` 总开关；剥离逻辑独立于注入逻辑，可分别开关。

**测试**：新增 `tests/signature-vault.test.js`——mint/verify/isVirtual 往返、篡改检测、strip 只剥虚拟不剥真实、Claude→OpenAI 端到端（thinking 块消失）、OpenAI→Claude 端到端（出现 `vsig1.` 前缀签名）、模拟重启后旧签名仍被剥离。

**预期收益**：组合 17/18/19 → **Tier 1**（配合 Phase 0 预算修复，Claude Code CLI 接非 Claude 上游的多轮思考体验完整）。

---

## 六、Phase 3：Responses SSE Emitter 收编（6-9 人日）【已落地 v1.5.0】

**新增模块**：`src/converters/responses-sse-emitter.js`，严格镜像 `AnthropicSseEmitter` 的实例化模式：

```js
// @ts-check
export class ResponsesSseEmitter {
    constructor({ requestId, model, store })  // store = StreamSessionStore，并发隔离靠它而非全局单例
    start() -> events[]                       // response.created + response.in_progress
    textDelta(text) / textDone()
    reasoningDelta(text) / reasoningDone()
    toolCallStart(id, name) / toolCallArgsDelta(d) / toolCallDone()
    complete(usage) -> response.completed
    // 内部维护 outputIndex / itemId / contentPart 生命周期，幂等（重复 done 不重复发）
}
```

**迁移策略（strangler-fig）**：

1. `openai-responses-events.js` 的生成器函数**不删除**——ResponsesSseEmitter 首版内部直接委托它们生成事件字符串，只收编**状态所有权**（从全局 `streamStateManager` 单例迁入实例 + StreamSessionStore）。
2. 逐个转换器迁移：OpenAIConverter 的 Responses 方向 → GeminiConverter（`:1270-1301` 自建状态）→ ClaudeConverter（`toOpenAIResponsesStreamChunk` :2083）→ OpenAIResponsesConverter 自建状态对象。每迁一个跑一次 golden 测试。

**测试**：新增 `tests/responses-sse-emitter.test.js`（对标 `tests/anthropic-sse-emitter.test.js` 的生命周期/幂等/多工具交叉用例）。**硬验收标准**：既有 `openai-claude-stream.test.js`、`gemini-claude-stream.test.js`、`codex-claude-stream.test.js` 等 golden 测试输出零变化。

**风险**：流式并发隔离语义变化（全局 → 实例），需审查所有 `streamStateManager` 直引用点；回滚按转换器粒度 revert。

**定位**：这是评估文档 §5.5 DFA 提案的现实落地形态（全量 DFA 不做的理由见第九节）。

---

## 七、Phase 4：可选增强（2-3 人日）

1. **合并逻辑去重**：三处 parts 级同角色合并提取为 `src/converters/utils.js` 的 `mergeConsecutiveSameRoleContents(contents, rolePair)` 纯函数 + 单测。评估文档 §5.3-2 的「虚拟轮次隔离边界符」**不做**（见第九节）。
2. **前缀对齐（大幅降级 §5.4 范围）**：不重排消息（破坏角色交替语义）。仅做 **tools 数组按 name 稳定排序**（env 开关 `CONVERT_SORT_TOOLS`，默认 off 先观测），消除同一客户端多请求间工具顺序抖动对隐式前缀缓存的干扰。system 与 tools 本就在 messages 之前，无需移动。
3. **cache_control 日志化**：跨协议显式缓存 polyfill（如 Gemini cachedContent API）**不做**（资源生命周期管理成本远超收益）。仅补：转换器丢弃 `cache_control` 时 debug 日志一次/字段，消灭「静默」。响应侧 `cached_tokens → cache_read_input_tokens` 回填已存在（`OpenAIConverter.js:431-432, 516-517`、`OpenAIResponsesConverter.js:849, 873`、`GeminiConverter.js:712-713, 774-775`、`CodexConverter.js:1035, 1564`），不动。

---

## 八、Phase 5：IR AST 长期演进（25-40 人日，暂不启动）

建议形态：

- 先以 JSDoc typedef 定义 `UnifiedChatIR`（纯类型，零运行时成本）；
- 新转换路径（如未来新增协议）强制走 IR（$T_{in}: P_{client} \to IR$，$T_{out}: IR \to P_{upstream}$）；
- 存量 24 组合仅在「该组合出现 Phase 0-3 修不动的结构性损耗」时逐对迁移；
- 双层级联路径（Responses→Chat→Trae、Claude→OpenAI→Trae，即组合 14-16、22-24）是唯一值得优先 IR 化的路径。

**本季度不排期**。

---

## 九、不建议实施清单（含理由）

| # | 评估文档提案 | 结论 | 理由 |
| :---: | --- | :---: | --- |
| 1 | §5.3-1 虚拟 HMAC 签名「伪装成合法 Claude 签名」 | **修正** | CLI 不做本地签名校验，无需也不可能伪造 Anthropic 服务端签名；降级为「自识别前缀 + 进程级 HMAC 无状态虚拟签名」，核心价值是让网关能区分真假签名从而安全剥离（Phase 2 已采纳修正版） |
| 2 | §5.4-1 前缀缓存物理对齐（重排请求体） | **大部分不做** | 重排消息违反 Gemini/Claude 角色交替硬约束；隐式前缀缓存只认 token 序列前缀一致，网关侧可安全操作的仅 tools 稳定排序一项，且收益未经实测——降级为 Phase 4 可选项，先观测 `cached_tokens` 再决定投入 |
| 3 | §5.5 DFA 全量流式重构 | **不做全量版** | 上游 SSE 是单连接有序流，「无序 chunk 防抖重排」需求不成立；真正痛点是状态所有权分散，Phase 3 收编已解决主要问题，成本约为 DFA 重构的 1/4 |
| 4 | §5.3-2 Part 级虚拟轮次隔离边界符 | **不做** | 现有 parts 级合并已保留各段为独立 part；插入不可见边界符属污染语义的投机优化，收益未证实 |
| 5 | cache_control 跨协议 polyfill | **不做，仅日志化** | Anthropic 显式缓存与 OpenAI/Gemini 隐式缓存是不同资源模型，伪造 cache_control 语义无法影响上游计费与命中；且 Anthropic 上游方向（zed/kiro）本就有透传/cachePoint 机制幸存 |

---

## 十、收益汇总与落地节奏

| 阶段 | 工作量 | 直接受益组合 | Tier 变化 |
| :---: | :---: | :---: | --- |
| Phase 0 | 5-7 人日 | 09, 12, 17, 18, 19, 20 | 12: 2~3→2；09: 2→1~2；20: 2~3→2；17/18/19 预算修复 |
| Phase 1 | 6-8 人日 | 04, 12, 20（22-24 间接） | 04/20 复杂工具场景 →1~2 |
| Phase 2 | 3-5 人日 | 17, 18, 19 | → Tier 1 |
| Phase 3 | 6-9 人日 | 全部 Responses 流式方向（02, 09, 12, 13, 18 等） | Tier 不变，消除事件乱序/状态污染类 bug |
| Phase 4 | 2-3 人日 | 全部（可观测性） | — |
| **合计** | **22-32 人日** | | **消除全部已确认 Tier 3 因素** |

**落地节奏**：

1. Phase 0 作为独立 PR（bug fix 性质，可快速合入发布）；
2. Phase 1、2 各自独立 PR；
3. Phase 3 按转换器分 3-4 个 PR；
4. **每阶段完成后同步更新评估文档** `CROSS_PROTOCOL_EVALUATION_AND_OPTIMIZATION.md` 的全景矩阵评级与第八节修订记录（沿用 v1.0.0→v1.1.0 的修订惯例），保持「评估—优化」双文档闭环。

---

## 附录 A：关键代码位置索引

**损耗点**

| 位置 | 说明 |
| --- | --- |
| `src/converters/utils.js:319-329` | `cleanJsonSchemaProperties`（白名单 :164-172，enum 特判 :272-281） |
| `src/converters/utils.js:385-407` | `determineReasoningEffortFromBudget`（阈值 :391-392） |
| `src/converters/strategies/OpenAIConverter.js:386-394` | OpenAI→Claude 预算表 |
| `src/converters/strategies/OpenAIConverter.js:1169-1197, 1371-1414` | reasoning_effort→Gemini 双轨映射、`isGemini3Model`、`applyReasoningEffortToGemini` |
| `src/converters/strategies/OpenAIConverter.js:1286, 1299` | Schema 清洗调用点 |
| `src/converters/strategies/OpenAIResponsesConverter.js:169-243` | `toOpenAIRequest`（reasoning/item_reference 丢弃点） |
| `src/converters/strategies/OpenAIResponsesConverter.js:299-331` | `toOpenAIResponse`（reasoning output 丢弃点） |
| `src/converters/strategies/OpenAIResponsesConverter.js:647-667` | `_mapReasoningToClaudeThinking`（canonical 五档表） |
| `src/converters/strategies/OpenAIResponsesConverter.js:1117, 1270-1281` | `toGeminiRequest`（reasoning.effort 丢失点） |
| `src/converters/strategies/ClaudeConverter.js:347, 1790, 2491-2493` | budget→effort 调用点 |
| `src/converters/strategies/ClaudeConverter.js:917, 1011-1027, 1050, 1063` | 签名常量、请求侧签名门槛、redacted_thinking 降级 |
| `src/converters/strategies/ClaudeConverter.js:1364-1387, 1509-1514` | 响应侧签名门槛、流式 signature_delta 丢弃点 |
| `src/converters/strategies/ClaudeConverter.js:797-909, 997-1133, 1894-1944, 2441-2479` | document 块四方向丢弃点 |
| `src/converters/strategies/GeminiConverter.js:886-959, 798-814` | thoughtSignature 回程还原（非流式/流式） |
| `src/providers/gemini/antigravity-core.js:393-394, 501-516` | 签名兜底补签、Schema 清洗调用点 |
| `src/providers/zed/zed-core.js:622-628, 708-714, 766` | zed 预算表 ×2、cache_control 透传幸存点 |
| `src/providers/claude/claude-kiro.js:1472-1474` | Kiro cachePoint 处理 |

**架构锚点**

| 位置 | 说明 |
| --- | --- |
| `src/convert/convert.js:75-109` | `convertData()` 路由（按源协议选转换器） |
| `src/converters/ConverterFactory.js` / `register-converters.js` | 转换器注册与实例缓存 |
| `src/handlers/request-pipeline.js:1463-1466` | 请求转换调用点（流式 chunk :584、非流式响应 :1022） |
| `src/converters/anthropic-sse-emitter.js` | Claude 事件链统一状态机（Phase 3 对标模板） |
| `src/providers/openai/openai-responses-events.js` | Responses 事件生成器（Phase 3 收编对象） |
| `src/converters/stream-session.js` | StreamSessionStore（30 分钟 TTL，并发隔离容器） |
| `src/utils/protocol.js:19` / `src/utils/constants.js:47-53` | provider→协议前缀映射、协议常量 |
| `src/core/config-manager.js:29-42` | env 配置解析模式（新增开关参照此处） |

**测试锚点**

| 位置 | 说明 |
| --- | --- |
| `tests/converters.test.js`（1067 行） | 转换器矩阵测试（Phase 0/1 扩展点） |
| `tests/anthropic-sse-emitter.test.js` | Emitter 生命周期测试（Phase 3 对标） |
| `tests/openai-claude-stream.test.js` / `gemini-claude-stream.test.js` / `codex-claude-stream.test.js` | golden 事件序列（Phase 3 零变化硬验收） |
| `tests/stream-session.test.js` | StreamSessionStore 测试 |

---

> **文档维护约定**：本方案每阶段实施完成并合入后，须在同一 PR 中更新本文档对应阶段的「状态」标注（待实施 → 已落地 + 版本号），并按第十节第 4 条同步修订评估文档矩阵。
