# AIClient-2API 发布说明 (v8.9.1)

> ## 🔧 v8.9.0 精简改造的缺陷修复版本
>
> **版本重点**：修复 v8.9.0「大刀阔斧精简」引入与遗留的 14 项缺陷。其中 3 项会直接导致
> 生产不可用——动态提供商整组模型被路由拦截、OAuth 节点账号名不落盘、
> 流式请求遇到客户端断连会打挂整个 worker。无破坏性变更，可直接升级。

---

## ⚠️ 兼容性说明

**本版本无破坏性变更**，从 v8.9.0 可直接升级，无需迁移数据或修改配置。

唯一需要注意的行为变化：

- **`/count_tokens` 的估算精度提升**。该端点仍返回估算值（非精确 BPE），
  但此前若干类别偏差极大（1000 个连续空格被算成 250 token，真实为 5；
  希腊语等非拉丁文字系统性偏低 77%）。现在对代表性载荷的平均偏差约 6.5%。
  Claude Code 等下游 harness 会周期调用此端点来判断上下文是否临近上限，
  因此精度提升对长会话的 compact 判断有实际意义。
  仍需精确值的场景请使用上游官方的 `count_tokens` 接口。
- **不提供覆盖率门禁**。`check:coverage` / `coverage:update` 及相关脚本均不存在，
  `verify` 与 CI 只以「测试是否通过」为准（详见下文第二节）。

---

## 一、核心修复

### 1. 动态提供商：空模型发现被当成成功并永久落盘 🔴

四个动态 provider（antigravity / codex / trae / zed）在上游失败时**不抛异常**，
而是返回各自已空的 fallback 数组。而缓存判据只检查 `fetchedAt > 0`，于是
「一次网络抖动」被记录成「成功发现 0 个模型」，得到 `known=true` + `candidateModels=[]`。
`nodeSupportsModel` 拿到 `known=true` 后不再放行，**整组节点从此拒绝一切模型**，
且因 `stale=false` 连后台刷新都不再触发，只能等 TTL 过期才自愈。

- 空结果现在一律按「发现失败」处理：不写缓存、不落盘、不覆盖已有良好清单。
- 失败时保留已有的良好发现（models / fetchedAt / source 全部沿用），只叠加退避。
- `toJSON()` 额外要求 `models` 非空，失败元数据只留在内存。

### 2. OAuth 节点身份：账号邮箱不落盘 🔴

三处调用写成 `_debouncedSave?.()`（漏传 `providerType`），`undefined` 入队后
真正的类型从不落盘，文件根本不写——「以账号邮箱命名」只在内存生效，重启即丢。

- 新增 `syncProviderIdentity()` 统一「补写账号名 + 清错误条 + 按正确类型落盘」。
- 该路径不再借用 `markProviderHealthy`：后者默认 `resetUsageCount=false` 会走
  `usageCount++` 并刷新 `lastUsed`，每次凭据加载都污染仪表盘用量与 LRU 选点。

### 3. Antigravity 流式请求会打挂 worker 🔴

`readline` 的 Interface 会把 input 的 `error` 转发到自身，而 `finally` 里的
`rl.close()` 又摘掉它唯一的监听器。「close 之后上游再 emit('error')」——
即 node-fetch 的 abort 形态（先 reject、再 emit）——于是变成 uncaughtException，
被判定为致命错误后 `gracefulShutdown()` → `process.exit`，
**把同一 worker 上所有在途请求一起带走**。触发条件就是用户在流式输出中途关闭标签页。

- 去掉 readline，改为直接迭代 stream + `StringDecoder` 自行切行，错误从迭代器正常抛出。

### 4. 「检查模型」污染线上节点 🟠

控制台探测传的是**尚未保存的草稿配置**，其 uuid 与线上节点相同，走正常写入路径
会覆写线上能力缓存、把节点标红并顶替适配器实例。用户打错一个路径（还没保存）
就能把生产节点搞成不可用。

- 新增 `dryRun` 探测模式：不写缓存、不落盘、不改健康状态。

### 5. 限流错误被误判成凭据失效 🟠

