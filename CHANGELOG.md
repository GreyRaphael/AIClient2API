# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
