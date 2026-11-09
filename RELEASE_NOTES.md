# AIClient-2API 发布说明 (v8.7.0)

> ## ⚠️ 本次含破坏性变更
>
> **Master 管理端点现在需要鉴权**，且默认只监听回环地址。
> 若你有脚本或运维流程直接调用 `/master/stop`、`/master/restart`、`/master/status`，
> 升级后会从 `200` 变成 `401`。迁移方式见文末「升级指南」。
>
> `/master/health` 保持公开，Docker 健康检查与探活配置**无需改动**。

---

## 一、安全修复

### 1. Master 管理端口完全暴露且无鉴权（Critical）

原实现 `server.listen(config.masterPort)` 监听所有网卡，CORS 为 `*`，五个管理端点全部无鉴权。
局域网内任意主机（或借浏览器发起跨站请求的外网网页）都能：

- `POST /master/stop` 直接关停网关 → 拒绝服务
- `GET /master/status` 读取服务器 PID 与内存占用 → 信息泄露

现在：

- 默认只绑 `127.0.0.1`（可用 `MASTER_HOST` 覆盖，容器场景设 `0.0.0.0`）
- 除 `/master/health` 外，所有端点要求 `Authorization: Bearer <secret>`
- CORS 只回显本机 Origin，不再返回通配 `*`

**凭据管理**：优先读 `MASTER_SECRET` 环境变量（需 ≥32 字符，过短会被忽略），
否则读 `configs/.master_secret`（首次启动自动生成 32 字节随机值，权限 `0o600`）。
首次生成时会在启动日志打印一次明文（便于 `docker logs` 获取），之后只打印文件路径。
该文件已加入 `.gitignore`，并从「下载全部配置」的备份 zip 中排除。

### 2. 插件沙箱可被异步事件循环穿透（Critical）

沙箱原本只靠调用栈判断「调用方是不是插件」。但异步边界会抹掉这段信息：

```javascript
// 插件把敏感操作包进定时器后，回调执行时栈上只剩 node:internal 帧
const steal = Function.prototype.bind.call(fs.readFileSync, null, '.env', 'utf8');
setTimeout(steal, 0);   // 检查被完全绕过，可读取 .env 与凭据文件
```

现在 `PluginManager` 在调用插件代码的唯一收口用 `AsyncLocalStorage` 标注插件身份，
上下文随异步资源（timer / microtask / nextTick / 预绑定函数）自动传播，
调用栈检查与异步上下文检查两条判据并存。实测三种逃逸手法全部拦截。

### 3. `/provider_health` 可能泄露凭据路径

`identify` 字段原先直接拼接 OAuth 凭据文件路径（含邮箱），而该端点无需鉴权。
改为 sha256 前 8 位短标识，既让同名兄弟节点可区分，又不泄露路径。

---

## 二、数据一致性修复

### 1. UI Token 并发丢失（High）

`saveToken` / `deleteToken` 是读-改-写，并发登录时后写者覆盖先写者。
**实测 6 个并发登录，最终只剩 1 个 token，丢 5 个。**

改为内存缓存 + 串行写队列：

- 写操作入队串行执行，落盘成功后才提交内存，调用方能感知真实失败
- 用文件 `(mtime, size)` 做失效判断 —— 因此「删 `configs/token-store.json`
  强制全员下线」这个运维手段**保持有效**
- `writeTokenStore` 不再吞掉写盘错误，登录接口能正确返回 500

> 注意：该队列是进程内锁，**不支持多实例共享同一 configs 目录**（跨进程需文件锁）。

### 2. 号池选点在脏数据下行为不确定

`calculateNodeScore` 在 `lastUsed` 为非法日期、`_lastSelectionSeq` 为非数值时返回 `NaN`，
而 `NaN` 参与比较恒为 `false`，会让排序比较器失去传递性：

- 可能选到明显更差的节点
- 极端情况下（全 NaN 池）线性扫描选不出任何节点 → `TypeError`

现在把 `NaN` 确定化为「最差」（等价 `+Infinity`）：既不漏选，也不会返回空。

---

## 三、可用性修复

| 问题 | 原行为 | 现行为 |
|---|---|---|
| 管理端口 `EADDRINUSE` | 整个网关无法启动 | 管理 API 降级禁用，worker 照常启动 |
| 空/畸形 `Host` 头 | `new URL()` 抛错 → 未鉴权即可制造 unhandledRejection | 兜底 `localhost` 并返回 400 |
| `restartCount` 永不重置 | 累计 10 次崩溃后永久放弃守护 | worker 上报 `ready` 时归零 |
| Master 未捕获异常 | 记录后继续（进程可能处于脏状态） | 明确「降级模式」；仅在 `MASTER_EXIT_ON_FATAL=1` 时才退出 |

