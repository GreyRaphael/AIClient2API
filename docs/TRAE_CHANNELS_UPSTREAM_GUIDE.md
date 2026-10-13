# Trae 双通道架构与上游技术规范详解

本文档详细记录了 AIClient2API 中字节跳动 **Trae** 提供商的双通道架构实现、上游协议机制、模型发现、请求参数差异及节点管理规范，为后续功能迭代和上游变更维护提供完整技术参考。

---

## 一、架构背景与演进

### 1. 历史渊源与项目背景
* **早期逆向与 trae2api-web**：最初社区对 Trae 的反代实现（如 `trae2api-web`）主要基于 Trae 的 **SOLO 个人版 Agent 接口**（即 `solo_work_lite` / `agent_v3` / `chat_v3`）。该接口打向 `https://trae-api-cn.mchost.guru`，主要用于 IDE 的端侧 Agent 协作。
* **企业版与原生 ToB Raw Chat**：随后 Trae 推出了企业版服务（`api.enterprise.trae.cn`），提供了原生的聊天端点 `/api/ide/v2/llm_raw_chat`（`function: "chat"`），支持更原生的企业模型调用与流式协议。
* **三通道独立决策**：在 AIClient2API 中，早先曾尝试在单一 provider 内混合多种模式，但由于各模式的**上游 Host、请求 Header 指纹、请求体参数规范、可用模型清单及命名**均存在显著差异。为了彻底杜绝配置混淆与功能限制，系统已将历史的 `agent_v3` 通道彻底清除并重构拆分为 **`trae`** (ToB Raw Chat)、**`trae-solo_work_lite`** (SOLO Agent) 以及 **`trae-chat_v3`** (侧边栏 Chat) 三个完全独立的顶级提供商。

### 2. 深度剖析：`solo_work_lite`、`chat_v3` 与企业 `chat` 三者区别，以及 `agent_v3` 的历史与清理

在分析上游 Trae 协议时，必须厘清 **业务功能函数 (Function)** 与 **网络网关路由 (Endpoint Route)** 两个层面的概念：

#### (1) 上游真正同级的三大业务模式 (`function` 字段)

经对 Trae 上游网关实测抓取与调试，上游后端真实注册并运行的聊天业务 `function` 主要是以下三个同级项：

| 业务模式 (`function`) | 所属通道 / 主机 | 上游模型数 | 核心定位与业务特征 |
| :--- | :--- | :---: | :--- |
| **`solo_work_lite`** | 个人版 / mchost.guru | **47 个配置 (实测 19 个真实活跃模型)** | **SOLO 智能体轻量工作流**。<br>Trae 个人版 IDE 主打的全自主编程智能体 SOLO（类似于 Composer/Devin）的轻量化工作流。上游为此模式特化了 Agent 子智能体支持（如 `file_search_agent`、`explore_sub_agent_v2`、`computer_use_subagent` 等），专为代码辅助 Agent 设计。 |
| **`chat_v3`** | 个人版 / mchost.guru | **57 个配置 (实测 20 个真实活跃模型)** | **个人版侧边栏 Chat (第 3 代)**。<br>Trae 个人版 IDE 经典的侧边栏问答对话界面。是个人版中可用模型库最全的模式（包含专属模型 `qwen3.8-flash`、`Doubao-Seed-Code`、`kimi-k2.8-preview` 等），并特化了 `fast_apply`（代码快速采纳）、`title_generation`（会话标题生成）、`input_optimization` 等对话衍生能力，底层走 `llm_raw_chat_v2` 管道。 |
| **企业 `chat`** | 企业版 / enterprise.trae.cn | **28 个配置 (实测 24 个真实活跃模型)** | **ToB 企业原生直连聊天**。<br>Trae 企业版专属服务。经过企业合规治理与审计，请求必须携带 Linux/PC 指纹、`x-flow-traceparent` 链路追踪以及 `access_type: 4`、`mode_type: 0`、`conversation_id`，且模型名称需补齐 `__max` / `__dev` 调度后缀。 |

#### (2) 为什么历史上有 `agent_v3`？为什么必须将其彻底清除与拆分？

**结论：`agent_v3` 从来不是上游的一个业务 `function`，它只是上游的 URL 网关路径层级！**

