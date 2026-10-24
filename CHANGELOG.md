# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [v4.1.9] - 2026-10-23

### Fixed (跨协议转译语义与健壮性收口)

- **Responses → Gemini**：`input` 内 system/developer 消息并入 `systemInstruction`；`text.format` 映射为 `responseMimeType` / `responseSchema`；多模态 `function_call_output` 归一化为 Struct 并将图片/文件拆为同轮 `inlineData`；无 user/assistant turn 的请求本地返回 400。
- **Chat → Antigravity**：thinking gating 覆盖 `gpt-*`、`-thinking`、`-high`、`-medium` 与 Claude 5.5，GPT-6 预适配补齐。
- **流内错误终态**：识别 `response.failed`、`event: error`、`data.error`（含空 `choices` / `candidates`）；转换器无法表达时返回 502；非流式 HTTP 200 错误体不再伪装成成功；错误帧不污染重试收尾状态。
- **Schema Polyfill**：补齐 `allOf` type/enum/items、可空 `oneOf`、`patternProperties`、`additionalProperties`、`not`、`dependentRequired`、`dependentSchemas`、`if/then/else`；摘要保留子 Schema `description`；阶段 2 裁剪只统计可达节点并按真实描述差值回缩。

### Changed

- 跨协议 E2E 增加 Responses→Gemini developer/text.format 与 system-only 400 定向用例，定向用例增至 16 项。
- 文档收敛为单一 19 模型复评入口，删除过期的 27 模型 review。

### Verification

- `npm test -- --runInBand`：**29 suites / 489 tests 全绿**。
- 19 模型 E2E：**35 / 35 通过**，19/19 模型 11/11，16/16 定向用例通过。

## [v4.1.8] - 2026-10-23

### Fixed

- 收口跨协议 P0/P1 一致性修复与 E2E 长尾治理。
- 修复 Responses 流式 `.done` 无前序 delta 时丢正文。
- 更新 Antigravity User-Agent 为 CLI 标识，修复模型列表动态刷新。

### Changed

- Antigravity 过滤 oss 与 `-low` 模型，预适配 GPT-6 系列 thinkingLevel。

## [v4.1.7] - 2026-10-22

### Fixed (跨协议转译 P1/P2 修复)

- **P1：Responses 下游兜底收尾**：`streamRequestId` 声明提升到 `try` 外，修复 `finally` 中 `ReferenceError` 导致的流卡死；兜底收尾失败时强制 `res.end()`。
- **P1：重试流状态泄漏**：`BaseConverter` 增加 `resetStreamState()` 契约；各 Converter 只清理流式状态、保留请求级工具名/custom tool 映射；pipeline 在每次尝试及空响应/凭证切换重试前清理，重试上下文固定 `requestId` 与共享 `streamState`，避免重复补发 `message_stop` / `response.completed`。
- **P2：终端空内容截断识别**：新增 `extractTerminalFinishReason()` / `isTerminalEmptyFinishReason()`，覆盖 OpenAI `length`、Claude `max_tokens`、Responses `max_output_tokens`、Gemini `MAX_TOKENS`，合法截断不再被放大为多次空响应重试。
- **P2：Responses → Gemini 工具 ID**：`functionCall` / `functionResponse` / `callIdToName` 统一使用 `call_id || id`，保证多轮工具历史配对。

### Changed

- 新增 `tests/v4-1-6-regressions.test.js`（9 个 P1/P2 回归用例）。
- 清理过时的跨协议评估/优化文档；评估入口后续见 [`docs/archive/CROSS_PROTOCOL_REVIEW_19MODELS_2026-10-23.md`](docs/archive/CROSS_PROTOCOL_REVIEW_19MODELS_2026-10-23.md)。
- 清理 E2E 测试中未使用的 `addQuotaFailure` 别名。

### Verification

- `npm test -- --runInBand`：**29 suites / 463 tests 全绿**。
- 最终 27 模型 E2E：**39 / 39 通过**，27/27 模型 11/11，12/12 定向用例通过。
- `streamRequestId is not defined`：**0 次**。
- `openai-custom:glm-5.3` 核心用例耗时从 195.2s 降至 15.4s。

## [v4.1.6] - 2026-10-22

### Changed

- E2E 默认通过 Jest `globalSetup` 从 `/auto/v1/models` 动态获取当前全量模型，不再硬编码 13/27；`AICLIENT_E2E_MODELS` 可覆盖为逗号分隔的子集。
- 合并 6 个历史版本化跨协议测试为 `tests/cross-protocol-historical-regressions.test.js`，删除 3 条低价值实现细节断言；单测套件从 33 个收敛为 28 个。
- `npm test` 移除 `--forceExit`，测试进程现在可自然退出。

### Fixed

- `src/utils/file-lock.js`：`withTimeout()` 在 Promise settle 后清理 30s 定时器，避免测试和 CLI 进程被悬挂的 timeout 拖住。
- `src/ui-modules/auth.js`：token 清理 `setInterval` 增加 `unref()`，避免模块被测试/CLI 引入时阻塞进程退出。

### Verification

- `npm test -- --runInBand`：**28 suites / 454 tests 全绿**，无需 `--forceExit`。
- E2E 默认动态发现 27 个模型；`openai-custom:glm-5.3` 核心矩阵 11/11 通过。

