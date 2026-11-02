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
| `AICLIENT_E2E_MODELS` | 7 Provider × 10 代表性模型（见下节） | 传逗号分隔的模型列表可精确覆盖默认收敛集；`all`/`*` 等同于全量（兼容旧用法） |
| `AICLIENT_E2E_ALL_MODELS` | 未设置（默认收敛） | 设为 `1`/`true` 恢复收敛前的全量模型扫描（当前 46 个模型，请求量会显著上升） |
| `AICLIENT_E2E_MODELS_FILE` | 系统临时目录 `aiclient-e2e-models.json` | 模型列表缓存文件路径；一般无需设置 |
| `AICLIENT_E2E_IMAGE_NEGATIVE_TIMEOUT_MS` | `30000` | `support_images=false` 模型的图片请求超时；超时按“未识图”计为通过 |
| `AICLIENT_E2E_IMAGE_GAP_MS` | `1500` | 图片矩阵请求间隔，降低上游限流概率 |

示例：

```bash
# 默认：启动 globalSetup，从 /auto/v1/models 拉取并筛选 10 个代表性模型
AICLIENT_E2E_BASE=http://127.0.0.1:3200/auto npm run test:e2e

# 恢复收敛前的全量模型扫描（请求量显著上升，发布前全量回归用）
AICLIENT_E2E_BASE=http://127.0.0.1:3200/auto AICLIENT_E2E_ALL_MODELS=1 npm run test:e2e

# 指定单个/少量模型（不访问 /auto/v1/models 的模型列表，优先级最高）
AICLIENT_E2E_BASE=http://127.0.0.1:3200/auto \
AICLIENT_E2E_MODELS=openai-custom:glm-5.3,gemini-antigravity:gemini-3.8-flash-high \
npm run test:e2e
```

> `npm run test:e2e` 通过 Jest `globalSetup` 抓取模型列表。若直接运行 `jest tests/e2e`，请带上 `--globalSetup=./tests/e2e/global-setup.js`，否则会提示模型列表不存在。

## 默认的代表性模型集（7 Provider × 10 模型）

默认不再跑 `/auto/v1/models` 返回的全部模型，而是收敛到下列代表性模型（定义在 `tests/e2e/representative-models.js`，由 `model-selection.js` 再导出）：

| Provider | 代表模型 | 覆盖的协议/方言 |
|---|---|---|
| `gemini-antigravity` | `gemini-antigravity:claude-sonnet-5-5-medium` | Gemini 上游 → Claude 协议 |
| `gemini-antigravity` | `gemini-antigravity:gemini-3.8-flash-medium` | Gemini 原生 + thinking 回退 |
| `openai-codex-oauth` | `openai-codex-oauth:gpt-6-luna` | Codex OAuth 0-Hop / Responses 原生 |
| `openai-custom` | `openai-custom:deepseek-v4.1-flash` | OpenAI Chat 原生 |
| `openaiResponses-custom` | `openaiResponses-custom:deepseek-v4-flash` | Responses 原生上游 |
| `trae-chat_v3` | `trae-chat_v3:deepseek-v4.1-flash` | Trae chat_v3 方言 |
| `trae` | `trae:DeepSeek-V4.1-Flash-1017` | Trae 原方言（模型名大小写混合） |
| `zed` | `zed:claude-haiku-5-5` | Zed Claude 通道 |
| `zed` | `zed:gemini-3.8-flash` | Zed Gemini 通道（120s 级长尾） |
| `zed` | `zed:gpt-6-luna` | Zed GPT 通道 |

- 匹配逻辑同时兼容 `/auto/v1/models` 返回 `provider:model` 与纯 `model` id（纯 id 时 provider 取 `owned_by`），并容忍模型名大小写差异；匹配不到的单个模型会以 `[E2E] ... will be skipped` warning 跳过。
- **若 10 个代表模型一个都匹配不到，globalSetup 直接报错**，不会静默跑 0 个用例。
- opt-in 用例（生图）额外依赖 `gemini-antigravity:gemini-3.1-flash-image`，同样由 globalSetup 带入。

## 覆盖范围

### 核心矩阵（每个模型 11 项）