1. **实测验证**：
   * 在向上游 `POST /api/ide/v1/get_detail_param` 传入 `{"function": "agent_v3"}` 时，上游返回 `configs count: 0`。上游调度器中根本不存在名为 `agent_v3` 的功能函数。
2. **历史命名的借用**：
   * 个人版对话接口在 Trae 网关上的完整路径为：
     ```
     https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat
     ```
     其中 `/api/agent/v3` 是字节 Trae 为 Agent 微服务集群划分的第 3 代网关路由层。早期社区（如 `trae2api-web`）借用了此路径片段将其称为 `agent_v3`。
3. **彻底拆分与清除的必要性**：
   * 实际上，走该网关的有两种截然不同的业务功能：`solo_work_lite`（专供 Agent，实测 19 个真实活跃模型）与 `chat_v3`（专供侧边栏对话，实测 20 个真实活跃模型，支持更高推理档位）。
   * 将两者合并为所谓的 `agent_v3` 会导致模型丢失（如缺少 `qwen3.8-flash`、`Doubao-Seed-Code`）、无法针对性配置思考档位等缺陷。因此，本系统将 `agent_v3` 彻底废弃清除，纯净拆解为独立的 `trae-solo_work_lite` 与 `trae-chat_v3` 提供商。并且彻底废除历史别名与下线模型的兜底强并逻辑，仅提供 100% 真实活跃模型。

#### (3) 完整四者技术层级拓扑

```text
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                 AIClient2API 顶层配置                                  │
│  Provider: "trae"       Provider: "trae-solo_work_lite"       Provider: "trae-chat_v3" │
│  (企业 ToB 原生直连)     (个人版 SOLO Agent 模式)              (个人版侧边栏 Chat 模式)   │
└────────────┬────────────────────────────┬─────────────────────────────┬────────────────┘
             │                            │                             │
             ▼                            ▼                             ▼
┌─────────────────────────┐  ┌───────────────────────────────────────────────────────────┐
│ 上游网络与网关 (Endpoint)│  │ 上游网络与网关路由 (Endpoint)                             │
│ Host: enterprise.trae.cn│  │ Host: trae-api-cn.mchost.guru                             │
│ Path: /llm_raw_chat     │  │ Path: /api/agent/v3/llm_utils_chat                        │
└────────────┬────────────┘  └────────────┬─────────────────────────────┬────────────────┘
             │                            │                             │
             ▼                            ▼                             ▼
┌─────────────────────────┐  ┌─────────────────────────┐  ┌─────────────────────────┐
│ 上游真实业务功能 Payload │  │ 上游真实业务功能 Payload │  │ 上游真实业务功能 Payload │
│ • function: "chat"      │  │ • function:             │  │ • function: "chat_v3"   │
│   (28 模型，企业审计)   │  │   "solo_work_lite"       │  │   (57 模型，侧边栏对话) │
│                         │  │   (46 模型，全功能 Agent)│  │                         │
└─────────────────────────┘  └─────────────────────────┘  └─────────────────────────┘
```

#### (4) 三大业务功能核心指标深度对比表

| 维度 | `solo_work_lite` | `chat_v3` | 企业 `chat` |
| :--- | :--- | :--- | :--- |
| **所属提供商** | **`trae-solo_work_lite`** | **`trae-chat_v3`** | **`trae`** |
| **所属上游主机** | `trae-api-cn.mchost.guru` | `trae-api-cn.mchost.guru` | `api.enterprise.trae.cn` |
| **上游对话接口** | `/api/agent/v3/llm_utils_chat` | `/api/agent/v3/llm_utils_chat` | `/api/ide/v2/llm_raw_chat` |
| **模型拉取接口** | `/api/ide/v1/get_detail_param` | `/api/ide/v1/get_detail_param` | `/api/ide/v1/batch_get_detail_param` |
| **拉取入参** | `{"function": "solo_work_lite"}` | `{"function": "chat_v3"}` | `{"functions": ["chat"], ...}` |
| **上游可用模型库** | 47 个配置项 (实测 19 个真实活跃模型) | 57 个配置项 (实测 20 个真实活跃模型) | 28 个配置项 (实测 24 个真实活跃模型) |
| **Agent / 工具链特性** | 内置 subagent 占位符、支持复杂 Agent 工具调度 | 纯问答，不支持 subagent | 支持常规 function_call，无 subagent |
| **专有辅助能力** | 富上下文规划、poly_prompt 扩展 | `fast_apply`、`title_generation` | 企业链路审计、`x-flow-traceparent` |
| **请求体必需字段** | `config_name`, `model`, `max_mode` | `config_name`, `model`, `max_mode` | `model_name` (`__max`), `conversation_id`, `session_id`, `access_type: 4`, `mode_type: 0` |
| **在当前项目中的应用** | `trae-solo_work_lite` 专属模式 (一等公民) | `trae-chat_v3` 专属模式 (一等公民) | `trae` 专属使用的上游 Function |

