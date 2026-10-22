# AIClient2API 跨协议转译修复计划（v4.1.4）

- 来源：[`CROSS_PROTOCOL_EVALUATION_V4_1_4.md`](./CROSS_PROTOCOL_EVALUATION_V4_1_4.md)
- 基线：`fix/cross-protocol-v4.1.3` @ `077d234`
- 目标：修复复评中确认的网关侧缺陷，保持现有协议面与配置兼容
- 进展：Phase 1（F1 + F2）已完成——`f366433`、`2aa4829`；Phase 2/3 待实施
- 原则：
  1. **Provider 边界归一化优先**：能在 provider 适配层兜住的，不下沉到每个 converter；
  2. **能力驱动**：能用 `provider-capabilities` 声明的，不写死模型名判断；
  3. **每个 commit 独立可验证**：单测 + 受影响 Provider 的定向 E2E；
  4. **不破坏 Tier 0 直通**：同协议直通路径保持零转换。

---

## 1. 修复清单

| ID | 问题 | 优先级 | 修复层 | 风险 |
|---|---|---:|---|---|
| F1 | Zed Anthropic `tool_result` 缺 `is_error` | **P1** | `zed-core` 请求归一化 | 低 |
| F2 | Gemini `thoughtsTokenCount` 未并入 output/completion | **P1** | `GeminiConverter` + 共享 usage helper | 中（影响客户端 usage/统计） |
| F3 | openai-custom 指定 function `tool_choice` 空 200 + 5 次长重试 | **P1** | `openai-core` + pipeline 重试预算 | 中 |
| F4 | Zed adaptive `high → max` 二次量化 | **P2** | `zed-core` budget→effort 统一 | 低-中 |
| F5 | Zed OpenAI 分支丢图片 | **P2** | `zed-core` open_ai 分支 | 低 |
| F6 | Zed Google 未接 Schema Polyfill + 丢 function id | **P2** | `zed-core` google 分支 | 中 |
| F7 | Zed Google 多轮工具历史 500 | **P2** | 能力声明 + 明确错误（不做伪修复） | 低 |
| F8 | Gemini 非 Claude 模型忽略 `maxOutputTokens` | **P2** | 文档 + 告警（保持删除策略） | 低 |
| F9 | Codex 无条件删除输出上限 | **P3** | Codex provider 层 + converter 能力驱动 | 低 |
| F10 | 错误响应丢失上游细节 | **P3** | `createErrorResponse` | 低-中 |
| F11 | reasoning 历史静默丢弃 | **P3** | 转换器日志 | 低 |
| F12 | 显式 `cache_control` 不可保留 | **P3** | 文档（无代码修复） | 无 |

---

## 2. 实施阶段

### Phase 1：P1 修复（2 个 commit）

#### F1 — Zed Anthropic `tool_result` 归一化（已完成 `f366433`）

**文件**

- `src/providers/zed/zed-core.js`（Anthropic 分支，约 `840-878`）
- `tests/zed-provider.test.js`

**改法**

在 Anthropic 分支把 Claude content 数组拷贝出来时，对所有 `tool_result` 块补默认值：

```js
content = m.content.map((block) => {
    if (block?.type === 'tool_result' && block.is_error === undefined) {
        return { ...block, is_error: false };
    }
    return block;
});
```

保留现有 `m.role === 'tool'` 分支的 `is_error: false`，避免双重逻辑冲突。

**为什么放在 zed-core**

`OpenAIConverter`、`OpenAIResponsesConverter`、未来新增的转换路径都会生成 `tool_result`；在 Zed 入口统一归一化，可以一次覆盖全部来源，同时不影响原生 Anthropic 上游。

**回归测试**

- 新增：`converted Claude tool_result without is_error is normalized`
  - 输入：Claude 形状的 `messages`，user content 含 `{type:'tool_result', tool_use_id:'x', content:'...'}`，无 `is_error`
  - 断言：`buildPayload()` 生成的 `provider_request.messages[..].content[0].is_error === false`
