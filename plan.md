# AIClient2API 代码优化计划

> 基于 2026-10-09 全量代码审查（结合 git history 热点分析）制定。
> 目标：消除死代码、收敛复制粘贴、解除循环依赖、降低热点文件（converter / kiro / pool-manager）的复发 bug 率。

## 进度（2026-10-09 更新）

- [x] Phase 0 基线：5 suites / 68 tests 全绿；type-check 空转；冒烟 EADDRINUSE（本机已有实例）
- [x] Phase 1 全部完成（commits: 7bb641c / e5591c2 / 5d49d5b / 78db87b / cafede2）
  - 1.4 说明：评估后选择方案 B（移除 type-check script），因 checkJs 会沿 import 图传递检查全库、存量 236 错误，不适合低风险任务
  - 1.5 附带发现：FORWARD_API/QWEN_API/IFLOW_API/GEMINI_CLI 适配器被上游刻意注释（fee1065/e261e1b），已改为说明性注释；这些提供商的 core/WebUI/映射仍在但请求会被 getServiceAdapter 拒绝，**是否恢复注册需用户决策**
- [x] Phase 2 完成（commits: c9d86bf / 40a07d0）
  - 两插件实现已轻微分叉，统一采用 a19d505 后 stats-manager 语义（mergeUsage 路径下可观测行为一致）
  - zed 接入共享归一化；trae 经评估为刻意的格式适配（reasoning 独立），保留原实现并加注释
  - kiro（估算式）/grok-core（透传）/grok-cli（3 行简读）评估后均非归一化复制粘贴，不迁移
  - 新增 tests/usage-normalizer.test.js（20 用例）；全量 6 suites / 88 tests 全绿
- [x] Phase 3 完成（commits: d9de9b1 / 759b5d4）
  - 3.1 新建 src/utils/protocol.js 下沉协议基础能力，21 个文件 import 重定向，common.js 静态环全部消除
  - 3.2 请求管线迁出至 src/handlers/request-pipeline.js；common.js 2441 → 619 行（达成 <1000 目标）
  - 静态环检测：common.js/request-pipeline.js 相关环为 0；存量 11 个环集中在 auth/oauth-handlers↔ui-manager↔adapter↔gemini-core 簇（与本次无关，见下）
  - 附带发现：getOpenAIStreamChunkStop 全仓库无实际调用方（common.js 的 import 是唯一引用但未使用），convert.js 中该导出亦为死代码
  - 遗留：CI 加入环检测防回归（需新增 madge devDependency 或内置脚本）；auth/oauth 簇 11 个存量环待评估
- [x] 四个停用适配器彻底删除（commit: 见 git log，FORWARD_API/QWEN_API/IFLOW_API/GEMINI_CLI
  的 core/auth/adapter/常量/映射/WebUI 引用全部移除；默认 MODEL_PROVIDER 改为 gemini-antigravity；
  静态环 11 -> 9；88/88 tests 全绿）
- [x] Phase 4.1 设计稿：docs/CONVERTER_STREAM_DESIGN.md（Parser/Session/Emitter 三层分离，
  StreamSession 替代 4 种碎片化状态，迁移顺序 Grok→Gemini→Responses→Codex→OpenAI→Claude）
- [x] Phase 4.2（瘦身版，经用户批准替代完整分层迁移）：
  - finish_reason 单点化（commit: mapFinishReason 扩展 gemini->openai/openai->gemini 两组映射 +
    按目标协议兜底；GeminiConverter 内联表与 OpenAIResponsesConverter 私有方法收编）
  - StreamSession 统一（commit: 新增 stream-session.js 带 TTL 存储，替换 9 处散落状态 Map；
    顺带修复 OpenAIConverter 手写清理会误杀活跃长流的问题）
- [ ] Phase 4.3（可选，完整 Parser/Emitter 分层）：按设计稿逐 Converter 迁移，视 bug 复发情况再评估
- [ ] Phase 5 结构项

## 执行原则

