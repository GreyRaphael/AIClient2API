# 缓存命中率低：原因与解决方案

- 状态：当前有效
- 更新：2026-11-04
- 范围：`src/utils/usage-normalizer.ts`、`src/converters/utils.ts`、`src/providers/**`、`model-usage-stats` 插件
- 相关文档：[跨协议转译架构](./CROSS_PROTOCOL_ARCHITECTURE.md)、[Trae 通道指南](./TRAE_CHANNELS_UPSTREAM_GUIDE.md)

---

## 1. 结论速览

「缓存命中率只有约 30%」不是单一问题，而是**两件事叠加**：

| 成分 | 占比 | 性质 | 归属 |
|---|---:|---|---|
| 统计口径混用 | 约 1/3 | **数字失真**（并非真的低） | 网关，本次已修 |
| 真实前缀失效 | 约 2/3 | **真实 miss** | 主要是客户端请求形状 |

关键前提：**上游的缓存能力本身完全正常。** 绕过网关直连上游、使用稳定前缀时，命中率可达 98%–99.9%（实测 4K / 35K / 105K / 210K token 均如此）。所以问题不在上游，也不在「代理不支持缓存」。

---

## 2. 上游缓存的机制（理解原因的基础）

主流上游（Trae ToB、Gemini、OpenAI 兼容、Anthropic 等）用的是**隐式内容前缀缓存**：

- 缓存键 = **从 prompt 第 0 个 token 开始的内容前缀哈希**；
- 块粒度约 **256 token**（Trae ToB 实测最小可复用块为 4096，均表现为 256 的整数倍）；
- 与 `conversation_id`、账号、会话都**无关**——纯内容匹配。

由此推出一条决定性规则：

> **prompt 前部任何位置发生 1 个 token 的变化，该位置之后的全部内容都失去可复用前缀。**

历史越长、变化点越靠前，损失越大。命中率 ≈ 变化点之前的内容占全文的比例。

### 2.1 位置敏感性实测

同一份「每轮变化的动态内容」，只改变它出现的位置（trae，10 轮增长历史）：

| 动态内容位置 | 命中率 |
|---|---:|
| system **头部**（prompt 最前） | **0%** |
| system **尾部**（前缀内） | **14.4%**（历史涨到 50k 时仅 7.8%） |
| 移到**末条 user 消息** | **82.7%** |

这条曲线与生产实测吻合：生产 `trae` 的 `>50k` 请求命中 15.3%、`>200k` 约 7%。

---

## 3. 原因一：统计口径混用（数字失真）

### 3.1 缺陷

`src/utils/usage-normalizer.ts` 曾把两种**互斥语义**塞进同一个 `promptTokens` 字段：

```ts
const promptTokens = toNumber(
    record.prompt_tokens ??     // OpenAI / Responses：inclusive，已含缓存
    usage?.prompt_tokens ??
    usage?.input_tokens ??      // Anthropic：exclusive，不含缓存 ← 问题所在
    record.input_tokens ??
    usage?.promptTokenCount ??  // Gemini：inclusive
    ...
);
```

命中率 = `cachedTokens / promptTokens`：

- inclusive 行（OpenAI / Gemini / Responses）→ 分母含缓存，**比值正确**；
- exclusive 行（Anthropic Messages）→ 分母只有「未命中部分」，**比值虚高，可超过 100%**。

### 3.2 表现

同一上游缓存状态，只换下游协议：

| 下游协议 | 下游 usage | 页面显示 | 真实 |
|---|---|---:|---:|
| `/v1/chat/completions` | `prompt_tokens:3039, cached:2944` | 96.9% | 96.9% ✅ |
| `/v1/messages` | `input_tokens:607, cache_read:2432` | **400%** ❌ | 80.0% |

生产日志中 `trae` 有 **15.1%** 的行出现 `Cached > Prompt` 这种物理上不可能的值（其余 provider 为 0%，因为只有 Anthropic 形状的 usage 会以 exclusive 进入）。

链路说明：trae 走 1-Hop 直出时，`toAnthropicUsage` → `anthropicUsageFromInclusiveInput` **按 Anthropic 规范正确地**把 `input_tokens` 算成「总量 − 缓存」；问题出在下游的 normalizer 又把它当 inclusive 用了。

> 注意：口径 bug 主要造成个别行**假高**，整体上只影响约 −1.5pp。它不是「30% 偏低」的主因，但会严重干扰判断——让人误以为缓存"爆表"或"完全失效"。

---

## 4. 原因二：真实前缀失效（大头）

### 4.1 客户端把易变内容放在 prompt 前部

