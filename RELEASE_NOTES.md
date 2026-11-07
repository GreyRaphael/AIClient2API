# AIClient-2API 发布说明 (v8.5.0)

> ## ✅ 无破坏性变更。**新增能力：按 token 售卖套餐（可选启用）。**
>
> 未设置套餐的 Key 行为与之前完全一致。

---

## 一、为什么需要这次改动

现有配额口径是**请求数**（`todayUsage >= dailyLimit`），且是**请求前检查、请求后记账**。
按 token 售卖时这两点都会导致亏钱：

```
t0  A.validateKey → todayUsage < L → 通过
t1  B.validateKey → todayUsage < L → 通过   ← A 还没记账
t2  A/B 完成 → todayUsage += 2
```

**超卖上界 ≈ 并发数 × 单请求 max_tokens。** 余额剩 1 token 时，一个 `max_tokens: 100000` 的请求也会放行。

## 二、设计：预扣 + 结算

```
请求进来
  ├─ 1. 预扣 reserve：转发前原子扣减（Node 单线程，同步块内检查+扣减无交错窗口）
  │     余额不足 → 429，此时才真正拦截
  ├─ 2. 转发上游
  └─ 3. 结算 settle：用真实 usage 校正
        实际 < 预扣 → 全额退还
        实际 > 预扣 → 补扣差额
```

**关于固定预扣额**：认证发生在请求体解析**之前**，此刻拿不到 `messages` / `max_tokens`。
可选方案只有「不预扣（退回超卖）」或「按固定额度预扣」。本版选后者：
默认预扣 20000 token（可用 `config.reserveTokensPerRequest` 配置），
结算时**未用完的部分全额退还**，用户不会多付钱，只是额度会被短暂占用。

## 三、套餐目录

**Token 数量**：1 亿 / 2 亿 / 5 亿 / 10 亿

**周期**：一周（+7 天）、一个月（**按日历月**，1 月 31 日 + 1 个月正确落到 2 月末而非 3 月 3 日）

**额外能力**：
- `dailyTokenCap` 每日速率保护（可选）——总量包建议强制，否则可能一天打光整月额度
- `validUntil` 绝对时间，避免"30 天"的相对歧义
- 续期从「现在」与「原到期时间」中较晚者起算，不损失剩余天数

## 四、账务安全细节

- **预扣立即落盘**（崩溃不丢已花的钱），结算走 5 秒防抖
- **拿不到 usage 时按预扣值计费**，否则客户端可构造无 usage 响应白嫖
- `tokenUsed` 与 `tokenReserved` 分开记，区分「已消费」与「在途」
- 预扣额通过每请求独立的 config 副本透传（`deepmerge({}, config)`），并发不会串扰

## 五、管理 API

```
GET    /api/potluck/plans              套餐目录
POST   /api/potluck/keys/plan          设置套餐 { keyId, packId, cycleId, dailyTokenCap? }
POST   /api/potluck/keys/plan/renew    续期 { keyId, cycleId? }
DELETE /api/potluck/keys/plan          移除套餐 { keyId }
```

## 六、验收（真实 store）

```
预扣 20000 → 结算 12000，退 8000  ×3         ✓
日上限 50000，用到 36000 时拒绝               ✓
60 并发 × 200 万 / 1 亿额度 → 成功 50 个       ✓
  在途预扣 100,000,000，剩余 0（精确无超卖）
```

- 单元测试 **90 suites / 939 tests** 全绿（含 15 个新用例）
- 核心不变量「并发预扣不超卖」已固化为测试

## 七、后续可选（未在本版实现）

- 缓存命中 token 折扣计价（当前按 `totalTokens` 全额计）
- 独立 billingLedger 与对账接口（当前依赖 `usageHistory`，仅保留 100 天）
- 套餐模板批量签发、用量预警