- 保留：现有 `zed-provider.test.js` 的 tool_use / functionResponse 断言。

**定向 E2E**

- `zed:claude-haiku-5-5` + Chat 多轮工具回传 → 预期 200，内容 `18`
- `zed:claude-sonnet-5-5` 同样验证一次（可选）

**验收**

- 修复前：Zed 400 `missing field is_error`，网关 500
- 修复后：200，且 `is_error:false` 出现在 Zed payload

---

#### F2 — Gemini usage 口径统一（已完成 `2aa4829`）

**文件**

- `src/converters/utils.js`
- `src/converters/strategies/GeminiConverter.js`
- `tests/converters.test.js` 或新增 `tests/cross-protocol-v4-1-4-fixes.test.js`

**改法**

新增共享 helper（命名可调整）：

```js
export function geminiUsageToOpenAI(usage = {}) {
    const prompt = Number(usage.promptTokenCount) || 0;
    const candidates = Number(usage.candidatesTokenCount) || 0;
    const thoughts = Number(usage.thoughtsTokenCount) || 0;
    const cached = Number(usage.cachedContentTokenCount) || 0;
    const total = Number(usage.totalTokenCount) || 0;
    // 防御：部分 Gemini 变体可能已把 thoughts 计入 candidates；
    // 若 prompt + candidates 已达到 total，则不再叠加 thoughts。
    const candidatesIncludeThoughts = total > 0 && prompt + candidates >= total;
    const completion = candidatesIncludeThoughts ? candidates : candidates + thoughts;
    return {
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: total || (prompt + completion),
        cached_tokens: cached,
        prompt_tokens_details: { cached_tokens: cached },
        completion_tokens_details: { reasoning_tokens: thoughts }
    };
}

export function geminiUsageToAnthropic(usage = {}) {
    const prompt = Number(usage.promptTokenCount) || 0;
    const candidates = Number(usage.candidatesTokenCount) || 0;
    const thoughts = Number(usage.thoughtsTokenCount) || 0;
    const cached = Number(usage.cachedContentTokenCount) || 0;
    const total = Number(usage.totalTokenCount) || 0;
    const candidatesIncludeThoughts = total > 0 && prompt + candidates >= total;
    return anthropicUsageFromInclusiveInput({
        inputTokens: prompt,
        cachedTokens: cached,
        outputTokens: candidatesIncludeThoughts ? candidates : candidates + thoughts
    });
}
```

替换 `GeminiConverter` 的 5 个 usage 映射点：

- Chat 非流式：`toOpenAIResponse()`
- Chat 流式：`toOpenAIStreamChunk()`
- Responses 非流式：`toOpenAIResponsesResponse()`
- Responses 流式：`toOpenAIResponsesStreamChunk()`（含 `savedUsage` 与兜底路径）
- Claude 非流式 / 流式：`toClaudeResponse()`、`toClaudeStreamChunk()` 的 `buildTerminalUsage()`

**注意**

- `total_tokens` 保持 Gemini 原值（已包含 thoughts）；
- 只有 `totalTokenCount` 缺失时才用 `prompt + completion` 计算；
- 不要修改 `usage-normalizer.js` 的统计逻辑，避免与客户端 usage 双重补偿。

**回归测试**

- Chat 非流式 fixture：`prompt=28, candidates=3, thoughts=186, total=217`
  - 断言 `completion_tokens=189`、`reasoning_tokens=186`
- Responses 非流式 fixture：`output_tokens=189`
- Claude fixture：`output_tokens=189`
- 断言 `completion/output >= reasoning_tokens` 恒成立。

**定向 E2E**

- `gemini-antigravity:gemini-3.8-flash-high` 的 Chat/Responses/Claude 共 6 条文本用例
- 预期：内容仍为 `391`；usage 不再出现 `completion < reasoning`