## [v4.1.5] - 2026-10-22

### Fixed (跨协议转译 v4.1.5 契约修复)

- **usage 不变量**：`applyEstimatedReasoningTokens()` 现在保证 `reasoning_tokens <= output_tokens`；上游已给 reasoning 但大于 output 时也会收敛，output 为 0 时不做估算，避免 `completion/output < reasoning` 的非法 usage。
- **Claude tool id**：OpenAI → Claude 的请求、非流式响应、流式响应统一通过 `toClaudeToolId()` 清洗为 `[a-zA-Z0-9_-]+`，并保证 `tool_use` / `tool_result` 两侧 id 一致。
- **Schema 保真**：oneOf/anyOf 对象分支的 `required` 改为交集，避免互斥分支字段被全部强制；数值/布尔 enum 在 Gemini 清洗前注入 description，保留约束语义。
- **CoT 历史可观测性**：Chat → Responses、Claude → Responses 丢弃 reasoning 时输出计数 debug 日志，默认行为不变。
- **E2E 覆盖**：新增 `AICLIENT_E2E_MODELS=all`（27 模型全量矩阵）、全模型 usage 不变量断言、OpenAI → Zed Claude 非法 tool id 回归用例。
- **文档清理**：移除已被取代的 13 模型阶段性复评，保留 27 模型全量复评与 archive 历史文档。

### Verification

- `npm test -- --runInBand`：**33 suites / 457 tests 全绿**。
- 27 模型核心 E2E：**296 / 297**；唯一失败为 `openai-custom:qwen3.8-max` 算术采样返回 `442`，同用例重试 3/3 返回 `391`，非转译回归。
- oneOf 定向 E2E、OpenAI → Zed Claude 非法 tool id 定向 E2E 通过。

## [v4.1.4] - 2026-10-22

### Fixed (跨协议转译 v4.1.4 + CoT 非确定性修正)

- **Gemini**：
  - 流式请求需要 thinking 时回退非流式 `generateContent`，保留 thought 文本；新增 `GEMINI_STREAM_THOUGHTS_FALLBACK`。
  - `maxOutputTokens` 改为标准透传；`MAX_TOKENS` / `SAFETY` 等终态不再触发空响应重试。
- **Zed**：
  - Anthropic `tool_result` 统一补齐 `is_error:false`。
  - `reasoning_effort: high` 不再被反解为 `max`。
  - OpenAI 通道补齐 `input_image` 映射。
  - Google 通道接入 Schema Polyfill，保留 function id；多轮工具历史降级为文本。
- **工具与 Schema**：
  - openai-custom 指定 function 强制 `tool_choice` 降级为 `required` + 收窄 tools；新增 `EMPTY_RESPONSE_MAX_TOTAL_MS` 重试预算。
  - oneOf/anyOf 对象分支合并 properties/required/enum；`CONVERT_SORT_TOOLS` 默认开启。
  - Codex `max_output_tokens` 默认透传。
- **Reasoning 与错误**：
  - GPT/Claude 有 reasoning 文本但缺 `reasoning_tokens` 时做保守估算并标记 `reasoning_tokens_estimated`。
  - 4xx 错误响应追加可读上游细节，5xx 不泄露内部 body。
  - 新增 `supportsToolResultHistory`、`supportsStreamingThoughts` 能力位。

### Verification

- `npm test -- --runInBand`：33 suites / 447 tests 全绿。
- `npm run test:e2e`：13 模型真实上游 E2E **24 / 24 PASS**。

## [v4.1.2] - 2026-10-21

### Fixed (跨协议转译 v4.1.1 复评 P1/P2)

- **流式与工具链**：
  - Gemini → OpenAI Chat 流式工具 chunk 不再提前写 `finish_reason=tool_calls`。
  - 打通 custom tool 全链路：新增请求级 `custom-tool-registry`；Responses → Codex 原生保留 `type:"custom"`，Responses → OpenAI / Claude / Gemini 降级为 function 后响应侧还原为 `custom_tool_call`。
  - Responses SSE 对 custom tool 改发 `custom_tool_call_input.delta/done`，不再按 `apply_patch` 名称推断类型。
  - Claude → OpenAI 流式 `tool_calls.index` 改为请求级从 0 递增映射。
- **思考与签名**：
  - Gemini → Claude 统一铸造 `vsig1.*` 虚拟签名；Claude → Gemini 不再透传 Claude 真实 signature。
  - OpenAI → Claude 映射 `thinking` 后移除非标准 `reasoning_effort`，显式 disabled 优先。
  - Grok 流式思考只写 `reasoning_content`，不再重复写入正文。
- **usage 与请求参数**：
  - Gemini / Codex → Claude 的 `input_tokens` 扣除 cached tokens。
  - Claude → OpenAI 不再默认注入 `max_tokens` / `temperature` / `top_p`。
  - `strict` 在 Chat ↔ Responses 双向保留；`parallel_tool_calls` ↔ `disable_parallel_tool_use` 双向映射。
  - 非流式 `custom_tool_call` 补齐 OpenAI Chat / Claude 输出。
- **多模态**：
  - Responses `input_file` 的 base64 数据映射为 Gemini `inlineData`。
