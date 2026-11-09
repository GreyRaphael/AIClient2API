# AIClient-2API 发布说明 (v8.8.0)

> ## ⚠️ 本次含破坏性变更
>
> **插件不再在运行时被隔离**。原先的「插件沙箱」实际拦不住任何东西，
> 却给出了错误的安全预期；现在明确改为「插件与主进程同权限」。
> 若你安装了第三方插件，请阅读下方「升级指南」。

本次发布基于对 v8.7.0 的全量代码审计（157 项发现）做定向修复，
重点不是加功能，而是修掉**真实缺陷**、移除**无效防护**、收敛**已漂移的重复实现**。

---

## 一、两个真实缺陷（会导致用户看到错误结果）

### 1. 流式响应重复输出

`openai-core` / `openai-responses-core` / `claude-core` 的流式实现在遇到
429、5xx 或网络中断时，会**从头重跑整个上游请求**。如果上游先吐了 N 个 chunk
再断连，客户端收到的是「前半段 + 完整重放」——表现为重复文本、错位，或出现
第二个 `message_start` / `response.created`。

值得一提的是：`antigravity-core` 早就修过同类问题，并且留了注释解释这个坑。
但那次修法只落在一个 provider 上——因为另外五个是从它复制出来的。
**这正是复制粘贴式重复的真实代价。**

三个 core 现已加入 `hasYielded` 守卫，且刻意放在 `catch` 的**最前面**，
早于所有重试分支——放在 429 分支之后仍会漏掉 429 场景。

### 2. Codex OAuth 授权后仍报「会话已过期」

回调服务器给了 **10 分钟**的授权窗口，但会话轮询循环写死 `100 × 3s = 5 分钟`，
到点直接删除会话。

于是用户在**第 6–9 分钟**完成授权时：浏览器正常显示「授权成功」，
后台却抛出 `Invalid or expired OAuth session`。授权实际已完成，却被告知失败。

现在两个数字由同一个常量推导，不可能再漂移。

---

## 二、两个静默的数据/资源问题

### 3. 号池状态写盘失败会丢数据

`ProviderPoolPersistence.flush()` 在**写入之前**就清空了待保存集合，
而失败分支只记一行日志。一次磁盘满、权限错误或锁超时，就会让这批状态变更
**永久消失且不再重试**——内存里改了，磁盘上没有，用户以为保存成功了。

改为写成功后才移除，失败时重新入队。

### 4. Codex 适配器每次配置重载泄漏一个定时器

构造函数启动了一个 15 分钟的缓存清理 `setInterval`，但对应的停止方法
**没有任何生产代码调用**，而销毁路径只是把对象引用删掉。

每次在控制台保存并重载配置，就泄漏一个定时器 + 一份会话缓存。
现已补上 `dispose()` 生命周期契约，并给定时器加 `unref()` 兜底。

---

## 三、两处凭据外泄面

### 5. `configs/.master_secret` 可被读取

`/api/upload-configs/view`、`download`、`delete`、`force-expire` 四个端点
只校验「路径在 configs/ 目录下」，因此：

```
GET /api/upload-configs/view/configs%2F.master_secret
```

会直接返回 **Master 管理端口的 Bearer 密钥明文**。

值得注意的是：备份 zip 端点**已经**显式排除了同一个文件——说明威胁模型是清楚的，
只是这几个单文件端点漏了。这类"同一策略只落实了一半"的问题，审计里反复出现。

### 6. 凭据文件前 100 字节随列表接口返回

配置列表接口带了一个 `preview` 字段，返回每个凭据文件的**前 100 个原始字节**。
对 `configs/codex/*.json` 而言，这 100 字节正好落在 `id_token` 的 JWT header 内。
该字段在前端**零消费者**——纯属多余暴露，已删除。

> 这两处都需要管理端登录令牌，属于纵深防御不一致而非未认证暴露；
> 但修复成本各只有几行，已一并处理。

---

## 四、主要设计变更：移除无效的插件沙箱

这是本次唯一的破坏性变更，也是审计中最值得说明的一项。

原 `security-hardening.ts`（1093 行、85 处 monkey-patch）通过调用栈 + 
`AsyncLocalStorage` 判断「调用方是不是插件」，据此拦截 `fs` / `net` / `vm` / 
`child_process`。

**实测结果**：

| API | 是否被拦截 |
|---|---|
| `net.connect` | ✅ 拦截 |
| `net.Socket.prototype.connect` | ❌ **可绕过** |
| `vm.runInThisContext` | ✅ 拦截 |
| `vm.compileFunction` | ❌ **可绕过** |
| `fs.existsSync` | ❌ 未覆盖 |

只封了模块级入口，prototype 路径和 `vm.compileFunction` 完全敞开。
也就是说：**实际没有任何隔离，但代码和日志都宣称有**——这比没有防护更危险，
因为它让运维错判了第三方插件的风险。

