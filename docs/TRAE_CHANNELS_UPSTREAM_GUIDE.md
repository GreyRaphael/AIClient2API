# Trae 双通道架构与上游技术规范详解

- 状态：当前有效
- 更新：2026-11-05
- 范围：`src/providers/trae/trae-core.ts`、`src/providers/trae/trae-channel.ts`、`src/utils/proxy-utils.ts`、`src/converters/utils.ts`

本文档详细记录 AIClient2API 中字节跳动 **Trae** 提供商的双通道架构实现、上游协议规范、模型动态发现与过滤算法、请求体改写流水线、传输层单 Socket 亲和性以及流式响应解析规范，为功能迭代与上游协议维护提供权威参考。

---

## 一、架构背景与演进

### 1. 历史渊源与项目背景
* **早期逆向与 trae2api-web**：最初社区对 Trae 的反代实现（如 `trae2api-web`）主要基于 Trae 的 **SOLO 个人版 Agent 接口**（打向 `https://trae-api-cn.mchost.guru`），用于 IDE 的端侧 Agent 协作。
* **企业版与原生 ToB Raw Chat**：随后 Trae 推出了企业版服务（`api.enterprise.trae.cn`），提供了原生的聊天端点 `/api/ide/v2/llm_raw_chat`（`function: "chat"`），支持更原生的企业模型调用、链路追踪与流式协议。
* **双通道收敛决策**：在系统早期迭代中，曾尝试在单一 provider 内混合多种模式，但由于上游 Host、Header 指纹、参数规范及可用模型清单存在显著差异。系统将历史网关路径 `agent_v3` 彻底清除，并将原 `solo_work_lite` 通道代码从运行时完全移除（文档中保留其逆向协议分析作为技术归档），全面收敛聚焦于两大活跃通道：
  1. **`trae`**：企业版 ToB 原生直连通道（`tob_raw_chat`）；
  2. **`trae-chat_v3`**：个人版侧边栏 Chat 模式（`chat_v3`）。

### 2. 核心架构拓扑

```text
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              AIClient2API 顶层活跃配置                                 │
│  Provider: "trae"                                       Provider: "trae-chat_v3"       │
│  (企业 ToB 原生直连，支持 KV Cache 90%+)                 (个人版侧边栏 Chat 模式)        │
│  [注：原 trae-solo_work_lite 代码已精简清理，仅作为本文档上游协议归档参考]             │
└────────────┬──────────────────────────────────────────────────────────┬────────────────┘
             │                                                          │
             ▼                                                          ▼
┌─────────────────────────┐  ┌───────────────────────────────────────────────────────────┐
│ 上游网络与网关 (Endpoint)│  │ 上游网络与网关路由 (Endpoint)                             │
│ Host: enterprise.trae.cn│  │ Host: trae-api-cn.mchost.guru                             │
│ Path: /llm_raw_chat     │  │ Path: /api/agent/v3/llm_utils_chat                        │
└────────────┬────────────┘  └────────────┬─────────────────────────────┬────────────────┘
             │                            │                             │
             ▼                            ▼ (上游协议同构参考)          ▼
┌─────────────────────────┐  ┌─────────────────────────┐  ┌─────────────────────────┐
│ 上游真实业务功能 Payload │  │ 上游真实业务功能 Payload │  │ 上游真实业务功能 Payload │
│ • function: "chat"      │  │ • function:             │  │ • function: "chat_v3"   │
│   (28 模型，企业审计)   │  │   "solo_work_lite"       │  │   (57 模型，侧边栏对话) │
│                         │  │   (47 模型，代码已归档)  │  │                         │
└─────────────────────────┘  └─────────────────────────┘  └─────────────────────────┘
```

