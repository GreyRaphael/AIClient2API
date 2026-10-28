# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [v5.1.0] - 2026-10-28

### Added

- 新增 `GET /api/provider-models/metadata`，返回所有 Provider 的模型 metadata（上游 capability 与自定义模型配置合并），供 WebUI 展示。
- 仪表盘“可用模型列表”改为两列卡片，每个模型单行展示 `id`、`context_length`、`max_output_tokens`、`support_images`、`support_efforts`；点击卡片复制模型 ID 与 metadata JSON。
- Playground 接口类型新增 OpenAI Responses（`/v1/responses`）与 Anthropic Messages（`/v1/messages`），支持流式/非流式与图片附件输入。
- Playground 流式输出新增客户端打字机预览，上游合并 delta 时仍保持逐字显示。
- 新增 Playground 三协议 e2e（Responses/Messages 文本流式与非流式、图片输入）与 UI 路由单测。

### Changed

- 自定义模型 metadata 注入逻辑抽取为 `src/providers/custom-model-metadata.ts`，`/v1/models` 与 metadata 端点共用。
- Playground 协议适配层统一处理 Chat / Responses / Messages 的请求构造、流式事件解析与非流式结果提取。

### Fixed

- 修复 `section-access.css` 中重复的模型列表样式覆盖仪表盘两列布局、导致卡片按 4 列排布的问题。
- 修复 Playground 在上游把多个 token 合并为少量大 delta 时看不到打字机效果的问题。

### Verification

- `npm test`：**52 suites / 651 tests 全绿**。
- `npm run verify`：typecheck、typecheck:plugins、strict、any、imports、cycles、coverage、runtime smoke 全部通过。
- Playground e2e：**10/10 通过**（2 个模型 × Responses/Messages × 流式/非流式 + Responses/Messages 图片输入）。

## [v5.0.8] - 2026-10-27

### Added

- 自定义模型新增 `context_length`、`max_output_tokens`、`support_images`、`support_efforts` metadata 字段，支持 WebUI 编辑并透传到 `/auto/v1/models` 与单 Provider `/v1/models`。
- `support_efforts` 支持 `null` / `high` / `max` / `high+max` 下拉配置；后端仅保留 `high` / `max`。
- 新增自定义模型 72 次 e2e 矩阵：6 模型 × 3 协议 × 2 effort × text/image。

### Changed

- **Antigravity**：`support_efforts=null` 时下游 `reasoning_effort` 一律剥离，不再返回 400；Provider 层同步兜底清理 thinkingConfig。
- **OpenAI Codex OAuth**：Claude → Codex 的 Messages 转换不再硬编码默认 `medium`，改由 Provider 按上游元数据取最高档。
- 自定义模型移除 `contextLength` / `maxTokens` 旧字段兼容与旧 `max_tokens` 输出，统一使用 `context_length` / `max_output_tokens`。
- 自定义模型移除 `temperature` / `topP` 配置与强制覆盖逻辑，采样参数回归客户端控制。

### Fixed

- 修复自定义模型 WebUI 无法修改推理档位的问题；多选控件改为明确的 `null` / `high` / `max` / `high+max` 下拉。
- 修复自定义模型 metadata 在 auto 聚合与单 Provider 模型列表中不一致的问题。

### Verification

- `npm test`：**51 suites / 649 tests 全绿**；typecheck、typecheck:strict、imports、cycles 全部通过。
- 自定义模型 e2e：**72/72 通过**（36 次文本、24 次识图、12 次无识图），0 逻辑失败 / 0 超时 / 0 限流。

## [v5.0.7] - 2026-10-26

### Added

- 新增 Zed 模型元数据运行时注册表：远端 `/models` 成功后按账号持久化，冷启动自动恢复；支持账户隔离、原子写入与损坏缓存降级。
- 新增 Zed 协议规则模块，按模型族同步解析 `claude` / `openaiResponses` / `gemini` 上游协议，核心 registry 不再依赖 provider 专属数据表。
- 补充 Zed 注册表缓存、账户隔离、冷启动、禁用模型过滤、未知模型宽松透传与健康检查预算回归测试。

### Changed