**验收**

- 所有 Gemini 文本响应满足 `completion_tokens >= reasoning_tokens`
- 现有 413 个单测零回归

---

### Phase 2：P2 修复（3 个 commit）

#### F3 — openai-custom 强制 `tool_choice` 与空响应重试预算

**文件**

- `src/providers/openai/openai-core.js`
- `src/handlers/request-pipeline.js`（重试预算）
- `src/core/config-manager.js`（新配置）
- `src/providers/provider-capabilities.js`（消费能力）
- `tests/provider-capabilities.test.js`、`tests/cross-protocol-v4-1-4-fixes.test.js`

**改法**

1. **能力门控**：抽一个 `normalizeToolChoiceForProvider(body, capabilities)`，在 `callApi()` 与 `streamApi()` 构造请求体时都调用：
   - `supportsForcedToolChoice === false` 且 `tool_choice` 为指定 function：
     - 若 `tools` 中存在同名 function，收窄 `tools` 为仅该 function，并改写 `tool_choice: 'required'`（语义最接近“必须调用该工具”）；
     - 若不存在同名 function，改写为 `'auto'` 并 warn。
   - `tool_choice: 'required'` 且不支持时，降级为 `'auto'`。
2. **运行时兜底**：非流式请求若 `response.data` 为空（`""` / 空对象），且原请求是“指定 function 强制调用”，自动用 `tool_choice:'required'` 重试一次；成功则返回，失败再进入现有空响应重试。流式路径由能力门控覆盖，不做空流二次重试。
3. **重试预算**：新增 `EMPTY_RESPONSE_MAX_TOTAL_MS`（默认 120000，设为 0 表示不限制），在首次空响应时把 `emptyResponseStartedAt` 写入 `retryContext`，每次重试前检查 `Date.now() - startedAt`，超预算直接返回明确错误，避免 5 × 60s 挂起。

**配置建议**

在 openai-custom 节点声明：

```json
"capabilities": {
  "models": {
    "*": { "supportsForcedToolChoice": false }
  }
}
```

不要加全局内置规则，因为标准 OpenAI 端点可能支持该字段；能力声明按节点配置最安全。

**回归测试**

- mock `axiosInstance.request`：
  - 指定 function + 空 body + capabilities false → 第二次请求 `tool_choice === 'required'`
  - 指定 function + capabilities true → 原样透传
  - 空响应预算耗尽 → 返回明确错误，不再重试
- 单元测试不依赖真实上游。

**定向 E2E**

- `openai-custom:glm-5.3` Chat 指定 `tool_choice:{type:'function',...}`：
  - 修复前：空 200 + 5 次重试
  - 修复后：≤30s 内返回 `get_weather`，或明确 4xx
- 顺带验证 5 个 openai-custom 模型。

---

#### F4 — Zed adaptive effort 统一

**文件**

- `src/providers/zed/zed-core.js`
- `tests/zed-provider.test.js`

**改法**

在 `zed-core` 内新增纯函数：

```js
function budgetToClaudeEffort(budget) {
    const b = Number(budget) || 4096;
    if (b <= 2048) return 'low';
    if (b <= 8192) return 'medium';
    if (b <= 20000) return 'high';
    // budget 无法区分 xhigh / max（canonical 表两者都是 32000）；
    // 这里回退到 max，xhigh 需要请求显式提供 thinking.effort。
    return 'max';
}
```

> 如果后续需要严格区分 `xhigh` 与 `max`，应在转换器上保留原始 `reasoning_effort` 提示（例如内部 `_reasoningEffort` 字段），而不是继续从 budget 反解。

替换两处阈值：

- Anthropic adaptive 分支（约 `763-770`）
- OpenAI Responses 分支的 budget→effort（约 `469-475`）

**回归测试**