---

## 二、三通道核心指标全景对比

| 维度 | `trae` (企业原生 ToB Raw Chat) | `trae-solo_work_lite` (SOLO Agent) | `trae-chat_v3` (侧边栏 Chat) |
| :--- | :--- | :--- | :--- |
| **Provider 标识** | `trae` | `trae-solo_work_lite` | `trae-chat_v3` |
| **通道模式 (`TRAE_CHANNEL_MODE`)** | `tob_raw_chat` | `solo_work_lite` | `chat_v3` |
| **默认上游 Host** | `https://api.enterprise.trae.cn` | `https://trae-api-cn.mchost.guru` | `https://trae-api-cn.mchost.guru` |
| **对话补全端点 (Chat Endpoint)** | `/api/ide/v2/llm_raw_chat` | `/api/agent/v3/llm_utils_chat` | `/api/agent/v3/llm_utils_chat` |
| **模型拉取端点 (Models Endpoint)** | `/api/ide/v1/batch_get_detail_param` | `/api/ide/v1/get_detail_param` | `/api/ide/v1/get_detail_param` |
| **核心 Function 字段** | `"chat"` | `"solo_work_lite"` | `"chat_v3"` |
| **上游 App ID** | `7b3f9dc2-8a4e-5c6d-2f1b-9e4a3c5b7df0` | `6eefa01c-1036-4c7e-9ca5-d891f63bfcd8` | `6eefa01c-1036-4c7e-9ca5-d891f63bfcd8` |
| **IDE 版本指纹** | `0.208.1` (`20260908`) | `0.1.52` (`20260811`) | `0.1.52` (`20260811`) |
| **设备类型指纹** | `X-Device-Type: linux`<br>`X-OS-Version: Linux 6.8.0`<br>`X-Device-Brand: PC` | `X-Device-Type: windows`<br>`X-OS-Version: Windows 11 Pro`<br>`X-Device-Brand: 83DG` | `X-Device-Type: windows`<br>`X-OS-Version: Windows 11 Pro`<br>`X-Device-Brand: 83DG` |
| **专有请求头** | `x-ide-function: chat`<br>`x-flow-traceparent: 00-...` | *无额外 traceparent* | *无额外 traceparent* |
| **对话上下文标识** | 必传 `conversation_id`, `session_id` | 无需上下文 ID | 无需上下文 ID |
| **专有请求参数** | `model_name` (如 `glm-5.2__max` 或 `__dev`), `mode_type: 0`, `access_type: 4` | 仅需 `config_name` 与 `model` | 仅需 `config_name` 与 `model` |
| **可用模型数** | 24 个 | 19 个 | 20 个 |

---

## 三、认证与凭证生命周期

三个通道底层均共用 Trae 的账户授权凭证体系（即 `configs/trae/*_creds.json`）。

### 1. 凭据文件结构
```json
{
  "user_id": "424094208",
  "email": "username@example.com",
  "access_token": "Cloud-IDE-JWT eyJhbGciOi...",
  "refresh_token": "75f6...",
  "personal_access_token": "trae_pat_...",
  "auth_host": "https://api.enterprise.trae.cn",
  "agent_host": "https://trae-api-cn.mchost.guru",
  "enterprise_id": 424094208,
  "device_id": "...",
  "machine_id": "...",
  "expires_at": 1791606076000,
  "updated_at": 1791602481000
}
```

### 2. Token 刷新机制 (`ExchangeToken`)
* **端点**：`POST {auth_host}/cloudide/api/v3/trae/oauth/ExchangeToken`
* **支持凭据**：支持 `personal_access_token` (PAT) 或 `refresh_token`。
* **主动刷新与防雪崩**：
  * 系统在 `expires_at` 距当前时间小于 24 小时时自动标记临期并预刷新。
  * `TraeApiService.getToken()` 内置 `_tokenRefreshPromise` 单飞（Single Flight）并发控制，防止高并发下多个请求同时调用上游刷新接口导致 Token 竞争失效。
  * 刷新成功后通过原子写入写回对应的凭证文件。