### 3. 个人版内部同构关系：`solo_work_lite` 与 `chat_v3`
上游个人版网关（`trae-api-cn.mchost.guru`）底层通过统一网关 `/api/agent/v3/llm_utils_chat` 提供服务（代码中统一由 `isSoloFamilyChannel` 识别）：
* 早期社区曾借用网关 URL 片段统称为所谓的 `agent_v3`，但实际上上游是通过请求体中的 `function` 字段严格分流的：
  * **`function: "chat_v3"`**：主打 IDE **侧边栏问答对话**，拥有最完整的主流模型库（含侧边栏特供的 `qwen3.8-flash`、`kimi-k2.8-preview` 等）与最高思考档位支持，并承接 `fast_apply` 等对话衍生功能；
  * **`function: "solo_work_lite"`**：主打端侧全自主智能体 **SOLO Agent**（类似 Devin/Composer 轻量工作流），上游为此挂载了复杂的 subagent 调度句柄（如 `file_search_agent`、`explore_sub_agent_v2`、`computer_use_subagent`）与特定代码模型（如 `kimi-k2.7-code`）；
* **收敛为 `trae-chat_v3` 的原因**：
  在引入 `extra_high` 思考准入过滤后，两个模式保留的旗舰思考大模型（GLM-5.3、DeepSeek-V4.1-Flash、Kimi-K3 等）完全一致，且 `chat_v3` 的接口纯粹无 subagent 冗余。系统因此收敛为 `trae-chat_v3`，下文保留 `solo_work_lite` 的协议规范以备查阅。

---

## 二、三通道核心指标全景对比

| 维度 | `trae` (企业原生 ToB Raw Chat) | `trae-chat_v3` (个人版侧边栏 Chat) | `solo_work_lite` (个人版 SOLO Agent, 协议归档) |
| :--- | :--- | :--- | :--- |
| **Provider 标识** | `trae` | `trae-chat_v3` | 原 `trae-solo_work_lite` *(代码已归档)* |
| **通道模式 (`TRAE_CHANNEL_MODE`)** | `tob_raw_chat` | `chat_v3` | `solo_work_lite` |
| **默认上游 Host** | `https://api.enterprise.trae.cn` | `https://trae-api-cn.mchost.guru` | `https://trae-api-cn.mchost.guru` |
| **对话补全端点 (Chat Endpoint)** | `/api/ide/v2/llm_raw_chat` | `/api/agent/v3/llm_utils_chat` | `/api/agent/v3/llm_utils_chat` |
| **模型拉取端点 (Models Endpoint)** | `/api/ide/v1/batch_get_detail_param` | `/api/ide/v1/get_detail_param` | `/api/ide/v1/get_detail_param` |
| **核心 Function 字段** | `"chat"` | `"chat_v3"` | `"solo_work_lite"` |
| **上游 App ID** | `7b3f9dc2-8a4e-5c6d-2f1b-9e4a3c5b7df0` | `6eefa01c-1036-4c7e-9ca5-d891f63bfcd8` | `6eefa01c-1036-4c7e-9ca5-d891f63bfcd8` |
| **IDE 版本指纹** | `0.211.1` (`ideVersionCode: 20260908`) | `3.4.4` (`ideVersionCode: 20261015`) | `0.1.52` (`ideVersionCode: 20260811`) |
| **设备类型指纹** | `X-Device-Type: linux`<br>`X-OS-Version: Linux 6.8.0`<br>`X-Device-Brand: PC` | `X-Device-Type: windows`<br>`X-OS-Version: Windows 11 Pro`<br>`X-Device-Brand: 83DG` | `X-Device-Type: windows`<br>`X-OS-Version: Windows 11 Pro`<br>`X-Device-Brand: 83DG` |
| **专有请求头** | `x-ide-function: chat`<br>`x-flow-traceparent: 00-...`<br>`x-session-affinity` | *标准客户端头 + 会话标识头* | *标准客户端头* |
| **会话上下文标识** | 必传 `conversation_id`, `session_id` | 必传 `conversation_id`, `session_id` | 支持 `conversation_id`, `session_id` |
| **专有请求参数** | `model_name` (`__max`/`__dev`), `mode_type: 0`, `access_type: 4`, `user_input` | `config_name`, `model`, `max_mode: true` | `config_name`, `model`, `max_mode: true` |
| **上游可用模型库** | 28 个原始配置 (过滤后 13 个思考模型) | 57 个原始配置 (过滤后 13 个思考模型) | 47 个原始配置 (过滤后 13 个思考模型) |
| **KV Cache 命中率表现** | **支持前缀缓存**（多轮综合命中率 **90%+**） | 上游恒返回 `0` | 上游恒返回 `0` |

---

## 三、认证与凭证生命周期