1. **小步提交**：每个任务独立 commit，commit message 遵循仓库现有约定（`refactor(scope): ...` / `chore(...)`）。
2. **测试基线先行**：开始前记录 `npm test` 基线结果；每个 Phase 结束后全量回归，不允许新增失败。
3. **纯重构不改行为**：除明确标注「行为修复」的任务外，所有改动必须保持对外行为不变。
4. **高风险任务（Phase 3+）单独评审**，不在一次提交中混合多个结构性改动。

### 基线确认（Phase 0）

- [ ] 运行 `npm test`，记录通过/失败数作为基线（jest `--forceExit` 已知存在，失败项需先甄别是否为存量问题）
- [ ] 运行 `npm run type-check`，确认现状（预期：实际未检查任何 JS，见任务 1.4）
- [ ] `node src/core/master.js --help` 或冒烟启动一次，确认服务可拉起

---

## Phase 1：低风险清理（Dead Code）

风险：低 ｜ 预计改动：~350 行删除 ｜ 无行为变化

### 1.1 移除未使用的 npm 依赖

**现状**：以下依赖在 `src/`、`tests/`、`static/`、`healthcheck.js` 中均无任何 import：

| 依赖 | 处置 |
|---|---|
| `lodash` | 从 dependencies 删除 |
| `openai` | 从 dependencies 删除 |
| `@ai-sdk/openai` | 从 dependencies 删除 |
| `ai` | 从 dependencies 删除 |
| `undici` | 移入 devDependencies（仅 `tests/api-integration.test.js:1` 使用 `fetch`；后续可评估直接改用 Node 20+ 全局 fetch 后彻底删除） |

**注意**：`dotenv` 保留（`src/services/api-server.js:119` 有 `import 'dotenv/config'`）。
**验证**：`npm install` 后 `npm test` 回归 + 冒烟启动；`grep -rn "from '<dep>'" src tests` 确认为零。

### 1.2 删除 `src/convert/convert.js` 的死导出

**现状**：该文件 36 个 export 中，27 个 `toXxxFromYyy` 包装函数（src/convert/convert.js:149-291，如 `toOpenAIRequestFromGemini`、`toClaudeStreamChunkFromOpenAI` 等）在全仓库零调用——是文件头注释自述的「新架构展示样板」残留。

**保留**（有外部调用）：`convertData`、`getOpenAIStreamChunkStop`、`extractAndProcessSystemMessages`、`extractTextFromMessageContent`、`getConverter`、`getRegisteredProtocols`、`isProtocolRegistered`、`clearConverterCache`、`getOpenAIResponsesStreamChunkBegin`、`getOpenAIResponsesStreamChunkEnd`，以及 default export 对象（同步剔除其中的死函数引用）。

**验证**：删除后对每个保留名 `grep -rn` 确认调用点不受影响；`npm test` 回归。

### 1.3 `_manageSystemPrompt` 私有化

**现状**：`src/utils/common.js:2009` export 了 `_manageSystemPrompt`，但全仓库唯一调用点在 common.js 内部（common.js:1944）。
**改动**：去掉 `export`，改为模块内私有函数。
**验证**：`grep -rn _manageSystemPrompt src` 确认无外部引用；测试回归。

### 1.4 修复 `type-check` 形同虚设

**现状**：tsconfig.json 设置了 `checkJs: false` 却 include 了 5 个 JS 文件，`tsc --noEmit` 实际只解析 `types/**/*.d.ts`，对源码零覆盖。
**方案**（二选一，倾向 A）：
- A. 开启 `checkJs: true` + `strict: false` 渐进检查，先只覆盖 `src/utils/` 与 `src/converters/`，为存量错误加 `// @ts-nocheck` 或 `@ts-expect-error` 豁免清单，后续逐步收敛；
- B. 维持现状但在 package.json 删除 `type-check` script，避免给人「有类型保障」的错觉。

**验证**：`npm run type-check` 真实报错/通过。

### 1.5 杂项清理