---

## 四、模型发现机制 (Model Discovery)

### 1. `trae` (ToB Raw Chat)
* **请求地址**：`POST https://api.enterprise.trae.cn/api/ide/v1/batch_get_detail_param`
* **请求体**：
  ```json
  {
    "app_id": "7b3f9dc2-8a4e-5c6d-2f1b-9e4a3c5b7df0",
    "version_code": "20260908",
    "functions": ["chat"],
    "agent_type": "chat",
    "mode_type": 0,
    "access_type": 4,
    "client_id": "trae-cli-client",
    "show_custom_model": false
  }
  ```
* **解析逻辑**：遍历响应中 `data.function_configs[]` 的每个项，提取 `config_info_list[]` 中的元数据。

### 2. `trae-solo_work_lite` (SOLO Agent) 与 `trae-chat_v3` (侧边栏 Chat)
* **请求地址**：`POST https://trae-api-cn.mchost.guru/api/ide/v1/get_detail_param`
* **请求体**：
  ```json
  {
    "function": "solo_work_lite", // 或 "chat_v3"
    "poly_prompt": true,
    "need_prompt": false,
    "config_names": null,
    "current_config_info": null,
    "mode_type": null,
    "agent_type": null
  }
  ```
* **解析逻辑**：直接提取响应中的 `data.config_info_list[]`。

### 3. 模型清洗与过滤机制（上游原始配置如何精简过滤为真实活跃模型）

系统严格执行**纯净上游真实模型原则**，彻底废除“基准兜底模型强行合并”与“强制追加 `auto` 虚拟别名”的旧机制。上游原始返回配置经过 4 道严密的过滤流水线清洗：

1. **内部 Agent/功能占位符拦截**：通过 `excludedConfigNames` 集合过滤纯内部使用的调度句柄（如 `computer_use_subagent`、`summary`、`fast_apply` 等）。
2. **外部自定义反代占位拦截**：通过 `is_custom_model` 或 `custom_` 前缀过滤用户在 Trae 自定义的外部 API 占位壳。
3. **上游开关状态与可见性校验**：严格剔除 `config_switch: false`（已下线/已关闭）、`is_invisible_to_user: true`（用户不可见）以及未命名的无效占位项（`display_name: "-"`）。
4. **底层真实 ID 提取**：直接暴露上游真实技术 ID，杜绝中文显示名污染。

#### (1) `trae` (ToB Chat, 原始 28 个 $\rightarrow$ 过滤后 24 个真实活跃模型)
* **原始返回 (28 个)**：包含 24 个正常业务大模型 + 4 个非活跃/辅助项。
* **过滤剔除 (4 个)**：
  1. `glm-5.1`：上游开关关闭 (`is_invisible_to_user: true`)。
  2. `DeepSeek-V4-Flash`：上游开关关闭（ToB 端官方统一启用 `DeepSeek-V4-Flash-Official`）。
  3. `summary`：内部摘要占位符 (`excludedConfigNames`)。
  4. `custom_model_placeholder`：自定义模型占位符 (`excludedConfigNames`)。
* **最终结果**：$28 - 4 = \mathbf{24\text{ 个}}$ 真实活跃模型。

#### (2) `trae-solo_work_lite` (`solo_work_lite`, 原始 47 个 $\rightarrow$ 过滤后 19 个真实活跃模型)
* **原始返回 (47 个)**：包含丰富但繁杂的 Agent 特化配置、外部自定义反代配置及开关关闭项。
* **过滤剔除 (28 个)**：
  1. **内部 Agent 占位符 (6 个)**：`computer_use_subagent`、`browser_use_subagent`、`file_search_agent`、`explore_sub_agent_v2`、`summary`、`custom_model_placeholder`。
  2. **自定义与外部映射模型 (13 个以 `custom_` 开头)**：`custom_model_gemini`、`custom_model_1M_text`、`custom_model_1M`、`custom_model_doubao_1M`、`custom_model_doubao_256k`、`custom_model_kimi`、`custom_model_claude`、`custom_model_gpt-6`、`custom_model_gpt-5`、`custom_model_no-fc`、`custom_model_deepseek_chat`、`custom_model_deepseek_reasoner`、`custom_model_deepseek_v4`。
  3. **非活跃/关闭/已下线/测试项 (9 个)**：
     - `seed-code-pro-0430`、`sagitta`、`aquila`（内部试验模型，`config_switch: false`）。
     - `Doubao-Seed-2.0-Code`、`glm-5`、`glm-5-turbo`、`DeepSeek-V4-Flash`、`DeepSeek-V4-Pro`（已下线或关闭）。
     - `-`（空白占位项）。