两个通道底层共用 Trae 的账户授权凭证体系（存储于 `configs/trae/*_creds.json`）。

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

## 四、模型发现机制 (Model Discovery) 与严格准入过滤

### 1. 模型列表接口调用

根据当前节点的通道模式，向对应上游接口发起 POST 请求：

#### (1) `chat_v3` (个人版侧边栏 Chat)
* **请求端点**：`POST https://trae-api-cn.mchost.guru/api/ide/v1/get_detail_param`
* **请求体**：
  ```json
  {
    "function": "chat_v3",
    "poly_prompt": true,
    "need_prompt": false,
    "config_names": null,
    "current_config_info": null,
    "mode_type": null,
    "agent_type": null
  }
  ```
* **数据提取**：从响应体 `res.data.config_info_list` 中获取模型配置项。

#### (2) `trae` (企业 ToB Raw Chat)
* **请求端点**：`POST https://api.enterprise.trae.cn/api/ide/v1/batch_get_detail_param`
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
* **数据提取**：遍历响应体 `res.data.function_configs[].config_info_list` 获取模型配置项。

#### (3) 附：`solo_work_lite` (个人版 SOLO Agent, 上游协议)
* **请求端点**：`POST https://trae-api-cn.mchost.guru/api/ide/v1/get_detail_param`（与 `chat_v3` 共享同端点）
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
* **数据提取**：从 `res.data.config_info_list` 中获取模型配置项（原始返回 47 个配置，曾包含专供自主 Agent 的子智能体调度句柄）。

### 2. 核心过滤流水线 (`fetchRemoteModels`)

代码通过两道严密规则对上游全量配置进行过滤，**天然排除**弱算力模型与内部辅助 subagent：

```ts
for (const item of allConfigs) {
    const id = item.config_name;
    if (!id) continue;

    const effortConfig = item.reasoning_effort_config;
    const rawOptions = Array.isArray(effortConfig?.options)
        ? effortConfig.options
        : (Array.isArray(effortConfig?.reasoning_effort_level_options) ? effortConfig.reasoning_effort_level_options : []);

    const normalizedOptions = rawOptions.map((opt) => String(opt || '').trim().toLowerCase());
    
    // 规则 1：思考档位必须包含 extra_high
    if (!normalizedOptions.includes('extra_high')) {
        continue;
    }

    // 规则 2：上游标记为用户不可见的配置不暴露
    if (item.is_invisible_to_user === true) {
        continue;
    }
    // ...通过准入，提取模型元数据
}
```

* **准入规则一：`options` 必须包含 `'extra_high'`**：
  * Trae 上游中，内部辅助/衍生 Agent（如 `summary`、`fast_apply`、`file_search_agent`、`explore_sub_agent_v2`）以及无深度思考能力的模型（如早期的豆包部分档位、Mimo 等）均不具备 `extra_high` 思考配置；
  * 此规则使得系统**无需硬编码排除列表**，即可自动化、纯净地仅保留具备最高思考推理能力的旗舰大模型。
* **准入规则二：`is_invisible_to_user !== true`**：
  * 剔除上游标记为废弃、内测或关闭的隐藏配置项。

### 3. 模型元数据提取规范
通过准入的模型，系统会提取以下权威属性并写入系统缓存：
1. **上下文窗口 (`context_window`)**：
   优先提取上游 Max 档位 `context_window_tokens.max`；若未显式提供则取 `dev` 或 `model_detail_list` 计算出的最大容量。
2. **最大输出 Token (`max_tokens`)**：
   从 `model_detail_list[].max_tokens` 所有变体中提取最大值。
3. **默认思考强度 (`default_reasoning_effort`)**：
   Trae 上游多数模型的 `default_level` 默认为保守的 `light`。代码通过 `resolveMaxStandardEffort` 动态优选最高档位，对外统一输出为标准层的 **`xhigh`**（对应上游 `extra_high`）。
4. **底层变体键名解析**：
   从 `model_detail_list` 中提取 Standard 档位（`__dev`，如 `glm-5.2__dev`）与 Max 档位（`__max`，如 `glm-5.2__max`），供后续发送请求时精确路由。

---

## 五、最新实测双通道思考模型对照表

