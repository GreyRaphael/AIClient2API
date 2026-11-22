# AIClient-2API 发布说明 (v8.9.7)

> ## 🛡️ Antigravity 429 指纹风控通用治理与诊断日志增强
>
> **版本重点**：彻底解决 DeepSeek Harness、Hermes Agent 等第三方 AI Agent 客户端访问 Antigravity 上游时因 `systemInstruction` 指纹触发 HTTP 429（`RESOURCE_EXHAUSTED` / `rateLimitExceeded`）的问题。放弃难以维护的黑名单正则清洗，改为更通用的 **统一 `systemInstruction` 显式授权 + 原始系统提示词无损迁移** 方案；同时增强 429 上游 RPC 错误详情与脱敏请求摘要日志，并消除热路径多余序列化开销。

---

## ⚠️ 升级与兼容性说明

- **运行时要求**：Node.js >= 26.0.0（与 v8.9.x 系列一致）。
- **兼容性**：无破坏性 HTTP API 或配置文件变更，可直接从 v8.9.x 平滑升级。

---

## 一、Antigravity 429 指纹风控通用治理

1. **统一 `systemInstruction` + 原始系统提示词无损迁入 `contents[0]`**
   - 经真实上游对照验证，Antigravity 风控仅扫描 `request.systemInstruction` 全文，对 `contents` 与 `tools` 描述不触发该风控。
   - 在 `src/providers/gemini/antigravity-transforms.ts` 中移除所有第三方客户端黑名单正则清洗与重复的 `ensureRolesInContents` 遍历，改为 `liftSystemInstructionToContents`：
     - 将 `request.systemInstruction` 统一为显式授权文案，指导模型将首条用户消息头部的 `<developer_instructions>` 块视为权威系统指令（防止模型将其误判为提示词注入）；
     - 将客户端原始系统提示词**一字不改**地前置到 `contents[0].parts[0]`（若首条非 `user` 或 `contents` 为空则前置新 `user` turn；图像模型不注入文本助手身份）。
   - 先基于原始首条用户消息计算稳定 `sessionId`，再执行系统提示词迁移，确保同客户端不同会话不撞 `sessionId`、多轮对话 `sessionId` 与 Prompt Cache 前缀保持稳定。
   - 彻底免维护黑名单规则，兼容任意第三方 Agent Harness，同时不再篡改用户对话正文。

---

## 二、429 诊断能力增强与热路径优化

1. **上游错误详情与 429 请求摘要日志**
   - 在 `src/providers/gemini/antigravity-core.ts` 中新增 `formatAntigravityErrorDetails` 与 `formatAntigravityRequestSummary`，错误日志自动提取并打印 Google RPC 响应中的 `rpcStatus`、`reason` 与 `details`，并在首次 429 时输出脱敏请求结构摘要（模型、`payloadBytes`、`sessionId`、轮次流向、工具列表及额外字段）。

2. **消除热路径多余序列化与重复遍历**
   - 为 `#logRequestSummaryIfNeeded` 增加 `logger.shouldLog('debug')` 守卫，并直接复用发请求时已序列化的 `serializedBody` 字节数，避免默认 `info` 日志级别下每次请求重复执行全量 `JSON.stringify`。
   - 收敛 `buildAntigravityPayload` 为单次 `contents` 规范化遍历。

---

## 三、验证结果

| 检查项 | 结果 |
|---|---|
| `npm run check:imports` | 150 个文件全部通过 |
| `npm run test:runtime` | 运行时冒烟测试通过 |
| Antigravity & Provider 能力单测 | **45 / 45 通过**（含 429 日志、统一迁移、跨轮 `sessionId` 与边界回归） |
| 真实上游 `gemini-4-hydrogen-medium` E2E 验收 | **4 / 4 通过**（覆盖 OpenAI Chat 非流式、Anthropic Messages 流式、OpenAI Responses 多轮与 Tool Calling，均携带 DeepSeek Harness / Web GUI / Hermes 触发特征，全部 HTTP 200 且严格遵循系统指令） |

---

**完整变更明细**：见 [CHANGELOG.md](https://github.com/GreyRaphael/AIClient2API/blob/main/CHANGELOG.md)