* **最终结果**：$47 - 6 - 13 - 9 = \mathbf{19\text{ 个}}$ 真实活跃模型。

#### (3) `trae-chat_v3` (`chat_v3`, 原始 57 个 $\rightarrow$ 过滤后 20 个真实活跃模型)
* **原始返回 (57 个)**：涵盖全量对话与衍生任务模型。
* **过滤剔除 (37 个)**：
  1. **内部衍生功能/辅助占位符 (5 个)**：`summary`、`fast_apply`、`fast_apply_new`、`title_generation`、`input_optimization`。
  2. **自定义与外部映射模型 (14 个)**：`custom_model_placeholder` 以及 `custom_model_gemini`、`custom_model_1M_text` 等 13 个外部反代项。
  3. **非活跃/关闭/已下线项 (18 个)**：
     `seed-code-pro-0430`、`sagitta`、`aquila`、`Doubao_1_6`、`glm-5.1`、`glm-5`、`glm-4.7`、`minimax-m2.1`、`kimi-k2.7-code`、`DeepSeek-V4-Flash`、`DeepSeek-V4-Pro`、`context_selection`、以及多个不可见或未启用占位项。
* **最终结果**：$57 - 5 - 14 - 18 = \mathbf{20\text{ 个}}$ 真实活跃模型。

---

### 4. 什么是个人版中的 `function: "chat"` (29 个旧版模型)？

在向 `mchost.guru` 请求 `get_detail_param` 时，传入 `function: "chat"` 会返回 29 个模型。这是 **Trae 个人版在早期（v1/v2 时代）的初代聊天接口残留**：

1. **历史背景**：
   * 在 Trae 尚未全面进化为以 **SOLO（Agent 模式）** 为主导，且尚未推出 **`chat_v3`** 之前，Trae 个人版 IDE 侧边栏最初调用的就是这个基础的 `function: "chat"`。
2. **模型特征（明显滞后于当前时代）**：
   * **保留大量上代基座模型**：如 **GLM-4.6 / GLM-4.7**（当前主流为 5.2/5.3）、**MiniMax-M2 / M2.1**（当前主流为 M3）、**Kimi-K2**（当前主流为 K2.7/K3）、**Qwen-3.5**（当前主流为 3.7+/3.8）、**Doubao_1_8** 等。
   * **完全缺失当前主流旗舰**：没有 `glm-5.3`、`mimo-v2.6-pro`、`kimi-k3`、`step-5-preview`、`DeepSeek-V4.1-Flash` 等最新模型。
3. **Trae 聊天模式的演进三部曲**：
   * **第 1 代（个人版早期）**：`mchost.guru` 下的 `function: "chat"`（即这 29 个旧模型），主要提供 GLM-4、MiniMax-M2 等基础代码问答。
   * **第 2 代（个人版升级 SOLO 与 v3）**：推出了 `function: "solo_work_lite"`（47 个配置项，19 个活跃模型）专供 Agent，并升级了 `function: "chat_v3"`（57 个配置项，20 个活跃模型）作为新的侧边栏主面板。
   * **第 3 代（企业版独立重构）**：将架构迁移至 `api.enterprise.trae.cn`，企业端重新启用了 `function: "chat"` 命名，但后端模型已全面替换为 28 个现代化新版配置（24 个活跃模型），并赋予了 `access_type: 4`、`mode_type: 0` 和 `__max` 调度后缀机制。

---

## 五、模型清单对比与差异矩阵

各通道实测可用模型清单对比，存在**专属模型**与**命名大小写/后缀差异**：

### 1. 通道独有活跃模型

