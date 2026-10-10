# Trae 双通道架构与上游技术规范详解

本文档详细记录了 AIClient2API 中字节跳动 **Trae** 提供商的双通道架构实现、上游协议机制、模型发现、请求参数差异及节点管理规范，为后续功能迭代和上游变更维护提供完整技术参考。

---

## 一、架构背景与演进

### 1. 历史渊源与项目背景
* **早期逆向与 trae2api-web**：最初社区对 Trae 的反代实现（如 `trae2api-web`）主要基于 Trae 的 **SOLO 个人版 Agent 接口**（即 `solo_work_lite` / `agent_v3` / `chat_v3`）。该接口打向 `https://trae-api-cn.mchost.guru`，主要用于 IDE 的端侧 Agent 协作。
* **企业版与原生 ToB Raw Chat**：随后 Trae 推出了企业版服务（`api.enterprise.trae.cn`），提供了原生的聊天端点 `/api/ide/v2/llm_raw_chat`（`function: "chat"`），支持更原生的企业模型调用与流式协议。
* **双通道独立决策**：在 AIClient2API 中，早先曾尝试在单一 provider 内混合两种模式，但由于两者的**上游 Host、请求 Header 指纹、请求体参数规范、可用模型清单及命名**均存在显著差异，混用容易引发风控拦截与配置混淆。因此重构为 **`trae`** 和 **`trae-agent_v3`** 两个完全独立的顶级提供商。

### 2. 深度剖析：`solo_work_lite`、`chat_v3` 与企业 `chat` 三者区别，以及为什么会有 `agent_v3`

在分析上游 Trae 协议时，必须厘清 **业务功能函数 (Function)** 与 **网络网关路由 (Endpoint Route)** 两个层面的概念：

#### (1) 上游真正同级的三大业务模式 (`function` 字段)

经对 Trae 上游网关实测抓取与调试，上游后端真实注册并运行的聊天业务 `function` 主要是以下三个同级项：

| 业务模式 (`function`) | 所属通道 / 主机 | 上游模型数 | 核心定位与业务特征 |
| :--- | :--- | :---: | :--- |
| **`solo_work_lite`** | 个人版 / mchost.guru | **46 个** | **SOLO 智能体轻量工作流**。<br>Trae 个人版 IDE 主打的全自主编程智能体 SOLO（类似于 Composer/Devin）的轻量化工作流。上游为此模式特化了 Agent 子智能体支持（如 `file_search_agent`、`explore_sub_agent_v2`、`computer_use_subagent` 等），专为代码辅助 Agent 设计。 |
| **`chat_v3`** | 个人版 / mchost.guru | **57 个** | **个人版侧边栏 Chat (第 3 代)**。<br>Trae 个人版 IDE 经典的侧边栏问答对话界面。是个人版中可用模型库最全的模式（除主流大模型外，还包含了 `qwen3.8-flash`、`Doubao_1_6`、`kimi-k2.8-preview` 等），并特化了 `fast_apply`（代码快速采纳）、`title_generation`（会话标题生成）、`input_optimization` 等对话衍生能力，底层走 `llm_raw_chat_v2` 管道。 |
| **企业 `chat`** | 企业版 / enterprise.trae.cn | **28 个** | **ToB 企业原生直连聊天**。<br>Trae 企业版专属服务。经过企业合规治理与审计，请求必须携带 Linux/PC 指纹、`x-flow-traceparent` 链路追踪以及 `access_type: 4`、`mode_type: 0`、`conversation_id`，且模型名称需补齐 `__max` / `__dev` 调度后缀。 |

#### (2) 为什么要有 `agent_v3`？它是和 `solo_work_lite` 同级的吗？

**结论：`agent_v3` 并不是上游的一个业务 `function`，它不能也不应该作为 `function` 的值传给上游。它是上游的 URL 路由路径层级！**

1. **实测验证**：
   * 在向上游 `POST /api/ide/v1/get_detail_param` 传入 `{"function": "agent_v3"}` 时，上游返回 `configs count: 0`。上游调度器中根本不存在名为 `agent_v3` 的功能函数。
2. **为什么项目中会叫 `agent_v3`？**
   * **URL 路径起源**：个人版对话接口在 Trae 网关上的完整路径为：
     ```
     https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat
     ```
     其中 `/api/agent/v3` 是字节 Trae 为 Agent 微服务集群划分的第 3 代网关路由层。
   * **项目命名的借用**：在早期 `trae2api-web` 及本系统开发过程中，为了将“走 `mchost.guru/api/agent/v3` 网关的通道”与“走官方企业端 `/api/ide/v2/llm_raw_chat` 的通道”进行清晰区分，开发者借用了 URL 中的路径片段 **`agent_v3`** 作为通道标识（Channel Mode）和 Provider 标识（`trae-agent_v3`）。
   * **实际运行映射**：
     虽然系统中的 Provider 叫 `trae-agent_v3`，但当它向网关 `/api/agent/v3/llm_utils_chat` 发起请求时，请求体中填入的真正业务功能函数其实是 **`function: "solo_work_lite"`**。

