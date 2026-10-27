# AIClient-2-API 发布说明 (v5.0.8)

> **v5.0.8** 是 v5.0.7 之后的 reasoning_effort 契约修复与自定义模型 metadata 能力版本。
>
> 本轮统一了 Antigravity / Codex 的 reasoning_effort 行为，并为自定义模型新增 `context_length`、`max_output_tokens`、`support_images`、`support_efforts` 四个 metadata 字段，WebUI 可直接配置并透传到 `/v1/models`。同时移除了自定义模型的历史字段兼容与 temperature/topP 覆盖逻辑。

---

## 🧠 reasoning_effort 契约修复

- **Antigravity**：`support_efforts` 固定为 `null`，下游传入的 `reasoning_effort`（含 `low` / `medium` / `high` / `max` / `xhigh`）一律剥离，不再返回 400；最终档位由模型 ID 决定。
- **OpenAI Codex OAuth**：Claude → Codex 的 Messages 转换不再硬编码默认 `medium`，未指定 thinking/effort 时统一由 Codex Provider 按上游元数据取最高档。
- 保留 Trae / Zed / Codex 的动态档位严格校验：不支持的档位仍在写出响应前返回 HTTP 400 `unsupported`。

## 🗂️ 自定义模型 metadata

- WebUI“自定义模型”新增并支持编辑：
  - `context_length`
  - `max_output_tokens`
  - `support_images`
  - `support_efforts`（下拉：`null` / `high` / `max` / `high+max`）
- 后端在 `/auto/v1/models` 与单 Provider `/xxx/v1/models` 中注入上述字段。
- `support_efforts` 后端仅保留 `high` / `max`；空数组或 `null` 输出 `null`。
- `max_output_tokens` 同时作为自定义模型的请求默认输出上限。
- 移除了 `contextLength` / `maxTokens` 旧字段兼容与旧 `max_tokens` 输出。
- 移除了自定义模型的 `temperature` / `topP` 配置与强制覆盖逻辑，采样参数回归由客户端控制。

## 🧹 清理与兼容性

- WebUI 自定义模型表单、表格参数列、i18n 与样式同步更新。
- `configs/custom_models.json.example` 已更新为新字段格式。
- `configs/custom_models.json` 为运行时配置且被 `.gitignore` 忽略；升级后可通过 WebUI 重新填写，或参考示例手动配置。
- 运行要求保持不变：Node.js `^22.18.0 || >=23.6.0`。
- 无 Provider 增删，无插件公共契约变更。

## 🧪 验证结果

| 项目 | 结果 |
|---|---|
| `npm test` | **51 suites / 649 tests 全绿** |
| `npm run typecheck` | **通过** |
| `npm run typecheck:strict` | **通过** |
| `npm run check:imports` | **通过** |
| `npm run check:cycles` | **通过** |
| 自定义模型 e2e | **72 次请求全部通过** |

### 自定义模型 E2E 覆盖

- 6 个模型 × 3 种协议（Chat / Responses / Messages）× 2 个 effort（`high` / `max`）× text / image = **72 次请求**。
- 36 次文本请求全部 HTTP 200 并返回预期内容。
- 24 次 `support_images=true` 图片请求全部正确识图。
- 12 次 `support_images=false` 图片请求均未识图，符合 metadata 判据。
- 0 个逻辑失败、0 个超时、0 个限流。

## 📦 升级建议

- 源码：

  ```bash
  git fetch --tags
  git checkout v5.0.8
  npm install
  npm start
  ```

- Docker：发布工作流在检测到 `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` 时会构建并推送 `5.0.8` 与 `latest` 镜像；未配置凭据时跳过，可稍后手动运行工作流。

- 升级后请重启服务并硬刷新 WebUI，以加载新的自定义模型表单与 metadata 字段。
