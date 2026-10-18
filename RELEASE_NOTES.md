# AIClient-2-API 发布说明 (v3.14.1)

> 本次 **v3.14.1** 是 **跨协议转译优化系列（Phase 0-4）的合辑发布**。依据 `docs/CROSS_PROTOCOL_OPTIMIZATION_PLAN.md` 全部落地：**思考预算换算统一与 medium 档复活**、**Schema Polyfill 降级编译器**、**签名金库（无状态 HMAC 虚拟思考签名）**、**Responses SSE Emitter 状态所有权收编**，以及**合并去重 / 工具稳定排序 / 缓存日志化**可选增强。过程里程碑标签：`v3.10.1`（Phase 0 定点修复）、`v3.11.0`（Phase 1）、`v3.12.0`（Phase 2）、`v3.13.0`（Phase 3）、`v3.14.0`（Phase 4），消除全部已确认 Tier 3 损耗因素。

---

## 🌟 核心更新亮点 (v3.14.1)

### 1. Phase 0 定点修复包（里程碑 v3.10.1）
- **思考预算换算统一**：新增 `thinking-budget.js`，新阈值 `low<=2048 / medium<=8192 / high>8192`，修复常规预算全部坍缩为 `high` 的正确性 bug；四份漂移换算表归一，Gemini 3 / 2.5 双轨映射集中管理。
- **Responses 方向思考链修复**：Responses→Gemini 恢复 `reasoning.effort` → thinkingConfig；Responses→OpenAI 保留 reasoning item（折入 assistant 消息）与响应侧 `reasoning_content` 回填，`item_reference` 显式日志跳过，消灭静默蒸发。
- **Claude document 块四方向落地**：→Gemini 原生 inlineData 无损、→Responses input_file、→Codex 占位（`CODEX_PDF_AS_INPUT_FILE=1` 尝鲜）、→OpenAI 占位 + warn。
- **思考签名闭环加固**：短签名放行、流式 `signature_delta` 转发携带 thoughtSignature 的 Gemini chunk、`redacted_thinking` 降级告警。

### 2. Phase 1 Schema Polyfill 降级编译器（里程碑 v3.11.0）
- **`$ref` 静态展开**：循环检测 + 深度上限 10，超限安全坍缩；剥离 `$defs`/`definitions`/`$schema`/`$id`。
- **约束自然语言化注入**：pattern/format/default/数值边界等 12 类被剥除约束以 `[Constraints: k=v]` 注入 description，原始描述永不裁剪；`oneOf`/`anyOf`/`allOf` 组合关键字降级。
- **可开关可回滚**：`CONVERT_SCHEMA_POLYFILL`（默认 on）、`CONVERT_SCHEMA_POLYFILL_MAX_DESC`（默认 1000），复杂工具调用失败主因消除。

### 3. Phase 2 签名金库 Signature Vault（里程碑 v3.12.0）
- **无状态 HMAC 虚拟签名**：`vsig1.<payload>.<hmac>` 格式，进程级密钥（`SIGNATURE_VAULT_SECRET` 或启动随机），无存储无 TTL。
- **注入/剥离闭环**：X→Claude 响应侧自动补签，Claude→非 Claude 四方向及 Claude 协议上游管道层无条件剥离虚拟签名，真签名永不剥离；HMAC 失败仍按前缀安全剥离，永不阻断请求。
- **组合 17/18/19 达 Tier 1**：Claude Code CLI 接非 Claude 上游的多轮思考 + 工具调用体验完整。

### 4. Phase 3 Responses SSE Emitter 收编（里程碑 v3.13.0）
- **新增 `ResponsesSseEmitter`**：严格镜像 `AnthropicSseEmitter` 生命周期，start/text/reasoning/toolCall/complete 全幂等。
- **状态所有权收编**：全局单例 `streamStateManager` 彻底消除，并发隔离全量依托 `StreamSessionStore`；事件生成器纯函数化。
- **三转换器迁移零回归**：OpenAI / Gemini / Claude 的 Responses 流式方向全量接入，既有 golden 流式测试 100% 通过。

### 5. Phase 4 可选增强 + 加固收尾（里程碑 v3.14.0）
- **合并去重**：三处 parts 级同角色合并提取为 `mergeConsecutiveSameRoleContents` 纯函数。
- **工具稳定排序**：`CONVERT_SORT_TOOLS`（默认 off）消除工具顺序抖动对隐式前缀缓存的干扰；`cache_control` 丢弃补 debug 日志。
- **质量收尾**：清理遗留死代码 436 行、转换开关统一经 config-manager、新增 5 个测试套件，**全量 19 套件 288 用例通过**。

---

## 🔧 历史版本回顾

### v3.10.0 (2026-10-16)
- **Codex OAuth 体系增强**：动态模型发现与自动同步（GPT-6 Luna / Astra / Sol 全系列）、WebUI 节点级客户端版本号独立配置、账号订阅类型解析与权限门禁过滤。
- **流式韧性修复**：非流式空响应误判修复、思考增量完整放行、客户端断开保护与空响应异常拦截。

### v3.9.1 (2026-10-13)
- **存量配置无缝升级**：v3.8.0 及更早的 `trae-agent_v3` 节点配置在启动时自动迁移至 `trae-solo_work_lite`（含历史 `TRAE_CHANNEL_MODE` 改写与回写持久化），升级后不再抛 `Unsupported model provider`。
- **代码评审清理集**：`AnthropicSseEmitter.delta()` 误用守卫、`safety_identifier` 随机值置空、`mapFinishReason`/`sanitizeToolId` 下沉共享层消除跨层反向依赖。

### v3.9.0 (2026-10-13)
- **Trae 通道重构**：重新确立 `trae-solo_work_lite`（SOLO Agent，19 模型）与 `trae-chat_v3`（侧边栏 Chat，20 模型）两个独立一级提供商。
- **协议合规修复集**：Zed 工具能力补全、Gemini->Claude 流式事件序列合规、Responses API 状态修正等。