#### (3) 完整四者技术层级拓扑

```text
┌────────────────────────────────────────────────────────────────────────┐
│                        AIClient2API 顶层配置                           │
│  Provider: "trae" (企业版)          Provider: "trae-agent_v3" (个人版) │
└──────────────────────┬─────────────────────────────────┬───────────────┘
                       │                                 │
                       ▼                                 ▼
┌───────────────────────────────────┐ ┌──────────────────────────────────┐
│ 上游网络与网关路由 (Endpoint)     │ │ 上游网络与网关路由 (Endpoint)    │
│ Host: api.enterprise.trae.cn      │ │ Host: trae-api-cn.mchost.guru    │
│ Path: /api/ide/v2/llm_raw_chat    │ │ Path: /api/agent/v3/...          │
│                                   │ │       (即 agent_v3 路径由来)     │
└──────────────────┬────────────────┘ └──────────────┬───────────────────┘
                   │                                 │
                   ▼                                 ▼
┌───────────────────────────────────┐ ┌──────────────────────────────────┐
│ 上游真实业务功能 (Function Payload) │ │ 上游真实业务功能 (Function Payload) │
│ • function: "chat" (28 模型)      │ │ • function: "solo_work_lite"     │
│   (企业版原生，带 traceparent/max)│ │   (46 模型，当前默认采用)        │
│                                   │ │ • function: "chat_v3"            │
│                                   │ │   (57 模型，侧边栏对话特化模式)  │
│                                   │ │ • function: "chat" (29 旧版模型) │
└───────────────────────────────────┘ └──────────────────────────────────┘
```

#### (4) 三大业务功能核心指标深度对比表

| 维度 | `solo_work_lite` | `chat_v3` | 企业 `chat` |
| :--- | :--- | :--- | :--- |
| **所属上游主机** | `trae-api-cn.mchost.guru` | `trae-api-cn.mchost.guru` | `api.enterprise.trae.cn` |
| **上游对话接口** | `/api/agent/v3/llm_utils_chat` | `/api/agent/v3/llm_utils_chat` | `/api/ide/v2/llm_raw_chat` |
| **模型拉取接口** | `/api/ide/v1/get_detail_param` | `/api/ide/v1/get_detail_param` | `/api/ide/v1/batch_get_detail_param` |
| **拉取入参** | `{"function": "solo_work_lite"}` | `{"function": "chat_v3"}` | `{"functions": ["chat"], ...}` |
| **上游可用模型库** | 46 个配置项 | 57 个配置项（最全） | 28 个配置项（企业管控） |
| **Agent / 工具链特性** | 内置 subagent 占位符、支持复杂 Agent 工具调度 | 纯问答，不支持 subagent | 支持常规 function_call，无 subagent |
| **专有辅助能力** | 富上下文规划、poly_prompt 扩展 | `fast_apply`、`title_generation` | 企业链路审计、`x-flow-traceparent` |
| **请求体必需字段** | `config_name`, `model`, `max_mode` | `config_name`, `model`, `max_mode` | `model_name` (`__max`), `conversation_id`, `session_id`, `access_type: 4`, `mode_type: 0` |
| **在当前项目中的应用** | `trae-agent_v3` 默认使用的上游 Function | 可作为后续需求扩展引入的纯对话候选通道 | `trae` 专属使用的上游 Function |

---

## 二、两通道核心指标全景对比

| 维度 | `trae` (企业原生 ToB Raw Chat) | `trae-agent_v3` (SOLO Agent v3 / chat_v3) |
| :--- | :--- | :--- |
| **Provider 标识** | `trae` | `trae-agent_v3` |
| **通道模式 (`TRAE_CHANNEL_MODE`)** | `tob_raw_chat` | `agent_v3` |
| **默认上游 Host** | `https://api.enterprise.trae.cn` | `https://trae-api-cn.mchost.guru` |
| **对话补全端点 (Chat Endpoint)** | `/api/ide/v2/llm_raw_chat` | `/api/agent/v3/llm_utils_chat` |
| **模型拉取端点 (Models Endpoint)** | `/api/ide/v1/batch_get_detail_param` | `/api/ide/v1/get_detail_param` |
| **核心 Function 字段** | `"chat"` | `"solo_work_lite"` |
| **上游 App ID** | `7b3f9dc2-8a4e-5c6d-2f1b-9e4a3c5b7df0` | `6eefa01c-1036-4c7e-9ca5-d891f63bfcd8` |
| **IDE 版本指纹** | `0.208.1` (`20260908`) | `0.1.52` (`20260811`) |
| **设备类型指纹** | `X-Device-Type: linux`<br>`X-OS-Version: Linux 6.8.0`<br>`X-Device-Brand: PC` | `X-Device-Type: windows`<br>`X-OS-Version: Windows 11 Pro`<br>`X-Device-Brand: 83DG` |
| **专有请求头** | `x-ide-function: chat`<br>`x-flow-traceparent: 00-...` | *无额外 traceparent* |
| **对话上下文标识** | 必传 `conversation_id`, `session_id` | 无需上下文 ID |
| **专有请求参数** | `model_name` (如 `glm-5.2__max` 或 `__dev`), `mode_type: 0`, `access_type: 4` | 仅需 `config_name` 与 `model` |
| **可用模型数** | 25 个 | 25 个 |