- **测试与文档**：
  - 新增 `tests/cross-protocol-v4-1-1-fixes.test.js`，共 20 个回归场景；`npm test -- --runInBand` = 26 suites / 376 tests 全绿。
  - 更新跨协议转译评估文档；移除已被取代的 v4.1.0 评估文档。

## [v4.1.1] - 2026-10-21

### Fixed (v4.1.0 复评 P0/P1 整改)

- **P0 功能中断**：
  - Codex → OpenAI Chat / Responses 非流式工具调用补齐 `requestId`，修复 `ReferenceError: requestId is not defined`。
  - Codex → Responses 非流式 `function_call` 同时输出 `fc_*` item id 与 `call_id`，恢复工具结果回传。
  - Claude → Codex 的 URL 图片映射为 `input_image`；URL document 保留 URL 文本兜底，不再静默丢成空 input。
- **P1 保真与鲁棒性**：
  - Claude → Gemini 补齐 `stop_sequences → generationConfig.stopSequences`。
  - Responses → Claude 终止事件补齐未关闭内容块的 `content_block_stop`。
  - Claude / Responses 下游 + OpenAI 上游流式场景由 provider 注入 `stream_options.include_usage`，并合并 finish/usage 分帧。
  - 统一 Claude / OpenAI / Responses 双向缓存 token 统计口径。
  - OpenAI `content_filter` → Anthropic 结束原因修正为 `refusal`。
  - Gemini → Responses 非流式保留 `MAX_TOKENS` / 安全类截断状态；Gemini → Claude 非流式保留截断前的部分正文。
- **测试与文档**：
  - 新增 `tests/cross-protocol-v4-1-0-p0-p1.test.js`。
  - 更新跨协议转译评估文档（v4.1.0 文档已由后续复评取代）。

### Verification

- `npm test -- --runInBand`：25 suites / 356 tests 全绿。

## [v4.1.0] - 2026-10-21

### Fixed (跨协议转译 v4.1 收敛)

- **P1 流式正确性**：
  - Gemini → OpenAI Chat 的工具索引改为请求级递增，Gemini → Responses 以 `callId` 作为工具身份，修复跨 chunk 工具合并/丢失。
  - Responses → OpenAI 流式状态按 `requestId` 隔离，固定 chunk `id/created`，避免状态按事件泄漏。
  - Claude → Responses 的 `input_image.image_url` 统一为字符串，修复图片被上游拒绝。
  - Grok → Responses 非流式 `function_call` 补 `call_id`，恢复非流式工具回传链路。
- **P2 保真与鲁棒性**：
  - Claude 目标请求补齐 `temperature` / `top_p` / `stop_sequences` / `metadata`，未显式提供的采样参数不再注入默认值。
  - `max_tokens` 统一 clamp 到 Anthropic 64K 输出上限。
  - Claude 流式 usage 合并 `message_start` 输入 token，修复最终用量归零。
  - Responses → OpenAI / Claude 支持 custom tool 输入增量。
  - Codex → OpenAI / Claude 处理 `response.incomplete`。
  - URL 图片、`file` / `input_file` 多模态映射补齐，减少静默丢失。
- **P3 清理**：
  - Claude → Responses 在 `content_block_stop` 时关闭 text 块。
  - 移除 Codex reasoning done 注入的人工换行。
  - OpenAI → Gemini 仅 system 消息时保留 `system_instruction` 语义。
- **测试与文档**：
  - 新增 `tests/cross-protocol-v4-1-p1/p2/p3.test.js`，共 17 个回归测试。
  - 新增并收敛跨协议转译评估文档（v4.1.0 文档已由后续复评取代）。

### Verification

- `npm test -- --runInBand`：24 suites / 344 tests 全绿。

## [v4.0.1] - 2026-10-21

### Fixed (跨协议转译 v4 复评整改)

- **P1 功能正确性**：
  - 修复 Claude → OpenAI Responses 流式工具调用重复 output item（Emitter 工具 key 统一）。
  - 修复 OpenAI Chat → Gemini 多条 system/developer 消息只保留最后一条。
  - 补齐 Responses ↔ OpenAI 的图像、`text.format`、`tool_choice`、`max_completion_tokens` 等字段映射。
  - 修复 Claude → OpenAI `tool_choice` 固定为 `auto`，补齐 `stop_sequences` / `metadata` 与 URL 图像。
  - Grok → Responses 流式改用 `ResponsesSseEmitter`，输出标准生命周期事件。
  - 修复 Codex 长工具名反向映射（请求/响应共用 requestId，请求状态跨实例共享）。
  - 修复 OpenAI → Claude usage-only 尾帧重复发送 `message_start`。
- **P2 保真与鲁棒性**：
  - Claude → Gemini 统一使用 `thinkingLevel`，并支持 adaptive thinking。
  - 补齐 OpenAI/Claude/Responses → Gemini 的 `required` / `any` tool_choice。
  - URL 图片/文档增加 `fileData` / `image_url` / 占位文本兜底。
  - Gemini → Responses 非流式输出标准 reasoning item。
  - 映射 `response.incomplete`，`response.failed` / `error` 向上抛出。
  - 收紧 Responses → Claude 无签名 thinking 回放策略，修正 SSE 生命周期顺序与 usage 统计。