- Chat / Responses / Claude 非流式与流式文本（强断言：`HTTP 200`、正文包含 `391`、流式生命周期终止事件 `[DONE]` / `response.completed` / `message_stop`）
- Chat / Responses / Claude 单轮 function tool（强断言：调用 `get_weather` 且参数包含 `Paris`）
- Chat 多轮工具结果回传（强断言：结合工具输出返回 `18`）
- 连续同角色 + system 折叠（强断言：多条连续 user 消息合并后记住数字 `7`）
- usage 不变量（部分路径强断言：`responses_stream` 与 `responses_tool` 对所有模型检查 `output_tokens >= reasoning_tokens`；`chat_text`、`chat_stream`、`responses_text` 仅对 `gemini-antigravity:*` 检查）
- Reasoning/thinking 存在性作为非阻塞 `[E2E warnings]` 输出（部分 Provider/模型如 Zed 的 Claude/Gemini 分支不向外暴露 thinking block）。

### 通用定向契约（6 项，默认运行）

- openai-custom 指定 function 强制 `tool_choice` 在 30s 内返回
- 多模态模型 32×32 红图识别
- 上游 4xx 错误响应保留可读细节
- 三下游协议（Chat / Responses / Claude）流式工具调用生命周期完整
- Responses→Gemini input 内 developer 消息与 `text.format` JSON Schema 结构化输出
- Responses→Gemini 仅 system/developer 消息返回本地 400，不请求上游

> 定向用例不再硬编码具体模型：从 `/auto/v1/models` 按 provider 前缀和模型名特征动态选择。
> 测试名会显示实际选中的模型；若没有匹配模型（例如某个 provider 被移除或模型下线），该用例自动 `skip`，不会误报失败。

### 图片输入矩阵（默认运行）

用例文件：`tests/e2e/image-input.e2e.test.js`

- 取样：本次模型集（默认即上文 10 个代表性模型）中 5 个核心 Provider（`gemini-antigravity` / `openai-codex-oauth` / `zed` / `trae` / `trae-chat_v3`）的模型，按 provider 前缀动态选择，不硬编码数量。
- 排除生图模型：`gemini-3.1-flash-image` 的 text-to-image / image-to-image 能力需要独立的图片生成测试，不进入本输入矩阵。
- 覆盖：每个模型分别请求 Chat / Responses / Messages 三种非流式图片输入。
- 测试图：320×160，左红/右蓝、中央数字 `42`、左下绿圆；通过 `support_images` 作为预期判据。
- `support_images=true`：强断言 `HTTP 200` 且正文包含 red + blue + 42。
- `support_images=false`：允许 4xx/5xx 或超时；HTTP 200 时必须没有正确识图，避免文本模型猜中造成假阳性。
- `false` 模型默认请求超时 `30s`（可用 `AICLIENT_E2E_IMAGE_NEGATIVE_TIMEOUT_MS` 调整），超时计为“未识图”通过。
- 上游持续 `429` / 配额耗尽时自动重试 2 次（间隔 20s）；仍失败则输出 `[image-e2e] ... skipped` warning 并跳过该单元格断言，不计为转译失败。
- 仅当模型 `support_efforts` 包含 `low` 时才注入 `reasoning_effort=low`，避免 `gemini-3.1-flash-image` 等非思考模型在 Responses 路径收到不支持的 thinking level。

```bash
# 仅跑图片输入矩阵
npm run test:e2e:images
```

### 图片生成矩阵（OpenAI Images API，opt-in）

用例文件：`tests/e2e/image-generation.e2e.test.js`

- 模型：`gemini-antigravity:gemini-3.1-flash-image`（从 `/auto/v1/models` 动态查找；不存在时整组 skip）。
- text-to-image：`POST /v1/images/generations`，断言 `data[0].b64_json` 非空，并校验返回字节是 PNG / JPEG / WebP。
- image-to-image：`POST /v1/images/edits`（multipart：测试图 + prompt），同样校验返回图片字节。
- 上游持续 429 / 配额耗尽时重试 2 次（间隔 20s），仍失败则 warning skip；HTTP 400 `Image generation rejected` 或其他非 200 视为失败。

```bash
# 仅跑图片生成（text-to-image / image-to-image）
npm run test:e2e:images:generation
```

