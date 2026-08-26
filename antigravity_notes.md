# Antigravity 架构与 Gemini 3.7 模型映射及思考机制说明

本文档记录了关于 AIClient2API 中 Google Antigravity Provider 的模型发现、上游映射以及 Thinking（思考级别）处理机制的核心要点。

---

## 一、模型获取机制（GET 与 POST 的差异）

### 1. 客户端视角（RESTful GET）
客户端通过 OpenAI 协议的 `GET /v1/models` 或 Gemini 协议的 `GET /v1beta/models` 发起请求获取模型列表。

### 2. 上游 Antigravity 协议（RPC POST）
项目与 Google Antigravity 上游通信时，并不是简单的 HTTP GET 透传，而是基于 Google Cloud Code 内部 RPC 协议：
* **模型列表接口**：`POST https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels`
* **请求体**：携带 `{ project: projectId }`
* **处理链路**：
  1. 上游接口返回该项目支持的内部模型 ID 列表（例如 `gemini-3.7-flash-tiered`, `gemini-pro-agent` 等）。
  2. 本地通过 `expandAntigravityClientModels()` 进行模型展开和别名映射。
  3. 通过 `PROVIDER_MODELS` 白名单与 `ANTIGRAVITY_MODEL_METADATA` 元数据进行校验与参数补充（Token 限制、Thinking 级别等）。
  4. 最终组装为标准 OpenAI/Gemini 格式的 Model List 返回给客户端。

---

## 二、Gemini 3.7 系列模型映射机制

### 1. 上游真实标识符
Google Antigravity 官方后端对于 3.7 Flash 的真实内部模型 ID 为 **`gemini-3.7-flash-tiered`**（Tiered 代表分层/分级思考能力）。

### 2. 之前无法获取和调用的原因
* **上游名称假设错误**：此前代码将上游名称误设为 `gemini-3.7-flash-low`。
* **展开逻辑失效**：上游返回 `gemini-3.7-flash-tiered` 时，本地映射表找不到对应键，且白名单与元数据中未包含该模型，被过滤机制当作未知模型丢弃，导致 `GET /v1/models` 无法列出。
* **路由错误**：客户端直接请求 `gemini-3.7-flash` 时，因被转换为不存在的 `gemini-3.7-flash-low`，导致发往 Google 上游时抛出 400/404 错误。

### 3. 当前完整映射架构

| 客户端请求模型 (Client Model) | 映射到上游模型 (Upstream Model) | 生效 Thinking 级别 |
| :--- | :--- | :--- |
| `gemini-3.7-flash-low` | `gemini-3.7-flash-tiered` | `low` |
| `gemini-3.7-flash-medium` | `gemini-3.7-flash-tiered` | `medium` |
| `gemini-3.7-flash-high` | `gemini-3.7-flash-tiered` | `high` |
| `gemini-3.7-flash` | `gemini-3.7-flash-tiered` | `high` (默认) |
| `gemini-3.7-flash-tiered` | `gemini-3.7-flash-tiered` | `high` (默认) |

---

## 三、Thinking（思考级别）与参数处理机制

### 1. 模型名强制绑定机制
Antigravity Provider 在底层（`antigravity-core.js`）采用了**根据客户端模型名称强制设定 Thinking Level** 的策略：
* 代码查表 `ANTIGRAVITY_CLIENT_MODEL_THINKING_LEVEL` 获取模型对应的级别。
* 在组装上游 Payload 时，通过 `applyAntigravityClientModelThinkingLevel` **无条件覆盖** `payload.request.generationConfig.thinkingConfig.thinkingLevel`。

### 2. 为什么在 `/v1` 请求中传 `reasoning_effort`（如 `max`）会被忽略？
以如下请求为例：
```json
{
  "model": "gemini-3.7-flash-tiered",
  "messages": [{"role": "user", "content": "hello"}],
  "reasoning_effort": "max",
  "stream": false
}
```
该请求中的 `reasoning_effort` 会被忽略，最终以 `high` 级别执行，原因如下：
1. **转换层未匹配**：`OpenAIConverter.js` 中的 `modelSupportsThinking()` 未将 `gemini-3` / `tiered` 纳入匹配，转换阶段直接跳过了 `reasoning_effort` 字段。
2. **枚举值不合法**：Gemini 3.7 仅支持 `low`、`medium`、`high`，OpenAI 风格的 `max` 无法被合法识别。
3. **底层强制覆写**：由于请求模型是 `gemini-3.7-flash-tiered`，底层查表映射为 `high`，最终上游接收到的参数固定为：
   ```json
   {
     "thinkingConfig": {
       "thinkingLevel": "high",
       "includeThoughts": true
     }
   }
   ```

---

## 四、客户端调用最佳实践

在 `/v1/chat/completions` 或 `/v1/responses` 请求中，**推荐直接通过模型名称切换思考强度**，无需额外配置自定义参数：

```json
// 1. 低思考强度（Low Thinking）
{ "model": "gemini-3.7-flash-low", "messages": [...] }

// 2. 中思考强度（Medium Thinking）
{ "model": "gemini-3.7-flash-medium", "messages": [...] }

// 3. 高思考强度（High Thinking，默认推荐）
{ "model": "gemini-3.7-flash-high", "messages": [...] }
// 或
{ "model": "gemini-3.7-flash", "messages": [...] }
```

---

## 五、Web 前端 `notSupportedModels` 联动过滤机制

在前端「提供商池管理」中勾选的“不支持的模型”（`notSupportedModels`），现已与 `/v1/models` 和 `/v1beta/models` 端点完成联动：
* **单提供商模式**：若节点或配置中指定了 `notSupportedModels`，系统在组装模型列表时会自动将对应的模型剔除。
* **Auto 聚合模式**：当某个提供商类型下的所有有效节点均排除了某些模型时，`getAllAvailableModels()` 会自动从聚合结果中剔除这部分模型，确保客户端获取到的模型列表与前端配置严格一致。