- **P3 清理**：
  - 删除 Codex `if(true)` 死代码、Grok 占位解构、未使用 Emitter API/常量、pipeline 不可达 Gemini 分支。
  - 移除 Grok 静态共享 UUID/baseUrl，改为请求级状态。
  - 新增 `tests/cross-protocol-v4-fixes.test.js`（18 个回归测试）。
- 文档：跨协议转译复评后续收敛到 [`docs/archive/CROSS_PROTOCOL_REVIEW_19MODELS_2026-10-23.md`](docs/archive/CROSS_PROTOCOL_REVIEW_19MODELS_2026-10-23.md)（历史复评文档已在 v4.1.7 清理）。

### Verification

- `npm test -- --runInBand`：21 suites / 327 tests 全绿。

## [v4.0.0] - 2026-10-21

> 本次发布为破坏性变更：下游协议收敛为 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 三种；Gemini 仅保留为上游 provider 协议。OpenAI Images 下游入口保持不变。

### Changed (变更)

- **下游协议收敛**：客户端只再暴露 `/v1/chat/completions`、`/v1/responses`、`/v1/messages` 与 `/v1/models`。
- **Gemini 角色调整**：Gemini/Antigravity 继续作为上游 provider，参与请求转换和响应回译；不再接受原生 Gemini 客户端请求。
- **OpenCode 示例迁移**：`gemini-antigravity` 示例从 `@ai-sdk/google` + `/v1beta` 改为 `@ai-sdk/openai-compatible` + `/v1`。
- **文档同步**：跨协议架构、Antigravity 说明、CLI 技能文档、启动信息和 API 文档统一标注下游/上游协议边界。

### Removed (移除)

- `GET /v1beta/models`
- `POST /v1beta/models/{model}:generateContent`
- `POST /v1beta/models/{model}:streamGenerateContent`
- `ENDPOINT_TYPE.GEMINI_CONTENT`、`ENDPOINT_TYPE.GEMINI_MODEL_LIST`、`API_ACTIONS`
- `request-pipeline` 中 Gemini 客户端协议映射、模型列表构造、错误格式与流式结束标记
- `GeminiStrategy.extractModelAndStreamInfo`
- Provider 池的 Gemini 模型列表格式
- 转换器中目标协议为 Gemini/Codex/Grok 的响应、流式与模型列表不可达分支（约 2.2k 行）
- Gemini 作为客户端协议的请求转换方法
- 未使用的 `getOpenAIStreamChunkStop`、`ContentProcessor`、`ToolProcessor`

### Kept (保留)

- `POST /v1/images/generations`、`POST /v1/images/edits` 及 Playground 图片入口
- Gemini/Antigravity、Codex、Grok、Kiro、Zed、Trae 等上游 provider
- 上游 Gemini → OpenAI/Claude/Responses 的响应与流式转换
- OpenAI/Claude/Responses → Gemini/Codex/Grok 的上游请求转换

### Verification

- `npm test -- --runInBand`：20 suites / 309 tests 全绿。
- 所有修改的 JS 文件通过 `node --check`。
- `request-pipeline` import smoke 通过。
- `tests/api-integration.test.js` 在未设置 `TEST_API_KEY` 时按既有逻辑跳过。

## [v3.17.0] - 2026-10-20

> 本次发布汇总 `v3.14.1` 之后的全部变更。过程里程碑标签：`v3.15.0`（模型能力统一）、`v3.16.0`（正向模型选择）、`v3.16.1`（Zed Gemini 3+ 修复）。

### Added (新增)

- **节点正向模型选择**：
  - 节点候选来自上游 `model_list`，默认全选；取消勾选即表示该节点不使用该模型。
  - 新增 `supportedModelsBaseline`，上游后续新增模型默认自动选中。
  - 分组最终模型列表 = 活跃节点选择集并集 ∪ 该分组的自定义模型。
  - 自定义模型只参与分组最终集与路由，不进入节点候选列表。
  - model_id 全程大小写敏感。
- **统一的模型能力与路由读取**：
  - `resolveNodeCapability()` 输出 `candidateModels` / `selectedModels` / `selectionMode`。
  - `/api/providers` 节点新增候选集、选择集与能力来源元数据。
  - `detect-models` 改为任意 provider 均可刷新的能力刷新入口。
- **一次性旧字段清理脚本**：
  - 新增 `src/scripts/purge-legacy-model-fields.js`，默认 dry-run，`--write` 才落盘。
- **跨协议架构入口**：
  - 新增 `docs/CROSS_PROTOCOL_ARCHITECTURE.md`，收敛当前协议链路、模型代际、流式状态与硬约束。

### Changed (变更)

- **模型代际收敛**：GPT-5+、Claude 4+、Gemini 3+；删除 Claude 3 回退、Zed o1/o3、Trae 旧 GPT/Claude 别名。
- **Gemini 思考配置统一**：删除 Gemini 2.5 `thinkingBudget` 双轨，统一为 `thinkingLevel`。
- **文档治理**：已实施方案归档到 `docs/archive/`；修复 Adapter Guide 的失效相对链接；更新配置示例、OpenClaw/OpenCode 示例与教程字段。
- **已移除 provider 清理**：删除 `gemini-cli-oauth`、`openai-qwen-oauth`、`openai-iflow` 在配置示例、UI 文案、config-scanner 与 CLI 注释中的残留。