| 通道 | 模型总数 | 独有模型列表 | 业务定位与差异说明 |
| :--- | :---: | :--- | :--- |
| **`trae`** (ToB) | **24 个** | `Doubao-Seed-2.0-Code`<br>`Doubao_1_6`<br>`glm-5v-turbo`<br>`minimax-m2.7`<br>`deepseek-V4-Pro` | 企业版专属治理保留；提供视觉模型 `glm-5v-turbo`；保留 `Doubao_1_6` 与特定 ToB 调度项。 |
| **`trae-solo_work_lite`** | **19 个** | `kimi-k2.6`<br>`kimi-k2.7-code` | SOLO Agent 专属轻量代码模型调度通道。 |
| **`trae-chat_v3`** | **20 个** | `Doubao-Seed-Code`<br>`kimi-k2.8-preview`<br>`qwen3.8-flash` | 侧边栏 Chat 专属对话模型，包含极速轻量模型 `qwen3.8-flash` 与 `kimi-k2.8-preview`。 |

### 2. 三通道全量真实活跃模型对照总表

| 序号 | 目标模型名称 | `trae` (ToB, 24) | `trae-solo_work_lite` (SOLO, 19) | `trae-chat_v3` (Chat, 20) |
| :---: | :--- | :---: | :---: | :---: |
| 1 | **Doubao-Seed-Evolving** | ✅ (`Doubao-Seed-Evolving`) | ✅ (`Doubao-Seed-Evolving`) | ✅ (`Doubao-Seed-Evolving`) |
| 2 | **Doubao-Seed-2.1-Pro** | ✅ (`Doubao-Seed-2.1-pro`) | ✅ (`Doubao-Seed-2.1-Pro`) | ✅ (`Doubao-Seed-2.1-Pro`) |
| 3 | **Doubao-Seed-2.1-Turbo** | ✅ (`Doubao-Seed-2.1-turbo`) | ✅ (`Doubao-Seed-2.1-Turbo`) | ✅ (`Doubao-Seed-2.1-Turbo`) |
| 4 | **Doubao-Seed-2.0-Code** | ✅ (`Doubao-Seed-2.0-Code`) | ❌ *(已下线)* | ❌ *(已下线)* |
| 5 | **Doubao_1_6** | ✅ (`Doubao_1_6`) | ❌ *(已下线)* | ❌ *(已下线)* |
| 6 | **Doubao-Seed-Code** | ❌ | ❌ | ✅ (`Doubao-Seed-Code`) |
| 7 | **glm-5.3-flashx** | ✅ (`glm-5.3-flashx`) | ✅ (`glm-5.3-flashx`) | ✅ (`glm-5.3-flashx`) |
| 8 | **glm-5.3-flash** | ✅ (`glm-5.3-flash`) | ✅ (`glm-5.3-flash`) | ✅ (`glm-5.3-flash`) |
| 9 | **glm-5.3** | ✅ (`glm-5.3`) | ✅ (`glm-5.3`) | ✅ (`glm-5.3`) |
| 10 | **glm-5.2** | ✅ (`glm-5.2`) | ✅ (`glm-5.2`) | ✅ (`glm-5.2`) |
| 11 | **glm-5v-turbo** | ✅ (`glm-5v-turbo`) | ❌ | ❌ |
| 12 | **DeepSeek-V4.1-Flash** | ✅ (`DeepSeek-V4.1-Flash`) | ✅ (`deepseek-v4.1-flash`) | ✅ (`deepseek-v4.1-flash`) |
| 13 | **DeepSeek-V4-Flash-Official** | ✅ (`DeepSeek-V4-Flash-Official`) | ✅ (`DeepSeek-V4-Flash-Official`) | ✅ (`DeepSeek-V4-Flash-Official`) |
| 14 | **DeepSeek-V4-Pro-Official** | ✅ (`DeepSeek-V4-Pro-Official`) | ✅ (`DeepSeek-V4-Pro-Official`) | ✅ (`DeepSeek-V4-Pro-Official`) |
| 15 | **deepseek-V4-Pro** | ✅ (`deepseek-V4-Pro`) | ❌ *(已下线)* | ❌ *(已下线)* |
| 16 | **kimi-k3** | ✅ (`kimi-k3`) | ✅ (`kimi-k3`) | ✅ (`kimi-k3`) |
| 17 | **kimi-k2.8-preview** | ✅ (`kimi-k2.8-preview`) | ❌ | ✅ (`kimi-k2.8-preview`) |
| 18 | **kimi-k2.7-code** | ✅ (`kimi-k2.7-code`) | ✅ (`kimi-k2.7-code`) | ❌ *(已下线)* |
| 19 | **kimi-k2.6** | ❌ | ✅ (`kimi-k2.6`) | ❌ |
| 20 | **mimo-v2.6-pro** | ✅ (`mimo-v2.6-pro`) | ✅ (`mimo-v2.6-pro`) | ✅ (`mimo-v2.6-pro`) |
| 21 | **mimo-v2.6-flash** | ✅ (`mimo-v2.6-flash`) | ✅ (`mimo-v2.6-flash`) | ✅ (`mimo-v2.6-flash`) |
| 22 | **minimax-m3** | ✅ (`minimax-m3`) | ✅ (`minimax-m3`) | ✅ (`minimax-m3`) |
| 23 | **minimax-m2.7** | ✅ (`minimax-m2.7`) | ❌ | ❌ |
| 24 | **qwen3.8-max** | ✅ (`qwen3.8-max`) | ✅ (`qwen3.8-max`) | ✅ (`qwen3.8-max`) |
| 25 | **qwen-3.7-plus** | ✅ (`qwen-3.7-plus`) | ✅ (`qwen-3.7-plus`) | ✅ (`qwen-3.7-plus`) |
| 26 | **qwen3.8-flash** | ❌ | ❌ | ✅ (`qwen3.8-flash`) |
| 27 | **step-5-preview** | ✅ (`step-5-preview`) | ✅ (`step-5-preview`) | ✅ (`step-5-preview`) |

