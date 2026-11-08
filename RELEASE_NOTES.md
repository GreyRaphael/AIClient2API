# AIClient-2API 发布说明 (v8.6.0)

> ## ✅ 无破坏性变更、无配置迁移
>
> 直接 `git pull && npm ci` 并重启服务即可。本次为**清理与类型改进**，
> 不改变任何对外行为。

---

## 一、移除号池选点的冗余并发锁

`ProviderPoolManager` 用 `_selectionLocks` / `_isSelecting` 包裹 `selector.select()`，
但该函数是**纯同步**的（内部无任何 `async` / `await`）。Node 单线程下
「读状态 → 排序 → 写回」本身即原子，原锁里的 `await new Promise(setImmediate)` 轮询
**只会让每个并发请求多等至少一帧事件循环**。

移除后实测 **40 个并发混合 provider 请求：40/40 成功，4.9 秒**，无重复选点。

## 二、删除无调用方的死代码

| 删除项 | 外部引用 |
|---|---|
| `roundRobinIndex` | 0 |
| `findProviderByUuid()` | 0 |
| `isAllProvidersUnhealthy()` | 0 |
| `getProviderStats()` | 0 |
| `_providerTypeSupportsModel()` / `_getCustomModelRoutingCandidates()` | 0（纯透传） |
| `src/ui-modules/system-monitor.ts` | 0 |

每一项删除前都确认过没有任何调用方，不留悬空引用。

## 三、清理配置示例里的失效项

`configs/config.json.example` 移除：

- `providerFallbackChain` / `modelFallbackMapping` —— 引用的是 **v8.0.0 就已移除**的
  `claude-kiro-oauth`，源码里已无任何相关引用
- `SYSTEM_PROMPT_FILE_PATH` / `SYSTEM_PROMPT_MODE` / `SYSTEM_PROMPT_REPLACEMENTS` ——
  源码已不再读取

新部署不会再复制这些死配置。

## 四、类型债务改善

| 指标 | 变化 |
|---|---|
| `DynamicPayload` 引用 | **1549 → 1326（−14%）** |
| `any` 标注 | 回到基线 234（`check:any` 棘轮门禁绿） |

顺手修掉两处宽类型：
- 错误负载 `Record<string, any>` → 显式结构 + `unknown`（结构已知，只有上游透传的
  `details` 是任意形状）
- `(p: any)` → `(p: ProviderStatus)`

## 五、规模

```
44 个文件，+678 / −1442（净删 764 行）
```

## 六、验证

| 项目 | 结果 |
|---|---|
| 单元测试 | **90 suites / 949 tests** 全绿 |
| 静态门禁（12 项） | typecheck / plugins / webui / check:strict / **check:any** / imports / cycles / lint:css / metrics:types / gen:webui-html / vendor:webui / runtime —— **全部 PASS** |
| 覆盖率 | `test:coverage` exit 0，`check:coverage` PASS |
| **全量 E2E** | **33/33**（8 个模型 × 11 项核心跨协议矩阵），exit 0 |

## 七、附：补记 v8.3.0 – v8.5.0

本次一并补上了此前遗漏的 CHANGELOG 条目：

- **v8.5.0** —— 按 token 售卖套餐（1/2/5/10 亿 × 一周/一个月），预扣 + 结算防超卖
- **v8.4.0** —— 客户端错误返回 4xx、修复缓存统计 NaN、统计页按日/按模型视图
- **v8.3.0** —— 解耦 maxSockets 与会话亲和（单 socket 无缓存收益、并发快 3.26 倍）、
  修复驱逐掐断在途流、按可达性决定直连

详细变更见 `CHANGELOG.md`。
