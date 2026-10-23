# AIClient-2-API 发布说明 (v4.1.9)

> **v4.1.9** 是跨协议转译语义、流内错误收尾与 Schema 保真的稳定性版本，无破坏性 API/协议变更。
>
> 本版本汇总 v4.1.8 与 v4.1.9 的修复：补齐 Responses → Gemini 的 system/结构化输出/多模态工具回传，收口同协议与跨协议流内错误，增强 Schema Polyfill，并完成 19 个真实模型的最终 E2E 验收。

---

## 🌟 核心变更

### 1. Responses → Gemini 语义补齐

- `input` 内的 `system` / `developer` 消息不再降级为 user，统一并入 `systemInstruction`。
- `text.format` 的 `json_object` / `json_schema` 映射为 Gemini `responseMimeType` / `responseSchema`，并复用 Schema Polyfill。
- 多模态 `function_call_output` 数组归一化为 `{ content }`，图片/文件拆为同轮 `inlineData`，避免把数组直接塞进 Gemini `FunctionResponse.response`。
- 只有 `instructions` / system / developer 而没有 user/assistant turn 的请求本地返回 **400**，不再把必然被拒绝的空 `contents` 发往上游。

### 2. 流内错误终态与错误体语义

- 识别 `response.failed`、`event: error`、`data.error`，包括 `choices: []` / `candidates: []` 形态。
- 转换器无法表达错误帧时返回 **502**，不再静默返回空 200 流。
- 非流式 HTTP 200 错误体统一转为 **502**，不再伪装成合法截断。
- 错误帧不再提前污染 `hasMessageStop`，重试成功后仍能正确补发终止帧。

### 3. Schema Polyfill 增强

- 补齐 `allOf` 的 type/enum/items 提升，scalar `allOf` 不再生成空 `properties`。
- 支持可空 `oneOf`、`patternProperties`、`additionalProperties`、`not`、`dependentRequired`、`dependentSchemas`、`if/then/else`。
- 摘要保留子 Schema 的 `description`，`min` / `maxLength` 等内层约束可传递到父摘要。
- 阶段 2 裁剪只统计清洗后可达节点，按真实描述差值回缩；`allOf` / `oneOf` / `$ref` 登记父节点，避免修改不可达分支导致虚减。

### 4. Antigravity 与 GPT-6 预适配

- Antigravity 过滤 `oss` 与 `-low` 模型，模型列表动态刷新恢复正常。
- User-Agent 更新为 CLI 标识。
- Chat → Antigravity 的 thinking gating 覆盖 `gpt-*`、`-thinking`、`-high`、`-medium` 与 Claude 5.5，GPT-6 预适配补齐。

### 5. 测试与文档

- 单元测试：**29 suites / 489 tests 全绿**。
- 19 模型全量 E2E：**35 / 35 通过**，19/19 模型 11/11，16/16 定向用例通过；核心矩阵 209/209。
- 新增 Responses→Gemini developer/text.format 与 system-only 400 定向用例。
- 文档收敛为单一 19 模型复评入口，删除过期的 27 模型 review。

---

## ✅ 验收结果

| 项目 | 结果 |
|---|---:|
| 单元测试 | 29 suites / 489 tests |
| E2E Jest 用例 | 35 / 35 |
| 19 模型核心矩阵 | 19 / 19 模型 11/11 |
| 核心子用例 | 209 / 209 |
| 定向 E2E | 16 / 16 |
| 收尾异常 | 0 |

> E2E 运行期间上游存在长尾与空响应波动（Zed Gemini 单模型约 230s；4 个 unary 空响应请求、1 个 stream 空响应请求），均由网关重试或 E2E 透明重试恢复，最终无转译断言失败。

---

## ⚠️ 已知限制

- 显式 `cache_control` 仍不可跨协议保留，仅做 `cached_tokens → cache_read_input_tokens` 计费回填。
- Anthropic 历史 `thinking` 需要真实签名、官方 Responses `reasoning` 需要 `encrypted_content`，跨协议默认跳过；Gemini 目标可通过 `CONVERT_REPLAY_COT_SUMMARY=true` 回放摘要。
- Gemini 原生签名由 `vsig1` 虚拟签名替代；严格校验签名的客户端可能不接受非标准格式。
- Schema 中不支持的关键字仍以 description 约束表达，而非结构等价。
- Reasoning 可用性由 Provider/模型/采样决定；Zed Claude/Gemini 与 Antigravity Claude 默认不暴露 thought 文本。

---

## 📦 升级建议

- 建议直接升级到 v4.1.9；无破坏性配置/API 变更。
- 使用 Responses → Gemini 结构化输出时，请确认客户端传入标准 `text.format`。
- 如依赖历史 CoT 回放，请按目标 Provider 的签名能力选择是否开启 `CONVERT_REPLAY_COT_SUMMARY`。

---

## 📚 相关文档

- [跨协议转译复评（19 模型全量 E2E · 2026-10-23）](docs/CROSS_PROTOCOL_REVIEW_19MODELS_2026-10-23.md)
- [跨协议架构](docs/CROSS_PROTOCOL_ARCHITECTURE.md)
- [流式转换设计](docs/CONVERTER_STREAM_DESIGN.md)
- [Provider 适配指南](docs/PROVIDER_ADAPTER_GUIDE.md)
