# Google Antigravity 提供商架构与模型技术规范

- 状态：当前有效
- 更新：2026-11-05
- 范围：`src/providers/gemini/antigravity-core.ts`、`src/providers/provider-registry.ts`、`src/converters/thinking-budget.ts`

本文档详细记录 AIClient2API 中 Google Antigravity 提供商的最新技术实现规范，聚焦于前沿模型（Gemini 3.8+ 及 Claude 5.x+），阐述模型列表动态发现、黑名单过滤、模型名称路由、思考级别绑定与 `reasoning_effort` 剥离机制。

---

## 一、Model List 获取与过滤机制

### 1.1 上游 RPC 协议与端点架构
Antigravity 并不是对客户端 `GET /v1/models` 的简单透传，而是基于 Google Cloud Code / Cloud AI Companion 内部 RPC 协议：
- **请求端点**：`POST ${baseURL}/v1internal:fetchAvailableModels`
- **请求体**：携带 `{ "project": "<discovered_project_id>" }`（若尚未发现 projectId 则传空对象 `{}`）
- **认证方式**：OAuth2 Bearer Token（由 Google OAuth 凭据加载，过期自动刷新）
- **客户端指纹**：
  - User-Agent：`antigravity/cli/${clientVersion} linux/amd64`
  - ideType：`"ANTIGRAVITY"`，ideName：`"antigravity"`

### 1.2 多环境自动降级顺序 (`getBaseURLFallbackOrder`)
系统采用多环境容灾顺序，优先获取最新的前沿模型：
1. **`ANTIGRAVITY_BASE_URL`**（节点显式指定）：若用户在节点配置中声明了专有反代或端点，恒定优先使用该配置。
2. **`ANTIGRAVITY_BASE_URL_DAILY`** (`https://daily-cloudcode-pa.googleapis.com`)：默认首选 Daily 灰度环境，确保第一时间发现并调度最新的前沿模型（如 `gemini-3.8-flash` 等）。
3. **`ANTIGRAVITY_BASE_URL_PROD`** (`https://cloudcode-pa.googleapis.com`)：若 Daily 环境请求失败或不可达，自动无缝降级到 Production 正式环境。

### 1.3 候选集提取与黑名单过滤 (`fetchAvailableModels`)
上游返回的响应体主要包含 `models`（模型元数据字典）、`agentModelSorts`（分组排序）与 `imageGenerationModelIds`（图像生成模型）。

候选集提取与过滤算法如下：
1. **收集候选模型**：
   - 遍历 `agentModelSorts[].groups[].modelIds` 收集所有模型 ID；
   - 遍历 `imageGenerationModelIds` 收集图像生成模型 ID。
2. **黑名单过滤 (`isExcludedModel`)**：
   - **`-low` 过滤**：过滤掉包含 `-low` 的弱思考或过低档位模型，推动模型集向高推理质量收敛；
   - **`oss` 过滤**：过滤掉包含 `oss` 的开源模型（第三方权重实验模型），保证服务稳定性。
3. **去重收敛**：
   ```ts
   this.availableModels = [...new Set(candidateModels.filter((id) => !isExcludedModel(id)))];
   ```
4. **冷启动兜底基线**：
   若所有上游端点均无法连通，系统回退到 `provider-registry.ts` 声明的静态基线模型：
   - `gemini-3.8-flash-high`
   - `gemini-3.1-pro-high`（网关层自动重定向至 `gemini-pro-agent`）

### 1.4 模型元数据导出 (`getNodeModelMetadata`)
Antigravity 将档位固化在模型 ID 中，在上游不提供动态 effort 字段。因此导出的元数据呈现为：
- `display_name`：由上游 `displayName` 提供或本地首字母大写格式化；
- `context_length`：上游 `maxTokens`；
- `max_output_tokens`：上游 `maxOutputTokens`；
- `support_images`：根据 `supportsImages` 真实输出；
- **`support_efforts`**：**固定输出 `null`**（向客户端显式声明不支持动态 effort 协商，档位直接通过模型名称切换）。

---

## 二、前沿模型路由机制：Gemini 3.8+ 与 Claude 5.x+

