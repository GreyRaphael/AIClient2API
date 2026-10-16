# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
  - 新增 `docs/CONVERTER_STREAM_DESIGN.md` 流式转换共享层设计规范。

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