代价方面：`fs.statSync` 实测从 105ms/20k 次劣化到 **787ms**（7.5×），
静态文件服务 3.5×，而这是每条日志都要走的路径。

更讽刺的是，该文件自身覆盖率是 **0/618 行**：那些「为避免拉低分支覆盖率而
刻意写成无 if 形式」的注释，保护的是一个从未被测试的文件。

**结论与处理**：同进程的 JS 插件无法用 monkey-patch 沙箱化，这是语言特性而非实现问题。
删除运行时补丁，保留真正有价值的**安装期静态扫描**（危险模式匹配、包解压路径逃逸
校验、私网 SSRF 拦截）。README 已明确写明权限边界。

---

## 五、其他修复与清理

- **流式错误状态码统一**：413（请求体过大）、400 等此前在 SSE 中一律变成
  500 `server_error`，一元接口却正确返回 4xx。现已共用同一解析逻辑。
- **认证失败日志泄露密钥**：`isAuthorized` 失败时会把候选 API Key 和 query key
  写进日志。被拒绝的请求恰恰最可能携带攻击者输入的值。改为只记录「是否存在」。
- **Claude 转换三处缺陷**：`parseInt` 外层 `try/catch` 永不触发（非法值会把
  `NaN` 发往上游）；单 block 的 `system` 对象被整体赋给字符串字段；
  `convertTools` 在调用方的 schema 上 `delete $schema`，污染入参。
- **日志轮转性能**：2000 行日志的 `statSync` 调用从 2000 次降到 **0**。
  顺带修复一个潜伏 bug——原 `existsSync` 前置判断与文件惰性创建竞争，
  首次写入时会导致**永不轮转**。
- **删除可证伪的死代码**：`registerWildcardProxyResolver`（零引用，
  其回退分支静态不可达）、`TRAE_REASONING_MODEL_PATTERNS`、
  `refreshProviderUuid`、`NETWORK.DEFAULT_PORT`、`image-zoom.js`
  （触发类名无任何写入方，却每次启动装两个永不触发的监听器）、
  SSE `'provider'` 幽灵事件（零发送方，却在三处被订阅）。
- **`ProviderStrategy` 改为 interface**：缺实现从「运行时才炸」变成编译错误。
  改造后立刻暴露 `GeminiStrategy` 缺失一个方法实现。
- **i18n**：补 5 个代码在用但字典缺失的 key（其中 `login.error.bodyTooLarge`
  会让登录页把原始 key 直接显示给用户），删 4 个 Kiro 移除后的孤儿 key；
  并强化一致性测试——旧测试只比对两本字典彼此，看不到「无人引用」这类漂移。
- **基准脚本替换**：删除含**真实 harness 启动 token** 与私有
  `session.v4.jsonl.zstd` 解析的旧脚本，新增 `scripts/cache-hit-benchmark.mjs`，
  只走网关公开 API，可直接进 CI 作为缓存命中率回归门禁。

---

## 六、升级指南

### 如果你只使用内置功能（多数用户）

**无需任何操作**。正常升级即可。

### 如果你安装了第三方插件

这是本次的破坏性变更点。原沙箱既然拦不住 `net.Socket.prototype.connect` 和
`vm.compileFunction`，那么它在过去也从未真正保护过你——只是让你以为被保护了。

现在明确约定：**插件与主进程同权限运行**。

建议做法：
1. 只安装**你信任来源**的插件；
2. 安装前可自行审查 `src/plugins-user/<插件名>/` 下的源码；
3. 对不可信插件，请改为在**独立进程或容器**中运行，不要依赖宿主隔离。

安装期静态扫描仍会拒绝含 `child_process`、`spawn`/`exec`、内嵌 SSH 私钥、
已知反向隧道特征与已知恶意标记的插件包，但它只能挡住**已知模式**。

### 如果你调用了 `/api/upload-configs/*` 单文件端点

行为变更：`.master_secret` 现在会返回 `403`。这是预期修复，请勿回退。

---

## 七、验证

本轮所有改动均通过完整门禁：

```
typecheck · typecheck:plugins · typecheck:webui · check:strict · check:any
check:imports · check:cycles · lint:css · webui-html-shell · webui-vendor
runtime-smoke · 1042 tests · coverage gate
```

- 测试数：1013 → **1042**（新增 5 个回归套件，删除 3 个沙箱用例）
- `src/core` 覆盖率：9.7% → **26.7%**
- 总覆盖率：48.71% → **49.86%**
- `any` 注解：234 → **0**
- 源码净删约 **2000 行**（含沙箱 1093 行）

每项修复都配有回归测试，并**逐一验证过"去掉修复后测试确实失败"**——
避免出现"测试通过但没锁住行为"的空壳用例。

---

**完整变更明细**：见 [CHANGELOG.md](https://github.com/GreyRaphael/AIClient2API/blob/main/CHANGELOG.md)
