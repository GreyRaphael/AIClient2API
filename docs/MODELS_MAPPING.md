# Upstream Models Metadata & Reasoning Effort Mapping

本文档汇总 5 个核心 Provider 的 `/v1/models` 元数据映射与 `reasoning_effort` 严格映射规则，对应 **2026-10-27** 的模型列表与 Provider 改造。

> 归档副本：`docs/MODELS_MAPPING.md`。根目录 `models_mapping.md` 与 5 份原始 JSON 作为抓取输入保留，不提交。

---

## 1. 2026-10-27 相关 commits

| Commit | 说明 |
| :--- | :--- |
| `b83e547` | refactor(antigravity): 简化 model_list 过滤、别名映射与去重逻辑 |
| `23d77f5` | refactor(antigravity): 严格按白名单收集与黑名单过滤两步精简 model_list |
| `5dad8f6` | refactor(trae): 彻底精简 model_list 过滤逻辑为仅依赖 extra_high |
| `e8cc4ea` | refactor(zed): 精简 model_list 过滤规则为仅保留 is_latest 模型 |
| `f5282bc` | feat(codex): model_list 过滤规则增加排除 visibility 为 hide 的模型 |
| `4c29dea` | feat(models): 新增共享模型元数据与 reasoning effort 工具 |
| `e7f6fab` | feat(providers): 严格 reasoning_effort 映射，并输出 4 个模型元数据字段 |
| `0312f61` | test(providers): 覆盖元数据聚合与严格 effort 映射 |
| `8bbbc6e` | chore(providers): 更新 Antigravity / Codex / Zed / Trae 客户端版本 |
| `3dfe9be` | chore(trae): chat_v3 使用最新 IDE 版本 |
| `9816fe0` | fix(trae): model_list 过滤改为 `extra_high && is_invisible_to_user !== true` |

---

## 2. 抓取客户端版本（2026-10-27）

| Provider / 通道 | 客户端版本 | 版本标识 |
| :--- | :--- | :--- |
| Antigravity | `1.4.7` | User-Agent: `antigravity/cli/1.4.7 linux/amd64` |
| OpenAI Codex OAuth | `0.164.0` | `CODEX_FALLBACK_VERSION` |
| Zed | `1.26.2+preview.381.87353f5227f6bc0757c3a077f42841dac6a8ed8e` | `ZED_FALLBACK_VERSION`，支持节点 `ZED_VERSION` 覆盖 |
| Trae (tob_raw_chat) | CLI `0.211.1` | `ideVersionCode: 20260908` |
| Trae (chat_v3) | IDE `3.4.4` | `ideVersionCode: 20261015` |

> Trae chat_v3 使用 IDE 版本；ToB raw chat 使用 CLI 版本，两者不是同一版本线。

---

## 3. `/v1/models` 扩展字段

扩展的 4 个字段：

1. `display_name`：模型展示名称
2. `context_length`：模型支持的最大总上下文 Token 数
3. `max_output_tokens`：单次生成最大输出 Token 数
4. `support_efforts`：支持的思考/推理级别；无法动态调节或非思考模型为 `null`

### 3.1 上游字段映射

| Provider | `display_name` | `context_length` | `max_output_tokens` | `support_efforts` |
| :--- | :--- | :--- | :--- | :--- |
| **Antigravity** | `displayName` | `maxTokens` | `maxOutputTokens` | 无动态数组，固定为 `null`（档位固化在模型 ID 中） |
| **OpenAI Codex OAuth** | `display_name` | `max_context_window`（872K，取最大值） | 默认 128,000（Responses 规范） | `supported_reasoning_levels[].effort` |
| **Zed** | `display_name` | `max_token_count` | `max_output_tokens` | `supported_effort_levels[].value`（小写归一化） |
| **Trae (tob_raw_chat)** | `display_config.display_name` | `context_window_tokens.max` 或 `.dev` | `model_detail_list[].max_tokens` | `reasoning_effort_config.options`（标准化映射） |
| **Trae (chat_v3)** | `display_config.display_name` | `context_window_tokens.max` 或 `.dev` | `model_detail_list[].max_tokens` | `reasoning_effort_config.options`（标准化映射） |

### 3.2 实现要点

- 元数据来自上游 model_list 响应，不在响应层硬编码模型数据。
- 节点能力缓存（`model-capability-cache.json`）新增 `modelMetadata`，按 `providerType:uuid` 隔离。
- `/auto/v1/models` 与 `/xxx/v1/models` 共用同一份能力元数据，因此两条路径字段一致。
- 多节点聚合时字段互补；旧版缓存缺少元数据会自动触发一次重新发现。
- Codex `context_length` 明确取 `max_context_window`（872,000），不使用 `context_window`（272,000）。

---

## 4. reasoning_effort 严格映射

### 4.1 总规则