---

## 三、认证与凭证生命周期

两个通道底层均共用 Trae 的账户授权凭证体系（即 `configs/trae/*_creds.json`）。

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

### 2. `trae-agent_v3` (Agent v3)
* **请求地址**：`POST https://trae-api-cn.mchost.guru/api/ide/v1/get_detail_param`
* **请求体**：
  ```json
  {
    "function": "solo_work_lite",
    "poly_prompt": true,
    "need_prompt": false,
    "config_names": null,
    "current_config_info": null,
    "mode_type": null,
    "agent_type": null
  }
  ```
* **解析逻辑**：直接提取响应中的 `data.config_info_list[]`。

### 3. 模型清洗与过滤机制（28 与 46 个上游配置如何过滤为 25 个可用模型）

经对上游接口数据逐项探测，上游原始返回的配置总数与 AIClient2API 最终呈现的 25 个模型存在以下过滤链路：

#### (1) `trae` (ToB Chat, 原始 28 个 $\rightarrow$ 最终 25 个)
* **原始返回 (28 个)**：包含 24 个正常业务大模型 + 4 个非活跃/辅助项。
* **过滤剔除 (4 个)**：
  1. `glm-5.1`：上游开关关闭 (`config_switch: false` / `is_invisible_to_user: true`)。
  2. `DeepSeek-V4-Flash`：上游开关关闭（ToB 端官方统一启用带后缀的 `DeepSeek-V4-Flash-Official`）。
  3. `summary`：内部摘要占位符，由 `excludedConfigNames` 集合拦截。
  4. `custom_model_placeholder`：自定义模型占位符，由 `excludedConfigNames` 集合拦截。
* **自动补齐 (1 个)**：
  * 系统在完成有效模型探测后，自动在模型列表首位追加了 `auto` 虚拟智能路由模型。
  * **计算式**：$28 - 4 + 1 (\text{auto}) = \mathbf{25\text{ 个}}$。

#### (2) `trae-agent_v3` (`solo_work_lite`, 原始 46 个 $\rightarrow$ 最终 25 个)
* **原始返回 (46 个)**：包含丰富但繁杂的 Agent 特化配置、外部自定义反代配置及开关关闭项。
* **过滤剔除 (21 个)**：
  1. **内部 Agent 占位符 (5 个)**：
     `computer_use_subagent`、`browser_use_subagent`、`file_search_agent`、`explore_sub_agent_v2`、`summary`。此类配置是 Trae IDE 端侧 Agent 用于调度特定子智能体（如电脑控制、浏览器控制、全局文件检索）的调度句柄，无法作为普通 LLM 对话模型使用。
  2. **自定义与外部映射模型 (13 个以 `custom_` 开头)**：
     `custom_model_gemini`、`custom_model_placeholder`、`custom_model_1M_text`、`custom_model_1M`、`custom_model_doubao_1M`、`custom_model_doubao_256k`、`custom_model_kimi`、`custom_model_claude`、`custom_model_gpt-6`、`custom_model_gpt-5`、`custom_model_no-fc`、`custom_model_deepseek_chat`、`custom_model_deepseek_reasoner`、`custom_model_deepseek_v4`。此类项是供用户在 Trae 设置中自定义外部 API Key/反代使用的配置壳，不属于 Trae 原生模型。
  3. **上游开关关闭项 (3 个)**：
     `seed-code-pro-0430`、`sagitta`、`aquila`（内部试验模型，`config_switch: false`）。
* **自动补齐 (1 个)**：追加 `auto` 虚拟路由模型。
* **计算式**：$46 - 5 - 13 - 3 + 1 (\text{auto}) = \mathbf{25\text{ 个}}$（与系统维护的基准模型集完全对齐）。

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
   * **第 2 代（个人版升级 SOLO 与 v3）**：推出了 `function: "solo_work_lite"`（46 个模型）专供 Agent，并升级了 `function: "chat_v3"`（57 个模型）作为新的侧边栏主面板。
   * **第 3 代（企业版独立重构）**：将架构迁移至 `api.enterprise.trae.cn`，企业端重新启用了 `function: "chat"` 命名，但后端模型已全面替换为 28 个现代化新版模型，并赋予了 `access_type: 4`、`mode_type: 0` 和 `__max` 调度后缀机制。