- `budget_tokens: 20000` → `output_config.effort === 'high'`
- `budget_tokens: 32000` → `max`（若产品要求 `xhigh`，需显式保留原始 effort；两处逻辑必须一致）
- `reasoning_effort: 'high'` 且无 budget → `high`

**定向 E2E**

- `zed:claude-haiku-5-5` Chat `reasoning_effort: high`；检查 payload/日志中不再出现 `effort: max`
- 该模型仍可能不返回 thinking，这是上游行为，不作为失败条件

---

#### F5 — Zed OpenAI 分支图片映射

**文件**

- `src/providers/zed/zed-core.js`（open_ai 分支，约 `369-460`）
- `tests/zed-provider.test.js`

**改法**

把 user 消息的内容收集从“只拼 `userText`”改为“构造 content 数组”：

```js
const userContent = [];
for (const part of m.content) {
    if (part.type === 'text') userContent.push({ type: 'input_text', text: part.text });
    else if (part.type === 'image' || part.type === 'input_image') {
        const url = part.source?.type === 'base64'
            ? `data:${part.source.media_type || 'image/png'};base64,${part.source.data}`
            : (part.image_url?.url || part.image_url || part.url);
        if (url) userContent.push({ type: 'input_image', image_url: url });
    } else if (part.type === 'tool_result') {
        input.push({ type: 'function_call_output', call_id: part.tool_use_id, output: ... });
    }
}
if (userContent.length > 0) input.push({ type: 'message', role: 'user', content: userContent });
```

保持 `function_call_output` 与 message 的相对顺序；必要时先把 tool output 推入，再推 user message。

**回归测试**

- payload 中 user message 含 `input_image`，`image_url` 为正确 data URL
- 纯文本 user 消息输出形状不变（避免 golden 回归）

**定向 E2E**

- `zed:gpt-6-luna` + 32×32 红图 → 预期 `Red`
- `zed:gemini-3.8-flash`、`zed:claude-haiku-5-5` 回归确认仍为 `Red`

---

### Phase 3：P2/P3 收尾（2-3 个 commit）

#### F6 — Zed Google Schema Polyfill + id 保留

**文件**

- `src/providers/zed/zed-core.js`（google 分支）
- `tests/zed-provider.test.js`

**改法**

- import `polyfillAndCleanSchemaForGemini`；
- `functionDeclarations` 的 `parameters` 改为：
  ```js
  parameters: polyfillAndCleanSchemaForGemini(t.input_schema || t.parameters || { type: 'object', properties: {} })
  ```
- `functionCall` / `functionResponse` 保留原始 `id`（如果存在）。

**回归测试**

- 复杂 Schema payload 的 `description` 包含约束文本；
- 简单 Schema 输出形状不变；
- `functionCall.id` / `functionResponse.id` 保留。

**定向 E2E**

- `zed:gemini-3.8-flash` 复杂 Schema：观察 `shipping` 是否从字符串变为对象；如果仍是字符串，记录为模型行为，不强行失败。

---

#### F7 — Zed Google 多轮工具历史：明确能力与错误

**文件**

- `src/providers/zed/zed-core.js`
- `src/providers/provider-capabilities.js`（可选新增能力键）
- `docs/PROVIDER_ADAPTER_GUIDE.md`

**改法（二选一）**

- **推荐**：新增能力键 `supportsToolResultHistory`（默认 true），内置规则对 `zed` + `gemini-*` 设为 false；当请求包含 tool_result 且能力为 false 时，返回明确 400/501，而不是把上游 500 空 body 透传。
- **保守**：不新增能力键，只在 `zed-core` google 分支检测到 tool_result 时 warn，并在文档中标注“不支持多轮工具历史”。

无论哪种，都不尝试伪造上游不支持的修复；补 id/thoughtSignature 已验证无效。

**回归测试**

- 能力解析：`zed/gemini-3.8-flash` → `supportsToolResultHistory=false`
- 请求含 tool_result → 明确错误码/错误消息
- 纯文本多轮不受影响

---