- `antigravity_notes.md` 从仓库根目录移入 `docs/`（内容与 docs/ 下文档同性质）
- 删除整块注释代码：`src/utils/common.js` 10 处、`src/converters/strategies/ClaudeConverter.js:715`（13 行）、`src/handlers/request-handler.js:254`（12 行）等（逐块人工确认非「刻意保留的协议样例」后删除）
- `console.log` 收敛：`src/ui-modules/oauth-api.js`、`src/core/security-hardening.js`、`src/ui-modules/event-broadcast.js` 改为走 `logger`（`src/scripts/` 下的保留，属 CLI 正常输出）

---

## Phase 2：共享 Usage 归一化（消灭复发 bug 类）

风险：中 ｜ 预计改动：净删 ~150 行 ｜ **行为必须逐 case 对齐**

**背景**：`src/plugins/api-potluck/index.js:41-126` 与 `src/plugins/model-usage-stats/stats-manager.js:238-300` 存在**逐字相同**的 `toNumber` / `normalizeUsageCandidate` / `mergeUsage` / `extractUsage`（约 100 行），commit `a19d505` 被迫同时改两处修同一个 reasoning_tokens 累加 bug。同时各 provider core 各自实现 usage 规整（zed-core.js:722 `_formatClaudeUsage`、trae-core 的 token_usage 回填、claude-kiro 自有逻辑），导致「usage 统计为 0」按 provider 逐个复发（`9881b1b` zed、`a19d505` trae 为同一 bug 类的两次修复）。

### 2.1 新建 `src/utils/usage-normalizer.js`

- 将两插件中逐字相同的 `toNumber`、`normalizeUsageCandidate`、`mergeUsage`、`extractUsage` 原样搬入并导出（第一版**不改变任何逻辑**，只做物理收敛）
- 从两处之一拷贝单测覆盖不到的边界，补单元测试 `tests/usage-normalizer.test.js`：OpenAI 标准、Gemini `usageMetadata`（thoughtsTokenCount）、Claude（cache_read_input_tokens）、Responses API（`response.usage`）、数组 candidate 合并、全零返回 null

### 2.2 两个插件改从共享模块 import

- `api-potluck/index.js`、`stats-manager.js` 删除本地副本，改为 `import { ... } from '../../utils/usage-normalizer.js'`
- **验证**：`npm test` + 手工核对 `a19d505` 修复的 reasoning_tokens 场景在新模块中行为一致

### 2.3 Provider core 接入（分 provider 小步提交）

- zed-core.js：`_formatClaudeUsage` 改为内部调用共享归一化 + 输出 Claude 格式字段映射（保留现有方法签名，先不扩散改动面）
- trae-core.js：token_usage 回填逻辑复用同一归一化
- claude-kiro.js、grok-core.js 等其余 core 后续逐个迁移，每个一个 commit
- **验证**：复用 `tests/zed-provider.test.js`、`tests/trae-provider.test.js` 中 `9881b1b`/`a19d505` 新增的 usage 断言；每个 provider 迁移后单独回归

---

## Phase 3：拆解 `common.js` + 解除循环依赖

风险：高 ｜ 需单独评审 ｜ 纯搬移，不改逻辑

**现状循环**：
- 直接环：`utils/common.js:6` → `convert/convert.js:11` → `common.js`
- 三环：`common.js` → `convert/convert.js:13` → `core/config-manager.js:3` → `common.js`
根因：`common.js`（2597 行，36 export）把基础常量/工具与高层请求管线混在一处，下游不得不在底层文件里反向 import 高层能力。

### 3.1 基础层下沉

- `MODEL_PROTOCOL_PREFIX`、`MODEL_PROVIDER`、`ENDPOINT_TYPE`、`getProtocolPrefix`、`FETCH_SYSTEM_PROMPT_FILE`、`INPUT_SYSTEM_PROMPT_FILE` 等纯常量/纯函数移入 `src/utils/constants.js`（或新建 `src/utils/protocol.js`）
- `convert/convert.js`、`provider-strategy-factory.js`、`config-manager.js` 改为从底层模块 import，**打断所有指向 common.js 的反向边**

### 3.2 请求管线迁移