### Fixed (修复)

- **Zed Gemini 3+ 思考配置**：`reasoning_effort` 正确映射为 `thinkingConfig.thinkingLevel`，修复 `gemini-4-argon` 等模型返回 500 的问题。
- **冷启动能力缓存**：刷新失败且无历史发现时回退静态基线，不把失败的空结果当成可靠发现。
- **自定义模型路由**：补齐非流式凭证重试的路由意图；自定义模型 `actualModel` 不再被上游候选集误拦截。
- **保存残留**：provider 更新时清除旧负向字段与运行时模型元数据，避免 spread 残留。

### Removed (移除)

- 移除 `notSupportedModels`、`disabledModels`、节点 `availableModels` 与 `includeDisabled`。
- 移除 `GET /api/provider-models/{type}`。
- 移除 `updateProviderModels()`、`getConfiguredNotSupportedModels*`、`filterNotSupportedModelsFromModelList()` 等旧逻辑。

### Verification

- `npm test`：21 suites / 326 tests 全绿。
- 文档本地链接检查：0 个失效链接。
- 32 个 provider/model 组合冒烟通过；Zed `gemini-4-argon` 在 `reasoning_effort=high` 下验证通过。

## [v3.14.1] - 2026-10-18

> 跨协议转译优化系列（Phase 0-4 全部落地 + 加固收尾；历史优化文档已在 v4.1.7 清理，可在 git 历史中查看）。过程里程碑标签：`v3.10.1`（Phase 0）、`v3.11.0`（Phase 1）、`v3.12.0`（Phase 2）、`v3.13.0`（Phase 3）、`v3.14.0`（Phase 4）。

### Added (新增)
- **Schema Polyfill 降级编译器**（Phase 1，里程碑 v3.11.0）：
  - 新增 `src/converters/schema-polyfill.js`，`$ref` 静态内联展开（循环检测 + 深度上限 10，超限安全坍缩）。
  - 被白名单剥除的约束（pattern/format/default/const/数值边界/长度/items 等 12 类）以 `[Constraints: k=v]` 格式注入 description，单字段 200 字符、整 schema 1000 字符双重上限，原始描述永不裁剪。
  - `oneOf`/`anyOf` 同型保留 type、异型删除 type 并注入分支摘要；`allOf` 浅合并 properties/required 并集。
  - env 开关 `CONVERT_SCHEMA_POLYFILL`（默认 on）与 `CONVERT_SCHEMA_POLYFILL_MAX_DESC`（默认 1000）。
- **签名金库 Signature Vault**（Phase 2，里程碑 v3.12.0）：
  - 新增 `src/converters/signature-vault.js`，无状态 HMAC 虚拟思考签名（`vsig1.<payload>.<hmac>`），进程级密钥（`SIGNATURE_VAULT_SECRET` 或启动随机生成），无 TTL。
  - X→Claude 响应侧（AnthropicSseEmitter + 各非流式组装路径）自动为无签名 thinking 块补签；Claude→非 Claude 四方向入口及 Claude 协议上游管道层无条件剥离虚拟签名，真签名永不剥离。
  - HMAC 校验失败仍按前缀安全剥离，永不因签名问题阻断请求；`SIGNATURE_VAULT` / `SIGNATURE_VAULT_STRIP` 独立开关。
- **Responses SSE Emitter 状态所有权收编**（Phase 3，里程碑 v3.13.0）：
  - 新增 `src/converters/responses-sse-emitter.js`，严格镜像 `AnthropicSseEmitter` 生命周期（start/textDelta/reasoningDelta/toolCall*/complete 全幂等）。
  - 全局单例 `streamStateManager` 彻底消除，流式状态收编实例字段 + `StreamSessionStore` 并发隔离；`openai-responses-events.js` 事件生成器纯函数化。
  - OpenAI / Gemini / Claude 三转换器 Responses 流式方向全量迁移，既有 golden 流式测试零回归。
- **跨协议可选增强**（Phase 4，里程碑 v3.14.0）：
  - 三处 parts 级同角色合并逻辑提取为 `mergeConsecutiveSameRoleContents` 纯函数。
  - tools 数组按 name 稳定排序（env `CONVERT_SORT_TOOLS`，默认 off），消除工具顺序抖动对隐式前缀缓存的干扰。
  - `cache_control` 跨协议丢弃补 debug 日志（`logOmittedCacheControl`），消灭静默丢弃。

### Fixed (修复)
- **Phase 0 定点修复包**（里程碑 v3.10.1）：
  - 统一思考预算换算：新阈值 `low<=2048 / medium<=8192 / high>8192`，修复常规预算全量坍缩为 high、medium 档名存实亡的问题；四份漂移换算表归一至 `src/converters/thinking-budget.js`。
  - Responses→Gemini 思考配置恢复：`toGeminiRequest` 按 `reasoning.effort` 生成 thinkingConfig（Gemini 3 thinkingLevel / 2.5 thinkingBudget 双轨）。
  - Responses→OpenAI 保留 reasoning item（折入 assistant 消息，`CONVERT_PRESERVE_REASONING_ITEM` 默认 on）与响应侧 `reasoning_content` 回填；`item_reference` 显式 debug 日志跳过。
  - Claude document 块四方向处理：→Gemini 原生 inlineData（>20MB 占位降级）、→Responses input_file、→Codex 占位（`CODEX_PDF_AS_INPUT_FILE=1` 尝鲜）、→OpenAI 占位 + warn 告警。
  - 思考签名闭环加固：<50 字符短签名放行 + debug、流式 `signature_delta` 转发携带 thoughtSignature 的 Gemini chunk、`redacted_thinking` 占位 + warn。