- **Zed 单跳协议感知重构**：客户端协议直接转换到模型对应的上游原生协议，移除 Claude 中枢二次转换；OpenAI Responses、Gemini 与 Anthropic 原生事件直接透传后再单跳回转。
- **删除 23 个模型的内置硬编码快照**：模型能力完全以 `cloud.zed.dev/models` 的运行时元数据为准，远端成功响应整体替换并过滤 `is_disabled` 模型。
- **未知模型宽松降级**：严格思考档位校验与 `max_output_tokens` 裁剪仅在权威元数据存在时生效；新增模型/档位不再被本地白名单误杀。
- **Trae 通道清理**：移除 `solo_work_lite` 节点选项与配置展示，思考模型过滤仅保留包含 `extra_high` 的通道。

### Fixed

- 修复 Zed 健康检查对 OpenAI Responses 通道发送 `max_tokens: 1` 导致上游返回空 500 的问题；Zed 健康检查改用最小可用预算 `16`，Kiro 保持 `1`。
- 修复 Zed 重构引入的 `request-pipeline` TypeScript 类型错误，`npm run typecheck` 恢复通过。
- 修复远端模型下架/禁用后仍残留在实例元数据与 `/v1/models` 的问题。

### Verification

- `npm run verify`：**50 suites / 626 tests 全绿**；typecheck、typecheck:plugins、strict、any 棘轮、imports、cycles、覆盖率门槛、runtime smoke 全部通过。
- 真实上游全量 E2E：**18 个模型 × 11 项核心用例（198 项）+ 6 项通用定向契约全部通过**；4 项 provider 方言 canary 全部通过。
- Zed 健康检查：3 个有额度节点全部 PASSED；3 个账号仍因 credits 耗尽返回 403（账号状态，非代码问题）。
- 刷新 any 与覆盖率基线：`DynamicPayload` references 1525；总覆盖率 行 33.49% / 分支 33.91% / 函数 37.24%。

## [v5.0.6] - 2026-10-26

### Changed

- 完成 P0–P2 后续重构：拆分 Zed 通道请求构建器、Kiro 请求与流状态、Provider Pool 选点/刷新调度及 Pipeline 流生命周期，保持现有 API、配置和插件调用约定。
- 修复 strict 门槛假阴性，主源码与内置插件启用 `noUnusedLocals`，并清理无用 import、变量、catch 绑定和死代码。
- 公共响应/流联合移除 `any` catch-all，请求扩展载荷改为 `unknown`；Claude → OpenAI usage 使用真实 DTO。`DynamicPayload` 引用从 1539 降至 1499。

### Added

- 新增 Kiro、Pool、Pipeline 核心表征测试，以及 Access API、Pool 重初始化、BaseConverter 和流生命周期回归测试。
- 新增 strict 编译器失败故障注入测试，避免非 `src/` 严格错误或失败的 baseline 更新被误报为成功。

### Verification

- `npm run verify`：49 suites / 618 tests 全绿；strict、noUnusedLocals、imports、cycles、any 棘轮、覆盖率门槛和真实 Node smoke 全部通过。
- 真实上游 E2E：18 个模型 × 11 项核心用例（198 项）全部通过，6 项通用定向契约与 4 项 provider 方言 canary 全部通过。
- 性能基准：非流式与流式各 20 请求、并发 3，成功率均为 100%；非流式 2.13 req/s、流式 1.65 req/s。
- clean checkout 覆盖率基线：行 32.88% / 分支 33.41% / 函数 36.20%。

## [v5.0.5] - 2026-10-25

### Fixed

- 覆盖率基线排除 gitignored 的 `src/plugins-user` 目录，避免本地存在用户插件时覆盖率高于 clean checkout，导致 CI 覆盖率门槛误判。`check-coverage` 同步跳过该目录，并补充回归测试。
- 覆盖率基线改为在 clean checkout 生成，并分别在 Node.js 22 与 24 下验证。

### Changed

- v5.0.5 仅包含 CI / 覆盖率工具链修复，**无运行时、API、配置或数据格式变更**。

### Verification

- GitHub Actions CI（Node 22.x / 24.x）：通过。
- `npm run verify`：44 suites / 593 tests 全绿，strict 0 errors，any 棘轮通过，imports / cycles / runtime smoke 通过。
- clean checkout 覆盖率：行 30.01% / 分支 31.21% / 函数 33.07%。

## [v5.0.4] - 2026-10-25