通过上述严格准入流水线保留的双通道活跃思考模型清单如下（实测 ToB 13 个，chat_v3 13 个）：

| 序号 | 规范模型名称 | `trae` (ToB Raw Chat) | `trae-chat_v3` (侧边栏 Chat) | 支持的思考档位 | 特性与说明 |
| :---: | :--- | :---: | :---: | :---: | :--- |
| 1 | **glm-5.3-flashx** | ✅ `glm-5.3-flashx` | ✅ `glm-5.3-flashx` | `light, high, extra_high` | 极速思考增强 |
| 2 | **glm-5.3-flash** | ✅ `glm-5.3-flash` | ✅ `glm-5.3-flash` | `light, high, extra_high` | 极速推理 |
| 3 | **glm-5.3** | ✅ `glm-5.3` | ✅ `glm-5.3` | `light, high, extra_high` | GLM 旗舰思考模型 |
| 4 | **glm-5.2** | ✅ `glm-5.2` | ✅ `glm-5.2` | `high, extra_high` | 默认起点即为 `high` |
| 5 | **DeepSeek-V4.1-Flash** | ✅ `DeepSeek-V4.1-Flash` | ✅ `deepseek-v4.1-flash` | `light, high, extra_high` | 大小写自动归一化映射 |
| 6 | **DeepSeek-V4.1-Flash-1017**| ✅ `DeepSeek-V4.1-Flash-1017` | ❌ *(ToB 独有)* | `light, high, extra_high` | 企业版特供定制快照 |
| 7 | **DeepSeek-V4-Flash-Official** | ✅ `DeepSeek-V4-Flash-Official` | ✅ `DeepSeek-V4-Flash-Official` | `light, high, extra_high` | DeepSeek 官方直连版 |
| 8 | **DeepSeek-V4-Pro-Official** | ✅ `DeepSeek-V4-Pro-Official` | ✅ `DeepSeek-V4-Pro-Official` | `light, high, extra_high` | DeepSeek 旗舰官方直连版 |
| 9 | **kimi-k3.1-pro** | ✅ `kimi-k3.1-pro` | ✅ `kimi-k3.1-pro` | `light, high, extra_high` | Kimi 现代化旗舰代码思考模型 |
| 10 | **kimi-k3** | ✅ `kimi-k3` | ✅ `kimi-k3` | `light, high, extra_high` | Kimi 基础深度思考模型 |
| 11 | **kimi-k2.8-preview** | ✅ `kimi-k2.8-preview` | ✅ `kimi-k2.8-preview` | `light, high, extra_high` | Kimi 预览版思考模型 |
| 12 | **minimax-m3.1-flash** | ✅ `minimax-m3.1-flash` | ✅ `minimax-m3.1-flash` | `light, high, extra_high` | MiniMax 极速思考模型 |
| 13 | **qwen3.8-max** | ✅ `qwen3.8-max` | ✅ `qwen3.8-max` | `light, high, extra_high` | 通义千问 3.8 旗舰思考模型 |
| 14 | **qwen3.8-flash** | ❌ *(chat_v3 独有)* | ✅ `qwen3.8-flash` | `light, high, extra_high` | 个人版侧边栏专属极速模型 |

---

## 六、请求改写与参数适配 (Payload Transformation)

### 1. 双通道发送请求体对比