### Changed (变更)
- **加固收尾（P0-P3）**：清理 Phase 1/3 遗留死代码 436 行；所有转换层功能开关（`CONVERT_*` / `SIGNATURE_VAULT*`）统一经 `config-manager` 读取；Responses 事件生成器切断全局状态镜像；`polyfillSchemaForGemini` 补齐 `dialect` 预留接口。
- **测试体系**：新增 thinking-budget / schema-polyfill / signature-vault / responses-sse-emitter / phase4-enhancements 五个测试套件，全量 19 套件 288 用例通过。

## [v3.10.0] - 2026-10-16

### Added (新增)
- **Codex 动态模型发现与自动同步**：
  - 对接 `/backend-api/codex/models?client_version=...` 端点动态查询账号可用的最新模型目录，设置 10 分钟本地缓存与节点元数据。
  - 动态拉取的模型自动与基准模型库合并，自动衍生 `-fast` 变体并保留 `gpt-image-2` 虚拟图像模型。
  - 扩充预置基准模型池，新增 `gpt-6-luna`、`gpt-6-astra`、`gpt-6.1-sol`、`gpt-6-sol` 等全新一代模型支持。
- **Codex WebUI 客户端版本号配置**：
  - 在 `openai-codex-oauth` 节点编辑表单中增加 `CODEX_VERSION` 输入项，支持针对不同账号独立配置客户端版本号。
  - 完善中英文多语言字典（提供商字段与占位提示），编辑保存版本号时即时作废缓存，下次调用立即按新版本号拉取最新模型。
- **Codex 订阅类型解析与权限门禁过滤**：
  - 新增 `parseCodexTokenMetadata` 自动解析 OAuth Token 中的 `chatgpt_plan_type` 订阅类型与 `account_id`。
  - 自动过滤 `supported_in_api: false` 以及需要升级付费计划（`upgrade`）的门禁模型，防止调用越权模型报错。

### Fixed (修复)
- **Codex 非流式响应误判修复**：修复上游返回有效非流式响应时，因响应结构校验误判为空响应而触发 5 次无意义重试并最终报错的问题。
- **流式思考增量放行**：放行 OpenAI 协议下的 reasoning delta 思考增量内容，保障思维链平滑透传展示。
- **客户端断开连接健康度判定修复**：修复客户端主动提前断开请求（如用户取消生成）时被误判为节点上游超时错误而扣减健康度的问题，保护节点号池稳定性。
- **思考后空响应拦截**：修复上游模型输出思考内容后直接断开且无正文（`MALFORMED_FUNCTION_CALL`）被静默放行的问题，及时捕获异常并介入重试或熔断。

### Changed (变更)
- **版本解析去暗箱化与去阻塞优化**：彻底移除 `child_process.execSync('codex --version')` 同步子进程探测，消除主线程事件循环阻塞与不同环境暗箱探测行为漂移风险。
- **架构解耦**：移除顶层单例 `CODEX_VERSION`，各 `CodexApiService` 实例独立持有自身的 `this.version`，实现多节点状态解耦。

## [v3.9.1] - 2026-10-13

### Fixed (修复)
- **发布卫生**：补齐 v3.9.0 缺失的版本 bump（v3.9.0 tag 指向的提交 package.json 仍为 3.8.0，CHANGELOG 仍挂 Unreleased）。
- **trae 存量配置兼容迁移**：config 加载时自动迁移历史 `trae-agent_v3` 池键至 `trae-solo_work_lite`（按 uuid 去重）、节点历史 `TRAE_CHANNEL_MODE`（`agent_v3`/`legacy`）改写为 `solo_work_lite` 并原子回写持久化；`resolveTraeChannelMode` 与 `MODEL_PROVIDER` 归一化同步容忍历史值——v3.8.0 及更早配置升级后不再抛 `Unsupported model provider`。
- **Responses API**：`response.completed` 的 `safety_identifier` 不再每次生成随机值（置空，与 usage 全零兜底同一治理原则，杜绝伪造数据）。
- **AnthropicSseEmitter**：`delta()` 增加误用守卫（multi 模式误调或无活动块时抛错并指引 `deltaAt`），杜绝静默产出 `index:-1` 的非法 SSE 事件。
- **provider-api**：`validateTraeProviderConfig` 改为显式 `TRAE_CHANNEL_MODE` 恒优先于 providerType（与通道判定「显式优先」原则一致），修复矛盾组合（如 `trae` + `solo_work_lite`）下的误拒/误放行。