> 该用例默认不随 `npm run test:e2e` 运行，避免生图配额导致日常 E2E 不稳定。

### Provider 方言 canary（4 项，opt-in）

```bash
npm run test:e2e:providers
```

- Zed Gemini 多轮工具历史降级为文本并返回 200
- OpenAI → Zed Claude 多轮工具历史中的非法 tool id 被清洗
- Gemini 流式 thinking 回退后仍返回 reasoning
- Gemini max_tokens 截断不触发空响应重试

这些用例依赖特定 provider 的方言行为，默认不随通用 E2E 运行，避免日常回归被单一 provider 绑架。

### 已移除的模型行为抽样

以下用例测的是模型采样/质量，而不是网关正确性，已从 E2E 移除；对应映射逻辑由确定性单测覆盖（`tests/converters.test.js`、`tests/openai-claude-stream.test.js`、`tests/regressions/cross-protocol.test.js` 等）：

- GPT 3 次采样 reasoning
- DeepSeek 三协议 reasoning 一致性
- CoT-present Chat / Claude 多轮工具回放
- `oneOf` schema 合并（已由 `tests/schema-polyfill.test.js` 覆盖）
- 多 system 折叠（已由 `tests/regressions/conversion-enhancements.test.js` 覆盖）

## 长尾重试与故障分类

- `postJson` 对 5xx/超时透明重试 1 次；`postSse` 除对 5xx/超时/空流重试外，还会识别流内可重试服务端错误（Responses `response.failed` / `event: error`、Claude `event: error`、OpenAI Chat `data.error` 的 `server_error` / `rate_limit_error`）并透明重试 1 次。
- `zed:gemini-*` 通道存在 120s 级上游长尾，单模型超时预算自动放宽至 600s（其余模型默认 300s，可通过 `AICLIENT_E2E_MODEL_TIMEOUT_MS` 覆盖）。
- 重试恢复的请求会记入 `[E2E warnings]`；若重试后仍因上游 5xx/流内错误失败，断言消息会标注 `[upstream_5xx:...]` 或 `[upstream_stream_error:...]`，与转译断言失败区分。

## 已知限制（不作为失败）

- Gemini 流式上游不返回 thought text；网关默认回退非流式以保留 reasoning。
- `zed:claude-haiku-5-5` / `zed:gemini-3.8-flash` 不返回 thinking block，但正文可能包含推理。
- `zed:gpt-6-luna` / Codex 的 reasoning 受 prompt、effort 与采样影响；E2E 用多步 prompt + 多次采样。
- Gemini `maxOutputTokens` 已透传，但 thinking token 也计入预算，极小值可能只产出 thinking。
- 显式 `cache_control` 仍不跨协议保留；网关默认开启工具稳定排序以对齐隐式前缀缓存。
- Codex 上游可能忽略 `max_output_tokens`，网关已透传该字段。
- 图片输入矩阵中上游持续 `429` / 配额耗尽（例如 `gemini-3.1-flash-image` 的图片生成配额）会记为 warning 并跳过该单元格断言，不作为图片转译失败。

测试会在控制台输出 `[E2E warnings]`，但只有确定性核心断言失败才会让测试失败。

## 注意

- 模型列表以 `/auto/v1/models` 为准，不在测试代码中硬编码。默认收敛到 7 Provider × 10 代表性模型：每个模型执行 11 次核心请求（约 110 次），另有 6 项通用定向契约。
- 图片输入矩阵在代表性模型中再对 `gemini-antigravity` / `openai-codex-oauth` / `zed` / `trae` / `trae-chat_v3` 的非生图模型各执行 3 次请求（默认 9 个模型 → 27 次，`gemini-3.1-flash-image` 单独测试）。4 项 provider 方言 canary 仅在 `test:e2e:providers` 中运行。
- 建议使用独立实例端口，避免影响主实例。
- 默认串行执行（`--runInBand`），避免并发触发上游限流。
- 发布前建议用 `AICLIENT_E2E_ALL_MODELS=1` 至少跑一次全量矩阵；日常回归用默认收敛集，或用 `AICLIENT_E2E_MODELS=...` 指定子集。