#### (1) `trae` (ToB Raw Chat) 最终 Payload 结构
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
  "user_input": "请帮我实现一个 LRU Cache",
  "reasoning_effort_level": "extra_high",
  "messages": [
    {
      "role": "user",
      "content": [{ "type": "text", "text": "请帮我实现一个 LRU Cache" }]
    }
  ]
}
```

#### (2) `trae-chat_v3`（及同构的 `solo_work_lite`）最终 Payload 结构
```json
{
  "stream": true,
  "config_name": "glm-5.2",
  "model": "glm-5.2",
  "function": "chat_v3", // 个人版 SOLO 模式则仅替换为 "solo_work_lite"
  "max_mode": true,
  "conversation_id": "87e424cd-9a92-4e68-a7d6-7a9c46abf036",
  "session_id": "87e424cd-9a92-4e68-a7d6-7a9c46abf036",
  "reasoning_effort_level": "extra_high",
  "messages": [
    {
      "role": "user",
      "content": [{ "type": "text", "text": "请帮我实现一个 LRU Cache" }]
    }
  ]
}
```
*注：个人版的两种模式在数据包协议上完全同构，仅区别于 `function` 字段（`"chat_v3"` 用于侧边栏对话，`"solo_work_lite"` 用于端侧 SOLO Agent 任务）。*

### 2. 核心改写流水线与防踩坑规则 (`prepareRequestBody`)

1. **私有字段深度清理**：
   遍历请求体，清理所有以 `_` 开头的网关内部标记（如 `_monitorRequestId`、`_requestBaseUrl`），防止向字节跳动上游泄露内部实现。
2. **多协议 1-Hop 入参归一**：
   * **OpenAI Responses 协议**：将 `instructions` + `input` 自动映射为 Trae `messages`，扁平 `tools` 映射为 Trae 嵌套 tools，删除 Responses 专有字段（`input`、`instructions`、`reasoning`）。
   * **Anthropic Messages 协议**：将 `system` 拍平插入 `messages[0]`，并**显式删除顶层的 `system` 字段**，杜绝与 `messages[0]` 双写产生重复指令，并消除 Anthropic 特有的 `cache_control` 噪声。
3. **思考深度严格映射 (`reasoning_effort_level`)**：
   * 客户端传 `xhigh` / `max` / `ultra` / `extra_high` $\rightarrow$ 映射为上游 `extra_high`；
   * 客户端传 `high` / `medium` $\rightarrow$ 映射为上游 `high`；
   * 客户端传 `low` / `light` $\rightarrow$ 映射为上游 `light`；
   * 客户端未显式传参时 $\rightarrow$ 自动优选当前模型支持的最高深度（默认 `extra_high`）；
   * 客户端传 `none` / `off` $\rightarrow$ 显式删除该字段，不触发思考。
4. **历史上下文思考残留清理**：
   在历史 `assistant` 与 `tool` 消息中，**删除 `reasoning_content`、`reasoning`、`thinking`**，确保发往上游的历史 prompt 不含动态变动的思考残留，保证前缀稳定性。
5. **消息结构与连续 Assistant 消息合并**：
   * `content` 数组化：上游严格要求 `content: [{ "type": "text", "text": "..." }]`；
   * **合并连续 Assistant 消息**：若上下文截断或工具执行出现连续相邻的 `assistant` 角色，上游会报错 `4027: param is invalid`。代码自动将连续 assistant 消息的内容与工具调用深度合并为一条。
6. **Tools 参数序列化与前缀缓存稳定化 (`stabilizeToolsForPrefixCache`)**：
   * **Go 结构体要求**：上游后端要求 `function.parameters` 必须为 JSON 序列化字符串；
   * **确定性稳定化**：Trae 走 1-Hop 直通，不经过 Converter strategies。代码在 Trae Provider 内部直接调用 `stabilizeToolsForPrefixCache`：
     - 按 `tools[].function.name` 进行码点确定性排序；
     - 递归深层排序 JSON Schema 键名。
     - **收益**：彻底消除客户端（如 MCP / 多智能体组装）每轮 tools 乱序导致的前缀缓存失效（命中率从 18% 提升至 75%+）。

### 3. 传输层单 Socket 亲和性与长连接池

为实现 90%+ 的 KV Cache 命中率与极低首字延迟，网络层实施了会话物理绑定：
1. **会话单 Socket Agent 缓存 (`singleSocketAgentCache`)**：
   在 `src/utils/proxy-utils.ts` 中，为每个会话维持独立的 `https.Agent({ keepAlive: true, maxSockets: 1 })`，以 `${nodeUuid}:${sessionAffinityId}` 为二级缓存键。
2. **链路追踪与亲和性 Headers**：
   * `x-flow-traceparent`: `00-${traceId}-${spanId}-01`。其中 `traceId` 与 `conversation_id` 强绑定（保持多轮会话恒定），`spanId` 每轮随机生成；
   * `x-session-affinity`、`session-id`、`x-conversation-id`：携带一致的会话指纹；
   * `x-request-id`、`x-client-request-id`：每轮随机生成独立的 UUID。
3. **物理连接复用**：
   同一会话的连续请求在操作系统网络层物理复用同一个 TCP Socket（日志可观测 `reused=true`），强制上游网关和 GPU 实例将请求精准路由至同一块已有显存 Cache 的节点。

---

## 七、流式 SSE 协议与响应解析

Trae 上游交互均强制使用 `stream: true`，服务端逐 chunk 解析并进行 1-Hop 渲染。

### 1. UTF-8 无损分块解码 (`StringDecoder`)
在上游响应的流式循环中，使用 Node.js 原生 `StringDecoder('utf-8')` 解码数据 chunk，保留不完整的末尾字节并在下一帧拼接，杜绝汉字多字节被 TCP 分包切割产生的乱码。

### 2. 上游 SSE 事件类型
* **`event: output`**（默认输出事件）：
  * `response`: 文本内容增量；
  * `reasoning_content`: 思考思维链内容增量；
  * `tool_calls`: 工具调用增量（若上游返回 `function_call`，网关自动归一化为标准 `function` 结构）。
* **`event: token_usage`**：
  * 返回当前轮次的 Token 用量：`prompt_tokens`、`completion_tokens`、`cache_read_input_tokens`（ToB 专属）、`reasoning_tokens`。
* **`event: error`**：
  * 上游抛出错误，包含 `code` 与 `message`。

### 3. 三协议 1-Hop 直出渲染器 (`createTraeStreamRenderer`)
根据下游请求协议，直接产出目标格式的 SSE 数据，不经中间转码：
* **OpenAI Chat**：格式化为 `chat.completion.chunk`；
* **OpenAI Responses**：格式化为 `response.output_item.added`、`response.content_part.delta` 等标准 Responses 事件；
* **Anthropic Messages**：格式化为 `message_start`、`content_block_delta`（`thinking_delta` 与 `text_delta`）、`message_stop`。

### 4. 常见上游错误码速查

| 错误码 | 错误表现 | 根因与规避策略 |
| :---: | :--- | :--- |
| **`4001`** | `We're sorry, the param is invalid.` | 请求体字段不匹配（如在 chat_v3 误发 ToB 的 `model_name`，或未传 `function`）。 |
| **`4023`** | `We're sorry, something went wrong.` | ① 目标模型不存在于当前通道；② 账号授权凭证失效（触发 401 凭证切换）；③ 上游后端偶发故障。 |
| **`4027`** | `Param is invalid (consecutive assistant messages)` | 请求的 `messages` 列表中存在连续相邻的 assistant 角色消息（网关已实现自动合并防御）。 |

