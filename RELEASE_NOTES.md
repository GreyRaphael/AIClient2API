# AIClient-2-API 发布说明 (v8.1.0)

> ## ✅ 本版本无破坏性变更
>
> **无需任何配置迁移、无需改动 `provider_pools.json`、公开 API 零改动。**
> 直接替换代码并重启即可。
>
> 本版本解决一个长期容易被误判的问题：**「缓存命中率只有约 30%」**。
> 经过对上游的对照实测，结论是——
>
> - **约 1/3 是统计口径失真**：命中率数字本身算错了（部分行甚至显示成 400%+）；
> - **约 2/3 是真实 miss**：但其中**网关可消除的部分已经修复**（tools 顺序抖动）。
>
> **核心证据**：绕过网关直连上游、使用完全稳定的前缀时，命中率可达
> **98%–99.9%**（4K / 35K / 105K / 210K token 均验证）。因此问题不在上游
> 不支持缓存，而在于发出去的请求前缀是否稳定。

---

## 一、两类根因

上游（Trae ToB、Gemini、OpenAI 兼容、Anthropic 等）使用的是**隐式内容前缀缓存**：
缓存键是从 prompt 第 0 个 token 开始的内容前缀哈希，块粒度约 256 token，
**与 `conversation_id`、账号、会话无关**——纯内容匹配。

由此推出一条决定性规则：

> **prompt 前部任何位置发生 1 个 token 的变化，该位置之后的全部内容
> 都失去可复用前缀。** 历史越长、变化点越靠前，损失越大。

### 1.1 原因一：统计口径混用（数字失真）

`src/utils/usage-normalizer.ts` 此前把两种**互斥语义**塞进同一个 `promptTokens`：

| 协议 | 字段 | 语义 |
|---|---|---|
| OpenAI / Responses / Gemini | `prompt_tokens`、`promptTokenCount` | **inclusive**（已含缓存） |
| Anthropic Messages | `input_tokens` | **exclusive**（不含缓存） |

由于命中率 = `cached / prompt`，Anthropic 形状的行**分母偏小、比值虚高**。
生产日志中 `trae` 有 **15.1%** 的行出现 `cached > prompt` 这种物理上不可能的值。

同一上游缓存状态，只换下游协议：

| 下游协议 | 下游 usage | 修复前显示 | 真实 |
|---|---|---:|---:|
| `/v1/chat/completions` | `prompt_tokens:3039, cached:2944` | 96.9% ✅ | 96.9% |
| `/v1/messages` | `input_tokens:607, cache_read:2432` | **400%** ❌ | 80.0% |

### 1.2 原因二：真实前缀失效

| 触发方式 | 实测影响 |
|---|---|
| 动态内容（`<env>`/git status/日期）放在 **system 尾部** | 命中率 **14.4%**（历史涨到 50k 时仅 7.8%） |
| 同一内容移到**末条 user 消息** | **82.7%** |
| **tools 每轮乱序** | 75.5% → **18.0%** |
| 历史中间插入 20 token 的 `<system-reminder>` | 99.4% → **31.8%** |

生产实测与上表吻合：`trae` 的 `>50k` 请求命中 15.3%、`>200k` 约 7%。

---

## 二、本次修复内容

### 2.1 统一缓存命中统计口径（`src/utils/usage-normalizer.ts`）

按「**顶层是否出现 `cache_*` 字段**」判别语义，把 exclusive 归一为 inclusive 总量：

```ts
// 判别子不能用「有没有 input_tokens」——
// Responses API 也给 input_tokens，但它是 inclusive 的
const topCacheRead = usage?.cache_read_input_tokens ?? record.cache_read_input_tokens;
const topCacheCreation = usage?.cache_creation_input_tokens ?? record.cache_creation_input_tokens;
const isAnthropicExclusive = topCacheRead !== undefined || topCacheCreation !== undefined;

const promptTokens = isAnthropicExclusive
    ? rawPromptTokens + toNumber(topCacheRead) + toNumber(topCacheCreation)
    : rawPromptTokens;
```

`totalTokens` 同步补齐，避免 `total < prompt` 的矛盾值。

**方向相反的配套修正**：`zed-core._formatClaudeUsage` 需要 Anthropic **exclusive**
语义，因此把缓存从总量中**扣回**（`input_tokens = total − cacheRead − cacheCreation`）。
两处方向相反，后续维护时勿混淆。

### 2.2 直通路径补齐 tools 稳定排序（收益最大）

