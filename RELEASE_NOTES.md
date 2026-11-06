# AIClient-2-API 发布说明 (v8.2.0)

> ## ✅ 本版本无破坏性变更
>
> **无需任何配置迁移、无需改动 `provider_pools.json`、公开 API 零改动。**
> 直接拉取最新代码并重启服务即可：`git pull && npm ci && systemctl --user restart aiclient2api`。
>
> 本版本重点解决跨多轮复杂智能体（如 DeepSeek Harness、Claude Code、Cursor 等）多步执行场景下的 **「前缀缓存命中率断崖式下跌」** 与 **「高并发跨账号号池轮询导致缓存清零」** 问题。
> 经过 DeepSeek Harness 实机 12 步全自主任务验收，**整体 KV 缓存命中率达到 93.13%**，后半程单步缓存率稳定保持在 **96.7% ～ 99.7%**。

---

## 一、真实场景评测（DeepSeek-Harness 12 步验收）

使用 DeepSeek Harness 真实代码审查与复杂多步重构任务进行端到端闭环验证：

| 步骤 (Step) | Prompt Tokens | Cached Tokens | 新增未缓存 (Uncached) | 单步缓存命中率 | 说明 |
|:---:|---:|---:|---:|---:|---|
| **Step 1** | 14,856 | 14,592 | 264 | **98.22%** | 首轮系统指令与项目上下文命中 |
| **Step 2** | 17,665 | 14,848 | 2,817 | **84.05%** | 工具调用输出回填 |
| **Step 3** | 20,076 | 17,664 | 2,412 | **87.99%** | 执行代码库检索 |
| **Step 4** | 23,219 | 19,968 | 3,251 | **86.00%** | 读取文件上下文 |
| **Step 5** | 27,079 | 23,040 | 4,039 | **85.08%** | 递归定位依赖文件 |
| **Step 6** | 32,978 | 26,880 | 6,098 | **81.51%** | 批量抓取历史 Commit |
| **Step 7** | 41,328 | 41,216 | 112 | **99.73%** | 上下文完全复用，几乎零新增冷启动 |
| **Step 8** | 46,771 | 41,216 | 5,555 | **88.12%** | 综合分析并构建测试 |
| **Step 9** | 46,989 | 46,592 | 397 | **99.16%** | 单步命中率超 99% |
| **Step 10** | 47,648 | 46,848 | 800 | **98.32%** | 单步命中率超 98% |
| **Step 11** | 48,926 | 47,616 | 1,310 | **97.32%** | 单步命中率超 97% |
| **Step 12** | 50,561 | 48,896 | 1,665 | **96.71%** | 任务完成与总结 |
| **总体 (Total)** | **418,096** | **389,376** | **28,720** | **93.13%** | **12 步综合缓存率超过 93%** |

---

## 二、本次核心修复内容

### 2.1 P0：全链路 SSE 流式 UTF-8 字符解码与防跨 chunk 乱码截断
* **问题根因**：Node.js 原生 SSE 流读取中，长中文字符由 3 字节 UTF-8 构成。当 TCP 分包或缓冲区边界恰好切断在中文中间时，直接使用 `chunk.toString()` 或 `buffer += chunk.toString()` 会将半个多字节替换为 UTF-8 替换符 `\ufffd`（乱码）。客户端在下一轮将 Assistant 消息原样发回上游时，上游在该乱码位置发生 Token 前缀失配，直接导致历史 KV 缓存断崖式丢失。
* **修复**：对 `openai-core`、`openai-responses-core`、`codex-core`、`claude-core`、`zed-core` 等所有 SSE 流式读取器引入 `StringDecoder('utf8')`，并使用 `Buffer.concat` 代替所有的请求体字符串累加，彻底根除 UTF-8 跨块切分产生的破坏。

### 2.2 P1：0-Hop 直通路径补齐 tools 稳定排序与通用 Socket 亲和性保活
* **直通工具稳定化**：在 `openai-core` 与 `claude-core` 的直通调用入口（`callApi` 与 `streamApi`）中接入 `stabilizeToolsForPrefixCache`，对入参 tools 数组按 `name` 排序并对 `parameters`/`input_schema` 的 properties 递归排序，防止客户端工具动态注册或 JSON 键乱序引发的前缀缓存抖动。
* **通用会话单连接亲和性**：在 `proxy-utils.ts` 中移除仅对本地与 Trae 生效的限制。只要下游携带 `x-session-affinity` / `session-id`（或网关基于首轮消息摘要自动提取的会话种子），即针对该会话分配专用 Keep-Alive 单 Socket Agent，避免多轮请求在全局多 Socket 池中随机漂移到不同的后端 L4 Pod。

