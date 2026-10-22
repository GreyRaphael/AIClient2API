# 跨协议 E2E 测试

真实上游、真实账号的跨协议转译 E2E。**默认不进入 `npm test`**，需要显式运行：

```bash
npm run test:e2e
```

## 前置条件

1. 网关已启动，并配置了真实 provider 账号：
   ```bash
   node src/services/api-server.js --port 3200
   ```
2. 客户端可用 API key（默认读取 `configs/config.json` 的 `REQUIRED_API_KEY`）。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `AICLIENT_E2E_BASE` | `http://127.0.0.1:3000/auto` | 网关 base URL，需包含 `/auto` 前缀 |
| `AICLIENT_API_KEY` | 读取 `configs/config.json` | 覆盖 API key |
| `AICLIENT_CONFIG_PATH` | `configs/config.json` | 指定配置文件路径 |
| `AICLIENT_E2E_MODELS` | 内置 13 个模型 | 逗号分隔的模型列表，用于缩小范围 |

示例：

```bash
AICLIENT_E2E_BASE=http://127.0.0.1:3200/auto \
AICLIENT_E2E_MODELS=openai-custom:glm-5.3,gemini-antigravity:gemini-3.8-flash-high \
npm run test:e2e
```

## 覆盖范围

### 核心矩阵（每个模型 11 项）

- Chat / Responses / Claude 非流式与流式文本
- Chat / Responses / Claude 单轮 function tool
- Chat 多轮工具结果回传
- 连续同角色 + system 折叠
- Gemini usage：`completion/output >= reasoning_tokens`

### 定向用例

- openai-custom 指定 function 强制 `tool_choice` 在 30s 内返回
- `zed:gpt-6-luna` 32×32 红图识别
- `zed:gemini-3.8-flash` 多轮工具历史降级为文本并返回 200
- Gemini 流式 thinking 回退后仍返回 reasoning
- Gemini max_tokens 截断不触发空响应重试
- 多步 prompt 下 GPT 3 次采样 reasoning
- 同一 run 三协议 reasoning 一致性
- CoT-present Chat / Claude 多轮工具回放
- oneOf 对象分支合并后字段名保持正确
- OpenAI → Zed Claude 多轮工具历史中的非法 tool id 被清洗
- 上游 4xx 错误响应保留可读细节

## 已知限制（不作为失败）

- Gemini 流式上游不返回 thought text；网关默认回退非流式以保留 reasoning。
- `zed:claude-haiku-5-5` / `zed:gemini-3.8-flash` 不返回 thinking block，但正文可能包含推理。
- `zed:gpt-6-luna` / Codex 的 reasoning 受 prompt、effort 与采样影响；E2E 用多步 prompt + 多次采样。
- Gemini `maxOutputTokens` 已透传，但 thinking token 也计入预算，极小值可能只产出 thinking。
- 显式 `cache_control` 仍不跨协议保留；网关默认开启工具稳定排序以对齐隐式前缀缓存。
- Codex 上游可能忽略 `max_output_tokens`，网关已透传该字段。

测试会在控制台输出 `[E2E warnings]`，但只有确定性核心断言失败才会让测试失败。

## 注意

- 每个模型会发起 11 次真实请求，13 个模型共 143 次；会消耗真实账号额度。
- 建议使用独立实例端口，避免影响主实例。
- 默认串行执行（`--runInBand`），避免并发触发上游限流。