- 下游未提供 `reasoning_effort`：默认使用上游支持的最高档位。
- 下游显式提供的档位必须与上游支持列表一一对应；不在列表中的档位直接返回 **HTTP 400 unsupported**。
- 显式 `none` / `off` / `false`：视为关闭思考；上游明确支持 `none` 时透传，否则省略 effort。
- 校验发生在写出任何响应字节之前，因此 Chat / Responses / Messages 三种协议的流式与非流式请求都会得到真正的 HTTP 400。
- Provider 层保留二次校验，防止元数据未就绪或直接调用 service 时绕过。

错误示例：

```text
reasoning_effort 'max' is unsupported for model 'DeepSeek-V4.1-Flash-1017' (trae).
Supported reasoning_effort values: [low, high, xhigh]
```

### 4.2 各 Provider 行为

| Provider | 上游档位来源 | 下游标准档位 | 缺省默认 | 不支持示例 |
| :--- | :--- | :--- | :--- | :--- |
| **Antigravity** | 无动态数组，档位固化在模型 ID | 接受 `low` / `medium` / `high` | 不注入（模型 ID 已决定） | `max` / `xhigh` / `ultra` → 400 |
| **OpenAI Codex OAuth** | `supported_reasoning_levels[].effort` | 与上游完全一致，含 `xhigh` / `max` / `ultra` | 列表最高档（terra 为 `ultra`） | luna 的 `ultra` → 400 |
| **Zed** | `supported_effort_levels[].value` | 与上游完全一致，大小写不敏感 | 列表最高档 | `gpt-6-luna` 的 `max` → 400 |
| **Trae (tob_raw_chat)** | `reasoning_effort_config.options` | `low` / `high` / `xhigh` ↔ `light` / `high` / `extra_high` | `xhigh` | `max` / `minimal` / `medium` → 400 |
| **Trae (chat_v3)** | 同上 | 同上 | `xhigh` | 同上 |

> Antigravity 的 `support_efforts` 为 `null`，但上游可按 low/medium/high 三档族识别；模型 ID（如 `-high` / `-medium`）仍是最终档位。

---

## 5. 模型元数据明细

### 5.1 Antigravity（9 个模型）

原始数据：`antigravity_model_list.json`

> 上游无动态可选档位字段；高/中深度作为独立模型实体发布，`support_efforts` 固定为 `null`。

| 模型 ID | 展示名称 | 上下文长度 | 最大输出 | 支持档位 |
| :--- | :--- | :---: | :---: | :---: |
| `claude-opus-5-5-high` | Claude Opus 5.5 (High) | 1,000,000 | 128,000 | `null` |
| `claude-opus-5-5-medium` | Claude Opus 5.5 (Medium) | 1,000,000 | 128,000 | `null` |
| `claude-sonnet-5-5-high` | Claude Sonnet 5.5 (High) | 1,000,000 | 128,000 | `null` |
| `claude-sonnet-5-5-medium` | Claude Sonnet 5.5 (Medium) | 1,000,000 | 128,000 | `null` |
| `gemini-3.1-flash-image` | Gemini 3.1 Flash Image | 65,536 | 65,536 | `null`（非思考模型） |
| `gemini-3.8-flash-high` | Gemini 3.8 Flash (High) | 1,048,576 | 65,536 | `null` |
| `gemini-3.8-flash-medium` | Gemini 3.8 Flash (Medium) | 1,048,576 | 65,536 | `null` |
| `gemini-4-argon-high` | Gemini 4 Argon (High) | 1,048,576 | 65,536 | `null` |
| `gemini-4-argon-medium` | Gemini 4 Argon (Medium) | 1,048,576 | 65,536 | `null` |

### 5.2 OpenAI Codex OAuth（3 个公开模型）

原始数据：`openai_codex_oauth_model_list.json`

> 过滤规则：排除 `supported_in_api=false`、需要 `upgrade`、`visibility=hide` 的模型。

| 模型 ID | 展示名称 | 上下文长度 | 最大输出 | 支持档位 |
| :--- | :--- | :---: | :---: | :---: |
| `gpt-6-luna` | GPT-6-Luna | 872,000 | 128,000 | `["low", "medium", "high", "xhigh", "max"]` |
| `gpt-5.6-terra` | GPT-5.6-Terra | 872,000 | 128,000 | `["low", "medium", "high", "xhigh", "max", "ultra"]` |
| `gpt-5.6-luna` | GPT-5.6-Luna | 872,000 | 128,000 | `["low", "medium", "high", "xhigh", "max"]` |

### 5.3 Zed（6 个 `is_latest` 模型）

原始数据：`zed_model_list.json`

> `support_efforts` 严格取上游 `supported_effort_levels[].value`；下游请求不在列表中的档位（例如 `gpt-6-luna` 的 `max`）返回 400 unsupported。缺省时默认使用列表最高档。

