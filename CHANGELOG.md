# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
