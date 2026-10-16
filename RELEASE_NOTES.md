# AIClient-2-API 发布说明 (v3.10.0)

> 本次 **v3.10.0** 是一次针对 **OpenAI Codex OAuth 体系的重大功能增强与流式处理韧性加固版本**。核心更新包括：**Codex 动态模型发现与自动同步**（支持 GPT-6 Luna / Astra / Sol 全新系列）、**WebUI 节点级客户端版本号独立配置**（告别子进程同步阻塞与环境暗箱探测）、**账号订阅类型解析与权限门禁过滤**，以及**非流式空响应误判与思考增量放行等关键协议修复**。

---

## 🌟 核心更新亮点 (v3.10.0)

### 1. OpenAI Codex OAuth 动态模型同步与全系列新模型支持
- **动态模型发现**：通过调用上游 `/backend-api/codex/models?client_version=...` 接口实时获取账号允许调用的模型清单，自动派生 `-fast` 变体与保留 `gpt-image-2` 虚拟图像模型。
- **基准模型库扩充**：预置基准模型全面集成 `gpt-6-luna`、`gpt-6-astra`、`gpt-6.1-sol`、`gpt-6-sol` 等全新一代模型。
- **权限安全过滤**：自动解析 OAuth AccessToken 中的 `chatgpt_plan_type` 订阅类型，精准识别并过滤 `supported_in_api: false` 及需升级付费计划（`upgrade`）的门禁模型，杜绝用户调用未授权模型报错。

### 2. WebUI 节点级客户端版本配置与底层去阻塞优化
- **WebUI 节点级版本配置**：在「提供商管理」的 Codex 节点编辑表单中新增 `CODEX_VERSION` 输入项，支持多账号独立配置版本；留空默认使用官方基准版本（`0.162.1`）。
- **即时生效与缓存失效**：编辑保存版本号时立即销毁旧缓存，下次请求无缝按新版本号向远端同步最新模型。
- **彻底消除主线程阻塞**：完全剔除 `child_process.execSync` 同步命令探测，执行耗时降低至 0.001ms 纯内存级别，消除了主事件循环卡顿与跨环境探测漂移的隐患。

### 3. 流式协议健壮性与连接健康度判定修复
- **非流式空响应校验修复**：修复 Codex 非流式调用中有效响应被错误识别为空响应、进而触发 5 次不必要重试并报错的问题。
- **思考增量完整放行**：完整透传 OpenAI 协议下的 reasoning delta 思考增量，思维链展示更加流畅。
- **客户端断开保护**：用户提前中断请求不再误扣提供商健康度，避免号池误熔断。
- **空响应异常拦截**：严密捕获上游思考后空响应（`MALFORMED_FUNCTION_CALL`），防止静默放行异常流。

---

## 🔧 历史版本回顾

### v3.9.1 (2026-10-13)
- **存量配置无缝升级**：v3.8.0 及更早的 `trae-agent_v3` 节点配置在启动时自动迁移至 `trae-solo_work_lite`（含历史 `TRAE_CHANNEL_MODE` 改写与回写持久化），升级后不再抛 `Unsupported model provider`。
- **代码评审清理集**：`AnthropicSseEmitter.delta()` 误用守卫、`safety_identifier` 随机值置空、`mapFinishReason`/`sanitizeToolId` 下沉共享层消除跨层反向依赖。

### v3.9.0 (2026-10-13)
- **Trae 通道重构**：重新确立 `trae-solo_work_lite`（SOLO Agent，19 模型）与 `trae-chat_v3`（侧边栏 Chat，20 模型）两个独立一级提供商。
- **协议合规修复集**：Zed 工具能力补全、Gemini->Claude 流式事件序列合规、Responses API 状态修正等。

### v3.8.0 (2026-10-10)
- **Trae 独立双通道拆分**：将 Trae 正式拆分为两个完全独立的一级提供商（`trae` 与 `trae-agent_v3`），完成双通道 50/50 模型实测。