### 3. 命名与大小写差异对照

| 目标模型 | `trae` (ToB) 模型 ID | `trae-solo_work_lite` / `trae-chat_v3` 模型 ID | 兼容策略 |
| :--- | :--- | :--- | :--- |
| **豆包 2.1 Pro** | `Doubao-Seed-2.1-pro` (小写 pro) | `Doubao-Seed-2.1-Pro` (大写 Pro) | `normalizeModelName` 自动大小写兼容 |
| **豆包 2.1 Turbo** | `Doubao-Seed-2.1-turbo` (小写 turbo) | `Doubao-Seed-2.1-Turbo` (大写 Turbo) | 自动大小写兼容 |
| **DeepSeek V4 Pro** | `deepseek-V4-Pro` 与 `DeepSeek-V4-Pro-Official` | `DeepSeek-V4-Pro-Official` | 请求时自动映射底层 ID |
| **DeepSeek V4.1 Flash** | `DeepSeek-V4.1-Flash` | `deepseek-v4.1-flash` | 大小写自动不区分归一化 |

---

## 六、请求改写与参数适配 (Payload Transformation)

### 1. 请求体结构对比

#### (1) `trae` (ToB Raw Chat) 发送给上游的请求体
```json
{
  "stream": true,
  "config_name": "glm-5.2",
  "model": "glm-5.2",
  "function": "chat",
  "max_mode": true,
  "model_name": "glm-5.2__max",
  "conversation_id": "87e424cd-9a92-4e68-a7d6-7a9c46abf036",
  "session_id": "87e424cd-9a92-4e68-a7d6-7a9c46abf036",
  "mode_type": 0,
  "access_type": 4,
  "reasoning_effort_level": "extra_high",
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "hi" }
      ]
    }
  ]
}
```

#### (2) `trae-solo_work_lite` / `trae-chat_v3` 发送给上游的请求体
```json
{
  "stream": true,
  "config_name": "glm-5.2",
  "model": "glm-5.2",
  "function": "solo_work_lite", // 或 "chat_v3"
  "max_mode": true,
  "reasoning_effort_level": "extra_high",
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "hi" }
      ]
    }
  ]
}
```

### 2. 关键改写规则（防踩坑要点）

1. **`messages.content` 结构封装**：
   * 上游不接受原生 OpenAI 的单个字符串 content，必须封装为数组对象：
     ```json
     "content": [{ "type": "text", "text": "..." }]
     ```
2. **Tool Calls 结构改写**：
   * OpenAI 标准格式为 `tool_calls: [{ function: { name, arguments } }]`。
   * Trae 上游要求字段名必须为 `function_call`，且 `name` 不能为空。代码中需自动将 `function` 重命名为 `function_call`，并丢弃无 name 的非法项。
