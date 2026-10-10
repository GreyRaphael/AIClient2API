# AIClient-2-API v3.8.0 发布说明

> 本次 **v3.8.0** 是一个重要的架构与功能升级版本。核心变更包括：将 **Trae 彻底拆分为两个完全独立的一级提供商**（`trae` 企业原生 ToB Raw Chat 与 `trae-agent_v3` SOLO Agent v3），并深度精简 WebUI 配置项；两通道各自完成 25/25 模型实机验证与动态发现；同时正式承接此前从 **v3.6.1 到 v3.7.1** 的多项重大重构与协议加固（包括下线 4 个废弃提供商、解耦循环依赖、请求管线独立、转码器流式状态机强化与 Zed 5 档思考映射）。

---

## 🌟 核心更新亮点 (v3.8.0)

### 1. Trae 独立双通道拆分 (重大架构升级)
- **顶级提供商完全解耦**：
  - `trae`：面向企业原生场景，默认对接 `https://api.enterprise.trae.cn/api/ide/v2/llm_raw_chat`（`function: "chat"`），采用 Linux/PC 客户端指纹、企业链路追踪与 `__max` 调度机制。
  - `trae-agent_v3`：面向 SOLO Agent 场景，默认对接 `https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat`（`function: "solo_work_lite"`），采用 Windows 11/83DG 客户端指纹。
- **WebUI 彻底精简**：
  - 彻底移除配置表单中的“通道模式 (Channel Mode)”选择框与号池表格列，用户不再需要理解复杂的通道模式概念，各取所需。
- **动态模型发现全面实测 (50/50 成功)**：
  - `trae` 与 `trae-agent_v3` 各自独立动态拉取 25 个模型，实测全部 50 个模型对话补全 100% 成功。
  - 支持各自独有模型（如 ToB 端的 `Doubao_1_6`、`glm-5v-turbo`、`minimax-m2.7`、`kimi-k2.8-preview`，以及 Agent 端的 `kimi-k2.6`、`glm-5`、`glm-5-turbo` 等）。
- **号池安全与防呆校验**：
  - 新增主机错配交叉校验（防止在 ToB 节点误填 Agent 域名），支持 `custom` 自定义反代逃生口。
  - 自定义 Host 在 PAT/OAuth 登录后完整沿链透传至新节点，号池写入操作加入深度磁盘合并保护。
- **技术全景文档**：
  - 补充 `docs/TRAE_CHANNELS_UPSTREAM_GUIDE.md`，深度剖析上游 `solo_work_lite`、`chat_v3` 与企业 `chat` 的协议与参数差异。

---

## 🏛️ 承前版本核心演进一览 (v3.6.1 ~ v3.7.1)

### v3.7.1：流式转换共享层
- 引入统一的带 TTL 的 `StreamSessionStore`，彻底解决高并发长连接转码过程中的会话泄漏隐患。
- 收编 `finish_reason` 映射至共享 `mapFinishReason`。

### v3.7.0：重大架构重构 (Breaking Changes)
- **彻底移除 4 个停用提供商**：清理 `FORWARD_API`、`QWEN_API`、`IFLOW_API`、`GEMINI_CLI` 的所有代码与映射，默认 `MODEL_PROVIDER` 切至 `gemini-antigravity`。
- **解耦核心循环依赖**：抽离底层 `src/utils/protocol.js`，将请求管线独立为 `src/handlers/request-pipeline.js`，核心代码更加高内聚低耦合。
- **共享用量归一化**：抽取 `usage-normalizer.js`，统一各模块用量提取。

### v3.6.2：转码器与多轮工具调用修复
- 修复连续 Assistant 工具调用消息合并逻辑，彻底解决并发 `tool_calls` 导致的流中断（4027 错误）。
- 消除 Gemini Protobuf `thinkingConfig` 中的 oneof 命名冲突。
- 修复 Trae 与 Zed Token 使用量和缓存命中统计准确性。

### v3.6.1：Zed 思考映射与 Antigravity 优化
- Zed 全面支持 OpenAI 思考模型的完整 5 档推理强度双向映射。
- Antigravity 优雅提取 `agentModelSorts` 与生图模型，自动排除低质量降级模型。