- `handleStreamRequest`（common.js:978，469 行）、`handleUnaryRequest`（:1447）、`handleModelListRequest`（:1669）、`handleContentGenerationRequest`（:1826）、`handleError`（:2090）移至 `src/handlers/`（新建 `request-pipeline.js` 或并入现有 `request-handler.js` 所在目录）
- common.js 仅保留纯工具函数；迁移期可在 common.js 保留 re-export 一层，确认无外部直接引用后再删

### 3.3 验证

- 用 `madge --circular src/`（或 node 脚本遍历 import 图）证明零环；加入 CI 检查防回归
- `npm test` 全量回归 + 冒烟启动 + 手工跑一遍 OpenAI/Claude/Gemini 三种协议的流式与非流式请求

---

## Phase 4：Converter 流式共享层

风险：高 ｜ 长期 ｜ 针对近期 bug 最密集区域

**背景**：最近 5 个 commit 全部是 converter/协议修复（zed cached token、gemini thinkingConfig oneof、Anthropic 工具调用流式状态机、多协议转码上下文丢失）。6 个 Converter 策略各 1500-2600 行，`toClaudeStreamChunk`、`toOpenAIResponsesStreamChunk` 等方法在 5 个文件中重复实现；`openai-responses-events.js` 的共享事件生成器是正确方向，但 Claude/Gemini 流式输出侧无等价共享层。

### 4.1 盘点与抽象设计（先出设计稿，不写实现）

- 盘点 6 个 Converter 的流式状态机共性：SSE 帧封装、tool_call 增量聚合、usage 尾部回填、finish_reason 映射
- 产出 `docs/CONVERTER_STREAM_DESIGN.md`，明确共享层 API（参照 `openai-responses-events.js` 的纯函数事件生成器风格，避免引入有状态基类）

### 4.2 逐 converter 迁移

- 顺序：GrokConverter（最小，1500 行）→ GeminiConverter → OpenAIResponsesConverter → CodexConverter → OpenAIConverter → ClaudeConverter（最大最复杂，最后动）
- 每个 converter 一个 commit，迁移后跑 `tests/converters.test.js` + 对应 provider 测试

---

## Phase 5：结构性重构（长期，可选）

- **5.1 `claude-kiro.js`（3816 行，git 热点第一）拆分**：按职责分为 OAuth 刷新 / AWS event-stream 解析 / 协议转换 / 用量统计四个模块；热点数据显示其 2025-12 单月 31 次变更，拆分可显著降低回归面
- **5.2 `provider-pool-manager.js`（2589 行）拆分**：节点选择、健康检查、用量追踪、配置持久化分离
- **5.3 抽象层合并**：`ProviderStrategyFactory`（provider-strategy-factory.js:14-33 硬编码 switch + 每次 new 实例）与 `adapterRegistry`（adapter.js）职责重叠，评估合并为单一注册表；`src/convert/`（单数）目录在死导出清理后评估与 `src/converters/` 合并命名
- **5.4 multipart 库统一**：`multer`（event-broadcast.js:4、plugin-api.js:6）与 `busboy`（api-manager.js:13）二选一，统一到 `busboy`（更轻）或全用 `multer`

---

## 里程碑与验收

| 里程碑 | 内容 | 验收标准 |
|---|---|---|
| M1 | Phase 0 + Phase 1 | 依赖瘦身 4 个；`convert.js` 死导出清零；测试基线不劣化 |
| M2 | Phase 2 | usage 归一化单点实现；两个插件 + zed/trae 接入；`a19d505`/`9881b1b` 场景有共享层单测覆盖 |
| M3 | Phase 3 | import 图零循环；common.js 降至 <1000 行纯工具 |
| M4 | Phase 4 | 流式事件生成单点实现；至少 3 个 Converter 完成迁移 |
| M5 | Phase 5 | 视排期逐项评审 |

## 不做的事（Out of Scope）

- 不改动任何 provider 的上游协议行为与模型映射逻辑
- 不引入新的运行时依赖
- 不重写 UI（`static/`、`ui-modules/` 仅做 Phase 1 的最小清理）
- 不处理 `src/plugins-user/`（运行时生成，非仓库源码）