#### F8 — Gemini `maxOutputTokens` 能力说明

**文件**

- `docs/CROSS_PROTOCOL_ARCHITECTURE.md` / `docs/PROVIDER_ADAPTER_GUIDE.md`
- `src/providers/gemini/antigravity-core.js`（保留现有 warn）

**改法**

- 不改变“非 Claude 模型默认删除 `maxOutputTokens`”的行为；
- 在文档中明确：Gemini CloudCode 非 Claude 模型不保证输出上限，客户端应使用超时/取消而不是依赖 `max_tokens`；
- 如节点声明 `supportsMaxOutputTokens=true`，才透传。

**验收**

- 文档更新；
- 不引入行为变更。

---

#### F9 — Codex 输出上限能力驱动

**文件**

- `src/providers/openai/codex-core.js`（provider 层）
- `src/converters/strategies/CodexConverter.js`（仅移除无条件 delete）
- `src/providers/provider-capabilities.js`
- `tests/converters.test.js`

**改法**

- 将 `delete max_output_tokens / max_completion_tokens` 从 converter 移到 Codex provider 层，避免 converter 依赖全局配置；
- 在 provider 层解析 `openai-codex-oauth` 能力：
  - `supportsMaxOutputTokens === false` 时删除，否则保留；
- 内置规则：`openai-codex-oauth` → `supportsMaxOutputTokens: false`（保持现有行为）。

**回归测试**

- Codex payload 不包含 max tokens（默认）；
- 节点显式声明 true 时保留（为未来上游能力留口）。

---

#### F10 — 错误细节透传

**文件**

- `src/handlers/request-pipeline.js`（`createErrorResponse` / `handleError`）
- `tests/api-integration.test.js` 或新增单测

**改法**

- 对 4xx，从 `error.response.data` 提取 `error.message` / `message` / 字符串 body；
- 截断到 500-1000 字符，追加到 `message` 或放入 `details` 字段；
- 不改变 5xx 的对外文案，避免泄露内部信息；
- 过滤明显敏感字段（authorization、api_key、token）。

**回归测试**

- 构造 `error.response.data = { error: { message: 'missing field is_error' } }`
- 断言客户端错误响应包含该 message
- 构造 500 错误，断言不泄露上游 body

---

#### F11 — reasoning 丢弃日志

**文件**

- `src/converters/strategies/OpenAIResponsesConverter.js`（Responses→Gemini）
- `src/converters/strategies/OpenAIConverter.js`（Chat→Responses）
- 可选：`ClaudeConverter` 现有 debug 保留

**改法**

- 在 `case 'reasoning'` 缺失处补 `logger.debug`，记录 `reasoning` item 被跳过及原因；
- Chat→Responses 遇到 assistant `reasoning_content` 时补 debug；
- 不改变请求内容，避免引入新的 400 风险。

---

#### F12 — `cache_control` 文档化

**文件**

- `docs/CROSS_PROTOCOL_ARCHITECTURE.md`
- `docs/PROVIDER_ADAPTER_GUIDE.md`

**改法**

- 明确：显式 `cache_control` 跨协议丢弃，仅保留隐式前缀缓存与 `cached_tokens` 回填；
- 保留现有每位置一次的 warn。

---

## 3. 提交顺序与验证

建议每个 commit 独立：

| Commit | 内容 | 必跑验证 |
|---|---|---|
| 1 | F1 Zed `is_error` | `node --check`（ESM 需复制为 `.mjs`）、`npm test -- --runInBand`、Zed 多轮工具 E2E |
| 2 | F2 Gemini usage | 单测、Gemini 6 条文本 E2E、usage 不变式检查 |
| 3 | F3 openai-custom tool_choice + 重试预算 | 单测 mock、openai-custom 5 模型强制 tool_choice E2E |
| 4 | F4 + F5 Zed effort/image | Zed payload 单测、zed gpt 图片 E2E |
| 5 | F6 + F7 Zed Google schema/history | Zed Google payload 单测、复杂 Schema E2E |
| 6 | F8~F12 文档/日志/错误透传 | 单测、全量 413 tests |