本网关对 Antigravity 仅保留并优化新代际核心模型线：**Gemini 3.8+ 体系**与 **Claude 5.x+（Sonnet / Opus 5.5+）体系**。

### 2.1 Gemini 3.8+ 模型线与自动重定向
1. **模型 ID 泛型识别 (`isKnownAntigravityModel`)**：
   网关支持泛型正则 `/^(gemini|claude|gpt)-[a-z0-9]+([-.][a-z0-9]+)*$/i`，允许客户端无缝调用上游灰度推出的新模型（如 `gemini-3.8-flash-*`、`gemini-4-argon-*` 等）。
2. **上游标识重定向 (`resolveAntigravityUpstreamModel`)**：
   - 剥离客户端展示用的括号后缀（`model(displayName)`）；
   - Google 上游已将 `gemini-3.1-pro-high` 标记为 deprecated，代码自动将其映射重定向至真实端点 **`gemini-pro-agent`**。
3. **思考流式非流式回退 (`_shouldFallbackToNonStream`)**：
   - Gemini 原生模型在调用 `streamGenerateContent` 时，上游 SSE 响应默认不暴露 `thought` 思考文本；
   - 网关配置 `supportsStreamingThoughts: false` 与 `GEMINI_STREAM_THOUGHTS_FALLBACK: true`：
     - 当调用 `gemini-3.8-flash-high` 等带思考模型时，自动回退到非流式 `generateContent` 捕获完整思维链；
     - 本地即时合成符合 SSE 规范的流式 chunk 推送给下游客户端，既保留完整的思考过程，又满足客户端的流式交互协议。

### 2.2 Claude 5.x+ 系列专有支持（Sonnet 5.5 / Opus 5.5）
Google Antigravity 官方后端支持托管 Anthropic Claude 系列，网关针对 Claude 5.5+ 实施了多项关键架构对齐：

1. **命名空间映射**：
   客户端若传入 `gemini-claude-*`，网关在 `resolveAntigravityUpstreamModel` 中自动重写为原生的 `claude-*`（例如 `claude-sonnet-5-5-20261022`、`claude-opus-5-5-preview`）。
2. **Claude 5.5+ 分级思考体系 (`isClaude55`)**：
   - 判别规则：模型名称包含 `claude` 且包含 `5-5` 或 `5.5`；
   - **分级机制对齐**：传统 Claude 采用整数 token 预算（`thinkingBudget`），而 **Claude 5.5+ 在 Antigravity 上游全面转向与 Gemini 一致的 `thinkingLevel`（分级体系）**！
   - 自动注入：
     - 若模型以 `-medium` 结尾赋予 `thinkingLevel: "medium"`；
     - 若模型以 `-low` 结尾赋予 `thinkingLevel: "low"`；
     - 其余默认赋予最高强度 `thinkingLevel: "high"`；
     - 显式声明 `includeThoughts: true`，并**强制清理旧式的 `thinkingBudget`**。
3. **非空文本占位防护 (`normalizeAntigravityTextPart`)**：
   - Antigravity 的 Claude 后端严格要求所有 text 块必须为非空白文本（不能为纯空字符串或纯空格）。
   - 当遇到客户端生成的空文本块时，网关自动填充安全占位符 `.`（`ANTIGRAVITY_EMPTY_TEXT_PLACEHOLDER`），防止 Google 上游抛出 400 校验异常。
4. **敏感 Agent 身份指纹净化 (`sanitizeAgentFingerprint`)**：
   - Claude 5.5 与 Gemini 3.8 接入了 Google 严格的反滥用风控；
   - 网关在文本入站时，自动拦截并重写常见 Agent 的身份指纹（如 "You are Antigravity... by Google Deepmind" 改写为通用助理），防止触发 429 反滥用拦截。
5. **流式 SSE 原生支持**：
   - Claude 5.x 系列的上游 SSE 流原生携带思考块，因此直接走原生双向流式，不触发非流式回退。

---

## 三、`reasoning_effort` 剥离与档位绑定特性