### Changed (变更)
- **分层治理**：`mapFinishReason`/`sanitizeToolId` 下沉至 `src/utils/protocol-utils.js`（`converters/utils.js` 再导出保持兼容），消除 zed-core 对 converters 层的反向依赖。
- **重构清理**：移除 `TRAE_CHANNEL_PRESETS` 无消费方的 `name`/`label` 死字段、`getChannelConfig` 不可达 preset 兜底、OpenAIConverter responses 流状态死初始化；`CodexConverter.streamParams` 更名 `streamSessions`；trae-core 别名表种类改为构造期一次解析缓存；`getOpenAIStreamIdentity` 缺 requestId 时按 store 一次性告警（并发共享 default 键风险可观测）。
- **文档**：修正 TRAE 通道指南残留旧模型数对照表（25/25/29 → 24/19/20，与 provider-models 实际清单一致）。

## [v3.9.0] - 2026-10-13

### Fixed (修复)
- **zed**：修复 open_ai 模型工具调用后 `response.completed` 的 stop_reason 恒为 `end_turn` 的问题（改用独立的 sawToolUse 标志）；google 路径补全整体缺失的工具能力（tools→functionDeclarations、tool_choice→functionCallingConfig、tool_use/tool_calls→functionCall、tool_result→functionResponse），工具 id 统一经 `sanitizeToolId` 清洗还原函数名。
- **converters**：Gemini->Claude 流式补齐 `message_start`/`content_block_start`、块 index 递增与 `message_stop` 收尾，产出合规 Anthropic SSE；Responses API 无 usage 时不再伪造随机 token 数（改全零兜底）；非流式 status 移除非法的 `requires_action`/`in_progress`（stop/tool_calls→completed，length/content_filter→incomplete+incomplete_details）；流式 chunk id/created 在同次请求中保持稳定；responses output_index 与 sequence_number 严格递增；快照式 arguments 按 diff 增量下发；Claude->OpenAI 的 finish_reason 不透传 anthropic 专有词表。
- **trae**：修复 CUSTOM 模式且 URL 含 `llm_utils_chat`（个人版自定义端点）时错误走 ToB 接口与别名表的问题；别名表剔除上游已下线/开关关闭的型号；WebUI Trae 授权弹窗默认 Host 按通道区分。
- **Gemini->Claude stop_reason 合规**：SAFETY/RECITATION 等安全拦截类终态统一映射为 Anthropic 合法值 `refusal`（原 `stop_sequence`/`safety`/`recitation`/`other` 语义错误或非法）。
- **grok**：修复 Grok->Claude 委托调用未透传 requestId 导致的并发流状态交叉（缺 responseId 时 message_start 每帧重发、messageId/usage 跨请求污染）；拆除重复包装层，首帧 message_start 由两个恢复为一个（合规 Anthropic SSE）。

### Changed (变更)
- **Trae 通道重构 (Breaking)**：彻底废除历史 `trae-agent_v3` 通道（经核实 `agent_v3` 仅为上游网关路径层级而非业务 function），重新确立 `trae-solo_work_lite`（SOLO Agent，19 模型）与 `trae-chat_v3`（侧边栏 Chat，20 模型）为独立一级提供商；废除动态拉取模型列表时的"基准兜底合并"与"强制追加 auto 虚拟别名"机制，模型列表 100% 对应上游真实活跃模型（trae 24 / solo_work_lite 19 / chat_v3 20）；请求时保留向后兼容的别名归一化。
- **Trae 通道判定收敛**：新增 `trae-channel.js` 纯函数模块作为 single source of truth（resolveTraeChannelMode/isSoloFamilyChannel/resolveAliasTableKind/TRAE_PROVIDER_DEFAULTS），trae-core/provider-api/service-manager 六处判定点统一委托；**通道模式优先级明确为「显式 configuredMode 恒优先于 providerType 与 URL 推断」**，修复个人版节点手改 `custom` 逃生口被 providerType 静默覆盖的问题。
- **Anthropic SSE 骨架统一**：新增 `AnthropicSseEmitter`（sequential/multi 双语义、done 终态守卫、finish 自动补 message_start），GeminiConverter claude 流首个迁移（净减 74 行），为后续 Codex/OpenAI 机器统一奠基。
- **重构清理**：`sanitizeToolId`、`getOpenAIStreamIdentity` 收敛为共享导出（消除逐字节重复定义）；zed-core 的 gemini finishReason 内联映射收编至共享 `mapFinishReason`；删除 GeminiConverter claude 流状态的 completed 死逻辑与 trae-core 的恒等冗余条件。

## [v3.8.0] - 2026-10-10

### Added (新增)
- **Trae 独立双通道拆分 (Breaking / Major)**：
  - 将 Trae 正式拆分为两个完全独立的一级提供商：`trae`（企业原生 ToB Raw Chat）与 `trae-agent_v3`（SOLO Agent v3 / chat_v3）。
  - 双通道各自拥有完全隔离的端点配置、请求 Header 指纹、请求体构建与动态模型发现。
  - `trae` 独立对接企业端点 `https://api.enterprise.trae.cn/api/ide/v2/llm_raw_chat`（`function: "chat"`）。
  - `trae-agent_v3` 独立对接端点 `https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat`（`function: "solo_work_lite"`）。