**每个 commit 的通用命令**

```bash
# ESM 语法检查（Node 可能按 CJS 解析 .js，先复制为 .mjs）
cp src/path/file.js /tmp/check.mjs && node --check /tmp/check.mjs

# 全量单测
npm test -- --runInBand

# 受影响 Provider 的定向 E2E
# 使用独立端口，避免影响用户 3000 实例
node src/services/api-server.js --port 3201
```

**最终验收**

1. `npm test -- --runInBand`：28 suites / 413+ tests 全绿；
2. 13 模型核心 E2E：≥ 127/143（Zed haiku 多轮回传修复；Zed gemini 仍可能受通道限制）；
3. Gemini 所有文本响应满足 `completion/output >= reasoning_tokens`；
4. openai-custom 指定 function 强制 `tool_choice` 在 30s 内返回工具调用或明确错误；
5. `zed:gpt-6-luna` 32×32 红图返回 `Red`；
6. 无 tracked 配置文件改动、无密钥写入日志；
7. golden stream 测试（`openai-claude-stream` / `gemini-claude-stream` / `codex-claude-stream`）输出零变化。

---

## 4. 风险与回滚

| 修复 | 风险 | 回滚/开关 |
|---|---|---|
| F1 `is_error` | 极低；只补可选字段 | 直接 revert |
| F2 Gemini usage | 客户端看到的 token 数变化，可能影响统计看板 | revert；或加 `CONVERT_GEMINI_INCLUSIVE_USAGE=false` 开关（默认 true） |
| F3 tool_choice 降级 | 多工具场景下 `required` 可能调用非指定工具 | 能力声明默认 true；仅声明 false 的节点降级；保留原请求日志 |
| F3 重试预算 | 可能提前终止合法的慢重试 | `EMPTY_RESPONSE_MAX_TOTAL_MS=0` 关闭限制 |
| F4 effort 映射 | adaptive 模型思考强度从 max 降为 high | revert；或保留旧阈值开关 |
| F5 图片映射 | 低；新增 input_image 分支 | revert |
| F6 Schema Polyfill | 工具 Schema 形状变化 | `CONVERT_SCHEMA_POLYFILL=false` |
| F7 Google 多轮工具 | 从 500 变为明确 4xx，客户端行为变化 | 能力键默认 true；仅 Zed Google 置 false |
| F9 Codex 能力 | 行为等价（默认仍删除） | 内置规则移除 |
| F10 错误细节 | 可能暴露上游内部错误文本 | 只对 4xx、截断、过滤敏感字段 |

---

## 5. 暂缓/不做

1. **统一 IR AST**：archive 5.1 的完整重构，收益大但风险高，不在本轮修复范围。
2. **显式 Prompt Caching 跨协议映射**：协议层没有等价字段，保持“丢弃 + warn + 文档”。
3. **Gemini 流式 thought text**：上游 SSE 不返回 thought 文本，网关无法凭空生成；文档标注为物理上限。
4. **Zed Google 多轮工具历史**：不在网关侧伪造修复；通过能力声明/明确错误管理预期。
5. **Zed 两模型 thinking 缺失**：优先按上游行为处理；如确认是 Zed 参数问题，再单独立项。

---

## 6. 建议的下一步

先做 Phase 1（F1 + F2），这两项都是低风险、可独立验证、对真实 Agent 使用影响最大的修复。完成后再决定是否继续 Phase 2。

修复完成后，更新：

- `docs/CROSS_PROTOCOL_EVALUATION_V4_1_4.md` 的状态与修复清单；
- `docs/CROSS_PROTOCOL_ARCHITECTURE.md` 的已知限制；
- `CHANGELOG.md`（如本轮形成版本）。