这是真实 miss 的**首要原因**。真实 agent 客户端（Claude Code 一类）常见的 system 结构：

```text
<静态指令 ... 数千 token ...>
<env>
Working directory: /repo
Platform: linux
Today's date: 2026-11-03      ← 每轮变
</env>
<git_status>
On branch main, 3 files modified   ← 每轮变
</git_status>
```

`<env>` / `<git_status>` 位于 system 尾部，即 **prompt 前缀内**。它们每轮变化 → 其后所有内容（全部历史对话）永久失去可复用前缀。

**修复方式（客户端侧）**：静态 system 恒定不变，把**所有易变信息放到最后一条 user 消息**里。

### 4.2 tools 顺序抖动

客户端（尤其 MCP 动态加载、多 sub-agent 并发组装）每轮给出的 tools 数组顺序可能不同。tools 位于 prompt 很靠前的位置，顺序一变 → 整段 miss。

实测（trae，10 个 tools，其余请求完全相同）：

| 场景 | 命中率 |
|---|---:|
| tools 顺序稳定 | 75.5% |
| tools **每轮乱序** | **18.0%** |

注意历史坑：`sortToolsByName` / 开关 `CONVERT_SORT_TOOLS`（默认 true）此前**只在 Converter strategies 内部被调用**。而 trae 走 1-Hop（`resolveBridgePlan` 对 trae 恒 `needsConversion=false`）、codex 走 0-Hop、zed 直通——这三条路径根本不进 Converter，**排序开关对它们静默失效**。本次已修复（见 §5）。

### 4.3 历史中间插入内容

在历史中间插入 `<system-reminder>`（时间戳、todo 状态等）：

| 场景 | 命中率 |
|---|---:|
| 基线（不插入） | 99.4% |
| 第 1 轮后插入 20 token 的 reminder | **31.8%** |
| 同样 reminder 放在末条 user 消息 | 99.3% |

插入点之后的整个后缀都失效；若 reminder 内容每轮变化，则**永久停在低值**，不会自愈。

### 4.4 长 prompt 的分段冷启动

大 prompt 首次调用天然只能吃到「上一档已建好的前缀」：实测 67k / 182k / 343k token 首次分别 cached 0 / 66944 / 182016，第二次同 prompt 才 100%。属上游特性，网关无从改善。

---

## 5. 解决方案

### 5.1 网关侧（本次已实施）

| # | 修复 | 位置 | 效果 |
|---|---|---|---|
| 1 | 直通路径补 tools 稳定排序 + schema 键序归一 | `converters/utils.ts` → `stabilizeToolsForPrefixCache()`，接入 `trae-core.ts` / `codex-core.ts` / `zed-payload-builders.ts` | 乱序命中率 **18.0% → 75.4%** |
| 2 | 统计口径按语义归一 | `utils/usage-normalizer.ts` | `cached > prompt` **15.1% → 0%** |
| 3 | Claude 路径删除透传的顶层 `system` | `trae-core.ts` | 消除与 `messages[0]` 的双写（`cache_control` 噪声） |
| 4 | 清理 `_` 前缀内部字段泄漏 | `trae-core.ts` | `_monitorRequestId` / `_requestBaseUrl` 不再发往上游 |
| 5 | `localeCompare` → 码点比较 | `converters/utils.ts:sortToolsByName` | 消除 locale/ICU 导致的跨机排序差异 |
| 6 | 新增 `sortJsonKeysDeep()` | `converters/utils.ts` | 消除 JSON 键序抖动导致的字节差异 |

**口径修复的核心逻辑**（`normalizeUsageCandidate`）：

```ts
// 判别子：顶层是否出现 cache_* 字段 = Anthropic exclusive
// 不能用「有没有 input_tokens」——Responses API 也给 input_tokens 但它是 inclusive
const topCacheRead = usage?.cache_read_input_tokens ?? record.cache_read_input_tokens;
const topCacheCreation = usage?.cache_creation_input_tokens ?? record.cache_creation_input_tokens;
const isAnthropicExclusive = topCacheRead !== undefined || topCacheCreation !== undefined;

// 统一成 inclusive（含缓存）总量，cached/prompt 才是跨协议可比的命中率
const promptTokens = isAnthropicExclusive
    ? rawPromptTokens + toNumber(topCacheRead) + toNumber(topCacheCreation)
    : rawPromptTokens;
```

> 注意下游消费者：`zed-core.ts:_formatClaudeUsage` 需要的是 **exclusive** 语义，因此它把缓存从总量中扣回（`input_tokens = total − cacheRead − cacheCreation`）。两者方向相反，改动时勿混淆。

### 5.2 客户端侧（必须由使用者配合）