**根因**：`sortToolsByName` 及其开关 `CONVERT_SORT_TOOLS`（默认开启）
**只在 Converter strategies 内部被调用**。而：

- `trae` 走 **1-Hop**（`resolveBridgePlan` 对 trae 恒 `needsConversion=false`）
- `codex` 的 `/v1/responses` 走 **0-Hop**
- `zed` 三协议**直通**

这三条路径**根本不进 Converter**，因此排序开关对它们**静默失效**——
这正是「tools 每轮重排 = 每轮冷启动」的根因。

**修复**：新增 `stabilizeToolsForPrefixCache()` 并接入三条直通路径：

| 文件 | 接入点 |
|---|---|
| `src/providers/trae/trae-core.ts` | `prepareRequestBody` 的 tools 归一化处 |
| `src/providers/openai/codex-core.ts` | 补完 `web_search` 之后 |
| `src/providers/zed/zed-payload-builders.ts` | 三处 tools 构建点（OpenAI / Gemini / Anthropic） |

该函数做两件事：
1. **按 name 稳定排序**（码点比较，不用 `localeCompare`——后者受进程 locale/ICU
   影响，同一份 tools 在不同机器上可能得出不同顺序，反而破坏稳定性）；
2. **对 `function.parameters` 递归归一 JSON 键序**，消除「同一份 schema、
   键插入顺序不同」导致的字节差异。

仅消除顺序抖动，**不改动任何语义**（数组元素顺序、字段值均保留）。

### 2.3 其他清理

- **`trae` 不再透传顶层 `system`**：该系统提示已由 `claudeRequestToTraeMessages`
  拍平进 `messages[0]`，顶层重复透传还会把客户端的 `cache_control:{type:'ephemeral'}`
  噪声带给上游（trae 不吃显式缓存）。
- **`trae` 清理 `_` 前缀内部字段泄漏**：`request-pipeline` 注入的
  `_monitorRequestId` / `_requestBaseUrl` 是可枚举赋值，会被 `{ ...requestBody }`
  浅拷贝带进上游 body。其余 Provider 均已显式删除，唯独 trae 遗漏。

---

## 三、新增文档

[`docs/CACHE_HIT_RATE.md`](docs/CACHE_HIT_RATE.md) —— 完整记录了：

- 上游隐式前缀缓存的机制与位置敏感性
- 两类根因的代码定位与实测数据
- 网关侧修复清单 + **客户端侧必须配合的三条约定**
- 排查流程（先判别口径 → 再直连上游确认真 miss → 最后定位请求形状）
- 正确口径公式、已修复项与「已知正常低命中情形」清单
- 相关代码索引

同步更新 [`docs/CROSS_PROTOCOL_ARCHITECTURE.md`](docs/CROSS_PROTOCOL_ARCHITECTURE.md)
第 5 节缓存约束与第 6 节文档入口。

---

## 四、验证

| 项目 | 结果 |
|---|---|
| `npm run typecheck` | **0 errors** |
| `npm test` | **85 suites / 862 tests 通过** |
| 既有失败 | 4 例（`phase3-providers` 的 Codex 超长工具名），已用 `git stash` 基线对照证明与本次改动无关 |
| `cached > prompt` 行占比 | **15.1% → 0%** |
| tools 每轮乱序命中率 | **18.0% → 75.4%**（与顺序稳定时的 75.6% 持平） |
| 真实流量复检 | `trae` 命中率 **75.2%** |
| 跨协议一致性 | Claude 与 OpenAI 两种下游协议的命中率恢复可比 |

---

## 五、升级建议

1. **无需配置迁移**：本版本不含破坏性变更，直接替换代码即可。
2. **重启服务**：使新的 `usage-normalizer` 与直通路径稳定化生效。
3. **观察命中率**：重启后 `model-usage-stats` 页面显示的 `cached / prompt`
   即为正确值，且 Claude / OpenAI 两种协议可比。
4. **若命中率仍偏低**，按以下顺序排查（详见 `docs/CACHE_HIT_RATE.md` §6）：
   - **客户端 system 是否静态**——把所有易变信息（日期、cwd、git status）
     移到**最后一条 user 消息**。这是最大头，实测 14.4% → 82.7%；
   - 历史中间是否插入了 `<system-reminder>` 等变化内容；
   - 客户端 tools 集合是否每轮**增删**（排序能兜住重排，兜不住增删）。

> **说明**：网关不会擅自改写对话语义（例如剔除 `<env>`、重排历史消息），
> 因为那会污染模型输入。这类信息应仅由客户端调整位置。

---

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)