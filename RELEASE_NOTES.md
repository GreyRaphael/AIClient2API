# AIClient-2-API 发布说明 (v5.1.0)

> **v5.1.0** 是 v5.0.8 之后的模型 metadata 可视化与 Playground 多协议版本。
>
> 仪表盘现在可以直接查看所有可用模型的上下文长度、输出上限、图片能力与推理档位；Playground 新增 OpenAI Responses 与 Anthropic Messages 两种接口类型，并修复了流式输出的打字机效果。

---

## 🗂️ 仪表盘模型 metadata

- 新增 `GET /api/provider-models/metadata`，按 Provider 汇总模型 metadata：
  - 上游 capability 已有的 `display_name` / `context_length` / `max_output_tokens` / `support_images` / `support_efforts`
  - 自定义模型配置中的同名 metadata 会合并覆盖上游值
- 仪表盘“可用模型列表”改为每行 2 个卡片，每个模型单行展示：
  - `id`
  - `context_length`
  - `max_output_tokens`
  - `support_images`
  - `support_efforts`
- 点击卡片会把模型 ID 与对应 metadata 以 JSON 复制到剪贴板，便于直接粘贴到配置或脚本中。
- 刷新模型能力时同步清空并重新拉取 metadata 缓存。
- 自定义模型 metadata 注入逻辑抽取到 `src/providers/custom-model-metadata.ts`，`/v1/models` 与 metadata 端点共用同一套规则。

## 🧪 Playground 多协议接口

- “接口类型”新增：
  - `responses` — OpenAI Responses（`POST /v1/responses`）
  - `messages` — Anthropic Messages（`POST /v1/messages`）
- 三种文本接口均支持流式与非流式：
  - Chat：`messages` + `reasoning_effort`
  - Responses：`instructions` + `input` + `reasoning.effort`
  - Messages：`system` + `messages` + `max_tokens` + `thinking: adaptive` + `output_config.effort`
- 历史消息与附件会自动转换成各协议格式：
  - Responses：`input_text` / `input_image`
  - Messages：`text` / `image` base64 block
- 流式解析覆盖：
  - Responses：`response.output_text.delta`、reasoning summary delta、`response.completed`
  - Messages：`text_delta`、`thinking_delta`、`message_stop`
- 新增客户端打字机预览队列：即使上游把多个 token 合并成少量大 delta，`stream=true` 仍会逐字展示，并在流结束后最多用 800ms 排空剩余字符。

## 🧹 修复

- 修复 `section-access.css` 中残留的重复模型列表样式：它在并行加载时可能覆盖仪表盘 CSS，导致模型卡片按 4 列排布。
- 修复 Playground 流式输出在 delta 合并场景下看起来与非流式一致的问题。

## 🧪 验证结果

| 项目 | 结果 |
|---|---|
| `npm test` | **52 suites / 651 tests 全绿** |
| `npm run verify` | **通过**（typecheck / plugins / strict / any / imports / cycles / coverage / runtime smoke） |
| Playground e2e | **10/10 通过** |

### Playground E2E 覆盖

- 2 个目标模型：Chat 原生 `openai-custom` 与 Responses 原生 `openaiResponses-custom`。
- Responses / Messages 各自非流式 + 流式文本，全部 HTTP 200 且返回预期 `391`。
- Responses / Messages 图片输入，均正确识别测试图的 `red + blue + 42`。
- 覆盖跨协议转译（Chat → Responses/Messages）与同协议直通（Responses → Responses）。

## 📦 升级建议

- 源码：

  ```bash
  git fetch --tags
  git checkout v5.1.0
  npm install
  npm start
  ```

- Docker：发布工作流在检测到 `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` 时会构建并推送 `5.1.0` 与 `latest` 镜像；未配置凭据时跳过，可稍后手动运行工作流。

- 升级后请重启服务并硬刷新 WebUI，以加载新的仪表盘模型卡片与 Playground 接口类型。

- 兼容性：无 Provider 增删，无插件公共契约变更；自定义模型继续使用 `context_length` / `max_output_tokens` / `support_images` / `support_efforts` 字段。