- **两端专属动态模型发现**：
  - `trae` 动态拉取企业 `batch_get_detail_param`（25 个模型，包括专属 `Doubao_1_6`、`glm-5v-turbo`、`minimax-m2.7`、`kimi-k2.8-preview`）。
  - `trae-agent_v3` 动态拉取个人版 `get_detail_param`（25 个模型，包括专属 `kimi-k2.6`、`glm-5`、`glm-5-turbo`、`DeepSeek-V4-Flash`）。
  - 经全量实测 50/50 模型请求 100% 成功。
- **配置安全与防呆校验**：
  - 提供商表单与 API 新增 `validateTraeProviderConfig` 交叉校验，严防 ToB 与 Agent v3 的 URL 错配。
  - PAT / OAuth 登录自定义 Host 沿 options 链完整透传至新节点 `TRAE_BASE_URL`。
  - `autoLinkProviderConfigs` 引入双重磁盘池合并防御，严禁局部写入覆盖整个号池文件。
- **技术规范文档**：
  - 新增 `docs/TRAE_CHANNELS_UPSTREAM_GUIDE.md`，深度剖析上游 `solo_work_lite`、`chat_v3` 与企业 `chat` 的协议与参数差异。

### Changed (变更)
- **WebUI 配置表单精简**：彻底移除“通道模式 (Channel Mode)”选择框与表格列，简化用户配置心智模型。
- **测试环境严格隔离**：单元测试注入独立临时文件，杜绝污染生产配置。

---

## [v3.7.1] - 2026-10-09

### Added (新增)
- **流式会话状态存储器 (StreamSessionStore)**：
  - 引入统一的带 TTL 的 `StreamSessionStore` 管理多协议转码过程中的临时会话上下文，解决长连接会话泄漏隐患。
- **架构设计规范**：
  - 新增 `docs/archive/CONVERTER_STREAM_DESIGN.md` 流式转换共享层设计规范。

### Changed (变更)
- **finish_reason 统一归一化**：
  - 将各协议转码器散落的终止原因映射统一收敛至共享的 `mapFinishReason`。

---

## [v3.7.0] - 2026-10-09

### Removed (移除 - Breaking Changes)
- **彻底下线 4 个废弃提供商**：
  - 彻底移除 `FORWARD_API`、`QWEN_API`、`IFLOW_API`、`GEMINI_CLI` 的适配器、业务核心、WebUI、认证逻辑与相关映射常量，默认 `MODEL_PROVIDER` 调整为 `gemini-antigravity`。

### Refactored (架构重构)
- **底层解耦与循环依赖消除**：
  - 新建 `src/utils/protocol.js` 下沉协议基础能力，消除 `common.js` 的全部静态循环依赖。
  - 将庞大的请求处理管线迁出至独立的 `src/handlers/request-pipeline.js`，`common.js` 代码体积大幅下降。
- **用量解析收敛**：
  - 抽取共享模块 `usage-normalizer.js`，统一 `api-potluck` 与 `model-usage-stats` 的统计提取逻辑。
- **依赖瘦身**：
  - 移除未使用的运行时依赖 `lodash`、`openai`、`@ai-sdk/openai`、`ai`，`undici` 归入 devDependencies。

---

## [v3.6.2] - 2026-10-08

### Fixed (修复)
- **转码器多轮工具调用**：
  - 合并连续 assistant 工具调用消息，修复并发 `tool_calls` 导致的流中断 (上游 4027 错误)。
  - 修复 Anthropic 协议 Harness 工具调用转换、响应块顺序与流式状态机。
  - 修复多协议转码工具调用上下文丢失与轮次校验问题。
- **Gemini Protobuf 冲突消除**：
  - 统一 `thinkingConfig` 中的 `includeThoughts` 命名，消除 Protobuf oneof 字段冲突。
- **用量统计修复**：
  - 修复 Trae 模型使用统计为 0 及 Token 累加逻辑。
  - 修复 Zed Provider 缓存命中 Token (Cached) 统计为 0 的问题。
  - 修复托管 Provider 丢失自定义模型及 Playground 不显示 OpenAI Custom 模型问题。

---

## [v3.6.1] - 2026-10-05

### Added (新增)
- **Zed 推理能力升级**：
  - 完整支持 OpenAI 思考模型的 5 档推理强度（Reasoning Effort）双向映射。
- **Antigravity 模型提取优化**：
  - 优雅提取 `agentModelSorts` 与生图模型，自动排除 medium/low/lite 降级模型。

### Fixed (修复)
- 修复 Antigravity 节点模型隔离与禁用节点时模型列表动态同步失效问题。
- 修复 Zed `claude-sonnet-5-5` 400 校验错误及测试配置污染问题。
- WebUI Playground 移除多余的 Temperature 与 MaxTokens 参数显示。

---

## [v3.6.0] - 2026-10-01

### Added (新增)
- **Trae (SOLO) 深度提供商接入**：
  - 支持 WebUI OAuth 授权与 PAT (Personal Access Token) 凭据导入管理。
  - 支持自 `api.enterprise.trae.cn` 与 `trae-api-cn.mchost.guru` 动态拉取模型元数据。
  - 动态提取 `context_window`（最高 1M Tokens）与 `max_tokens`（最高 64k Tokens）。
  - 双向映射思考深度参数 `reasoning_effort`。
  - 完整支持 OpenAI 兼容工具调用 (Tool Call) 与 SSE 流式聚合。
  - 生产级多租户隔离架构。