网关**不应**擅自改写对话语义（例如剔除 `<env>`、重排历史消息），否则会污染模型输入。以下需由客户端/使用者处理：

1. **system 保持静态**：所有易变信息（日期、cwd、git status、随机 ID）放到**最后一条 user 消息**。
2. **不要每轮重排 tools**：排序能兜住「顺序抖动」，但兜不住「工具集本身增删」。
3. **不要把 `<system-reminder>` 插到历史中间**：放尾部。

---

## 6. 排查流程

发现某 provider/model 命中率偏低时，按以下顺序定位：

### 6.1 先确认是不是口径问题

检查日志中是否存在 `Cached > Prompt`：

```bash
grep "Request Finalized" logs/app-*.log \
  | grep -oE "Prompt: [0-9]+ .*Cached: [0-9]+" \
  | sed 's/Prompt: //' \
  | awk -F' \\| Completion: [0-9]+ \\| Total: [0-9]+ \\| Cached: ' '{if($2>$1)bad++;n++} END{printf "rows=%d impossible=%d\n",n,bad}'
```

- 有不可能值 → 该 provider 走了 Anthropic exclusive 语义，说明**旧版本未修复**，升级即可。
- 无误但仍低 → 进入下一步。

### 6.2 再确认是不是真 miss

**绕过网关直连上游**，用完全稳定的前缀连发数次：

- 若上游能到 90%+ → 网关发出的请求前缀在漂移，继续 §6.3；
- 若上游也很低 → 上游未启用缓存，或该模型不支持（如 `trae-chat_v3` 实测上游恒返回 `cache_read_input_tokens: 0`，该通道命中率不可测）。

### 6.3 定位请求形状

| 检查项 | 方法 |
|---|---|
| system 是否含易变内容 | 对比两次请求的 system 文本，看尾部是否有日期/状态 |
| tools 顺序是否每轮变化 | 抓取发往上游的 payload，对比 `tools[].function.name` 序列 |
| 历史中间是否插入内容 | 对比连续两轮 messages，看是否以「旧 messages 为前缀」 |
| 请求规模分布 | 按 total_in 分桶统计；长请求命中率显著更低即前缀失效的典型特征 |

### 6.4 已知的正常低命中情形（非缺陷）

| 情形 | 说明 |
|---|---|
| 短请求（< 2k token） | 未达到最小缓存块（约 4096），天然命中 0 |
| 每次请求内容都不同 | 无前缀可复用 |
| 长 prompt 首次调用 | 分段冷启动，第二次才命中 |
| `trae-chat_v3` | 上游不返回 `cache_read`，无法命中（结构性） |
| zed 账号异常期 | 账号被封（401）时请求本身失败，不产生缓存 |

---

## 7. 正确口径与验证方法

### 7.1 正确的命中率

统一用**含缓存（inclusive）**分母：

```text
命中率 = cachedTokens / promptTokens        // promptTokens 已含 cachedTokens
```

其中 Anthropic 形状需先把 `input_tokens + cache_read + cache_creation` 合成 `promptTokens`。修复后 `model-usage-stats` 页面的 `cached / prompt` 即为正确值，且 **Claude / OpenAI 两种协议可比**。

### 7.2 本次修复的验证数据

| 指标 | 修复前 | 修复后 |
|---|---:|---:|
| `cached > prompt` 行占比（trae） | 15.1% | **0%** |
| tools 每轮乱序命中率 | 18.0% | **75.4%** |
| Claude 协议显示 | 400%+（不可能值） | 69.5%（与 OpenAI 的 70–84% 一致可比） |
| 修复后真实流量（trae） | 14.9%–16% | **75.2%** |

---

## 8. 相关代码索引

| 功能 | 位置 |
|---|---|
| usage 归一化（口径） | `src/utils/usage-normalizer.ts` |
| tools 稳定化 + JSON 键序归一 | `src/converters/utils.ts`（`stabilizeToolsForPrefixCache` / `sortJsonKeysDeep`） |
| Trae 1-Hop 请求改写 | `src/providers/trae/trae-core.ts`（`prepareRequestBody`） |
| Codex 0-Hop 请求改写 | `src/providers/openai/codex-core.ts` |
| Zed 直通 payload 构建 | `src/providers/zed/zed-payload-builders.ts` |
| Anthropic 语义转换 | `src/converters/utils.ts`（`anthropicUsageFromInclusiveInput`） |
| 统计入库 | `src/plugins/model-usage-stats/stats-manager.js` |
| 桥接计划（判断是否走 Converter） | `src/handlers/request-pipeline.ts`（`resolveBridgePlan`） |