### Fixed

- 修复插件方法 receiver 丢失：`init` / `destroy` / `authenticate` / `middleware` / `hooks` 改为通过 `.call(plugin, ...)` 调用，恢复 `this` 绑定，避免依赖实例状态的第三方插件静默失效。新增 5 个 receiver 回归测试。
- 修复覆盖率门槛的 LCOV `FNDA` 解析 off-by-one：`FNDA:` 前缀长度为 5，旧实现从 `slice(6)` 开始会丢掉 hit count 第一位，导致函数覆盖率被系统性低估。修复后函数覆盖率由 11.39% 校正为 32.65%（293 → 840 covered）；这是统计口径修复，不是测试覆盖率突然提升。

### Changed

- `npm run verify` 现在执行 `test:coverage` 并通过 `check:coverage` 校验覆盖率门槛，本地验证与 CI 口径一致。
- 新增覆盖率门槛回归测试，包含“覆盖率低于基线时必须失败”的失败路径断言。
- 清理 `provider-config-linker` 行尾空白，无行为变化。

### Verification

- `npm run verify`：44 suites / 592 tests 全绿，strict 0 errors，any 棘轮通过，imports 136 文件通过，cycles 0，runtime smoke OK。
- 覆盖率：行 29.84% / 分支 31.09% / 函数 32.65%。
- 全量 E2E：20 个模型 × 11 项核心用例 + 6 项定向契约，26/26 通过。
- 定向回归 E2E：openai-custom:glm-5.3，11 项核心 + 2 项定向通过。

## [v5.0.3] - 2026-10-25

### Fixed

- 修复非号池部署（`providerPools` 为空且使用 `openai-custom` / `openaiResponses-custom` / `claude-custom`）时所有内容生成请求返回 500 `service.generateContent is not a function` 的回归。`request-handler` 恢复传入 `null`，由 `handleContentGenerationRequest` 延迟解析 service。
- 修复 `request-handler`、`api-manager`、`service-manager`、`plugin-installer`、`provider-api` 中 5 个自递归的 `getErrorMessage`，避免错误路径抛出 `RangeError: Maximum call stack size exceeded`（插件市场离线 fallback、provider 健康检查等）。
- 新增回归测试：真实 standalone server + 空号池 + 本地假上游；插件市场离线缓存 fallback；全源码 `getErrorMessage` 自递归扫描。
- `any` 棘轮扩展为同时校验正则口径、TypeScript AST `AnyKeyword` 节点（`src` + `types/`）以及 `DynamicPayload` 定义/引用数；新增别名或引用会使 CI 失败。
- 补齐第三方依赖类型：`busboy` 使用 `@types/busboy`；`adm-zip` 0.5.x 与 `multer` 使用本地最小声明（`types/adm-zip.d.ts`、`types/multer.d.ts`），移除 `types/vendor-modules.d.ts` 的 `any` 模块声明。
- 在触碰的 UI 上传模块中收敛动态类型：`event-broadcast` / `plugin-api` 移除 `DynamicPayload`，改用真实 multer `File`、`Record<string, unknown>` 与显式窄化/守卫。
- 修正发布说明中的 `any` 口径与 Node.js 版本要求。

### Verification

- `npm run verify`：32 suites / 497 tests 全绿，strict 0 errors，imports 128 文件通过，runtime smoke OK。
- 全量 e2e：20 个模型，26/26 通过（20 × 11 项核心用例 + 6 项定向契约）。

## [v5.0.2] - 2026-10-25

### Changed

- **TypeScript 严格化重构收尾**：按 `: any` / `as any` 正则口径，`src` 下显式 `any` 从 2279 降至 234 处（-90%），`strict` 错误清零，`@ts-nocheck` 保持 0 文件 / 0 行。
- Provider 层（antigravity、zed、codex、claude-kiro、trae、openai、model-capability、adapter、registry/capabilities/strategies）全部收敛到真实 DTO / 协议类型。
- 四个协议转换器（Claude / OpenAI / OpenAI Responses / Codex）及 `GeminiConverter` 的公共入口与内部 payload 完成类型化。
- `request-pipeline` 引入统一 `PipelineError` 边界；handlers、UI API、core 与 services 模块同步类型化。
- 正则口径下剩余 234 处显式 `any` 位于 `security-hardening.ts` 的 monkey-patch wrapper；按 TypeScript AST 统计所有 `AnyKeyword` 节点（含泛型位置与 `types/`）为 393 处（src=331 / types=62）。
- 新增 `any` 棘轮基线（234 annotations / 6 assertions / 393 AST nodes，DynamicPayload 51 definitions / 1567 references），后续新增 `: any`、`as any`、`Record<string, any>` 或 `DynamicPayload` 将使 CI 失败。
- **运行要求提升**：Node.js >= 22.18.0（原生 TypeScript 类型擦除），Node 20 及更早版本无法启动。