| 模型 ID | 展示名称 | 上下文长度 | 最大输出 | 支持档位 |
| :--- | :--- | :---: | :---: | :---: |
| `claude-sonnet-5-5` | Claude Sonnet 5.5 | 1,000,000 | 128,000 | `["low", "medium", "high", "xhigh", "max"]` |
| `claude-haiku-5-5` | Claude Haiku 5.5 | 100,000 | 128,000 | `["low", "medium", "high", "xhigh", "max"]` |
| `gpt-6.1-sol` | GPT-6.1 Sol | 400,000 | 128,000 | `["low", "medium", "high", "xhigh", "max"]` |
| `gpt-6-luna` | GPT-6 Luna | 400,000 | 128,000 | `["low", "medium", "high", "xhigh"]` |
| `gemini-4-argon` | Gemini 4 Argon | 1,048,576 | 65,536 | `["low", "medium", "high"]` |
| `gemini-3.8-flash` | Gemini 3.8 Flash | 1,048,576 | 65,535 | `["low", "medium", "high"]` |

### 5.4 Trae (tob_raw_chat)（13 个可用基线候选模型）

原始数据：`trae_tob_raw_chat_model_list.json`

> 过滤规则：
> 1. `reasoning_effort_config.options` 必须含 `extra_high`；
> 2. `is_invisible_to_user !== true`。
>
> 上游仍会返回 `deepseek-V4-Pro` / `DeepSeek-V4-Flash` 两个历史配置，但它们被标记为 `is_invisible_to_user: true`，且实际请求返回 `4023 model unknown`；`9816fe0` 起统一按 visibility 过滤，不再暴露。

| 模型 ID | 展示名称 | 上下文长度 | 最大输出 | 支持档位 |
| :--- | :--- | :---: | :---: | :---: |
| `DeepSeek-V4-Flash-Official` | DeepSeek-V4-Flash 正式版 | 1,000,000 | 64,000 | `["low", "high", "xhigh"]` |
| `DeepSeek-V4-Pro-Official` | DeepSeek-V4-Pro 正式版 | 1,000,000 | 64,000 | `["low", "high", "xhigh"]` |
| `DeepSeek-V4.1-Flash` | DeepSeek-V4.1-Flash | 1,000,000 | 64,000 | `["low", "high", "xhigh"]` |
| `DeepSeek-V4.1-Flash-1017` | DeepSeek-V4.1-Flash-1017 | 1,000,000 | 64,000 | `["low", "high", "xhigh"]` |
| `glm-5.2` | GLM-5.2 | 1,000,000 | 64,000 | `["high", "xhigh"]` |
| `glm-5.3` | GLM-5.3 | 1,000,000 | 64,000 | `["low", "high", "xhigh"]` |
| `glm-5.3-flash` | GLM-5.3-Flash | 1,000,000 | 64,000 | `["low", "high", "xhigh"]` |
| `glm-5.3-flashx` | GLM-5.3-FlashX | 1,000,000 | 64,000 | `["low", "high", "xhigh"]` |
| `kimi-k2.8-preview` | Kimi-K2.8-Preview | 1,000,000 | 64,000 | `["low", "high", "xhigh"]` |
| `kimi-k3` | Kimi-K3 | 1,000,000 | 64,000 | `["low", "high", "xhigh"]` |
| `kimi-k3.1-pro` | Kimi-K3.1-Pro | 1,000,000 | 64,000 | `["low", "high", "xhigh"]` |
| `minimax-m3.1-flash` | MiniMax-M3.1-Flash | 1,000,000 | 64,000 | `["low", "high", "xhigh"]` |
| `qwen3.8-max` | Qwen3.8-Max | 1,000,000 | 64,000 | `["low", "high", "xhigh"]` |

### 5.5 Trae (chat_v3)（13 个可用基线候选模型）

原始数据：`trae_chat_v3_model_list.json`

> chat_v3 使用 IDE 版本 `3.4.4` 抓取；过滤规则与 tob_raw_chat 相同：`extra_high && is_invisible_to_user !== true`。
> 上游标记为 invisible 的 `DeepSeek-V4-Flash` / `DeepSeek-V4-Pro` 不再暴露。