---

## 八、号池管理与防呆机制 (Provider Pools)

在 `configs/provider_pools.json` 中，活跃通道作为独立数组存储：

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
* 禁止在 `trae-chat_v3` 节点上填写 `enterprise.trae.cn`（ToB 企业版）主机地址。
* 若用户显式声明 `TRAE_CHANNEL_MODE: "custom"`，则允许任意自定义反代域名。

### 2. 登录自动关联与 Host 透传
在执行 PAT 或 OAuth 登录时，若指定了自定义 Host（例如专有代理域名），该 Host 会沿着 `autoLinkProviderConfigs` 的配置链完整透传至新创建的节点属性 `TRAE_BASE_URL`，避免保存后仍被重置回硬编码默认地址。

---

## 九、前缀缓存与 KV Cache 特性对比

Trae 上游对缓存的支持因通道模式而异：

| 通道 | 前缀缓存支持 | `cache_read_input_tokens` 遥测 | 典型命中率 | 适用场景 |
| :--- | :---: | :---: | :---: | :--- |
| **`trae`** (企业 ToB) | **支持** | **真实返回** | **90%+**（长会话稳定复用） | 复杂多轮 Agent、深度代码排查与长文本推理 |
| **`trae-chat_v3`** (个人版) | 结构性未知 | 上游恒返回 `0` | 显示为 0% | 轻量个人对话、侧边栏单轮或短轮交互 |

`trae` (ToB) 在复杂 Agent 场景下实现高命中率的深度原理、前缀对齐、UTF-8 无损分包与单 Socket 亲和性机制，详见 [`docs/CACHE_HIT_RATE.md`](./CACHE_HIT_RATE.md)。