### Verification

- `npm run verify`：strict 0 errors，30 suites / 494 tests 全绿，imports 128 文件通过，runtime smoke OK。

## [v5.0.1] - 2026-10-24

### Fixed

- **WebUI `#upload-config` 空白**：补齐前端 provider 注册表相关 import，修复渲染配置列表时 `detectProviderFromPath is not defined` 导致的 `ReferenceError`。
  - `upload-config-manager.js` 补回 `detectProviderFromPath`
  - `file-upload.js` 补回 `getProviderUploadDir`
  - `modal.js` 补回 `isOAuthProvider`
- 该问题由 v5.0.0 的前端 provider 注册表合并引入；后端 `/api/upload-configs` 数据本身正常。

### Verification

- `npm test -- --runInBand`：**27 suites / 486 tests 全绿**。
- `npm run typecheck`：**0 errors**。
- `npx jest tests/static-syntax.test.js`：**27 / 27 通过**。

## [v5.0.0] - 2026-10-24

### Breaking Changes

- **移除 `grok-cli-oauth` provider**：删除 Grok CLI core、OAuth、适配器注册、模型清单、号池与用量查询、OAuth/批量导入路由、前端入口与配置示例。其他 provider（Antigravity、Kiro、Codex、OpenAI、Claude、Zed、Trae）保持不变。
- 升级后请删除 `configs/grok-cli/`、`provider_pools.json` 中的 `grok-cli-oauth` 节点及相关缓存；这些运行时数据不会被自动清理。

### Added

- 新增前端 `static/app/provider-registry.js` 与后端 `src/providers/provider-registry.js`，统一维护 provider 类型、协议、模型 baseline、健康检查模型、凭据路径、图标与 UI 元数据。
- 新增 `npm run typecheck`，`tsconfig.json` 纳入 `src/**/*.js` 并开启 `checkJs`；新增 GitHub Actions CI（typecheck + 单测）。
- 新增 `docs/CONFIG_PRECEDENCE.md`，明确配置读取、provider 能力、模型列表与 fallback 优先级。
- E2E 新增动态模型选择：定向用例从 `/auto/v1/models` 按 provider 前缀选择，无匹配模型时自动 skip。
- 新增 `npm run test:e2e:providers`，用于运行 Zed / Gemini 方言 canary。

### Changed

- P0 工程精简：统一使用 npm，删除 `pnpm-lock.yaml` 与安装脚本 pnpm 分支；移除未使用依赖 `ws`、`supertest`、`jest-environment-node`；删除未引用资源与一次性迁移脚本。
- 过期评审/流式设计文档归档到 `docs/archive/`；历史回归测试合并为 `tests/regressions/` 两个领域文件，126 个用例全部保留。
- 通用 E2E 定向用例从 16 项压缩到 6 项；4 项 provider 方言用例移入 opt-in canary；移除模型采样/质量类 E2E。
- 动态 provider 的静态模型清单压缩为少量冷启动 baseline，完整模型以 `/auto/v1/models` 为准。
- 内置 provider 能力规则并入 provider registry，减少方言知识散落。
- 类型检查修复了生图 `prompt` 作用域、Trae header 数组、`update-api` arrayBuffer 返回值、`config-scanner` 注册表导入等实际缺陷。

### Verification

- `npm test -- --runInBand`：**27 suites / 486 tests 全绿**。
- `npm run typecheck`：**0 errors**。
- 默认 E2E（19 模型全量）：**25 / 25 通过**（19 个模型 × 11 项核心 + 6 项通用定向）。
- Provider 方言 canary：**4 / 4 通过**。
- `npx jest tests/static-syntax.test.js`：**27 / 27 通过**。

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