### 3.1 为什么必须剥离 `reasoning_effort`？
在标准 OpenAI 协议（`/v1/chat/completions`）或 Responses 协议中，客户端常传入 `reasoning_effort`（如 `"low"`, `"medium"`, `"high"`, `"max"`）或 `reasoning.effort`。
但在 Antigravity 上游架构中：
1. **上游不支持请求体动态 effort 协商**：Google Cloud Code RPC 接口不接受 OpenAI 风格的 `reasoning_effort` 字段；
2. **思考档位完全固化在模型 ID 中**：Antigravity 是通过模型后缀（`-high` / `-medium` / `-low`）或特定模型 ID（如 `gemini-3.8-flash-high`）来声明思考强度的；
3. **防止冲突与 400 报错**：如果将客户端透传的 `reasoning_effort` 或跨协议转换器预先生成的通用 `thinkingConfig` 透传发给 Google 上游，极易触发上游 Schema 校验错误（如 unrecognized field 或 conflicting parameters）。

### 3.2 严格静默剥离机制 (`stripAntigravityReasoningEffort`)
在 `buildAntigravityPayload` 入口处，网关无条件执行深度剥离：
```ts
function stripAntigravityReasoningEffort(requestBody: DynamicPayload): boolean {
    if (!requestBody || typeof requestBody !== 'object') return false;

    let stripped = false;
    // 1. 剥离内部临时标记
    if (Object.prototype.hasOwnProperty.call(requestBody, '_rawThinkingEffort')) {
        delete requestBody._rawThinkingEffort;
        stripped = true;
    }
    // 2. 剥离客户端传入的 reasoning_effort / reasoning.effort
    if (stripRequestedReasoningEffort(requestBody)) stripped = true;

    // 3. 彻底删除下游转换层可能预填的 thinkingConfig
    if (requestBody.generationConfig?.thinkingConfig) {
        delete requestBody.generationConfig.thinkingConfig;
        stripped = true;
        if (Object.keys(requestBody.generationConfig).length === 0) {
            delete requestBody.generationConfig;
        }
    }
    return stripped;
}
```
**行为特征**：**静默剥离、不校验、不报错**。客户端传入任何形式的 `reasoning_effort` 均会被安全吸收，保证接口最大兼容性。

### 3.3 档位二次重构与精准注入
在剥离客户端的动态参数后，网关在 `buildAntigravityPayload` 终末阶段，根据模型本身的权威属性重新注入合规的思考参数：

| 目标模型分类 | 识别依据 | 注入的 `thinkingConfig` | 思考文本策略 |
| :--- | :--- | :--- | :--- |
| **带档位 Gemini 3.8+** | 模型以 `-high`, `-medium`, `-low` 结尾 | `thinkingLevel: "HIGH" / "MEDIUM" / "LOW"`<br>`includeThoughts: true` | 非流式捕获 + 本地 SSE 增量推流 |
| **Claude 5.5+ 系列** | 模型包含 `claude` 且含有 `5-5` 或 `5.5` | `thinkingLevel: "high" / "medium" / "low"`<br>`includeThoughts: true`（删除 `thinkingBudget`） | 原生流式直通 |
| **生图模型** | 模型名称包含 `image` | `includeThoughts: false`（清理图像配置外的冲突字段） | 不开启思考 |
| **标准无档位模型** | 无档位后缀 | 不注入 `thinkingConfig` | 默认标准输出 |

---

## 四、客户端调用最佳实践

### 4.1 推荐的模型选择方式
调用 Antigravity 提供商时，**强烈推荐直接通过模型 ID 切换思考强度**，无需在客户端配置任何 `reasoning_effort`：

```json
// 1. Gemini 3.8 高强度推理（默认推荐）
{
  "model": "gemini-3.8-flash-high",
  "messages": [{ "role": "user", "content": "实现一个高性能红黑树..." }]
}

// 2. Claude 5.5 Sonnet 高强度思考
{
  "model": "claude-sonnet-5-5-high",
  "messages": [{ "role": "user", "content": "设计微服务分布式事务架构..." }]
}

// 3. Gemini 3.8 中等思考强度
{
  "model": "gemini-3.8-flash-medium",
  "messages": [{ "role": "user", "content": "解释快速排序原理..." }]
}
```

客户端即便传递了 `"reasoning_effort": "max"` 或 `"reasoning_effort": "low"`，网关也会安全剥离并以模型 ID 本身的档位（如 `-high`）为准，完全杜绝调用报错。
