# AIClient-2API 发布说明 (v8.3.0)

> ## ✅ 本版本无破坏性变更
>
> **无需配置迁移、公开 API 零改动。** `keepAlive` 与 `maxFreeSockets` 保持不变，
> 仅把 `maxSockets` 从「被会话 id 钉死为 1」改回可配置池（默认 64）。
> 若某上游确实要求单连接绑定 KV cache slot，仍可在 `provider_pools.json` 显式设 `"singleSocket": true`。

---

## 一、修复：会话亲和导致所有 provider 并发串行化

v8.2.0 引入的「每会话一个 `maxSockets:1` Agent」策略，实测**没有缓存收益**，却把并发串行化。

**实测数据**（真实网关，关闭环境代理使 socket 复用真实发生）：

| 场景 | 命中率 |
|---|---|
| 池大小 1 / 2 / 4 / 8 / 16 / 32 / 64 | 96.1%–99.4%，5 种池大小均值极差 **0.94 pp** |
| trae，亲和开 n=18 vs 关 n=16 | 中位数 **97.23% vs 97.23%（完全相同）** |
| 每轮强制全新 TCP 连接 | 仍有 **97.0%–99.5%** 命中 |
| 有无 `session-id` 头 | 98.14% vs 99.43%（噪声内） |

**同会话并发代价**：亲和开 ~6 000 ms vs 亲和关 **~1 800 ms（快 3.26 倍）**。

结论：命中由**字节相同的内容前缀**决定，与 TCP 连接/会话隔离无因果关系。改为按节点共享连接池，
保留 `keepAlive: true`（复用前提）与 `maxFreeSockets: 1`（限定空闲池）。

## 二、修复：连接池驱逐掐断在途流

旧实现缓存放不下时无条件 `agent.destroy()`，会掐断正在传输的响应，客户端收到**无 `[DONE]` 的截断流**。
现改为仅在没有在途 socket 时销毁，容量 100→256 并采用真正 LRU。

## 三、修复：环境变量代理劫持直连

直连分支未设 `axiosConfig.proxy = false`，axios 会读取 `http_proxy`/`NODE_USE_ENV_PROXY`
改写目标地址，导致 Keep-Alive 全部失效。

**但不能无条件关闭**：实测 codex 的 `chatgpt.com` 在该环境**只能经代理访问**，强制直连会使其 500。
因此改为按可达性判断（本机/私网/`NO_PROXY` 覆盖才强制直连）。

## 四、其他修复

- `invalidateKeepAliveAgents(uuid)` 此前**永远匹配失败**（键含会话后缀），导致轮换凭据后流量继续走旧连接 → 支持前缀批量失效
- 号池过载判定是**死代码**（`queueLimit` 默认 0 使 `queue.length >= 0` 恒真），并发时每轮丢弃亲和 → 与评分逻辑对齐
- `usage-normalizer` 混合形状重复计数（prompt 1400 → 1000）与伪造 total（1010 → 610）
- 移除无收益的会话→节点粘滞表 `_sessionNodeMap`：真实双账号号池实测粘滞 98.46% vs 轮询 98.39/98.46%，
  负载均衡反而从 49.7/50.3 改善到 **50.0/50.0**

## 五、代码简化

- 6 处重复的内部字段剥离逻辑收敛为 `stripInternalFields()` / `deleteInternalFields()`
- 4 处重复的 session 头注入收敛为 `buildSessionHeaders()`

## 六、验证

- 单元测试 **88 suites / 921 tests** 全绿
- `typecheck` / `typecheck:webui` / `check:imports` / `check:cycles` 全部 exit 0
- E2E **33/33**（8 个模型 × 11 项核心跨协议矩阵）
- 缓存命中率严格 A/B：原始 97.22% → 修复后 **99.87%**（未退化，反而更高）