---

## 五、模型清单对比与差异矩阵

两个通道实测均返回 25 个模型，但存在**专属模型**与**命名大小写/后缀差异**：

### 1. 通道独有模型

| `trae` (ToB) 独有模型 | `trae-agent_v3` (Agent v3) 独有模型 | 说明 |
| :--- | :--- | :--- |
| `Doubao_1_6` | `glm-5` | 基础大模型版本差异 |
| `glm-5v-turbo` | `glm-5-turbo` | 视觉多模态 / 标准 Turbo 命名分化 |
| `minimax-m2.7` | `kimi-k2.6` | 旧版保留模型差异 |
| `kimi-k2.8-preview` | `DeepSeek-V4-Flash` | ToB 提供了 Kimi 2.8 预览，SOLO 则有基础版 Flash |

### 2. 命名与大小写差异对照

| 目标模型 | `trae` (ToB) 模型 ID | `trae-agent_v3` 模型 ID | 兼容策略 |
| :--- | :--- | :--- | :--- |
| **豆包 2.1 Pro** | `Doubao-Seed-2.1-pro` (小写 pro) | `Doubao-Seed-2.1-Pro` (大写 Pro) | `normalizeModelName` 自动大小写兼容 |
| **豆包 2.1 Turbo** | `Doubao-Seed-2.1-turbo` (小写 turbo) | `Doubao-Seed-2.1-Turbo` (大写 Turbo) | 自动大小写兼容 |
| **DeepSeek V4 Pro** | `deepseek-V4-Pro` 与 `DeepSeek-V4-Pro-Official` | `DeepSeek-V4-Pro` 与 `DeepSeek-V4-Pro-Official` | 同时注册两种写法 |
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

#### (2) `trae-agent_v3` (Agent v3) 发送给上游的请求体
```json
{
  "stream": true,
  "config_name": "glm-5.2",
  "model": "glm-5.2",
  "function": "solo_work_lite",
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

Trae 两个通道在请求上游时均必须强制设定 `stream: true`（非流式请求在服务端聚合）。

### 1. 上游 SSE 事件类型
* `event: chat_response`：标准文本块与 Reasoning 内容增量。
* `event: token_usage`：包含 `prompt_tokens`、`completion_tokens` 以及详细的 `reasoning_tokens`。
* `event: error`：上游错误事件，包含错误码及提示信息。

### 2. 常见上游错误码速查

| 错误码 | 错误表现 | 根因与规避策略 |
| :---: | :--- | :--- |
| **`4001`** | `We're sorry, the param is invalid.` | 请求体字段不匹配（如在 agent_v3 误发 ToB 的 `model_name`，或未传 `function`）。 |
| **`4023`** | `We're sorry, something went wrong.` | ① 目标模型不存在于当前通道；② 模型通道鉴权异常；③ 上游后端偶发故障。 |
| **`4027`** | `Param is invalid (consecutive assistant messages)` | 请求的 `messages` 列表中存在连续相邻的 assistant 角色消息。 |

---

## 八、号池管理与防呆机制 (Provider Pools)

在 `configs/provider_pools.json` 中，两个通道作为独立数组存储：

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
  "trae-agent_v3": [
    {
      "customName": "Agent v3",
      "TRAE_OAUTH_CREDS_FILE_PATH": "./configs/trae/..._creds.json",
      "TRAE_CHANNEL_MODE": "agent_v3",
      "TRAE_BASE_URL": "https://trae-api-cn.mchost.guru",
      "uuid": "c5a78210-9b4f-4d1e-8e2a-7140bfe29aa1",
      "checkModelName": "glm-5.2"
    }
  ]
}
```

### 1. 防呆错配校验 (`validateTraeProviderConfig`)
在 WebUI 保存或 API 更新提供商配置时，系统会自动执行严格的主机地址交叉校验：
* 禁止在 `trae` 节点上填写 `mchost.guru`（Agent v3）主机地址。
* 禁止在 `trae-agent_v3` 节点上填写 `enterprise.trae.cn`（ToB 企业版）主机地址。
* 若用户显式声明 `TRAE_CHANNEL_MODE: "custom"`，则允许任意自定义反代域名。

### 2. 登录自动关联与 Host 透传
在执行 PAT 或 OAuth 登录时，若指定了自定义 Host（例如专有代理域名），该 Host 会沿着 `autoLinkProviderConfigs` 的配置链完整透传至新创建的节点属性 `TRAE_BASE_URL`，避免保存后仍被重置回硬编码默认地址。