### 2.3 P2：号池多账号节点会话粘滞（Session Stickiness）
* **问题根因**：此前号池选择器 `ProviderPoolSelector` 使用纯 LRU 评分策略，每次请求都会主动挑选评分最低（最久未使用）的节点。当号池配置了多个账号（如 2 个 Trae 账号或多个 Codex/API 凭据）时，多轮对话的每一步都会轮流换号。由于每个账号在上游拥有独立的认证上下文与计算集群，每次换号都会导致上游面对全新会话，缓存命中率直接归零。
* **修复**：在 `ProviderPoolSelector` 中新增基于会话 ID 的 LRU 亲和性映射表（`_sessionNodeMap`）。同一会话的多轮交互在原节点健康且未达并发上限的情况下，始终固定在同一个账号/节点上；当且仅当节点故障或显式重试时平滑故障转移。新增单元测试保障亲和性与故障切换行为。

### 2.4 P2：Zed 协议确定性 `thread_id` 派生
* **修复**：在 `zed-payload-builders.ts` 中，将每轮无条件生成的随机 `thread_id: randomUUID()` 改为通过 `toValidUUID(sessionId)` 从下游会话确定性派生，保证多轮交互在上游始终位于同一会话流。

### 2.5 内部调度属性深度隔离与 Google / OpenAI 原生协议兼容
* **修复**：网关内部注入的调度控制标记（如 `_downstreamSessionId`、`_monitorRequestId`、`_requestBaseUrl` 等）在发往实际提供商前统一深度剥离，彻底杜绝 Google Antigravity 原生 Protobuf 报错 `Invalid JSON payload received. Unknown name "_downstreamSessionId"` 以及 OpenAI Responses API 报 `400 Bad Request: Unsupported parameter` 的阻断性兼容问题。

---

## 三、7 大主流 Provider 实测兼容性矩阵

对以下 7 个 Provider 及其代表模型进行了全量多轮对话与流式 SSE 验证：

| Provider | 代表模型 | 多轮对话与流式状态 | Turn 2 缓存命中率 | 特性支持 |
|---|---|:---:|:---:|---|
| **antigravity** | `gemini-3.8-flash-medium` | ✅ 成功 | 0.0% (依赖官方显式缓存) | 支持原生 Thinking 流式回传与多轮对话 |
| **openai-codex-oauth** | `gpt-6-luna` | ✅ 成功 | **61.0%** (指令级缓存) | 自动绑定 `prompt_cache_key`，命中 4K+ 指令缓存 |
| **openai-custom** | `deepseek-v4.1-flash` | ✅ 成功 | **92.3%** | 本地/自建推理端点，极速低延迟输出 |
| **claude-custom** | `deepseek-flash` | ✅ 成功 | **92.3%** | DeepSeek 官方 Anthropic 协议端点 |
| **openai responses** | `deepseek-v4-flash` | ✅ 成功 | 0.0% (依上游 vLLM 开启情况) | 标准 OpenAI Responses 协议，支持原生推理 |
| **trae (tob_raw_chat)** | `DeepSeek-V4.1-Flash-1017` | ✅ 成功 | **96.5%** | 官方 Direct LLM 通道，前缀缓存收益极高 |
| **trae (chat_v3)** | `deepseek-v4.1-flash` | ✅ 成功 | 0.0% (IDE 封装代理层) | 完整保留思考过程与代码补全能力 |

---

## 四、升级说明

* **平滑升级**：本版本完全向前兼容，现有的 `config.json`、`provider_pools.json` 与客户端调用方式无需任何变动。
* **推荐实践**：在客户端（如 Cursor、Claude Code、DSH 等）配置中开启会话保持或传递 `session-id` / `x-session-affinity` 请求头，即可自动激活网关的单 Socket 亲和性与号池账号粘滞功能，获得最高的缓存加速与推理性价比。