原来用裸词 `Token` / `OAuth` / `credentials` 匹配，于是
`model token budget exceeded`、`Daily OAuth quota exhausted` 这类**限流**错误
也会把节点永久标红——而红条正是控制台新增的 UI，用户直接看到。

- 改为结构化 401/403 状态码 + 明确的鉴权错误短语，并排除配额/限流语境。

### 6. 其他修复

| 问题 | 影响 |
|---|---|
| `openInBrowser` 谎报成功 | `spawn` 对 ENOENT 不同步抛出，旧实现先 resolve 再 unref，于是「系统没有浏览器」被当成成功并打出假日志 |
| 超限上传返回 400 而非 413 | 吞掉了 `MultipartError.statusCode`，客户端无法区分「请求太大」与「报文坏了」 |
| UI 刷新阻塞请求路径 | `add` 在文件锁内同步等上游（最长 15s+）；列表页冷缓存时串行等待每个节点 |
| 分词 `\p{N}` 兜底缺失 | `Ⅳ` / `٠١٢` / `१२३` 等字符被**整类静默丢弃**，既不计数也不报错 |
| 分词 catch 静默降级 | 异常时无任何日志，数值悄悄变形而无人察觉 |

---

## 二、质量门禁与验证

- **`npm run verify` 串联以下 11 个步骤**：

  1. `typecheck`：TypeScript 主工程零错误
  2. `typecheck:webui`：WebUI 零构建 TypeScript 语法静态类型零错误
  3. `check:strict`：strict 棘轮保持 0 错误基线
  4. `check:any`：0 any 标注 / 0 any 断言
  5. `check:imports`：133 个源文件运行时导入完整性 100% 通过
  6. `check:cycles`：0 循环依赖
  7. `lint:css`：Stylelint CSS 静态校验全部通过
  8. `gen:webui-html:check`：HTML 外壳与真源一致
  9. `vendor:webui:check`：第三方库静态资源同步通过
  10. `test`：**1098 项测试全绿**（Node 26 原生 `node:test`）
  11. `test:runtime`：原生运行时无转译直接启动冒烟测试

- **CI 修复**：删除已失效的 `npm run test:node` 步骤（该脚本在 Jest→node:test 迁移中
  已删除，但 CI 仍在调用，导致 CI 必然失败）；去掉对 `node --test` 无效的
  `--runInBand`（它会被当成文件名 glob，既不串行也不报错）；删除纯装饰性的
  `metrics:types`（不带 `--check`，只打印不校验）。

- **测试基座修复**：`jest.getTimerCount()` 此前恒返回 0，让定时器泄漏断言
  变成恒真（变异实验证明：删掉 `clearTimer()` 后旧基座 12/12 全绿）；
  `looseEqual` 补齐 Date / RegExp / Buffer / class 实例 / 稀疏数组语义，
  消除 4 类静默假通过。另修好三处「看起来是绿的」失效断言
  （FA 子集因 devDependency 缺失恒早退、ZIP 测试从不校验中央目录、
  设计尺度测试漏扫 JS 内联样式）。

- **不提供覆盖率门禁**。本次 14 个缺陷全部落在**有覆盖**的代码里
  （例如 `model-capability` 当时有 28 个测试全绿，只是断言写错了），
  覆盖率对其无一有效；而基线历史上曾与删测试同 commit 被下调
  （`src/providers` 从 60.63% 降到 47.26%）。覆盖率只能证明「测试没被删」，
  证明不了「测试写得对」。真正有效的手段是对照真实执行读代码与变异测试。

---

## 三、升级建议

- **运行时环境要求**：Node.js >= 26.0.0（与 v8.9.0 相同）
- **升级步骤**：

  ```bash
  git pull
  npm ci --ignore-scripts
  npm start
  ```

- **无需迁移**：本次不涉及存储结构、配置键或数据格式变更。
- **建议复核**：若此前已遇到「某提供商突然全部模型不可用」或
  「OAuth 节点重启后账号名丢失」，本次修复直接对应这两个症状；
  升级后既有节点的缓存会被自动重建，无需手工清理 `configs/model-capability-cache.json`。

---

**完整变更明细**：见 [CHANGELOG.md](https://github.com/GreyRaphael/AIClient2API/blob/main/CHANGELOG.md)
