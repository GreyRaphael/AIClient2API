# AIClient-2-API 发布说明 (v4.1.5)

> **v4.1.5** 是跨协议转译的契约修复版本，无破坏性协议变更。
>
> 本版本基于 27 个真实模型的跨协议 E2E 复评，修复 usage 不变量、Claude tool id、oneOf Schema 保真与 CoT 历史可观测性问题，并把全量 E2E 矩阵固化为可选发布前检查。

---

## 🌟 核心修复

### 1. usage 不变量：reasoning_tokens 不再大于 output_tokens

- `applyEstimatedReasoningTokens()` 现在保证 `reasoning_tokens <= output_tokens`。
- 上游返回的 reasoning token 大于 output token 时会被收敛，避免 `completion_tokens < reasoning_tokens` 的非法 usage。
- `output_tokens` 缺失或为 0 时不再凭空估算，保持原始 usage。
- 保留 `reasoning_tokens_estimated: true` 标记，客户端可区分估算值与上游精确值。

### 2. Claude tool id 统一清洗

- OpenAI → Claude 的请求、非流式响应、流式响应统一通过 `toClaudeToolId()` 处理。
- tool id 只保留 `[a-zA-Z0-9_-]`，满足 Anthropic `tool_use.id` 约束。
- 保证 `tool_use.id` 与 `tool_result.tool_use_id` 使用同一清洗结果，避免跨 provider fallback 时 400。

### 3. oneOf / anyOf Schema 保真

- 对象分支合并 `properties` 时，`required` 从“并集”改为“交集”，避免把互斥分支的必填字段强加到所有分支。
- 数值/布尔 enum 在 Gemini 白名单清洗前注入 `description`，即使 Gemini 只接受字符串 enum，约束语义仍可保留。
- 复杂联合类型仍建议使用简单、稳定的工具参数结构；Schema 降级无法做到逐字节等价。

### 4. CoT 历史可观测性

- Chat → Responses、Claude → Responses 丢弃 reasoning 时输出计数 debug 日志。
- 默认行为不变：没有 `encrypted_content` 的历史 thinking 不会回放给官方 Responses 上游，避免必然 400。

### 5. E2E 测试增强

- 新增 `AICLIENT_E2E_MODELS=all`：使用当前 27 模型全量矩阵。
- 核心矩阵新增全模型 usage 不变量断言：`completion/output >= reasoning_tokens`。
- 新增 OpenAI → Zed Claude 非法 tool id 回归用例。
- 更新 `tests/e2e/README.md`，补充全量矩阵与发布前检查说明。

---

## ✅ 验证

- `npm test -- --runInBand`：**33 suites / 457 tests 全绿**。
- 27 模型核心 E2E：**296 / 297**。
  - 唯一失败为 `openai-custom:qwen3.8-max` 的算术采样返回 `442`；同用例重试 3/3 返回 `391`，确认是模型采样问题，不是转译回归。
  - 26 个模型 11/11，1 个模型 10/11。
- usage 不变量：**0 违反**；此前 `zed:gpt-6-luna` Responses 非流式的 `output=27 < reasoning=84` 已修复为 `27 / 27`。
- 定向 E2E：oneOf 字段名、OpenAI → Zed Claude 非法 tool id 均通过。
- 复验期间最终 5xx 为 0；空响应护栏触发 1 次并自动恢复。

---

## 📦 升级建议

```bash
docker pull greyraphael/aiclient-2-api:latest
# 或固定版本
docker pull greyraphael/aiclient-2-api:4.1.5
```

无需修改客户端协议；下游仍为 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages。

---

## ⚠️ 行为变化

- **reasoning_tokens**：估算值或上游非法值会被收敛到 `output_tokens` 以内，并保留 `reasoning_tokens_estimated` 标记。
- **Claude tool id**：非法字符会被替换为 `_`；依赖原始 id 字符串做外部映射的客户端需要按清洗后的 id 关联。
- **oneOf required**：对象分支不再把所有分支的 required 字段合并为必填；模型可能输出更宽松的参数集合，工具实现应继续做服务端校验。
- **全量 E2E**：`AICLIENT_E2E_MODELS=all` 会发起 27 × 11 = 297 次真实请求，消耗账号额度。

---

## 📚 相关文档

- [跨协议转译架构](docs/CROSS_PROTOCOL_ARCHITECTURE.md)
- [跨协议转译复评（27 模型全量）](docs/CROSS_PROTOCOL_EVALUATION_V4_1_4_FULL_COVERAGE.md)
- [Provider 接入指南](docs/PROVIDER_ADAPTER_GUIDE.md)
- [变更日志](CHANGELOG.md)

---

## 🔭 已知边界

- 显式 `cache_control` 仍无跨协议等价字段，只能依赖隐式前缀缓存。
- 官方 Responses 上游的 reasoning item 需要 `encrypted_content`；跨协议历史 thinking 默认不回放。
- `zed:claude-haiku-5-5` / `zed:gemini-3.8-flash` 等模型不暴露 thinking block，只把推理写在正文。
- Gemini 流式 thinking 需要回退非流式合成；`thinkingLevel` 只有三档。
- `oneOf` 合并能保留字段名和约束提示，但复杂联合类型仍可能被模型简化。