| 模型 ID | 展示名称 | 上下文长度 | 最大输出 | 支持档位 |
| :--- | :--- | :---: | :---: | :---: |
| `DeepSeek-V4-Flash-Official` | DeepSeek-V4-Flash | 1,000,000 | 64,000 | `["low", "high", "xhigh"]` |
| `DeepSeek-V4-Pro-Official` | DeepSeek-V4-Pro | 1,000,000 | 64,000 | `["low", "high", "xhigh"]` |
| `deepseek-v4.1-flash` | DeepSeek-V4.1-Flash | 1,000,000 | 64,000 | `["low", "high", "xhigh"]` |
| `glm-5.2` | GLM-5.2 | 1,000,000 | 64,000 | `["high", "xhigh"]` |
| `glm-5.3` | GLM-5.3 | 1,000,000 | 64,000 | `["low", "high", "xhigh"]` |
| `glm-5.3-flash` | GLM-5.3-Flash | 1,000,000 | 64,000 | `["low", "high", "xhigh"]` |
| `glm-5.3-flashx` | GLM-5.3-FlashX | 1,000,000 | 64,000 | `["low", "high", "xhigh"]` |
| `kimi-k2.8-preview` | Kimi-K2.8-Preview | 1,000,000 | 64,000 | `["low", "high", "xhigh"]` |
| `kimi-k3` | Kimi-K3 | 1,000,000 | 64,000 | `["low", "high", "xhigh"]` |
| `kimi-k3.1-pro` | Kimi-K3.1-Pro | 1,000,000 | 64,000 | `["low", "high", "xhigh"]` |
| `minimax-m3.1-flash` | MiniMax-M3.1-Flash | 1,000,000 | 64,000 | `["low", "high", "xhigh"]` |
| `qwen3.8-flash` | Qwen3.8-Flash | 1,000,000 | 64,000 | `["low", "high", "xhigh"]` |
| `qwen3.8-max` | Qwen3.8-Max | 1,000,000 | 64,000 | `["low", "high", "xhigh"]` |

---

## 6. 验证记录

- `npm run typecheck` 通过。
- 单元测试：51 suites / 640 tests 全部通过。
- `/auto/v1/models` 与 5 个单 Provider `/v1/models` 均输出 4 个扩展字段。
- 12 个实际暴露模型与本文档逐项比对一致（含 Codex 872,000 / 128,000）。
- 400 unsupported 实测覆盖：
  - Trae `DeepSeek-V4.1-Flash-1017` + `max`：Chat / Responses / Messages 三种格式均 400。
  - Codex `gpt-6-luna` + `ultra` → 400。
  - Zed `gpt-6-luna` + `max` → 400。
  - Zed `gemini-4-argon` + `max` → 400。
  - Antigravity `gemini-3.8-flash-high` + `max` → 400。
  - Trae chat_v3 `glm-5.3-flashx` + `max` → 400。
- 支持档位与缺省档位实测 200。
- E2E 核心矩阵覆盖 5 个 Provider；Provider 方言 canary 4/4 通过。

### 6.1 220 组合 reasoning_effort 矩阵（2026-10-27）

- 覆盖：44 个 model_id × `[low, medium, high, xhigh, max]` = 220 个组合，请求 `http://localhost:3000/auto/v1/chat/completions`。
- 结果：217 PASS，0 LOGIC_FAIL，3 个上游/账号错误。
- 所有预期不支持的 77 个组合均返回 HTTP 400 且包含 `unsupported`。
- 预期支持的 143 个组合中 140 个返回 HTTP 200；3 个为上游错误：
  - Trae chat_v3 `kimi-k3.1-pro` 的 `low` / `high` / `xhigh` → 上游 `1005`（当前账号 plan 限制），非映射逻辑问题。

| Provider | 组合数 | PASS | LOGIC_FAIL | 上游/账号错误 |
| :--- | ---: | ---: | ---: | ---: |
| Trae tob_raw_chat | 65 | 65 | 0 | 0 |
| Trae chat_v3 | 65 | 62 | 0 | 3 |
| OpenAI Codex OAuth | 15 | 15 | 0 | 0 |
| Antigravity | 45 | 45 | 0 | 0 |
| Zed | 30 | 30 | 0 | 0 |
| **合计** | **220** | **217** | **0** | **3** |

> 矩阵执行时临时将 5 个 Provider 的 `supportedModels` 扩展为全部 44 个候选模型，确保所有 ID 可路由；测试完成后已恢复原配置。当前候选集为 44 个（13+13+9+3+6）。

---

## 7. 已知边界

- Antigravity 档位固化在模型 ID 中，`support_efforts` 为 `null`；不注入默认档位。
- Codex `max_output_tokens` 为 Responses 规范默认 128,000，不是逐模型上游字段。
- Trae ToB / chat_v3 的 model_list 过滤规则为 `extra_high && is_invisible_to_user !== true`；上游 invisible 配置（ToB 的 `deepseek-V4-Pro` / `DeepSeek-V4-Flash`，chat_v3 的 `DeepSeek-V4-Flash` / `DeepSeek-V4-Pro`）不暴露。
- 当前 5 个 Provider 的候选集为 44 个（13+13+9+3+6）；220 矩阵基于同一集合执行。
- 根目录 JSON / `models_mapping.md` 是抓取工作文件，不提交；稳定快照以 `docs/MODELS_MAPPING.md` 为准。