> 关于最后一条：master 是 worker 的**唯一**守护者，而 `install-and-run.sh` / `npm start` /
> Dockerfile CMD 全部是裸 `node` 启动，仓库内没有 pm2 / systemd / Procfile。
> 若默认 `process.exit(1)`，master 退出会连带 worker 一起退出 = 整个网关永久下线。
> 因此默认改为降级存活，仅在运维显式声明有 supervisor 时才退出。

---

## 四、性能与代码质量

### 号池选点（10 节点实测 **10.28 → 5.30 µs，−48%**）

- 循环不变量外提：`cleanRequested` / `cleanRaw` / `getCustomModelRoutingCandidates`
  原先在每个节点的 `filter` 迭代里重算（含 Set 构造与全量遍历）
- 以一次线性扫描取代全量排序：`calculateNodeScore` 内含 `new Date().getTime()` 解析，
  原实现在 `sort` 比较器里被调用 O(N log N) 次

### 其他

- **策略工厂单例化**：5 个策略类经核实零实例字段，流式响应的每个 chunk 都会取一次策略，
  改为复用单例。用 `Object.hasOwn` 判定，避免 `__proto__` / `constructor` 等原型键命中
- **消除 `globalThis` 跨模块通信**：health check 定时器收敛到新模块
  `src/services/health-check-scheduler.ts`。直接互相 import 会形成运行时环
  （`check:cycles` 会拦下），故由双方共同依赖这个新模块
- `service-manager` 原型检查改用 `Object.hasOwn`；修正 `unhealthySummeryMessage` 拼写
  （新旧两个键双写，旧键标 `@deprecated` 保留一个发布周期）
- 清理 `convert.ts` 废弃的 `modelList` JSDoc 重载与 `api-server-core.ts` 注释残留

---

## 五、验证

| 项目 | 结果 |
|---|---|
| 单元测试 | **97 suites / 1015 tests** 全绿（基线 949，新增 66） |
| `npm run verify` | **exit 0**（typecheck / plugins / webui / check:strict / check:any / imports / cycles / lint:css / coverage / runtime 全 PASS） |
| 覆盖率 | `check:coverage` PASS；`src/core` 由 9.71% **升至 15.64%** |
| 全量 E2E | **26 passed / 1 skipped**，3 suites，exit 0 |
| 生图 E2E | **2 passed** — 文生图 200（968KB）、图生图 200（325KB） |
| 真实运行验证 | 真实启动 master，401 矩阵 6/6 正确；50 次畸形 Host → 50 个 400、0 未捕获异常 |

### 新增测试（7 文件 / 66 用例）

| 文件 | 用例 | 覆盖的关键回归 |
|---|---|---|
| `master-auth.test.js` | 21 | NBSP 绕过、空 secret、长度不等不挂起、CORS、畸形 Host |
| `plugin-sandbox-async-escape.test.js` | 1 | 三种异步逃逸手法（真实子进程 + 真实沙箱） |
| `token-store-concurrency.test.js` | 7 | 20 并发登录不丢、删文件即失效、写失败抛错 |
| `provider-pool-select-nan.test.js` | 13 | NaN / 全 NaN、并列 tie-break、custom model 过滤 |
| `health-check-scheduler.test.js` | 12 | reload 不泄漏、stop 幂等 |
| `provider-health-contract.test.js` | 8 | 新旧键双写契约 |
| `provider-strategy-factory.test.js` | 4 | 单例性、无状态不变式、原型键拒绝 |

各模块均做了**反向验证**：把有缺陷的实现打回代码确认测试会失败，
而不只是确认新测试能通过。

---

## 六、规模

```
16 个文件，+808 / −248
```

---

## 七、升级指南

### 如果你有脚本调用 Master 管理端点

```bash
# 1. 取得 secret（二选一）
docker logs <container> | grep -i "master secret"   # 首次生成时会打印一次
cat configs/.master_secret                           # 之后随时可读

# 2. 调用时带上
curl -H "Authorization: Bearer <secret>" http://127.0.0.1:3100/master/status
```

### 如果你需要在容器外访问管理 API

```bash
MASTER_HOST=0.0.0.0
# 并在 docker-compose.yml 中发布 3100 端口
```

默认 `docker-compose.yml` 未发布 3100，因此**默认部署不受监听地址变更影响**。

### 其他

直接 `git pull && npm ci` 并重启服务即可。无需配置迁移；
`configs/.master_secret` 会在首次启动时自动生成。

---

## 八、已知限制

- Token 存储的串行写队列是**进程内**锁，不支持多实例共享同一 `configs` 目录。
- `MASTER_SECRET` 环境变量优先级高于文件：若中途设置或撤销该变量，凭据会切换。
