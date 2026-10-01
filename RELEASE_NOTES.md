# AIClient-2-API v3.6.0 发布说明

> 本次 **v3.6.0** 版本带来了全新的 **Trae (SOLO) 深度提供商支持**，具备完整的生产级工业化架构，支持 Max Mode 1M (1,000,000) 超长上下文窗口、64k 输出最大化、推理深度 (Reasoning Effort) 标准映射以及 OpenAI 兼容的流式 Function Calling / Tool Call 聚合能力。同时，本次更新加固了数据流类型守卫，优化了架构模块命名，并修复了 Gemini/Antigravity 等多项上游用量与调用问题。

---

## 🌟 核心更新亮点

### 1. 深度集成 Trae (SOLO) 提供商 (生产级工业标准)
- **多途径凭据接入与管理**：
  - 完整支持 WebUI OAuth 授权引导与重定向回调登录。
  - 支持个人访问令牌 (Personal Access Token, PAT) 一键导入与更新。
  - 自动管理与刷新 OAuth 访问令牌 (`ExchangeToken` / `RefreshToken`)。
- **云端双端动态模型探测与同步**：
  - 彻底摆脱对本地 `~/.trae/cli/models_cache.json` 静态文件的依赖。
  - 支持自 `api.enterprise.trae.cn`（官方企业端点）与 `trae-api-cn.mchost.guru`（Agent Max 端点）动态拉取模型元数据。
  - 采用 **并发健康探测 + 自动降级保障** 机制，秒级同步最新官方底层模型。
- **动态 Max 模式与物理输出上限探测 (无硬编码)**：
  - `context_window` 优先使用上游标称的 Max Mode 档位（最高达 1,000,000 / 1M Tokens）；未提供时取 dev 及详情最大容量。
  - `max_tokens` 动态遍历上游所有挡位，提取物理最大输出值（最高达 64,000 Tokens）。
  - 杜绝任意魔法数值硬编码，精准呈现各模型真实物理能力（如 256k/32k、200k/16k、1M/64k）。
- **思考能力 (Reasoning / Thinking) 双向标准化**：
  - 上游原生选项 (`light`, `high`, `extra_high`) 与标准客户端参数 (`low`, `high`, `xhigh`) 完备双向映射。
  - 智能感知模型思考配置，保留 Kimi 系列特有的默认 `xhigh` 思考深度以及 DeepSeek/GLM 思考等级。
- **模型命名纯正化与安全过滤**：
  - 严格采用上游官方底层技术 ID（如 `DeepSeek-V4-Pro-Official`、`Doubao-Seed-2.1-Pro` 等），彻底杜绝中文显示名污染。
  - 优雅过滤 `custom_` 企业自定义别名以及外部映射模型（如 `gemini` / `claude` 等），保留最纯正原生模型。
  - 注入标准别名 `auto` 并动态继承底层主力模型（`glm-5.2`）的上下文与推理元数据。
- **OpenAI 标准工具调用 (Function Calling / Tool Call) 支持**：
  - 全面支持 Trae 原生 Tool Call 标准转换。
  - 实现流式 (SSE) 场景下的增量分片聚合与解析，确保各类 Agent 框架与前端工具平滑调用。
- **多租户与多账号高并发安全隔离**：
  - 每个 Trae 账户基于 `host#userId` 拥有独立隔离的元数据缓存与通道映射，彻底防止并发串号。

---

## 🛠️ 重构与架构优化

1. **跨协议数据流类型约束与轻量级守卫体系**：
   - 为各 Provider 适配器的数据流转建立统一类型守卫，防止非预期 payload 导致的运行时崩溃。
2. **模块文件命名规范化**：
   - 优化核心模块与适配器的命名规范，消除同名异构与单复数混用歧义。
3. **废弃死代码清理**：
   - 彻底清理项目中历史遗留的冗余模块与废弃逻辑，提升代码库健康度。

---

## 🐞 问题修复 (Bug Fixes)

1. **Gemini 工具调用**：过滤 Gemini API 工具声明中 `enum` 属性出现的空字符串值，避免上游 400 参数校验失败。
2. **用量统计**：
   - 修复 Antigravity 和 Gemini 账号用量查询错误显示为 Free 的问题。
   - 修复全局刷新用量与 Antigravity 周配额显示异常。
3. **容错机制**：将上游空响应最大重试次数 `EMPTY_RESPONSE_MAX_RETRIES` 调整为 5 并支持面板动态配置。

---

## 🧪 自动化测试验证

- 新增完备的 Trae 自动化测试套件 (`tests/trae-provider.test.js`)，覆盖核心初始化、流式工具聚合、模型底层 ID 映射、思考参数转换与多账号隔离。
- 全项目 38 个单元测试全部通过。
