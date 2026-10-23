# AIClient-2-API 发布说明 (v4.1.7)

> **v4.1.7** 是跨协议转译重试与流式收尾的稳定性修复版本，无破坏性 API/协议变更。
>
> 本版本修复了空响应重试路径上的两个 P1 缺陷、两个 P2 契约问题，并完成 27 个真实模型的最终 E2E 验收。

---

## 🌟 核心变更

### 1. 修复 Responses 下游兜底收尾卡死（P1）

- `streamRequestId` 声明提升到 `try` 外，修复 `finally` 兜底分支中的 `ReferenceError`。
- 兜底收尾失败时强制 `res.end()`，避免客户端永久等待读超时。
- 新增跨重试帧共享的 `streamState.hasMessageStop`：内层重试帧已经发送 `message_stop` / `response.completed` 时，外层帧不再重复补发终止事件。

**效果**：此前 `openai-custom:glm-5.3` 在空响应重试后可能卡住约 180s；修复后该用例耗时从 **195.2s 降至 15.4s**。

### 2. 修复空响应/凭证切换重试的流状态泄漏（P1）

- `BaseConverter` 新增 `resetStreamState()` 契约。
- 各 Converter 只清理流式状态，保留请求级工具名映射与 custom tool 登记。
- pipeline 在每次尝试开始、空响应重试、凭证切换重试前清理上游 Converter 的流式状态。
- 重试上下文固定 `requestId` 与共享 `streamState`，保证内层/外层帧使用同一份会话状态。

**效果**：重试流不再缺少 `message_start` / `response.created` 等生命周期首帧。

### 3. 统一终端空内容截断识别（P2）

新增 `extractTerminalFinishReason()` / `isTerminalEmptyFinishReason()`，覆盖：

| 协议 | 终态示例 |
|---|---|
| OpenAI Chat | `length`、`content_filter` |
| Anthropic Messages | `max_tokens`、`refusal` |
| OpenAI Responses / Codex | `max_output_tokens`、`incomplete` |
| Gemini | `MAX_TOKENS`、`SAFETY` 等安全终态 |

合法截断不再被当作空响应重试最多 5 次并最终 502。

### 4. 修复 Responses → Gemini 工具 ID 配对（P2）

`functionCall`、`functionResponse`、`callIdToName` 统一使用 `item.call_id || item.id`，保证多轮工具历史中的调用与结果使用同一个 ID。

### 5. 文档与测试清理

- 新增 `tests/v4-1-6-regressions.test.js`，覆盖 9 个 P1/P2 回归场景。
- 清理过时的跨协议评估/优化文档；评估入口后续见 [`docs/CROSS_PROTOCOL_REVIEW_19MODELS_2026-10-23.md`](docs/CROSS_PROTOCOL_REVIEW_19MODELS_2026-10-23.md)。
- 清理 E2E 测试中未使用的 `addQuotaFailure` 别名。

---

## ✅ 验证结果

### 单元测试

```text
Test Suites: 29 passed, 29 total
Tests:       463 passed, 463 total
```

### 最终 27 模型 E2E

- 模型来源：`GET /auto/v1/models` 动态发现，共 27 个模型
- 参数：`reasoning_effort=high`（Claude 使用 `thinking.budget_tokens=20000`）
- 结果：**39 / 39 通过**；27/27 模型核心用例 **11/11**；12/12 定向用例通过

| 指标 | 结果 |
|---|---:|
| E2E Jest 用例 | **39 / 39** |
| 27 模型核心矩阵 | **27 / 27 模型 11/11** |
| 定向 E2E | **12 / 12** |
| `streamRequestId is not defined` | **0 次** |
| `openai-custom:glm-5.3` 耗时 | **15.4s**（修复前 195.2s） |
| 核心矩阵总耗时 | **991.6s**（修复前 1,215.6s） |

---

## 🔧 升级说明

- 本版本无破坏性 API 变更，客户端无需修改请求格式。
- 升级后请**重启网关进程**，使新的重试/收尾逻辑生效。
- Docker 镜像标签：`4.1.7`、`latest`。

---

## 📚 相关文档

- [跨协议转译复评（19 模型全量 E2E · 2026-10-23）](docs/CROSS_PROTOCOL_REVIEW_19MODELS_2026-10-23.md)
- [跨协议架构](docs/CROSS_PROTOCOL_ARCHITECTURE.md)
- [流式转换设计](docs/CONVERTER_STREAM_DESIGN.md)
- [Provider 适配指南](docs/PROVIDER_ADAPTER_GUIDE.md)