3. **连续 Assistant 消息合并（规避 4027 错误）**：
   * 如果用户请求中由于上下文截断或连续调用出现相邻的两个 `assistant` 角色消息，上游后端会报错 `Trae stream error (4027): param is invalid`。
   * 本系统在 `prepareRequestBody` 中自动将相邻的连续 assistant 消息的内容与工具调用深度合并为一条。
4. **思考深度映射 (`reasoning_effort`)**：
   * 客户端传入的 `reasoning_effort`（`low` / `medium` / `high` / `max`）会被映射为 Trae 上游识别的等级：
     * `low` / `light` $\rightarrow$ `light`
     * `medium` / `high` $\rightarrow$ `high`
     * `max` / `ultra` / `extra_high` $\rightarrow$ `extra_high`
   * 并注入到 `reasoning_effort_level` 字段中。

---

## 七、流式 SSE 协议与错误码分析

Trae 通道在请求上游时均必须强制设定 `stream: true`（非流式请求在服务端聚合）。

### 1. 上游 SSE 事件类型
* `event: chat_response`：标准文本块与 Reasoning 内容增量。
* `event: token_usage`：包含 `prompt_tokens`、`completion_tokens` 以及详细的 `reasoning_tokens`。
* `event: error`：上游错误事件，包含错误码及提示信息。

### 2. 常见上游错误码速查

| 错误码 | 错误表现 | 根因与规避策略 |
| :---: | :--- | :--- |
| **`4001`** | `We're sorry, the param is invalid.` | 请求体字段不匹配（如在 solo_work_lite 误发 ToB 的 `model_name`，或未传 `function`）。 |
| **`4023`** | `We're sorry, something went wrong.` | ① 目标模型不存在于当前通道；② 模型通道鉴权异常；③ 上游后端偶发故障。 |
| **`4027`** | `Param is invalid (consecutive assistant messages)` | 请求的 `messages` 列表中存在连续相邻的 assistant 角色消息。 |

---

## 八、号池管理与防呆机制 (Provider Pools)

在 `configs/provider_pools.json` 中，三个通道作为独立数组存储：

```json
{
  "trae": [
    {
      "customName": "ToB Raw Chat",
      "TRAE_OAUTH_CREDS_FILE_PATH": "./configs/trae/..._creds.json",
      "TRAE_CHANNEL_MODE": "tob_raw_chat",
      "TRAE_BASE_URL": "https://api.enterprise.trae.cn",
      "uuid": "bedb2578-5f2d-436a-ae5a-1541f5e7bee9",
      "checkModelName": "glm-5.2"
    }
  ],
  "trae-solo_work_lite": [
    {
      "customName": "SOLO Agent",
      "TRAE_OAUTH_CREDS_FILE_PATH": "./configs/trae/..._creds.json",
      "TRAE_CHANNEL_MODE": "solo_work_lite",
      "TRAE_BASE_URL": "https://trae-api-cn.mchost.guru",
      "uuid": "c5a78210-9b4f-4d1e-8e2a-7140bfe29aa1",
      "checkModelName": "deepseek-v4.1-flash"
    }
  ],
  "trae-chat_v3": [
    {
      "customName": "Chat v3",
      "TRAE_OAUTH_CREDS_FILE_PATH": "./configs/trae/..._creds.json",
      "TRAE_CHANNEL_MODE": "chat_v3",
      "TRAE_BASE_URL": "https://trae-api-cn.mchost.guru",
      "uuid": "d8b89321-1c5e-4e2f-9f3b-8251cfd30bb2",
      "checkModelName": "deepseek-v4.1-flash"
    }
  ]
}
```

### 1. 防呆错配校验 (`validateTraeProviderConfig`)
在 WebUI 保存或 API 更新提供商配置时，系统会自动执行严格的主机地址交叉校验：
* 禁止在 `trae` 节点上填写 `mchost.guru` 主机地址。
* 禁止在 `trae-solo_work_lite` / `trae-chat_v3` 节点上填写 `enterprise.trae.cn`（ToB 企业版）主机地址。
* 若用户显式声明 `TRAE_CHANNEL_MODE: "custom"`，则允许任意自定义反代域名。

### 2. 登录自动关联与 Host 透传
在执行 PAT 或 OAuth 登录时，若指定了自定义 Host（例如专有代理域名），该 Host 会沿着 `autoLinkProviderConfigs` 的配置链完整透传至新创建的节点属性 `TRAE_BASE_URL`，避免保存后仍被重置回硬编码默认地址。
