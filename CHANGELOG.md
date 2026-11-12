# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [v8.9.2] - 2026-11-12

### Changed — 请求管线解耦（纯内部重构，无行为变更）

- **拆分 `src/handlers/request-pipeline.ts`：2641 行 → 1248 行（−53%）**。
  该文件是仓库内改动最密集的模块（最近 40 个提交中 39 个真实修改它，
  累计 +3510/−869），且 `handleStreamRequest` 内部有 127 行位于 5 层以上嵌套
  （最深 7 层）。按职责拆为 `src/handlers/pipeline/` 下 6 个模块：

  | 模块 | 行数 | 职责 |
  |---|---:|---|
  | `error-response.ts` | 476 | 错误响应构造与投递 |
  | `unary-handler.ts` | 490 | 非流式处理 + 空响应重试预算 + 号池健康映射 |
  | `protocol-plan.ts` | 401 | 终态原因、桥接计划、有效内容识别、文本提取 |
  | `model-routing.ts` | 139 | 自定义模型路由与 `/v1/models` 拼装 |
  | `stream-writer.ts` | 89 | 背压感知帧写出 + 零窗口防挂死 |
  | `error-types.ts` | 22 | 共用的 `PipelineError` 形状（纯类型） |

  拆分依据经实测：`handleUnaryRequest` 对 stream 专有符号的引用数为 0；
  错误簇对其余文件的符号引用仅有 `PipelineError` 一处。
  `request-pipeline.ts` 保留全部 27 个原有导出，外部导入方无需改动。

- **`npm test` 显式设定并发**（默认 5，可用 `TEST_CONCURRENCY` 覆盖）。
  实测 17.5–19.1s → 16.6–17.3s（约 6%）。同时避免行为随 Node 默认值漂移。

### Fixed — 重构过程中暴露的问题

- **消除一处新引入的运行时循环依赖**：`unary-handler` 反向依赖
  `request-pipeline` 的 `extractResponseText` / `getMonitorRequestId`，
  形成 `request-pipeline -> unary-handler -> request-pipeline`。
  把三个「按协议选策略」的纯函数（含 `extractPromptText`）下沉到
  `protocol-plan.ts` 后消失。
- **恢复被误删的 `isTerminalEmptyFinishReason` re-export**：缺失导致
  `cross-protocol-bridging.test.mjs`（109 项用例）整文件加载失败，
  测试总数一度从 1098 掉到 990。

### Notes

- `handleStreamRequest` 拆分后仍为 614 行。其 2 处自递归（凭证切换 / 空响应重试）
  需要传递 12 项状态到下一帧，强行抽出 retry-controller 会得不偿失；
  彻底处理需先把递归改写为「循环 + 显式状态对象」的重试状态机，留待后续。

## [v8.9.1] - 2026-11-12

### Fixed — v8.9.0 之后精简改造的评审修复

- **动态提供商空模型发现被当成成功并永久落盘**：四个动态 provider 在上游失败时
  返回空数组而非抛错，而 `hasUsableDiscovery` 只检查 `fetchedAt>0`，
  于是得到 `known=true` + `candidateModels=[]`，路由守卫随即拒绝**一切**模型。
  现在空结果一律视为发现失败：不写缓存、不落盘、不覆盖已有良好清单。
- **`_debouncedSave()` 漏传 providerType**：三处调用写成 `_debouncedSave?.()`，
  `undefined` 入队导致真正的 providerType 从不落盘，「以账号邮箱命名」只在内存生效。
  新增 `syncProviderIdentity()` 统一「补写账号名 + 清错误条 + 落盘」，
  同时不再借用 `markProviderHealthy`（后者会污染 `usageCount` / `lastUsed`，破坏 LRU）。
- **Antigravity 流式请求打挂 worker**：`readline` 的 Interface 会把 input 的 `error`
  转发到自身，而 `finally` 里的 `rl.close()` 又摘掉它唯一的监听器；
  「close 之后上游再 emit('error')」（node-fetch abort 的形态）于是变成
  uncaughtException → `gracefulShutdown()` → `process.exit`。
  现改为直接迭代 stream（`StringDecoder` 自行切行），错误从迭代器正常抛出。
  触发条件就是用户在流式输出中途关闭标签页。
- **「检查模型」用草稿配置污染线上节点**：控制台探测传的是尚未保存的草稿配置，
  其 uuid 与线上节点相同，会覆写线上能力缓存、把节点标红。
  新增 `dryRun` 探测模式：不写缓存、不落盘、不改健康状态。
- **限流错误被误判成凭据失效**：原来用裸词 `Token`/`OAuth`/`credentials` 匹配，
  `model token budget exceeded` 这类限流也会把节点永久标红。
  改为结构化 401/403 状态码 + 明确的鉴权错误短语，并排除配额/限流语境。
- **`openInBrowser` 谎报成功**：`spawn` 对 ENOENT 不同步抛出，旧实现先
  `resolve()` 再 `unref()`，于是「系统没有浏览器」被当成成功并打出假日志。
  现在等 `'spawn'` 事件才 resolve，`'error'` 一律 reject。
- **超限上传返回 400 而非 413**：`handleUploadOAuthCredentials` 硬编码 `writeHead(400)`，
  吞掉了 `MultipartError.statusCode`。
- **UI 刷新阻塞请求路径**：`add` 在 `withFileLock` 内同步等上游（最长 15s+），
  `GET /api/providers/:type` 冷缓存时串行等待每个节点。均改为后台触发。
- **分词估算精度**：按真实 Claude BPE 实测标定权重（各文字系统分别取比率、
  空白整块计权、非拉丁文字按 UTF-8 字节标定、编码块走专门分支）。
  20 条代表性载荷平均偏差 ~6.5%（未参与调参的留出集约 11.7%，
  不要按 6.5% 承诺精度）；此前空白类最高偏 +4900%、希腊语偏低 77%。
  同时补回 `\p{N}` 兜底（`Ⅳ` / `٠١٢` / `१२३` 此前被整类丢弃），
  并恢复 catch 分支的告警日志。

### Changed

- CI 移除已失效的 `npm run test:node` 步骤（该脚本不存在，CI 必红），
  并去掉对 `node --test` 无效的 `--runInBand`（它会被当成文件名 glob）。
- 测试基座修复两处失真：`jest.getTimerCount()` 此前恒返回 0（定时器泄漏断言因此恒真），
  现在自行记账；`looseEqual` 补齐 Date / RegExp / Buffer / class 实例 / 稀疏数组语义，
  消除 4 类静默假通过。
- `tests/webui-fa-subset.test.mjs` 此前依赖已移除的 devDependency 而恒早退，
  现在直接对照子集 CSS 校验；`tests/zip.test.mjs` 补齐中央目录与 EOCD 断言。
- `potluck-user` 热力图图例的行内 `gap: 3px` 收敛到样式表（并入 2px 网格）。
- **不提供覆盖率门禁**：`check:coverage` / `coverage:update` / `scripts/check-coverage.mjs`
  / `scripts/coverage-baseline.json` 一律不存在，`verify` 与 CI 只以测试是否通过为准。
  理由：本次 14 个缺陷里没有一个属于「有测试但没跑」形态，覆盖率对其全部无效；
  而基线历史上曾与删测试同 commit 被下调，只能证明「测试没被删」，
  证明不了「测试写得对」。真正有效的手段是对照真实执行读代码与变异测试。


## [v8.9.0] - 2026-11-11

### Node 26 Migration & Architecture Refactoring

- **Node 26 全面重构（Phase 1 - Phase 4）**：
  - 运行时引擎升级至 `engines: >=26.0.0`，启用原生编译缓存（`enableCompileCache`）。
  - 深度利用现代标准库语法：原生 `Temporal`（替代手写日期计算）、`Array.fromAsync`、
    `Object.groupBy`、`Array.prototype.toSorted`、`structuredClone`。
  - 核心存储引擎全面切至 Node 原生 `node:sqlite`（`DatabaseSync`），实现毫秒级原子事务持久化。
  - 流式转发接入背压监控机制与 `AbortSignal.any` 级联多路信号取消。
  - 引入原生 `diagnostics_channel` 网络诊断套件，提供首包时延（TTFB）与吞吐链路追踪。
  - 测试套件全量迁移到 Node 26 原生 `node:test`（`npm test`）。
  - 彻底卸载 `multer` 依赖，重构 CLI 为标准 `node:util parseArgs`。
  - 深度精简死代码与冗余一次性测试用例（`src/` 净减 751 行，仓库整体净减约 1 万行）。

### ⚠️ Breaking Changes

本版本是破坏性变更。**不提供向后兼容，也不提供数据迁移**——以下能力与数据入口均已删除。

- **运行时基线收紧至 Node.js 26+**：`engines` 由 `>=24.0.0` 上调为 `>=26.0.0`。
  入口在加载应用模块图之前校验主版本，Node 24 及更早版本会直接退出并给出升级提示。
  本版本直接运行 `.ts` 源码，依赖 Node 原生 TypeScript 类型擦除。
- **插件系统已彻底移除**：`src/plugins/`、`src/plugins-user/`、`src/core/plugin-manager.ts`、
  `src/core/plugin-security.ts`、`src/services/plugin-installer.ts`、`src/ui-modules/plugin-api.ts`
  全部删除；插件市场（远程下载与本地 ZIP 上传安装）、插件运行时沙箱、安装期静态扫描
  （`DANGEROUS_PLUGIN_PATTERNS`）一并消失。`configs/plugins.json` 不再被任何代码读取。
  原插件能力已由核心模块承接：
  - **令牌管理**（`src/services/api-keys/`，原 api-potluck）：1 / 2 / 5 / 10 亿 Token 套餐、
    有效期与自然月顺延、预扣—结算记账、每日 Token 上限。
  - **模型用量统计**（`src/services/usage-stats/`，原 model-usage-stats）：改为请求流水线
    内直接记账，移入控制台主菜单，不再受插件开关控制。
- **存储引擎由 JSON 切换为 `node:sqlite`（`DatabaseSync`），且不迁移旧数据**：
  `configs/api-potluck-keys.json`、`configs/api-potluck-data.json`、
  `configs/model-usage-stats.json` 不再被任何代码读取，读取与迁移这些 JSON 的实现已删除。
  从 8.8.x 升级需**重新创建令牌与统计**（旧 JSON 文件可自行留档或删除）。
- **亮色主题已移除**：全局声明 `color-scheme: dark`，仅支持暗色主题；
  原先主题切换写入的 `localStorage.theme` 会被主动清除。
- **移除的 HTTP 接口**（插件管理相关，全部返回 404）：

  | 方法 | 路径 |
  |---|---|
  | GET | `/api/plugins` |
  | GET | `/api/plugins/market` |
  | POST | `/api/plugins/install` |
  | POST | `/api/plugins/upload` |
  | POST | `/api/plugins/:name/toggle` |
  | DELETE | `/api/plugins/:name` |

- **移除的 npm script 与配置文件**：`typecheck:plugins`
  （`tsconfig.plugins.json`、`types/plugin.d.ts` 一并删除）。

### WebUI & Heatmap Experience

- **模型用量日历热力图改版**：
  - 升级为 GitHub 风格全自然年（53~54周）排布，支持按年度智能分页与切换，解除 3 个月限制。
  - 格子高度充分利用卡片空间自适应拉伸并严格锁定 1:1 正方形（面积提升 3.3 倍以上）。
  - 新增月份刻度、周一/周三/周五星期标尺与 5 级色度图例（月份与格子在同一个 grid 内）。
  - 全局声明 `color-scheme: dark;`，重构纤细透明横向滚动条，彻底移除亮色主题冗余。

### Changed

- **`model-usage-stats` 从插件迁为核心功能，并搬进主菜单**（紧挨「实时日志」上方）。
  - 后端：`src/plugins/model-usage-stats/`（4 个 `.js`，760 行）→ `src/services/usage-stats/`
    （5 个 `.ts`：types / stats-db / stats-manager / api-routes / index）。不再受
    `configs/plugins.json` 的 `enabled` 开关控制，无需启用插件即可用。
  - 记账时机从 **插件 hook** 改为**核心流水线直接调用**（`request-pipeline.ts` 3 处、
    `api-manager.ts` 2 处）。`finalizeRequest` 刻意放在插件 `onContentGenerated` **之外**
    执行——插件可被用户禁用，用量统计不该跟着丢数据。
  - API 契约完全不变：`GET /api/model-usage-stats?date=YYYY-MM-DD`（省略 = 历史累计）、
    `POST|DELETE /reset`、`POST|DELETE /reset-tokens`，dual 鉴权（session token 或
    `REQUIRED_API_KEY`）。路由注册刻意早于 `isUIApiPath` 的 session 门禁，否则只用
    API Key 的调用方（含 `scripts/cache-hit-benchmark.mjs`）会被误拦成 401。
  - 前端：删除独立页 `static/model-usage-stats.html` + `static/ui/pages/model-usage-stats.js`
    + `static/ui/styles/pages/model-usage-stats.css`，改为主菜单 section
    `static/ui/sections/model-usage-stats/{index,usage-utils}.ts`。
    **不再需要手填访问凭证**（走控制台 session token），`lib/credential-api.js` 的
    `dual` 模式随之删除。
  - 页面只保留两块核心内容：「选择日期」卡片（内含「历史累计」与「重置统计」）
    + 右侧汇总卡片（5 项指标，进度条 + 数值）+ 明细表格（按模型 / 按 Provider 切换、
    搜索、排序、命中率药丸，沿用迁移前的交互）。

### Added

- **WebUI 现在可以直接用 TypeScript**（仍然零构建）。`serveStaticFiles` 对 `.ts` 做
  服务端运行时类型擦除（`node:module` 的 `stripTypeScriptTypes`，`mode: 'strip'`），
  擦除结果按 `filePath + mtimeMs + size` 缓存，并与压缩缓存共用同一份字节（避免
  「压缩版含类型、未压缩版不含」的错配）。`.ts` 因此获得与 `.js` 一致的
  `text/javascript` MIME、`no-cache` + 弱 ETag + 304 与 br/gzip 压缩。
  - 代价：只能用**可擦除语法**（不能用 `enum` 与构造函数参数属性 `constructor(private x)`）。
  - Node 首次调用 `stripTypeScriptTypes` 会发一条 `ExperimentalWarning`；实现里只在那
    一次调用期间临时接管 `process.emitWarning` 并立刻还原，启动日志不再出现该警告。
    （踩过的坑：Node 用 `emitWarning(message, type)` 两参数形状发出这条警告，`type`
    在第二个参数而非 `Error.name` 里，只判 `instanceof Error` 会让拦截静默失效。）
  - `tsconfig.webui.json` 的 `include` 纳入 `static/ui/**/*.ts`，并开启
    `allowImportingTsExtensions`（浏览器不做扩展名补全，所以相对 import 必须写全扩展名）。

### Removed

- **SEA 单文件打包能力移除**：删除 `npm run build:sea` 与 `scripts/build-sea.mjs`，
  以及 `.gitignore` 中对应的 `dist/`、`bin/` 忽略项。原实现只产出不含业务代码的壳，
  无法实际运行服务，随本版本一同下线。
- **覆盖率门禁移除**：删除 `check:coverage` / `test:coverage` / `coverage:update`
  三个 npm script，以及 `scripts/check-coverage.mjs`、`scripts/coverage-baseline.json`
  与 `jest.config.js` 的 coverage 配置；`npm run verify` 与 CI 不再包含覆盖率步骤。
  质量约束改由 `typecheck`、`check:strict`、`check:any`、`check:imports`、
  `check:cycles`、`lint:css` 与 `test` 承担。
- **三个插件的 JSON→SQLite 迁移代码与测试全部删除**（迁移窗口已过，旧 JSON 早已不存在）：
  `src/plugins/shared/sqlite-store.js` 的 `backupLegacyJson` / `readLegacyJson`，
  `api-potluck/potluck-db.js` 的 `migrateFromLegacyJson`，以及
  `tests/plugin-sqlite-storage.test.js` 里对应的 3 个迁移用例。
  另加两条反向断言，防止这些已删除的导出被重新加回。
- **用量缓存 `usage-cache.json` 的兼容读取一并删除**：`src/ui-modules/usage-cache.ts`
  不再读取旧 JSON，仅使用 `configs/usage-cache.db`。
- `static/ui/lib/stats.js` 的 `flattenModelUsage`（随独立页删除后不再有调用者）。
- **插件市场与插件配置文件整体移出仓库**：`configs/plugins.json.example`、
  `configs/market.json.example` 已随插件系统一并删除（当前 `configs/` 下不存在这两个文件）；
  `model-usage-stats` 也不再作为插件或市场条目出现。

### Fixed

- **模型用量统计的日历在控制台里不可见**（本次迁移引入，e2e 抓到）。`StatsCalendar`
  的样式（`.calendar-day` 的宽高等）此前只存在于 `pages/plugin-shared.css`，而该文件
  只被 potluck / potluck-user 两个独立页加载，控制台的 `index.html` 从不加载它 ——
  迁移后日历格子高度为 0。修法：`StatsCalendar` 被三处复用（新 section + potluck 两页），
  而 `shared.css` 是唯一被所有页面加载的层，因此把整组日历规则收敛到 `shared.css`
  一处；色阶抽成令牌 `--calendar-level-1..4`（亮/暗两套值都进 `base.css`），
  不再各写一份十六进制色值。
- **日历格子从方块变成圆点、提示文字在暗色主题下不可读**（本次迁移引入，用户反馈）。
  重写日历样式时把「具体像素值」误换成「设计令牌」：`border-radius: 2px` →
  `var(--radius-sm)`（6px），11px 的方块配上 6px 圆角几乎成了圆形。同一批还有
  三处：`.calendar-tooltip` 的 `color` 从 `var(--white)` 改成 `var(--bg-primary)`
  （暗色主题下深字压深底，亮色下恰好正常所以测试没响）、`cursor: pointer` 丢失、
  tooltip 圆角 `4px`→6px。全部按原始值还原，并新增 4 条回归断言锁住
  「11px 方块 + 小圆角 + 四档绿逐级加深 + 规则归属 shared.css」。

## [v8.8.1] - 2026-11-09

### Fixed

- **前缀缓存基准测试修正**（`scripts/cache-hit-benchmark.mjs`）：首版提示词过短（79–471 tokens）
  低于主流大模型上游 KV 缓存门槛（Anthropic 1024 / OpenAI 1024），导致命中率恒为 0%。
  通过确定性生成稳定长前缀（~6000 字符，1500+ tokens）使测试能够真实检验网关前缀缓存能力，
  实测稳态命中率达 98%~99%。

### Tests

- **删除计算样式契约测试**（`tests/webui-e2e/style-contract.*`，80 组合 / 1072 条断言 /
  170KB 基线）：它是为一次 CSS 大重构（21 文件、约 1.2 万行）专门引入的一次性安全网，
  该重构早已完成。作为长期回归网它有三个问题：① 断言的是"元素存在且值匹配"，
  元素不渲染时语义会静默退化为"存在 vs 不存在"，而存在性由运行时数据状态决定
  （`.btn-primary` 仅在"有新版本"时渲染，导致所有 8 个组合在 GitHub API 不可达时失败）；
  ② 基线自相矛盾——同一 `.btn-primary` 在 5 个 section 记录为值、5 个记录为 null；
  ③ 记录值本身无意义（背景色为全透明 `rgba(0,0,0,0)`）。
  仓库已有 26 个稳定的 jest CSS 单测（令牌、层叠、作用域、设计标度、移动端、硬编码颜色），
  均不依赖页面数据状态。删除后 webui e2e 从 42 passed / 9 failed（5.5 分钟）
  变为 **43 passed / 0 failed（1.6 分钟）**。
- **修复插件页 e2e 的 mock 数据**：模型 ID 由账号已不再提供的 `gemini-3-flash`
  改为实际存在的 `gemini-3.8-flash-medium`；并补上 `daily[date].models`
  （默认视图读的是该字段，缺它会恒定渲染「没有匹配的数据」）。

## [v8.8.0] - 2026-11-09

本轮基于 v8.7.0 的全量代码审计（157 项发现）做定向修复，重点收敛三类问题：
真实缺陷、无效防护、以及已漂移的重复实现。

### Fixed

- **流式响应在已产出内容后仍会重试，导致客户端收到重复文本**（C1）。`openai-core`、
  `openai-responses-core`、`claude-core` 的 `streamApi` 在 429/5xx/网络错误时会
  `yield*` 重跑整个请求；上游先吐 N 个 chunk 再断连时，用户看到的是「前半段 + 完整
  重放」。`antigravity-core` 早已修过同类问题并留有注释，但修法只落在一个 core 上
  ——因为另外五个是复制出来的。现三个 core 均加入 `hasYielded` 守卫，且置于 `catch`
  最前（早于所有重试分支）。
- **`_abortSignal` 是死代码，健康检查超时无法取消上游请求**（C2）。全仓库仅一处
  `defineProperty` 注入、零处读取；15 秒超时只是让 `Promise.race` 返回，底层请求继续
  跑完并占用账号配额。已删除该注入。
- **号池状态写入失败会丢数据**。`ProviderPoolPersistence.flush()` 在写入前就
  `pendingSaves.clear()`，`catch` 只记日志；一次 ENOSPC/EACCES 就让整批状态变更
  永久消失且不重试。改为写成功后按类型移除，失败时重新入队。
- **`configs/.master_secret` 可被单文件端点读取**。`/api/upload-configs/view`、
  `download`、`delete`、`force-expire` 只校验「路径在 configs/ 下」，而备份 zip 端点
  已显式排除该文件——说明威胁模型明确，只是这几个端点漏了。现统一走
  `checkConfigPath()`。
- **凭据文件前 100 字节随列表接口外泄**。`config-scanner` 的 `preview` 字段对
  `configs/codex/*.json` 而言落在 `id_token` 的 JWT header 内，且该字段全仓库零消费者。
  已删除。
- **Codex 适配器定时器泄漏**。构造函数启动 15 分钟 `setInterval`，但
  `stopCacheCleanup()` 零生产调用方，`invalidateServiceAdapter()` 直接丢弃引用。
  每次配置重载泄漏一个定时器 + 一份会话缓存。现补 `dispose()` 生命周期契约。
- **Codex OAuth 回调窗口与轮询预算不一致**。回调服务器开 10 分钟，轮询循环却在
  5 分钟就清理会话；用户第 6–9 分钟完成授权会看到成功页，随后得到
  `Invalid or expired OAuth session`。两者现由同一常量推导。
- **流式错误状态码与一元路径不一致**。流式只读 `status || code`，导致 413/400 在
  SSE 中变成 500 `server_error`。现共用 `resolveErrorStatusCode()`。
- **认证失败日志写入完整 API Key**。`common.isAuthorized` 在失败时打印候选密钥与
  query key；被拒绝的请求恰恰最可能携带攻击者提供的值。改为只记录「是否存在」。
- **`ClaudeConverter` 三处转换缺陷**：`parseInt` 外层 `try/catch` 永不触发（非法值
  会把 `NaN` 发上游）；单 block 的 `system` 对象被整体赋给字符串字段 `instructions`；
  `convertTools` 在别名 schema 上 `delete $schema`，污染调用方入参。
- **`GeminiStrategy` 缺少 `extractModelAndStreamInfo` 实现**。将抽象类改为 `interface`
  后立即暴露为编译错误；此前是运行时 `throw`，只因当前路由走不到而未显形。
- **日志轮转的大小检查不再每次 `statSync`**。改为本地字节累加 + 分钟级限频；
  实测 2000 行日志的 `statSync` 调用从 2000 次降至 0。顺带修掉一个潜伏 bug：
  原 `existsSync` 前置判断与 `createWriteStream` 惰性建文件竞争，首次写入时会导致
  **永不轮转**。

### Changed

- **删除运行时插件"沙箱"**（见 Breaking）。
- **删除可证伪的死代码**：`registerWildcardProxyResolver`（零引用，其回退分支静态
  不可达）、`TRAE_REASONING_MODEL_PATTERNS`、`ProviderPoolManager.refreshProviderUuid`、
  `NETWORK.DEFAULT_PORT`、`image-zoom.js`（`clickable-qr` 无写入方，却每次启动装两个
  永不触发的监听器）、SSE `'provider'` 幽灵事件（零发送方，却在三处订阅）。
- **`ProviderStrategy` 由抽象类改为 interface**，缺实现从运行时错误变为编译错误。
- **收敛重复实现**：三个 OAuth 实现的凭据文件名净化（字节相同）、JWT 解码、
  token 过期计算合入 `oauth-shared`；`default-auth` 改用 `common.isAuthorized`。
- **i18n 补 5 个缺失 key**（含 `login.error.bodyTooLarge`，此前登录页会把原始 key
  直接显示给用户）、删 4 个 Kiro 移除后遗留的孤儿 key；并强化 parity 测试，
  使其能发现「无人引用」的 key——旧测试只比对两本字典彼此。
- **基准脚本替换**：删除含真实 harness token 与私有 `session.v4.jsonl.zstd` 解析的
  `scripts/harness-benchmark.mjs`，新增 `scripts/cache-hit-benchmark.mjs`
  （纯网关公开 API，可进 CI 当回归）。

### Breaking

- **插件不再在运行时被 fs/net/vm 隔离**。原 `security-hardening.ts` 用 85 处
  monkey-patch + 调用栈判定尝试沙箱化插件，实测只覆盖模块级入口
  （`net.connect`、`vm.runInThisContext`），而 `net.Socket.prototype.connect`、
  `vm.compileFunction` 等路径一直可绕过——即"实际没有防护，但代码和日志都宣称有"，
  运维因此会误判第三方插件的风险。该文件自身覆盖率 0/618 行，却以"避免拉低分支
  覆盖率"为由写成无 if 形式，并对 fs 热路径造成 3.5–7.5× 开销。
  现删除运行时沙箱，保留安装期静态扫描（`DANGEROUS_PLUGIN_PATTERNS`、包解压路径
  逃逸校验、私网 SSRF 拦截）。**插件与主进程同权限，请只安装可信来源的插件**；
  需要隔离不可信插件时请改为独立进程/容器运行。README 已补充该权限说明。

## [v8.7.0] - 2026-11-09

### Security

- **Master 管理端口加固**（`src/core/master-core.ts`）。管理 API 原先监听所有网卡、
  CORS 为 `*`、五个端点全部无鉴权——局域网内任意主机（或借浏览器发起跨站请求的网页）
  都能 `POST /master/stop` 关停网关，或从 `/master/status` 读取 PID 与内存占用。
  现在：默认只绑 `127.0.0.1`（可用 `MASTER_HOST` 覆盖）；除 `/master/health` 外的端点
  一律要求 `Authorization: Bearer <secret>`；CORS 只回显本机 Origin。
- **管理 secret 的生成与存放**：优先 `MASTER_SECRET` 环境变量（需 ≥32 字符，否则忽略），
  其次读取 `configs/.master_secret`（首次启动自动生成 32 字节随机值，`mode 0o600`）。
  首次生成时会在启动日志打印一次明文（便于 `docker logs` 获取），之后只打印路径。
  该文件已加入 `.gitignore`，并从「下载全部配置」的备份 zip 中排除。
- **修复沙箱的异步逃逸**（`src/core/security-hardening.ts` + `src/core/plugin-security.ts`）。
  沙箱原本只靠调用栈判断调用方是否为插件，插件把敏感操作投递给 `setTimeout` /
  `queueMicrotask` / 预先 `bind` 的函数后，回调执行时栈上只剩 Node 内部帧，
  检查即被放行（可读取 `.env` 与凭据文件）。现在 `PluginManager` 在调用插件代码的
  唯一收口用 `AsyncLocalStorage` 标注插件身份，上下文随异步资源自动传播，
  栈检查与上下文检查两条判据并存。

### Fixed

- **UI Token 存储的并发丢 Token**（`src/ui-modules/auth.ts`）。`saveToken`/`deleteToken`
  是读-改-写，并发登录时后写者会覆盖先写者（实测 6 并发登录丢 5 个 token）。
  改为内存缓存 + 串行写队列：写操作入队串行执行、落盘成功后才提交内存；
  用文件 `(mtime,size)` 做失效判断，因此外部修改与删除仍立即可见
  （「删 `configs/token-store.json` 强制全员下线」的运维手段保持有效）。
  `writeTokenStore` 不再吞掉写盘错误，登录接口能正确返回 500。
- **Master 进程的 restartCount 永不重置**：worker 每次崩溃配额只增不减，累计 10 次后
  永久放弃守护。现在 worker 上报 `ready` 时归零。
- **管理端口 `EADDRINUSE` 导致整个网关起不来**：补 `server.on('error')`，
  端口被占用时管理 API 降级禁用，worker 照常启动。
- **未鉴权即可制造 unhandledRejection**：`new URL(req.url, http://${req.headers.host})`
  在空/畸形 Host 下抛错。现在兜底 `host || 'localhost'` 并返回 400。
- **`/provider_health` 的 `identify` 可能泄露凭据路径**：原先拼进的是 OAuth 凭据文件路径
  （含邮箱）。改为 sha256 前 8 位短标识，既让同名兄弟节点可区分，又不泄露路径。
  另修正 `unhealthySummeryMessage` 拼写，新旧两个键双写以兼容既有消费方。
- **号池选点在脏数据下的不确定行为**（`src/providers/provider-pool-selector.ts`）：
  `calculateNodeScore` 在 `lastUsed` 为非法日期、`_lastSelectionSeq` 为非数值时返回 `NaN`，
  而 `NaN` 参与比较恒为 false，会让比较器失去传递性。现在把 `NaN` 确定化为「最差」。
  同时外提循环不变量、以一次线性扫描取代全量排序（10 节点实测 10.3 → 5.3 µs）。
- `normalizeProviderErrorMessage` 之外的 `service-manager` 原型检查改用 `Object.hasOwn`。

### Changed

- **策略工厂改为单例复用**（`src/utils/provider-strategy-factory.ts`）：5 个策略类
  实测零实例字段，流式响应每个 chunk 都会取一次策略，改为复用单例。
  用 `Object.hasOwn` 判定，避免 `__proto__` / `constructor` 等原型键命中。
- **移除 `globalThis` 跨模块通信**：health check 定时器的三个全局属性
  （`reloadHealthCheckTimer` / `stopHealthCheckTimer` / `_activeHealthCheckInterval`）
  收敛到新模块 `src/services/health-check-scheduler.ts`，由 `api-server-core` 与
  `config-api` 共同依赖。直接互相 import 会形成运行时环（`check:cycles` 会拦下）。
- 清理 `convert.ts` 废弃的 `modelList` JSDoc 重载与 `api-server-core.ts` 注释残留代码。

### Breaking

- **管理端点现在需要鉴权**：任何调用 `/master/status`、`/master/restart`、
  `/master/stop`、`/master/start` 的脚本或运维习惯都会从 `200` 变为 `401`。
  迁移方式：从启动日志或 `configs/.master_secret` 取得 secret，请求时带上
  `Authorization: Bearer <secret>`。`/master/health` 保持公开，无需改动探活配置。
- **管理端口默认只监听回环**：容器场景若需从宿主机访问管理 API，需显式设置
  `MASTER_HOST=0.0.0.0` 并发布对应端口（现有 `docker-compose.yml` 未发布 3100，
  因此默认部署不受影响）。

## [Unreleased]

## [v8.6.0] - 2026-11-08

清理死代码与冗余并发锁，净删 791 行。**无破坏性变更、无配置迁移**。

### Changed

- **移除号池选点的冗余互斥锁**（`_selectionLocks` / `_isSelecting`）。
  被包裹的 `selector.select()` 是纯同步函数（内部无任何 `async`/`await`），
  Node 单线程下「检查 + 更新」本身即原子，原锁里的 `await setImmediate` 轮询
  只会让每个并发请求多等一帧事件循环。40 并发混合请求实测 **40/40 成功、4.9s**。
- 删除无调用方的 `roundRobinIndex` / `findProviderByUuid` /
  `isAllProvidersUnhealthy` / `getProviderStats` 及两个透传方法。
- 删除 `src/ui-modules/system-monitor.ts`。
- `config.json.example` 移除 `providerFallbackChain` / `modelFallbackMapping`
  （引用的是 v8.0.0 已移除的 `claude-kiro-oauth`）与 `SYSTEM_PROMPT_*`
  （源码已无引用），新部署不再复制死配置。

### Fixed

- `request-pipeline` 错误负载用显式结构替代 `Record<string, any>`，
  上游透传部分用 `unknown`；`api-manager` 的 `(p: any)` 改为 `(p: ProviderStatus)`。
  两处使 `check:any` 棘轮门禁恢复绿（234 annotations，回到基线）。

### Verification

- 单元测试 **90 suites / 949 tests** 全绿
- 13 项门禁全部通过：typecheck / typecheck:plugins / typecheck:webui /
  check:strict / check:any / check:imports / check:cycles / lint:css /
  metrics:types / gen:webui-html:check / vendor:webui:check /
  test:coverage / check:coverage / test:runtime
- 全量 E2E **33/33**（8 个模型 × 11 项核心跨协议矩阵），exit 0
- 类型债务：`DynamicPayload` 引用 **1549 → 1326（−14%）**

## [v8.5.0] - 2026-11-07

按 token 售卖套餐。采用**预扣 + 结算**防止并发超卖
（旧实现「请求前检查、请求后记账」，超卖上界 ≈ 并发数 × 单请求 token 上限）。

### Added

- 套餐目录：**1 / 2 / 5 / 10 亿 token** × 周期 **一周 / 一个月**（一个月按日历月顺延，
  1 月 31 日 + 1 月正确落到 2 月末）
- `reserveTokens()` / `settleTokens()`：转发前原子预扣，结算按真实 usage 多退少补
- 每日 token 速率保护（`dailyTokenCap`）、续期不损失剩余天数
- 管理 API：`GET /api/potluck/plans`、`POST /api/potluck/keys/plan`（设置/续期/移除）

### Fixed

- 非生成类请求（`GET /v1/models`、`count_tokens`）不再预扣，避免额度永久泄漏
- 上游失败 / 前置校验失败 / 客户端断连时全额退还预扣
- 流式首帧缓冲后失败（如 502）也正确退还，不再按"防白嫖"误扣
- 无 usage 时按预扣值计费，防止构造空响应白嫖

## [v8.4.0] - 2026-11-07

### Fixed

- 客户端请求错误改返回 **4xx**：不存在的模型 500→400、缺 `messages` 502→400
  且耗时从「烧掉 5 次上游重试」降到 **13 ms**
- `mergeUsage` 在多字段缺失时产生 `NaN`，导致 potluck 缓存命中统计恒为 0

### Added

- 统计页支持**按日 / 按模型**查看，日历可点击切换日期，新增历史累计按钮
- 表格新增**缓存命中率**列；`daily[date]` 增加 `models` 子维度并兼容旧数据

## [v8.3.0] - 2026-11-07

### Changed

- 解耦 `maxSockets` 与会话亲和：实测单 socket **无缓存收益**
  （trace 复用真实发生下 97.23% vs 97.23%），同会话并发快 **3.26 倍**；
  保留 `keepAlive: true` / `maxFreeSockets: 1`
- 移除无收益的会话→节点粘滞表，负载均衡 49.7/50.3 → **50.0/50.0**

### Fixed

- 连接池驱逐不再掐断在途流（仅空闲时销毁，容量 100→256 + 真 LRU）
- 按可达性决定是否强制 `proxy:false`（codex 的 `chatgpt.com` 只能经代理访问）
- `invalidateKeepAliveAgents` 支持 uuid 前缀失效
- `usage-normalizer` 混合形状重复计数与伪造 `total_tokens`

## [v8.2.0] - 2026-11-06

多轮 KV Cache 稳定性与前缀缓存命中率全面提升。**无破坏性变更、无配置迁移、公开 API 零改动**。
本版本重点解决跨多轮复杂智能体（如 DeepSeek Harness、Claude Code、Cursor 等）执行场景下「前缀缓存命中率断崖式下跌」与「号池多账号轮询导致缓存清零」的问题。
实测 DeepSeek Harness 12 步自主任务，整体 KV 缓存命中率达到 **93.13%**，后半程单步缓存率稳定保持在 **96.7% ～ 99.7%**。

### Fixed

- **全链路 SSE 流式 UTF-8 字符解码防跨块乱码**：在 `openai-core`、`openai-responses-core`、`codex-core`、`claude-core`、`zed-core` 等所有 SSE 流式读取器引入 `StringDecoder('utf8')`，并使用 `Buffer.concat` 代替原生字符串拼接，杜绝多字节 UTF-8 中文字符跨 chunk 分割时被替换为 `\ufffd` 导致的下游 Assistant 历史消息前缀断裂。
- **0-Hop 直通路径工具 Schema 深度稳定化**：在 `openai-core` 与 `claude-core` 的直通调用入口（`callApi` 与 `streamApi`）中接入 `stabilizeToolsForPrefixCache`，对入参 tools 数组按 `name` 排序并对 `parameters`/`input_schema` 的 properties 递归排序，防止客户端工具动态注册或 JSON 键乱序引发的前缀缓存抖动。
- **全局会话级单 Socket 亲和性保活**：在 `proxy-utils.ts` 中解除单连接亲和性仅限本地与 Trae 的限制。只要请求存在会话标识（`x-session-affinity` / `session-id` 或网关基于首轮摘要派生的会话种子），即分配并绑定专用 Keep-Alive 单 Socket Agent，避免多轮请求在全局多 Socket 池中随机漂移到不同的后端 L4 Pod。
- **号池多账号节点会话粘滞（Session Stickiness）**：在 `ProviderPoolSelector` 中新增基于会话 ID 的 LRU 亲和性映射表（`_sessionNodeMap`）。同一会话的多轮交互在原节点健康且未达并发上限的情况下，始终固定在同一个账号/节点上，彻底解决多账号号池由于 LRU 轮询导致每轮请求在不同账号间交替、上游 KV 缓存归零的问题。
- **Zed 协议确定性 `thread_id` 派生**：在 `zed-payload-builders.ts` 中，将每轮无条件生成的随机 `thread_id: randomUUID()` 改为通过 `toValidUUID(sessionId)` 从下游会话确定性派生，保证多轮交互在上游始终位于同一会话流。
- **内部调度属性深度隔离与 Google / OpenAI 原生协议兼容**：在所有提供商发往真实上游前，统一深度剥离网关注入的内部 `_` 调度标记（如 `_downstreamSessionId`、`_monitorRequestId`、`_requestBaseUrl` 等），彻底解决 Google Antigravity 原生 Protobuf 报错 `Invalid JSON payload received. Unknown name "_downstreamSessionId"` 以及 OpenAI Responses API 报 `400 Bad Request: Unsupported parameter` 的阻断性兼容问题。
- **跨 Provider 会话缓存绑定支持**：利用提取的 `downstreamSessionId` 派生 Antigravity 的 `generateStableSessionID` 与 Codex 的 `prompt_cache_key`，实现跨提供商多轮前缀缓存。

## [v8.1.0] - 2026-11-04

缓存命中率统计口径修复与隐式前缀缓存对齐。**无破坏性变更、无配置迁移、公开 API 零改动**。
本版本解决「缓存命中率显示只有约 30%」的问题：其中约 1/3 是统计口径失真，约 2/3 是
网关侧可消除的前缀失效（完整分析见 [`docs/CACHE_HIT_RATE.md`](docs/CACHE_HIT_RATE.md)）。

### Fixed

- **统一缓存命中统计口径**：`usage-normalizer` 此前把两种互斥语义塞进同一个
  `promptTokens` 字段——OpenAI / Responses / Gemini 的 `prompt_tokens`、
  `promptTokenCount` 是 inclusive（已含缓存），而 Anthropic Messages 的
  `input_tokens` 是 exclusive（不含缓存）。由于命中率 = `cached/prompt`，
  Anthropic 形状的行分母偏小、比值虚高，生产日志中 `trae` 有 **15.1%** 的行
  出现 `cached > prompt` 这种不可能值。现按「顶层是否出现 `cache_*` 字段」
  判别语义（不可用「有没有 `input_tokens`」——Responses API 也给 `input_tokens`
  但它是 inclusive），把 exclusive 归一为 inclusive 总量；`totalTokens` 同步补齐。
- **`zed-core._formatClaudeUsage` 方向修正**：该路径需要 Anthropic **exclusive**
  语义，故把缓存从总量中扣回（`input_tokens = total - cacheRead - cacheCreation`），
  避免下游重复计数。
- **`trae` 直通路径补齐 tools 稳定排序**：`sortToolsByName` 及其开关
  `CONVERT_SORT_TOOLS`（默认开启）此前只在 Converter strategies 内部被调用。
  而 `trae` 走 1-Hop（`resolveBridgePlan` 对 trae 恒 `needsConversion=false`）、
  `codex` 走 0-Hop、`zed` 直通，这三条路径不进 Converter，排序开关对它们
  **静默失效**。上游使用隐式内容前缀缓存（按 token 前缀哈希），tools 位于 prompt
  很靠前的位置，客户端（尤其 MCP / 多 sub-agent 并发组装）每轮顺序不同即导致
  其后整段内容失去可复用前缀。
- **`trae` 移除透传的顶层 `system`**：Claude 分支此前只删 `max_tokens`，
  `system` 已由 `claudeRequestToTraeMessages` 拍平进 `messages[0]`，顶层重复透传
  还会把客户端的 `cache_control:{type:'ephemeral'}` 噪声带给上游（trae 不吃显式缓存）。
- **`trae` 清理 `_` 前缀内部字段泄漏**：`request-pipeline` 注入的
  `_monitorRequestId` / `_requestBaseUrl` 为可枚举赋值，会被 `{ ...requestBody }`
  浅拷贝带进上游 body，而其余 Provider 均已显式删除。

### Added

- `converters/utils.ts` 新增 `stabilizeToolsForPrefixCache()`：按 name 稳定排序 +
  对 `function.parameters` 做递归 JSON 键序归一，消除「同一份 schema、键插入顺序不同」
  导致的字节差异。兼容 `{name}` 与 `{type,function:{name,parameters}}` 两种包装。
- `converters/utils.ts` 新增 `sortJsonKeysDeep()`：递归按字典序重建对象键顺序
  （数组保持元素顺序），让语义等价的 JSON 产出逐字节一致的序列化结果。
- `docs/CACHE_HIT_RATE.md`：记录该问题的完整分析——上游隐式前缀缓存机制、
  两类根因、位置敏感性实测、网关侧修复清单、客户端侧配合约定与排查流程。

### Changed

- **三条直通路径接入 tools 稳定化**：`trae-core`、`codex-core`（0-Hop）、
  `zed-payload-builders`（三处 tools 构建点）。
- `sortToolsByName` 的 `localeCompare` 改为码点比较：`localeCompare` 受进程
  locale/ICU 影响，同一份 tools 在不同机器上可能得出不同顺序，反而破坏前缀缓存稳定性。
- `docs/CROSS_PROTOCOL_ARCHITECTURE.md`：第 5 节缓存约束补明上游实际使用隐式前缀
  缓存、直通 Provider 亦需请求侧稳定化；第 6 节文档入口登记新文档。

### Removed

- 清理 `review/` 下 56 个审计中间产物（53 个原始抓包与 3 份分析报告），
  知识已固化进 `docs/CACHE_HIT_RATE.md`。

### Verification

- `npm run typecheck`：**0 errors**。
- `npm test`：**86 suites / 879 tests 全部通过，0 失败**。
  v8.0.0 基线为 85 suites / 862 tests 全绿；新增 1 个测试文件、17 个用例。
- 口径验证：`cached > prompt` 行占比 **15.1% → 0%**；Claude 与 OpenAI 两种下游
  协议的命中率恢复可比（修复前 Claude 路径显示成 400%+）。
- tools 验证（trae，10 个 tools，其余请求全同）：每轮乱序命中率
  **18.0% → 75.4%**，与顺序稳定时的 75.6% 持平。
- 真实流量复检：`trae` 命中率 **75.2%**。

### Fixed (发布前回归修复)

> 首发版本曾引入 1 处回归：Codex 0-Hop 路径把网关注入的无名 `web_search` 工具
> 一并纳入排序，因取不到 name（空串码点最小）而被排到 `tools[0]`，把客户端原有
> 首工具挤到 `tools[1]`，导致 4 个 `phase3-providers` 用例失败
> （`Cannot read properties of undefined (reading 'length')` 等）。
>
> 修复：先对「客户端的工具」稳定化，再追加网关注入的 `web_search`，使其固定
> 位于末尾、不参与排序。修复后该测试套件恢复 27/27，全量 879/879。
>
> 同时修正 `stabilizeToolsForPrefixCache` 只处理嵌套 `function.parameters` 的
> 缺陷——Codex / Zed 使用扁平 `parameters` 或 `input_schema`，此前 schema 键序
> 归一在这几处静默失效，现已覆盖三种形状。

## [v8.0.0] - 2026-11-03

彻底移除 Kiro provider（`claude-kiro-oauth`）。**这是破坏性变更**：
该 provider 不再可用，已配置的 Kiro 节点将不再被加载。

### ⚠️ Breaking Changes

- **移除 `claude-kiro-oauth` provider**：删除其核心服务、OAuth 流程、
  协议转换器、流解析器、适配器注册、UI 入口、用量查询与配置模板。
  `provider_pools.json` 中的 Kiro 节点需迁移到其他 provider。
- **移除相关 API 端点**：`/api/kiro/batch-import-tokens`、
  `/api/kiro/import-aws-credentials` 不再存在。

### Removed

- 删除 10 个 Kiro 专有文件（服务、OAuth、请求构建、流解析、状态机、
  AWS 凭据导入弹窗与纯函数、3 个测试文件）。
- WebUI：`AuthDialog` 移除 5 种 Kiro 认证方式与 `aws-import` 步骤；
  `provider-registry` / `provider-fields` / `routing` / `providers-utils` /
  `ProviderManagerModal` 移除 Kiro 条目；中英 locale 各移除 54 个 key；
  删除 334 行 AWS 导入样式与 `.tag-kiro-oauth` 徽章样式。
- 文档：README 中英各删 2 章（共 92 行），`OPENCODE_CONFIG_EXAMPLE.md`
  示例改用 `claude-custom`，`provider_pools.json.example` 移除 28 行模板。

### Changed

- `oauth-shared.ts` 移除仅为 Kiro 服务的 `showDebugHint` / `logMessage` 选项
  （唯一调用方 Gemini 未使用）。
- `provider-pool-manager.ts` 移除 Kiro 专属健康检查 `max_tokens: 1` 特例。
- 依赖 Kiro 的测试改用仍维护的 provider，覆盖意图保持不变。

## [v7.0.0] - 2026-11-03

运行基线收紧为 Node.js 24+。**这是破坏性变更**：Node.js 22 及更早版本将拒绝启动。

> 本版本同时并入 v6.3.0 的后端优化内容（该数字版本号未在 GitHub 单独发布）。

### ⚠️ Breaking Changes

- **不再支持 Node.js 22**：`engines` 由 `^22.18.0 || >=23.6.0` 收紧为 `>=24.0.0`。
- **启动时新增真实主版本校验**：此前只探测 `process.features.typescript`，
  而 Node 22.18+ 与本项目基线在类型擦除能力上**完全一致**，会导致 22.x 静默通过。
  现在入口会在加载应用模块图之前校验主版本，低于 24 直接退出并给出升级提示。
- `.nvmrc` 由 `22` 改为 `24`。
- Dockerfile 基础镜像由 `node:22-alpine` 升级为 `node:24-alpine`。
- CI 矩阵由 `[22.x, 24.x]` 改为单版本 `24.x`（13 个检查步骤的执行次数减半）。

### Removed

- **移除 `dotenv` 依赖**：改用 Node 内置 `process.loadEnvFile`，
  新增 `src/services/env-loader.ts` 封装。语义与 dotenv 对齐：
  `.env` 缺失时静默跳过（原生 `loadEnvFile` 会抛 `ENOENT`）、不覆盖已存在的环境变量。

### Changed

- `src/core/master-core.ts`、`src/utils/tls-sidecar.ts` 改用 `import.meta.dirname`，
  移除 `fileURLToPath(import.meta.url)` 的间接转换（后者保留 try/catch 兜底语义）。
- `README.md` / `README-ZH.md` / `install-and-run.sh` / `install-and-run.ps1`
  的版本要求与提示文案同步为 Node.js 24+。

### Added

- `tests/runtime-check.test.js` 扩展：主版本解析、低于 24 拒绝、
  以及**入口级**伪造 `v22.18.0` 的快速失败验证。
- `tests/env-loader.test.js`：`.env` 缺失静默跳过、不覆盖已有变量、
  自定义文件名（因 Jest 的 `process.env` 为隔离副本，注入语义在子进程中验证）。

## [v6.3.0] - 2026-11-03

跨协议转译的跳数收敛与准确性修复。**无破坏性变更、无配置迁移、公开 API 零改动**。

### Changed

- **跳数收敛**：`openai-codex-oauth` 由 `1-Hop / 1-Hop / 1-Hop` 收敛为
  `1-Hop / 0-Hop / 1-Hop`；`trae` 与 `trae-chat_v3` 由 `1-Hop / 2-Hop / 2-Hop`
  收敛为 `1-Hop / 1-Hop / 1-Hop`。改为「下游 `/v1/responses` 直通 Codex」
  与「Trae 三端直接产出下游协议」，去掉中间 OpenAI 协议转换层。
- 管道层引入显式「桥接计划」（`resolveBridgePlan`），把「是否需要转换」从
  「协议前缀不同」升级为可推理的计划表，避免 0-Hop / 1-Hop 场景误走 `convertData`。
- **Codex 方言清洗内聚到 Provider**：`input` 字符串/数组归一、`system`→`developer`、
  已提取 `instructions` 时过滤重复 system 消息、`text.format` 字符串归一、
  剔除 `temperature` / `top_p` / `user`。清洗幂等，1-Hop 路径重复执行无副作用。
- **工具名缩短/还原归属改为「谁缩短谁还原」**：0-Hop 时由 Provider 自己维护映射
  （挂在请求体不可枚举属性上，不会发往上游），1-Hop 时仍由 Converter 负责，
  杜绝双重缩短与双重还原。
- **Trae 三协议入参一步归一**：Responses 的 `instructions` + `input`、Claude 的
  `system` + content blocks 直接构造 Trae 私有 messages/tools，
  `tool_result` 提升为独立 `role: 'tool'` 消息，`parameters` 序列化为 JSON 字符串。
- `DynamicPayload`（`Record<string, any>` 逃生舱）引用从 1549 收敛到 1506，
  为新增的 Provider 协议结构定义具名类型（`TraeMessage` / `AntigravityStreamFrame` 等）。

### Fixed

- `CodexConverter` 非流式响应只取首个 `output_text` 块、多段输出用覆盖而非累加，
  导致长回答被截断；现改为 filter + join 累加（跨 item 用换行分隔）。
- `CodexConverter` 流式忽略 `response.reasoning_text.delta`，且 `toOpenAIStreamChunk`
  未处理增量工具参数；补齐 reasoning 分支，并增加 `output_item.added` /
  `function_call_arguments.delta` / `output_item.done` 三段式增量工具调用。
- `GeminiConverter` 非流式忽略内联图片（`inlineData` / `inline_data`），
  导致生图结果在非流式路径丢失；新增 `normalizeInlineData` 并收口四条路径。
- `ZedApiService` 非流式聚合忽略 `signature_delta`，导致 thinking 块缺签名；
  现累加签名并在真有时写入。
- `TraeApiService` 聚合工具调用对同名多帧执行 `+=`，拼成 `get_weatherget_weather`；
  改为仅在名称为空时赋值。
- **生图/改图路由不再把 `provider:model` 前缀泄漏给上游**：
  `/v1/images/generations` 与 `/v1/images/edits` 此前用原始模型 ID（含 `provider:`）
  调用 Provider，`[Antigravity] 模型不存在: gemini-antigravity:xxx` 必然 500；
  现与对话路径对齐，同步 `result.actualModel`。
- Codex 0-Hop 的历史 `input` 中的超长工具名（>64 字符）此前未缩短，
  多轮对话会被上游拒绝；现从 `input` 历史一并收集并改写。
- Trae 1-Hop 的空 `tool_result` / `function_call_output` 会产出空 content 数组
  被上游 400；统一兜底为 `[{ type: 'text', text: '' }]`。
- Trae 1-Hop 的 Claude 非流式 thinking 块缺 `signature`；现按与其它 Provider
  一致的语义铸造虚拟签名。
- 管道层 `extractPromptText` / `_applyCustomModelParameters` 支持 `protocolOverride`，
  避免 0-Hop/1-Hop 跳过 Converter 后按错误协议解析请求体。

### Performance

- Antigravity SSE 热路径每帧由「`filterSSEUsageMetadata` 的 `JSON.parse` +
  `JSON.stringify`」加二次 `JSON.parse` 降为**单次解析**，改为对象级剥离
  `usageMetadata`；顺带修正原实现 `slice(6)` 错切 `data: ` 前缀的缺陷。
- Antigravity 非流式聚合消除三重 JSON 往返：`convertStreamToNonStream` 可直接
  消费已解析对象数组，去掉 `stringify` → `join` → `split` → `parse`。
- Antigravity 请求构建深拷贝从**最多 4 次降为 1 次**：非流式回退判定前移到建包之前，
  回退时复用同一份 payload（含 Base64 图片时显著减少主线程阻塞）。
- Trae 请求体入口移除全量深拷贝，改为浅拷贝。
- Converter 会话级状态驻留治理：`buildToolNameMap` 仅在确有工具名被缩短时写入；
  非流式出口与流终止路径主动释放；管道层 `finally` 统一调用 `clearCustomTools`。

### Security

- 封堵插件通过 `Error.stackTraceLimit = 0`、负值或劫持 `Error.prepareStackTrace`
  清空调用栈、绕过 `fs` 写保护沙箱的路径；取栈时临时抬升到安全下限并还原现场，
  补充子进程回归用例。
- 移除 `src/plugins-user/` 下 12 个越权写文件的安全审计 PoC 插件及其配置条目。
- 删除 6 个单行 `.js` 转发桩，`src/plugins/` 下 import 统一指向 `.ts`。

### Removed

- 删除 8 个冗余测试文件（`api-integration`、`import-integrity`、`static-syntax`、
  `static-import-graph`、`webui-ui-importmap`、`error-helper-regression`、
  `playground-interfaces.e2e`、`custom-model-metadata.e2e`）。
  其中 `error-helper-regression` 含唯一覆盖插件市场降级回退的用例，
  该断言已迁移至 `tests/plugin-installer-market.test.js` 后再删除；
  `webui-ui-importmap` 的 modulepreload / sourcemap 断言并入 `webui-html-shell`。
- 移除 `package.json` 的 `test:integration` 脚本（其唯一引用方已被删除）。

### Added

- `tests/regressions/bridge-plan.test.js`：锁定 hop 矩阵与协议覆盖行为。
- `tests/regressions/phase2-*.test.js`（80 例）、`phase3-providers.test.js`（24 例）：
  覆盖 5 项转译修复、4 项热路径优化与 Provider 三协议 1-Hop 契约。
- `tests/image-route-model-prefix.test.js`：锁定生图路由的模型前缀解析。
- `tests/e2e-model-auxiliary-isolation.test.js`：通用矩阵排除仅用于图像用例的辅助模型。

## [v6.2.0] - 2026-11-02

WebUI「美观与简洁」的第二轮优化与样式架构深化。**无破坏性变更、无配置迁移、公开 API 零改动**。
以「不必过度追求 UI 保持原样」为前提，把省下来的地方从"像素完全不变"换成
"更统一 + 更少代码"，并把每一处视觉变化都落进计算样式契约的 diff 里。

### Added

- `--space-1..--space-20`（2px 网格）与 `--text-xs..--text-2xl`（7 档）设计尺度令牌。
- `components/PasswordInput.js`：通用密码输入组件（仅编辑态支持回读明文、展开期间强制只读，保证密码安全）。
- `lib/api.js#downloadBlob`：通用 Blob 文件下载辅助函数，统一各页面下载触发逻辑。
- `lib/sse.js#streamBatchImport`：统一封装 POST + SSE 批量导入与鉴权错误解析。
- `components/DistributionList.js`：支持自定义格式化函数与空状态插槽，并在 `model-usage-stats.js` 中复用以淘汰重复的局部条形图实现。
- `scripts/webui-html-shell.mjs` + `scripts/gen-webui-html-head.mjs`：5 份 HTML 的
  import map 与主题引导脚本的单一真源；`npm run gen:webui-html:check` 纳入 `verify`。
- `lib/page-boot.js`：4 个独立页共用的启动器（收敛 4 份逐字重复的 `boot()`）。
- `lib/credential-api.js`：插件页的凭证请求封装（保留 `auth: 'bearer'|'dual'` 差异）。
- `hooks/useResource.js`：带加载/错误/重载三态的取数 hook。
- `store/toast.js#toastError`：69 处「标题恒为错误」的统一入口。
- 新增护栏测试：`ui-static-assets`、`webui-html-shell`、`ui-design-scale`、
  `webui-api-client`、`webui-page-boot`、`webui-no-hardcoded-color`、`ui-mobile-scope`。

### Changed

- **首屏传输量 312.4 KB → 101.6 KB（-67.5%）**：`vmcard.png`（216 KB / 1280×420，
  实际只渲染 100×33 px）与 `packycode.png` 改为 360 宽 webp（4.3 KB / 4.0 KB）。
- 5 张只被 README 引用的图（305 KB）移到 `docs/assets/sponsors/`；`static/` 1.8 MB → 1.3 MB。
- **字号从 39 种有效取值收敛到 7 档**（密集 UI 10–18px）；圆角全部走 `--radius-*`；
  gap 走 2px 网格；px/rem 写法统一。82 条字号变化最大偏移 0.85px。
- **mobile.css 拆分与瘦身**：单 section 响应式规则回迁入各自 section 文件，
  `mobile.css` 体积从 29.6 KB 降至 17.9 KB（br 3.9 → 2.9 KB）。
- **共享原子类上收与解耦**：密码框（`.password-input-wrapper` / `.password-toggle`）与开关（`.toggle-switch` / `.toggle-slider`）收拢至 `shared.css` 权威定义，`lib/section-styles.js` 解除跨模块隐式依赖。
- **各面板与独立插件页样式去重**：`alignment.css` 剥离页面专有规则并回迁；`plugin-shared.css` 统一作为 potluck、potluck-user 与 model-usage-stats 的共享底座。
- **业务弹窗与下载逻辑规范化**：`plugins.js` 统一接入 `Modal` 组件；`upload-config` 与 `usage` 下载接入 `downloadBlob`；`AuthDialog` 与 `KiroAwsImportModal` 接入 `streamBatchImport`。

### Fixed

- **控制台首屏在系统深色下闪白**：`index.html` 的主题引导脚本漏了
  `prefers-color-scheme` 回退分支（其余 4 份 HTML 都有）。copy-paste 漂移所致。
- **`lib/api.js` 的 `get/post/put/delete` 丢弃 `options.headers`**：
  `RequestOptions` 类型里声明了 headers，只有 `request()` 真正合并。
- **JS 内联样式里 7 处硬编码颜色**（`#10b981`/`#ef4444`/`#9ca3af`/`#94a3b8`/`#fff`）：
  颜色令牌化此前只扫 CSS，暗色主题下这些不可控。
- **移动端 Header 菜单的脆弱耦合**：JS 写内联 `display`、CSS 用 11 条
  `[style*="display: flex"]` 子串匹配去捞——内联样式一旦被格式化就整块失效。
  改为 `.is-open` 类，顺带去掉 2 条 `!important`。

### Removed

- `base.css` 里「统一卡片圆角」聚合规则（死代码：CSSOM 置空后 6 个 section 的
  computed style 零变化）与 3 个被更晚同名规则完全覆盖的早期副本；清理未使用的颜色与状态变量。
- `potluck.css` 中与 `plugin-shared.css` 逐字节相同的 47 条规则。
- `model-usage-stats.js` 冗余的局部 `Bars` 条形图实现。
- `lib/section-styles.js#__resetSectionStyles`（无引用）。

## [v6.1.0] - 2026-11-02

WebUI 样式体系的整体重构。**无破坏性变更、无配置迁移、公开 API 零改动**，
但 WebUI 首屏传输量降到约一半，并补齐了一整套 CSS 自动化护栏。

### Added

- **计算样式契约**（`tests/webui-e2e/style-contract.spec.js` + `style-contract.json`）：锁定 4 个断点（390/768/1024/1440）× 明暗 2 主题 × 10 个页面、共 80 个组合的关键选择器计算样式。截图比对受字体度量与抗锯齿影响、跨机器不稳定；计算样式跨机器确定，失败信息直接指出「哪个断点/主题/页面 的 哪个选择器 的 哪个属性 期望→实际」。基线随代码一起 review，更新基线时的 diff 就是样式改动清单。
- **CSS 护栏测试**：`ui-css-order`（样式表分层顺序）、`ui-css-tokens`（令牌完整性：所有 `var()` 的令牌都有定义、无写死 fallback）、`ui-css-scoping`（作用域化约束）、`ui-static-compression`（br/gzip 协商与 ETag 分编码）、`ui-dashboard-system-info`（系统信息面板结构）。
- **stylelint 接入**（`npm run lint:css`）：只启用在现有代码上能确定性判定的规则，纳入 `npm run verify` 与 CI。
- 新增 `pages/plugin-shared.css`：收敛 `potluck.html` / `potluck-user.html` 两份逐字节相同的公共样式（55 条规则、3 个响应式断点）。

### Changed

- **静态资源启用 br/gzip 压缩**：项目无构建步骤，CSS/JS 以源码直出，而服务端此前完全没有压缩——单个 32.6 KB 的文件就传 32.6 KB。现在按 `Accept-Encoding` 协商（解析 q 值）、按 (路径, mtime, size) 缓存压缩结果、ETag 带编码后缀避免 br 与 gzip 串味、补 `Vary`。实测首屏样式表 236.8 → 53.0 KB、脚本 186.7 → 75.5 KB，首屏合计 **665.1 → 368.1 KB（省 45%）**。
- **各页面样式改为按需加载**：`index.html` 原本一次性加载全部 11 份 section CSS（gzip 后约 29 KB，占首屏 CSS 的 63%），大部分首屏用不到。现在复用已有的 section 懒加载机制，切换页面时才插入对应样式，进入任一页面的 CSS 从 53.0 KB 降到 **26.9~28.6 KB**（静态引用文件数 17 → 6）。
- **颜色令牌化**：组件/页面 CSS 里 196 处十六进制颜色字面量中，58 处改为引用 `base.css` 已定义的语义令牌，并删除 26 处冗余的 `var(--x, <写死值>)` fallback。字面量降到 115 处；全部 1681 处 `var()` 引用零 fallback、零未定义令牌。
- **插件页样式去重**：`potluck-user.css` 移出与 `potluck.css` 重复的 55 条规则，12.2 KB → 5.8 KB。
- **表单原子类收敛到 shared 层**：`.form-group` / `.form-row` / `.form-group label` / `.form-control::placeholder` 此前在 `section-config.css` 与 `section-providers.css` 里各有一份逐字节相同的副本，现在统一上收到 `shared.css` 作为唯一权威定义；各 section 只保留差异覆盖。
- **减少 `!important`**：47 → 38。删除的 9 处都是「同块内更晚位置或更高特异性本就能胜出」的冗余；保留的 38 处逐条核对为必要（无障碍 `prefers-reduced-motion` 标准写法、`@media print`、对抗 JS 写入的内联 style，以及媒体查询前置导致的结构性需求）。
- **仪表盘系统信息精简**：去掉「CPU 使用」，剩 6 项重排为 3 列 × 2 行——上排「运行时间 / Node.js 版本 / 版本号」，下排「内存使用 / 运行模式 / 进程 PID」。CSS 从「12 栏 + `nth-child(-n+3)` 特例」简化为三等分，散落两处的「超窄面板单列」容器查询合并为一处。列数仍由容器查询按面板实际宽度自适应（≥470px 三列、默认两列、<299px 单列）。
- **删除死样式**：旧二维码 `<img class="qr-code">` 系列、已下线的系统提示词替换 UI 规则，共约 89 行。
- **`alignment.css` 去掉 21 处多余的 `body` 前缀**：该文件本就最后加载，靠加载顺序即可胜出；加 `body` 只是把特异性从 (0,1,0) 抬到 (0,1,1)，让后续覆盖更难。
- locale 词典由 741 条收敛至 740 条（删除 `dashboard.cpuUsage`，中英保持对齐）。

### Fixed

- **移动端样式整体失效**：`mobile.css` 是纯 `@media` 层，却被排在 `index.html` 的组件样式**之前**，导致每条移动端媒体查询都被后面同等特异性的组件规则覆盖。390×844 实测 `.header-content` 的 padding 是桌面的 `12px 32px` 而非预期的 `8px 12px`、`.header h1` 是 `20px` 而非 `14px`——属性级统计显示 `mobile.css` 的 290 条声明里 **170 条失效**。现已调整到全部组件样式之后（桌面端实测计算值完全不变）。
- **登录页样式层叠反了**：`login.css` 排在 `base.css` 之前，页面样式被基础层反压。
- **`base.css` 里 `.form-control` 重复定义**：一处定义完整样式（底色 `--bg-secondary`），另一处又覆盖 `background: var(--bg-primary)`。后者是历次修改叠加的副作用而非设计意图，已合并为一处并恢复 `--bg-secondary`。
- **跨页样式污染**：`upload-config` 与 `config` 页从未定义自己的输入框尺寸，一直在用 `section-providers.css` 泄漏过来的样式（2px 边框 / 8px 圆角）。providers 的紧凑表单样式改用 `#providers` 作用域收敛后，这两页显式声明了各自需要的尺寸。
- **`--danger-hover` 令牌用了但从未定义**（靠内联 fallback 兜底），现已补齐亮/暗两份定义并移除 fallback。
- **冗余样式表引用**：`model-usage-stats.html` 的 `mobile.css` 位置不当，已移到页面样式之后。

### Removed

- 删除已无消费方的 CPU 采样：`GET /api/system` 不再返回 `cpuUsage` 字段，也不再每次请求执行 `process.cpuUsage()` / 调用外部命令（这是 WebUI 内部接口，不影响 OpenAI / Claude / Gemini 对外协议）。

### Verification

- `npm test`：**77 suites / 885 tests 全绿**（重构前 72/854）。
- WebUI E2E：**53/53 通过**（重构前 42），含新增的计算样式契约 8/8 与移动端面板切换 3/3。
- `npm run verify`（typecheck / plugins / strict / any / imports / cycles / **lint:css** / coverage / runtime smoke）、`typecheck:webui`、`vendor:webui:check` 全部通过。
- stylelint：0 error（`no-duplicate-selectors` 以 warning 呈现，50 条为已知的结构性分层）。
- Font Awesome 子集 **137 icons** 不变。


## [v6.0.1] - 2026-10-31

### Fixed

- **插件页的插件入口链接恢复可点击**：插件描述里用相对路径指向自身页面（如 `<a href="potluck.html">`），而 `sanitizeHtml` 的链接白名单只接受 `/` 开头的绝对路径与 `http(s)`/`mailto`，相对路径被判定为不安全并移除了 `href`——包含 `potluck.html`、`potluck-user.html`、`model-usage-stats.html` 的三个入口因此退化成不可点击的纯文本。现在同源相对路径可通过校验（仍拒绝协议相对 `//host`、`/\host`、反斜杠与 `..` 路径穿越），危险协议照旧拒绝。
- **登录页头像与主界面左上角 Logo 改由本地 SVG 提供**：此前这两处（以及两个入口 HTML 的 favicon）都在引用原作者服务器上的远程图片 `https://src.hex2077.dev/logo/favicon.ico`，服务断网或对方关站时图标会直接加载失败。现在新增 `static/assets/logo.svg`（三路上游汇聚为单一输出）与 `static/assets/user-avatar.svg`，均使用主题渐变配色，favicon 同步指向 logo.svg。

### Changed

- **Header 移除原作者的两个推广入口**：B 站「视频教程」与第三方「小卖部」链接及其文案、样式全部删除，头部控件由 8 个精简为 6 个（点 Star、连接状态、主题、语言、登出、重载）。
- **README 品牌资源清理**：头部图标由原作者卡通插画 `logo-mid.webp` 换为 `static/assets/logo.svg`；赞助商区块的微信二维码图片换为同尺寸的 `static/assets/qr-placeholder.svg`（带 `prefers-color-scheme` 深色适配），并修正「请扫描左侧二维码」的过时文案；删除已无引用的 `logo-mid.webp`、`logo-mid0.webp`、`web.png`、`wechat.png`。
- Font Awesome 子集由 139 个图标收敛为 137 个（`fa-video` 随推广链接移除而失效）。
- locale 词典由 743 条收敛至 741 条（中英始终保持对齐）。

### Verification

- `npm test`：**72 suites / 854 tests 全绿**。
- WebUI E2E：**42/42 通过**。
- `npm run verify`（typecheck / plugins / strict / any / imports / cycles / coverage / runtime smoke）、`typecheck:webui`、`vendor:webui:check` 全部通过。

## [v6.0.0] - 2026-10-30

### Breaking Changes

- **移除 Fallback 机制**：删除 `providerFallbackChain`（跨类型回退链）与 `modelFallbackMapping`（跨协议模型映射）两项配置及其全部后端逻辑，同时移除 `MODEL_FALLBACK_ENABLED` 开关。`ProviderPoolManager` 现在只在请求指定的 provider 类型内选择节点，不再跨类型回退。
- **未知名模型改为直接报错**：随 `MODEL_FALLBACK_ENABLED` 移除，Kiro / Codex / Antigravity 遇到不在可用列表中的模型名时一律抛出错误，不再静默回退到默认模型。此前模型名拼写错误会被掩盖并实际调用另一个模型计费。
- **移除 System Prompt 配置**：删除 `SYSTEM_PROMPT_FILE_PATH` / `SYSTEM_PROMPT_MODE` / `SYSTEM_PROMPT_REPLACEMENTS` 三项配置与配置页对应 UI（文件路径、append/overwrite 模式、多行编辑框、替换规则表）。请求不再被注入内置系统提示词。
- **仓库归属切换**：项目以 `GreyRaphael/AIClient2API` 为准，README / FUNDING / docker-compose / 内置文档示例全部改指向本仓库与 `greyraphael/aiclient-2-api` 镜像。
- 升级后请删除 `configs/config.json` 中的 `providerFallbackChain`、`modelFallbackMapping`、`MODEL_FALLBACK_ENABLED`、`SYSTEM_PROMPT_*` 字段（残留字段会被忽略，不影响启动，但不再产生任何效果）。

### Removed

- 删除 `configs/fetch_system_prompt.txt` 的运行时写回行为：此前**每个请求**都会把该请求的 system prompt 覆盖写入这个文件，属于持续磁盘写入副作用。
- 删除仪表盘版本下拉框（此前存在三个缺陷：已是最新时下拉框为空白、`(当前)` 标记恒不出现、"检查更新"会覆盖已选版本）。更新面板现在只有两个按钮：**检查更新**（有更新则提示版本号）与 **立即更新**（有更新时才出现），只支持更新到 GitHub 最新版本，不再支持选择或降级到任意历史版本。
- 删除仪表盘二维码图片（`wechat` / `sponsor` / `x.com` / `coffee`），改为同尺寸内联 SVG 占位框，位置与尺寸保持不变。
- 删除「成为赞助商」卡片（仅用于解释上方微信二维码的用法）、3 个不可见的 `.qr-description` 节点、孤儿资源 `static/ip2node.png`。
- 删除仪表盘「可用模型列表」的 `<details>` 折叠包装（默认永远展开，折叠无实际意义），改为静态面板；同时删除 `section-access.css` 中从仪表盘迁移后遗留的孤儿折叠样式。

### Changed

- **自定义模型列表默认按第一列（ID）升序排序**，不再依赖接口返回顺序；表头点击仍为升序 → 降序 → 不排序三态循环。
- 配置页「高级配置」分组精简为仅剩「提供商池配置文件路径」与「后台登录密码」。
- 清理死 locale key 与孤儿样式：中英词典由 772 条收敛至 743 条（两侧始终对齐）。

### Fixed

- 修复设置自动更新后跳过的配置项：`SYSTEM_PROMPT_MODE` 与 `SYSTEM_PROMPT_REPLACEMENTS` 在 UI 保存路径中被写入但缺少对应读取校验的问题（随相关功能整体移除而消失）。
- 修复 `provider-pool-manager` 中 `acquireSlotWithFallback` / `selectProviderWithFallback` 在无 healthy 节点时仍可能返回跨类型结果的问题（现统一返回 `null`）。

### Verification

- `npm test`：**72 suites / 853 tests 全绿**。
- WebUI E2E：**38/38 通过**。
- `npm run verify`（typecheck / plugins / strict / any / imports / cycles / coverage / runtime smoke）、`typecheck:webui`、`vendor:webui:check` 全部通过。

## [v5.3.0] - 2026-10-30

### Added

- 新增按需回读明文的两个接口：`GET /api/config/secret?field=REQUIRED_API_KEY` 与 `GET /api/providers/:type/:uuid/secret?field=...`，各自维护字段白名单，且响应带 `no-store` 禁止缓存。
- 提供商节点新增 `ANTIGRAVITY_CLIENT_VERSION` / `ZED_VERSION` 客户端版本输入（与既有 `CODEX_VERSION` 对齐）：留空使用内置默认版本，填写后用于 User-Agent、`ide_version` / `X-Zed-Version` 及上游 model_list 拉取。

### Changed

- 最低浏览器要求提升至 Chrome/Edge 105+、Firefox 121+、Safari 16.4+（CSS 对齐修正使用 `:has()`），并同步 README 与重构文档。
- 登录页、`potluck`、`potluck-user`、`model-usage-stats` 的内联 CSS 抽离到 `static/ui/styles/pages/`。
- 移除死组件 `CodeBlock` / `Field`、未使用的认证/provider helper、死事件与 76 条未引用 locale key；删除可确认无对应 DOM 的旧 CSS 选择器与未使用变量。
- **仪表盘**：删除“服务器时间”“操作系统”卡片；取消“更多系统信息”折叠，7 张卡片直接平铺（桌面端上排 3 个 / 下排 4 个，12 栏栅格），文字居中且运行时间不再断行。
- **快速接入**：页头改为标题/刷新按钮 + 副标题独立成行；彻底删除“客户端配置片段”卡片（含 `access/snippets.js`、每语种 22 条 locale key 与相关 CSS）。
- **使用指南**：彻底删除页面（`sections/guide.js`、`section-guide.css`、`nav.guide`/`guide.*` 文案与 `#guide` 路由项），旧书签回落仪表盘。
- 抽取 `hooks/useSecretReveal.js` 统一“眼睛”状态机（配置页 / 提供商节点）；快速接入页因 `/access-info` 本就下发明文 Key，改为直接切换 `type`，去掉多余的一次回读请求。

### Fixed

- **修复鉴权绕过**：`verifyToken` 直接以 `tokens[token]` 取值，`__proto__` / `constructor` / `toString` 等原型链成员会被当成合法 token（真值且无 `expiryTime`，`Date.now() > undefined` 为假），可无密码读取全部明文密钥；同时 `expiryTime` 缺失或非数字的记录也被当成“永不过期”。现在 token store 归一化为无原型对象，并要求自身属性命中且过期时间为有限数字。
- **修复请求挂起**：`handleUIApiRequests` 未包 try/catch，UI 路由内抛错（非法百分号转义 `%E0%A4%A`、`providerType=__proto__`）会让 rejection 逃逸且响应永不写回，客户端只能等到超时。现在统一兜住并回 500，非法百分号转义前置拒绝为 400。
- **修复“眼睛”按钮回读的明文进入可编辑缓冲**：非编辑态也可回读、明文进入草稿缓冲，键入一个字符后保存会写入 `明文+字符`（`filterMaskedData` 已不再识别为掩码）。现在仅编辑态允许回读，明文展开期间强制只读。
- **修复“生成新 Key”后仍显示旧明文**：回读缓存未随表单值失效，输入框显示旧 Key 而表单已是新 Key。现在缓存与取值绑定，值变化当次渲染即失效。
- 修复仪表盘系统信息栅格用视口宽度断点、而面板实际宽度受右侧固定 440px 卡片挤压导致的数值溢出被裁切（1025–1299px 区间最多外溢 39px）；改为按面板宽度做容器查询。
- 修复 WebUI 弹窗关闭按钮显示 `&times;`、登录页页脚显示 `&copy;` 的问题（htm 文本节点不解析 HTML 实体，改用 `×` / `©` 字面量）。
- 修复 Kiro 授权弹窗与 OAuth 路径提示把 `<strong>` / `<code>` 标签显示为字面量的问题，静态 i18n 富文本改用 `dangerouslySetInnerHTML` 渲染。
- 修复 Modal 重新渲染导致输入框丢失焦点、叠加 Modal 按 ESC 关闭全部弹窗的问题，并补充焦点陷阱与滚动锁栈。
- 修复 Playground 提供商变更后缓存不刷新、主题无法跟随系统、主界面标题/描述不随语言切换的问题。
- 补全 `--font-mono`、`--warning-border-light`、`--neutral-shadow-10`、`--danger-10` 与 `modalSlideIn`，并将 Playground 全局 keyframes 改为 `pg-*` 前缀避免覆盖 Header 动画。
- **修复提供商配置弹窗在“编辑 / 新增”态下右上角 `×` 点击无效**：此前 `tryClose` 遇到未保存状态直接 return，必须先保存或取消才能关闭；现在会先丢弃草稿再关闭（ESC、遮罩同）。
- 修复提供商字段声明里 25 条从未被读取的 `label` 死数据（渲染实际用的是 `getFieldLabel`），并把 `CODEX_EMAIL` / `ZED_EMAIL` / `ZED_OAUTH_CREDS_FILE_PATH` 补进标签表——此前它们在表单上直接显示裸字段名。
- 修复“眼睛”按钮点了没反应：此前服务端只下发脱敏占位符，切换 `type` 后依旧显示 `******`。现在点击时才按需回读明文（配置页 API 密钥与提供商节点密钥；快速接入页用的是本就明文的 `/access-info` Key）。

### Verification

- `npm test`：**72 suites / 852 tests 全绿**。
- WebUI E2E：**36/36 通过**。
- `npm run verify`（typecheck / plugins / strict / any / imports / cycles / coverage / runtime smoke）、`typecheck:webui`、`vendor:webui:check` 全部通过。

## [v5.2.0] - 2026-10-29

### Added

- WebUI 无构建重构（Preact 11 + htm + signals）：`static/ui/` 统一入口、import map、`static/vendor/` 本地依赖与 Font Awesome 子集。
- 统一 `Modal/ConfirmDialog/Pagination/Toast`、`useApi/useEvent/useInterval` 与 provider/usage/stats 纯函数模块。
- 提供商授权补齐 Kiro AWS 账号导入：支持 AWS SSO cache JSON 文件合并、JSON 粘贴、单条提交与批量 SSE 进度。
- Playwright 隔离 E2E（26 个用例）与 Jest SSR/i18n parity/import map/FA 子集守卫。

### Changed

- 控制台全部 11 个页面迁移为 Preact 组件；旧 `static/app/*.js`、`static/components/*.html` 全部移除。
- 提供商授权/批量导入迁移为 `AuthDialog`，配置页改为字段声明驱动表单。
- 登录页、`potluck.html`、`potluck-user.html`、`model-usage-stats.html` 迁移为 `ui/pages/*`，插件路径保持不变。
- `ui-manager` 静态服务补齐 `.mjs`/字体 MIME、ETag 再验证、`/vendor/` immutable 与 static 根目录校验。

### Removed

- `static/app/` 旧 JS（provider-manager、modal、event-stream、i18n DOM 扫描等）与旧 HTML 片段。
- `static/app/`、`static/components/` 目录（CSS 统一迁至 `static/ui/styles/`）。

### Fixed

- 插件描述富文本清洗拒绝 `//host`、`/\host` 等协议相对/反斜杠链接绕过，并补充危险协议、事件属性与嵌套标签测试。

### Verification

- `npm test`：**70 suites / 838 tests 全绿**。
- WebUI E2E：**26/26 通过**。
- `npm run verify`：typecheck、typecheck:plugins、strict、any、imports、cycles、coverage、runtime smoke 全部通过。
- `typecheck:webui`、`vendor:webui:check` 通过。

## [v5.1.0] - 2026-10-28

### Added

- 新增 `GET /api/provider-models/metadata`，返回所有 Provider 的模型 metadata（上游 capability 与自定义模型配置合并），供 WebUI 展示。
- 仪表盘“可用模型列表”改为两列卡片，每个模型单行展示 `id`、`context_length`、`max_output_tokens`、`support_images`、`support_efforts`；点击卡片复制模型 ID 与 metadata JSON。
- Playground 接口类型新增 OpenAI Responses（`/v1/responses`）与 Anthropic Messages（`/v1/messages`），支持流式/非流式与图片附件输入。
- Playground 流式输出新增客户端打字机预览，上游合并 delta 时仍保持逐字显示。
- 新增 Playground 三协议 e2e（Responses/Messages 文本流式与非流式、图片输入）与 UI 路由单测。

### Changed

- 自定义模型 metadata 注入逻辑抽取为 `src/providers/custom-model-metadata.ts`，`/v1/models` 与 metadata 端点共用。
- Playground 协议适配层统一处理 Chat / Responses / Messages 的请求构造、流式事件解析与非流式结果提取。

### Fixed

- 修复 `section-access.css` 中重复的模型列表样式覆盖仪表盘两列布局、导致卡片按 4 列排布的问题。
- 修复 Playground 在上游把多个 token 合并为少量大 delta 时看不到打字机效果的问题。

### Verification

- `npm test`：**52 suites / 651 tests 全绿**。
- `npm run verify`：typecheck、typecheck:plugins、strict、any、imports、cycles、coverage、runtime smoke 全部通过。
- Playground e2e：**10/10 通过**（2 个模型 × Responses/Messages × 流式/非流式 + Responses/Messages 图片输入）。

## [v5.0.8] - 2026-10-27

### Added

- 自定义模型新增 `context_length`、`max_output_tokens`、`support_images`、`support_efforts` metadata 字段，支持 WebUI 编辑并透传到 `/auto/v1/models` 与单 Provider `/v1/models`。
- `support_efforts` 支持 `null` / `high` / `max` / `high+max` 下拉配置；后端仅保留 `high` / `max`。
- 新增自定义模型 72 次 e2e 矩阵：6 模型 × 3 协议 × 2 effort × text/image。

### Changed

- **Antigravity**：`support_efforts=null` 时下游 `reasoning_effort` 一律剥离，不再返回 400；Provider 层同步兜底清理 thinkingConfig。
- **OpenAI Codex OAuth**：Claude → Codex 的 Messages 转换不再硬编码默认 `medium`，改由 Provider 按上游元数据取最高档。
- 自定义模型移除 `contextLength` / `maxTokens` 旧字段兼容与旧 `max_tokens` 输出，统一使用 `context_length` / `max_output_tokens`。
- 自定义模型移除 `temperature` / `topP` 配置与强制覆盖逻辑，采样参数回归客户端控制。

### Fixed

- 修复自定义模型 WebUI 无法修改推理档位的问题；多选控件改为明确的 `null` / `high` / `max` / `high+max` 下拉。
- 修复自定义模型 metadata 在 auto 聚合与单 Provider 模型列表中不一致的问题。

### Verification

- `npm test`：**51 suites / 649 tests 全绿**；typecheck、typecheck:strict、imports、cycles 全部通过。
- 自定义模型 e2e：**72/72 通过**（36 次文本、24 次识图、12 次无识图），0 逻辑失败 / 0 超时 / 0 限流。

## [v5.0.7] - 2026-10-26

### Added

- 新增 Zed 模型元数据运行时注册表：远端 `/models` 成功后按账号持久化，冷启动自动恢复；支持账户隔离、原子写入与损坏缓存降级。
- 新增 Zed 协议规则模块，按模型族同步解析 `claude` / `openaiResponses` / `gemini` 上游协议，核心 registry 不再依赖 provider 专属数据表。
- 补充 Zed 注册表缓存、账户隔离、冷启动、禁用模型过滤、未知模型宽松透传与健康检查预算回归测试。

### Changed

- **Zed 单跳协议感知重构**：客户端协议直接转换到模型对应的上游原生协议，移除 Claude 中枢二次转换；OpenAI Responses、Gemini 与 Anthropic 原生事件直接透传后再单跳回转。
- **删除 23 个模型的内置硬编码快照**：模型能力完全以 `cloud.zed.dev/models` 的运行时元数据为准，远端成功响应整体替换并过滤 `is_disabled` 模型。
- **未知模型宽松降级**：严格思考档位校验与 `max_output_tokens` 裁剪仅在权威元数据存在时生效；新增模型/档位不再被本地白名单误杀。
- **Trae 通道清理**：移除 `solo_work_lite` 节点选项与配置展示，思考模型过滤仅保留包含 `extra_high` 的通道。

### Fixed

- 修复 Zed 健康检查对 OpenAI Responses 通道发送 `max_tokens: 1` 导致上游返回空 500 的问题；Zed 健康检查改用最小可用预算 `16`，Kiro 保持 `1`。
- 修复 Zed 重构引入的 `request-pipeline` TypeScript 类型错误，`npm run typecheck` 恢复通过。
- 修复远端模型下架/禁用后仍残留在实例元数据与 `/v1/models` 的问题。

### Verification

- `npm run verify`：**50 suites / 626 tests 全绿**；typecheck、typecheck:plugins、strict、any 棘轮、imports、cycles、覆盖率门槛、runtime smoke 全部通过。
- 真实上游全量 E2E：**18 个模型 × 11 项核心用例（198 项）+ 6 项通用定向契约全部通过**；4 项 provider 方言 canary 全部通过。
- Zed 健康检查：3 个有额度节点全部 PASSED；3 个账号仍因 credits 耗尽返回 403（账号状态，非代码问题）。
- 刷新 any 与覆盖率基线：`DynamicPayload` references 1525；总覆盖率 行 33.49% / 分支 33.91% / 函数 37.24%。

## [v5.0.6] - 2026-10-26

### Changed

- 完成 P0–P2 后续重构：拆分 Zed 通道请求构建器、Kiro 请求与流状态、Provider Pool 选点/刷新调度及 Pipeline 流生命周期，保持现有 API、配置和插件调用约定。
- 修复 strict 门槛假阴性，主源码与内置插件启用 `noUnusedLocals`，并清理无用 import、变量、catch 绑定和死代码。
- 公共响应/流联合移除 `any` catch-all，请求扩展载荷改为 `unknown`；Claude → OpenAI usage 使用真实 DTO。`DynamicPayload` 引用从 1539 降至 1499。

### Added

- 新增 Kiro、Pool、Pipeline 核心表征测试，以及 Access API、Pool 重初始化、BaseConverter 和流生命周期回归测试。
- 新增 strict 编译器失败故障注入测试，避免非 `src/` 严格错误或失败的 baseline 更新被误报为成功。

### Verification

- `npm run verify`：49 suites / 618 tests 全绿；strict、noUnusedLocals、imports、cycles、any 棘轮、覆盖率门槛和真实 Node smoke 全部通过。
- 真实上游 E2E：18 个模型 × 11 项核心用例（198 项）全部通过，6 项通用定向契约与 4 项 provider 方言 canary 全部通过。
- 性能基准：非流式与流式各 20 请求、并发 3，成功率均为 100%；非流式 2.13 req/s、流式 1.65 req/s。
- clean checkout 覆盖率基线：行 32.88% / 分支 33.41% / 函数 36.20%。

## [v5.0.5] - 2026-10-25

### Fixed

- 覆盖率基线排除 gitignored 的 `src/plugins-user` 目录，避免本地存在用户插件时覆盖率高于 clean checkout，导致 CI 覆盖率门槛误判。`check-coverage` 同步跳过该目录，并补充回归测试。
- 覆盖率基线改为在 clean checkout 生成，并分别在 Node.js 22 与 24 下验证。

### Changed

- v5.0.5 仅包含 CI / 覆盖率工具链修复，**无运行时、API、配置或数据格式变更**。

### Verification

- GitHub Actions CI（Node 22.x / 24.x）：通过。
- `npm run verify`：44 suites / 593 tests 全绿，strict 0 errors，any 棘轮通过，imports / cycles / runtime smoke 通过。
- clean checkout 覆盖率：行 30.01% / 分支 31.21% / 函数 33.07%。

## [v5.0.4] - 2026-10-25

### Fixed

- 修复插件方法 receiver 丢失：`init` / `destroy` / `authenticate` / `middleware` / `hooks` 改为通过 `.call(plugin, ...)` 调用，恢复 `this` 绑定，避免依赖实例状态的第三方插件静默失效。新增 5 个 receiver 回归测试。
- 修复覆盖率门槛的 LCOV `FNDA` 解析 off-by-one：`FNDA:` 前缀长度为 5，旧实现从 `slice(6)` 开始会丢掉 hit count 第一位，导致函数覆盖率被系统性低估。修复后函数覆盖率由 11.39% 校正为 32.65%（293 → 840 covered）；这是统计口径修复，不是测试覆盖率突然提升。

### Changed

- `npm run verify` 现在执行 `test:coverage` 并通过 `check:coverage` 校验覆盖率门槛，本地验证与 CI 口径一致。
- 新增覆盖率门槛回归测试，包含“覆盖率低于基线时必须失败”的失败路径断言。
- 清理 `provider-config-linker` 行尾空白，无行为变化。

### Verification

- `npm run verify`：44 suites / 592 tests 全绿，strict 0 errors，any 棘轮通过，imports 136 文件通过，cycles 0，runtime smoke OK。
- 覆盖率：行 29.84% / 分支 31.09% / 函数 32.65%。
- 全量 E2E：20 个模型 × 11 项核心用例 + 6 项定向契约，26/26 通过。
- 定向回归 E2E：openai-custom:glm-5.3，11 项核心 + 2 项定向通过。

## [v5.0.3] - 2026-10-25

### Fixed

- 修复非号池部署（`providerPools` 为空且使用 `openai-custom` / `openaiResponses-custom` / `claude-custom`）时所有内容生成请求返回 500 `service.generateContent is not a function` 的回归。`request-handler` 恢复传入 `null`，由 `handleContentGenerationRequest` 延迟解析 service。
- 修复 `request-handler`、`api-manager`、`service-manager`、`plugin-installer`、`provider-api` 中 5 个自递归的 `getErrorMessage`，避免错误路径抛出 `RangeError: Maximum call stack size exceeded`（插件市场离线 fallback、provider 健康检查等）。
- 新增回归测试：真实 standalone server + 空号池 + 本地假上游；插件市场离线缓存 fallback；全源码 `getErrorMessage` 自递归扫描。
- `any` 棘轮扩展为同时校验正则口径、TypeScript AST `AnyKeyword` 节点（`src` + `types/`）以及 `DynamicPayload` 定义/引用数；新增别名或引用会使 CI 失败。
- 补齐第三方依赖类型：`busboy` 使用 `@types/busboy`；`adm-zip` 0.5.x 与 `multer` 使用本地最小声明（`types/adm-zip.d.ts`、`types/multer.d.ts`），移除 `types/vendor-modules.d.ts` 的 `any` 模块声明。
- 在触碰的 UI 上传模块中收敛动态类型：`event-broadcast` / `plugin-api` 移除 `DynamicPayload`，改用真实 multer `File`、`Record<string, unknown>` 与显式窄化/守卫。
- 修正发布说明中的 `any` 口径与 Node.js 版本要求。

### Verification

- `npm run verify`：32 suites / 497 tests 全绿，strict 0 errors，imports 128 文件通过，runtime smoke OK。
- 全量 e2e：20 个模型，26/26 通过（20 × 11 项核心用例 + 6 项定向契约）。

## [v5.0.2] - 2026-10-25

### Changed

- **TypeScript 严格化重构收尾**：按 `: any` / `as any` 正则口径，`src` 下显式 `any` 从 2279 降至 234 处（-90%），`strict` 错误清零，`@ts-nocheck` 保持 0 文件 / 0 行。
- Provider 层（antigravity、zed、codex、claude-kiro、trae、openai、model-capability、adapter、registry/capabilities/strategies）全部收敛到真实 DTO / 协议类型。
- 四个协议转换器（Claude / OpenAI / OpenAI Responses / Codex）及 `GeminiConverter` 的公共入口与内部 payload 完成类型化。
- `request-pipeline` 引入统一 `PipelineError` 边界；handlers、UI API、core 与 services 模块同步类型化。
- 正则口径下剩余 234 处显式 `any` 位于 `security-hardening.ts` 的 monkey-patch wrapper；按 TypeScript AST 统计所有 `AnyKeyword` 节点（含泛型位置与 `types/`）为 393 处（src=331 / types=62）。
- 新增 `any` 棘轮基线（234 annotations / 6 assertions / 393 AST nodes，DynamicPayload 51 definitions / 1567 references），后续新增 `: any`、`as any`、`Record<string, any>` 或 `DynamicPayload` 将使 CI 失败。
- **运行要求提升**：Node.js >= 22.18.0（原生 TypeScript 类型擦除），Node 20 及更早版本无法启动。

### Verification

- `npm run verify`：strict 0 errors，30 suites / 494 tests 全绿，imports 128 文件通过，runtime smoke OK。

## [v5.0.1] - 2026-10-24

### Fixed

- **WebUI `#upload-config` 空白**：补齐前端 provider 注册表相关 import，修复渲染配置列表时 `detectProviderFromPath is not defined` 导致的 `ReferenceError`。
  - `upload-config-manager.js` 补回 `detectProviderFromPath`
  - `file-upload.js` 补回 `getProviderUploadDir`
  - `modal.js` 补回 `isOAuthProvider`
- 该问题由 v5.0.0 的前端 provider 注册表合并引入；后端 `/api/upload-configs` 数据本身正常。

### Verification

- `npm test -- --runInBand`：**27 suites / 486 tests 全绿**。
- `npm run typecheck`：**0 errors**。
- `npx jest tests/static-syntax.test.js`：**27 / 27 通过**。

## [v5.0.0] - 2026-10-24

### Breaking Changes

- **移除 `grok-cli-oauth` provider**：删除 Grok CLI core、OAuth、适配器注册、模型清单、号池与用量查询、OAuth/批量导入路由、前端入口与配置示例。其他 provider（Antigravity、Kiro、Codex、OpenAI、Claude、Zed、Trae）保持不变。
- 升级后请删除 `configs/grok-cli/`、`provider_pools.json` 中的 `grok-cli-oauth` 节点及相关缓存；这些运行时数据不会被自动清理。

### Added

- 新增前端 `static/app/provider-registry.js` 与后端 `src/providers/provider-registry.js`，统一维护 provider 类型、协议、模型 baseline、健康检查模型、凭据路径、图标与 UI 元数据。
- 新增 `npm run typecheck`，`tsconfig.json` 纳入 `src/**/*.js` 并开启 `checkJs`；新增 GitHub Actions CI（typecheck + 单测）。
- 新增 `docs/CONFIG_PRECEDENCE.md`，明确配置读取、provider 能力、模型列表与 fallback 优先级。
- E2E 新增动态模型选择：定向用例从 `/auto/v1/models` 按 provider 前缀选择，无匹配模型时自动 skip。
- 新增 `npm run test:e2e:providers`，用于运行 Zed / Gemini 方言 canary。

### Changed

- P0 工程精简：统一使用 npm，删除 `pnpm-lock.yaml` 与安装脚本 pnpm 分支；移除未使用依赖 `ws`、`supertest`、`jest-environment-node`；删除未引用资源与一次性迁移脚本。
- 过期评审/流式设计文档归档到 `docs/archive/`；历史回归测试合并为 `tests/regressions/` 两个领域文件，126 个用例全部保留。
- 通用 E2E 定向用例从 16 项压缩到 6 项；4 项 provider 方言用例移入 opt-in canary；移除模型采样/质量类 E2E。
- 动态 provider 的静态模型清单压缩为少量冷启动 baseline，完整模型以 `/auto/v1/models` 为准。
- 内置 provider 能力规则并入 provider registry，减少方言知识散落。
- 类型检查修复了生图 `prompt` 作用域、Trae header 数组、`update-api` arrayBuffer 返回值、`config-scanner` 注册表导入等实际缺陷。

### Verification

- `npm test -- --runInBand`：**27 suites / 486 tests 全绿**。
- `npm run typecheck`：**0 errors**。
- 默认 E2E（19 模型全量）：**25 / 25 通过**（19 个模型 × 11 项核心 + 6 项通用定向）。
- Provider 方言 canary：**4 / 4 通过**。
- `npx jest tests/static-syntax.test.js`：**27 / 27 通过**。

## [v4.1.9] - 2026-10-23

### Fixed (跨协议转译语义与健壮性收口)

- **Responses → Gemini**：`input` 内 system/developer 消息并入 `systemInstruction`；`text.format` 映射为 `responseMimeType` / `responseSchema`；多模态 `function_call_output` 归一化为 Struct 并将图片/文件拆为同轮 `inlineData`；无 user/assistant turn 的请求本地返回 400。
- **Chat → Antigravity**：thinking gating 覆盖 `gpt-*`、`-thinking`、`-high`、`-medium` 与 Claude 5.5，GPT-6 预适配补齐。
- **流内错误终态**：识别 `response.failed`、`event: error`、`data.error`（含空 `choices` / `candidates`）；转换器无法表达时返回 502；非流式 HTTP 200 错误体不再伪装成成功；错误帧不污染重试收尾状态。
- **Schema Polyfill**：补齐 `allOf` type/enum/items、可空 `oneOf`、`patternProperties`、`additionalProperties`、`not`、`dependentRequired`、`dependentSchemas`、`if/then/else`；摘要保留子 Schema `description`；阶段 2 裁剪只统计可达节点并按真实描述差值回缩。

### Changed

- 跨协议 E2E 增加 Responses→Gemini developer/text.format 与 system-only 400 定向用例，定向用例增至 16 项。
- 文档收敛为单一 19 模型复评入口，删除过期的 27 模型 review。

### Verification

- `npm test -- --runInBand`：**29 suites / 489 tests 全绿**。
- 19 模型 E2E：**35 / 35 通过**，19/19 模型 11/11，16/16 定向用例通过。

## [v4.1.8] - 2026-10-23

### Fixed

- 收口跨协议 P0/P1 一致性修复与 E2E 长尾治理。
- 修复 Responses 流式 `.done` 无前序 delta 时丢正文。
- 更新 Antigravity User-Agent 为 CLI 标识，修复模型列表动态刷新。

### Changed

- Antigravity 过滤 oss 与 `-low` 模型，预适配 GPT-6 系列 thinkingLevel。

## [v4.1.7] - 2026-10-22

### Fixed (跨协议转译 P1/P2 修复)

- **P1：Responses 下游兜底收尾**：`streamRequestId` 声明提升到 `try` 外，修复 `finally` 中 `ReferenceError` 导致的流卡死；兜底收尾失败时强制 `res.end()`。
- **P1：重试流状态泄漏**：`BaseConverter` 增加 `resetStreamState()` 契约；各 Converter 只清理流式状态、保留请求级工具名/custom tool 映射；pipeline 在每次尝试及空响应/凭证切换重试前清理，重试上下文固定 `requestId` 与共享 `streamState`，避免重复补发 `message_stop` / `response.completed`。
- **P2：终端空内容截断识别**：新增 `extractTerminalFinishReason()` / `isTerminalEmptyFinishReason()`，覆盖 OpenAI `length`、Claude `max_tokens`、Responses `max_output_tokens`、Gemini `MAX_TOKENS`，合法截断不再被放大为多次空响应重试。
- **P2：Responses → Gemini 工具 ID**：`functionCall` / `functionResponse` / `callIdToName` 统一使用 `call_id || id`，保证多轮工具历史配对。

### Changed

- 新增 `tests/v4-1-6-regressions.test.js`（9 个 P1/P2 回归用例）。
- 清理过时的跨协议评估/优化文档；评估入口后续见 [`docs/archive/CROSS_PROTOCOL_REVIEW_19MODELS_2026-10-23.md`](docs/archive/CROSS_PROTOCOL_REVIEW_19MODELS_2026-10-23.md)。
- 清理 E2E 测试中未使用的 `addQuotaFailure` 别名。

### Verification

- `npm test -- --runInBand`：**29 suites / 463 tests 全绿**。
- 最终 27 模型 E2E：**39 / 39 通过**，27/27 模型 11/11，12/12 定向用例通过。
- `streamRequestId is not defined`：**0 次**。
- `openai-custom:glm-5.3` 核心用例耗时从 195.2s 降至 15.4s。

## [v4.1.6] - 2026-10-22

### Changed

- E2E 默认通过 Jest `globalSetup` 从 `/auto/v1/models` 动态获取当前全量模型，不再硬编码 13/27；`AICLIENT_E2E_MODELS` 可覆盖为逗号分隔的子集。
- 合并 6 个历史版本化跨协议测试为 `tests/cross-protocol-historical-regressions.test.js`，删除 3 条低价值实现细节断言；单测套件从 33 个收敛为 28 个。
- `npm test` 移除 `--forceExit`，测试进程现在可自然退出。

### Fixed

- `src/utils/file-lock.js`：`withTimeout()` 在 Promise settle 后清理 30s 定时器，避免测试和 CLI 进程被悬挂的 timeout 拖住。
- `src/ui-modules/auth.js`：token 清理 `setInterval` 增加 `unref()`，避免模块被测试/CLI 引入时阻塞进程退出。

### Verification

- `npm test -- --runInBand`：**28 suites / 454 tests 全绿**，无需 `--forceExit`。
- E2E 默认动态发现 27 个模型；`openai-custom:glm-5.3` 核心矩阵 11/11 通过。

## [v4.1.5] - 2026-10-22

### Fixed (跨协议转译 v4.1.5 契约修复)

- **usage 不变量**：`applyEstimatedReasoningTokens()` 现在保证 `reasoning_tokens <= output_tokens`；上游已给 reasoning 但大于 output 时也会收敛，output 为 0 时不做估算，避免 `completion/output < reasoning` 的非法 usage。
- **Claude tool id**：OpenAI → Claude 的请求、非流式响应、流式响应统一通过 `toClaudeToolId()` 清洗为 `[a-zA-Z0-9_-]+`，并保证 `tool_use` / `tool_result` 两侧 id 一致。
- **Schema 保真**：oneOf/anyOf 对象分支的 `required` 改为交集，避免互斥分支字段被全部强制；数值/布尔 enum 在 Gemini 清洗前注入 description，保留约束语义。
- **CoT 历史可观测性**：Chat → Responses、Claude → Responses 丢弃 reasoning 时输出计数 debug 日志，默认行为不变。
- **E2E 覆盖**：新增 `AICLIENT_E2E_MODELS=all`（27 模型全量矩阵）、全模型 usage 不变量断言、OpenAI → Zed Claude 非法 tool id 回归用例。
- **文档清理**：移除已被取代的 13 模型阶段性复评，保留 27 模型全量复评与 archive 历史文档。

### Verification

- `npm test -- --runInBand`：**33 suites / 457 tests 全绿**。
- 27 模型核心 E2E：**296 / 297**；唯一失败为 `openai-custom:qwen3.8-max` 算术采样返回 `442`，同用例重试 3/3 返回 `391`，非转译回归。
- oneOf 定向 E2E、OpenAI → Zed Claude 非法 tool id 定向 E2E 通过。

## [v4.1.4] - 2026-10-22

### Fixed (跨协议转译 v4.1.4 + CoT 非确定性修正)

- **Gemini**：
  - 流式请求需要 thinking 时回退非流式 `generateContent`，保留 thought 文本；新增 `GEMINI_STREAM_THOUGHTS_FALLBACK`。
  - `maxOutputTokens` 改为标准透传；`MAX_TOKENS` / `SAFETY` 等终态不再触发空响应重试。
- **Zed**：
  - Anthropic `tool_result` 统一补齐 `is_error:false`。
  - `reasoning_effort: high` 不再被反解为 `max`。
  - OpenAI 通道补齐 `input_image` 映射。
  - Google 通道接入 Schema Polyfill，保留 function id；多轮工具历史降级为文本。
- **工具与 Schema**：
  - openai-custom 指定 function 强制 `tool_choice` 降级为 `required` + 收窄 tools；新增 `EMPTY_RESPONSE_MAX_TOTAL_MS` 重试预算。
  - oneOf/anyOf 对象分支合并 properties/required/enum；`CONVERT_SORT_TOOLS` 默认开启。
  - Codex `max_output_tokens` 默认透传。
- **Reasoning 与错误**：
  - GPT/Claude 有 reasoning 文本但缺 `reasoning_tokens` 时做保守估算并标记 `reasoning_tokens_estimated`。
  - 4xx 错误响应追加可读上游细节，5xx 不泄露内部 body。
  - 新增 `supportsToolResultHistory`、`supportsStreamingThoughts` 能力位。

### Verification

- `npm test -- --runInBand`：33 suites / 447 tests 全绿。
- `npm run test:e2e`：13 模型真实上游 E2E **24 / 24 PASS**。

## [v4.1.2] - 2026-10-21

### Fixed (跨协议转译 v4.1.1 复评 P1/P2)

- **流式与工具链**：
  - Gemini → OpenAI Chat 流式工具 chunk 不再提前写 `finish_reason=tool_calls`。
  - 打通 custom tool 全链路：新增请求级 `custom-tool-registry`；Responses → Codex 原生保留 `type:"custom"`，Responses → OpenAI / Claude / Gemini 降级为 function 后响应侧还原为 `custom_tool_call`。
  - Responses SSE 对 custom tool 改发 `custom_tool_call_input.delta/done`，不再按 `apply_patch` 名称推断类型。
  - Claude → OpenAI 流式 `tool_calls.index` 改为请求级从 0 递增映射。
- **思考与签名**：
  - Gemini → Claude 统一铸造 `vsig1.*` 虚拟签名；Claude → Gemini 不再透传 Claude 真实 signature。
  - OpenAI → Claude 映射 `thinking` 后移除非标准 `reasoning_effort`，显式 disabled 优先。
  - Grok 流式思考只写 `reasoning_content`，不再重复写入正文。
- **usage 与请求参数**：
  - Gemini / Codex → Claude 的 `input_tokens` 扣除 cached tokens。
  - Claude → OpenAI 不再默认注入 `max_tokens` / `temperature` / `top_p`。
  - `strict` 在 Chat ↔ Responses 双向保留；`parallel_tool_calls` ↔ `disable_parallel_tool_use` 双向映射。
  - 非流式 `custom_tool_call` 补齐 OpenAI Chat / Claude 输出。
- **多模态**：
  - Responses `input_file` 的 base64 数据映射为 Gemini `inlineData`。
- **测试与文档**：
  - 新增 `tests/cross-protocol-v4-1-1-fixes.test.js`，共 20 个回归场景；`npm test -- --runInBand` = 26 suites / 376 tests 全绿。
  - 更新跨协议转译评估文档；移除已被取代的 v4.1.0 评估文档。

## [v4.1.1] - 2026-10-21

### Fixed (v4.1.0 复评 P0/P1 整改)

- **P0 功能中断**：
  - Codex → OpenAI Chat / Responses 非流式工具调用补齐 `requestId`，修复 `ReferenceError: requestId is not defined`。
  - Codex → Responses 非流式 `function_call` 同时输出 `fc_*` item id 与 `call_id`，恢复工具结果回传。
  - Claude → Codex 的 URL 图片映射为 `input_image`；URL document 保留 URL 文本兜底，不再静默丢成空 input。
- **P1 保真与鲁棒性**：
  - Claude → Gemini 补齐 `stop_sequences → generationConfig.stopSequences`。
  - Responses → Claude 终止事件补齐未关闭内容块的 `content_block_stop`。
  - Claude / Responses 下游 + OpenAI 上游流式场景由 provider 注入 `stream_options.include_usage`，并合并 finish/usage 分帧。
  - 统一 Claude / OpenAI / Responses 双向缓存 token 统计口径。
  - OpenAI `content_filter` → Anthropic 结束原因修正为 `refusal`。
  - Gemini → Responses 非流式保留 `MAX_TOKENS` / 安全类截断状态；Gemini → Claude 非流式保留截断前的部分正文。
- **测试与文档**：
  - 新增 `tests/cross-protocol-v4-1-0-p0-p1.test.js`。
  - 更新跨协议转译评估文档（v4.1.0 文档已由后续复评取代）。

### Verification

- `npm test -- --runInBand`：25 suites / 356 tests 全绿。

## [v4.1.0] - 2026-10-21

### Fixed (跨协议转译 v4.1 收敛)

- **P1 流式正确性**：
  - Gemini → OpenAI Chat 的工具索引改为请求级递增，Gemini → Responses 以 `callId` 作为工具身份，修复跨 chunk 工具合并/丢失。
  - Responses → OpenAI 流式状态按 `requestId` 隔离，固定 chunk `id/created`，避免状态按事件泄漏。
  - Claude → Responses 的 `input_image.image_url` 统一为字符串，修复图片被上游拒绝。
  - Grok → Responses 非流式 `function_call` 补 `call_id`，恢复非流式工具回传链路。
- **P2 保真与鲁棒性**：
  - Claude 目标请求补齐 `temperature` / `top_p` / `stop_sequences` / `metadata`，未显式提供的采样参数不再注入默认值。
  - `max_tokens` 统一 clamp 到 Anthropic 64K 输出上限。
  - Claude 流式 usage 合并 `message_start` 输入 token，修复最终用量归零。
  - Responses → OpenAI / Claude 支持 custom tool 输入增量。
  - Codex → OpenAI / Claude 处理 `response.incomplete`。
  - URL 图片、`file` / `input_file` 多模态映射补齐，减少静默丢失。
- **P3 清理**：
  - Claude → Responses 在 `content_block_stop` 时关闭 text 块。
  - 移除 Codex reasoning done 注入的人工换行。
  - OpenAI → Gemini 仅 system 消息时保留 `system_instruction` 语义。
- **测试与文档**：
  - 新增 `tests/cross-protocol-v4-1-p1/p2/p3.test.js`，共 17 个回归测试。
  - 新增并收敛跨协议转译评估文档（v4.1.0 文档已由后续复评取代）。

### Verification

- `npm test -- --runInBand`：24 suites / 344 tests 全绿。

## [v4.0.1] - 2026-10-21

### Fixed (跨协议转译 v4 复评整改)

- **P1 功能正确性**：
  - 修复 Claude → OpenAI Responses 流式工具调用重复 output item（Emitter 工具 key 统一）。
  - 修复 OpenAI Chat → Gemini 多条 system/developer 消息只保留最后一条。
  - 补齐 Responses ↔ OpenAI 的图像、`text.format`、`tool_choice`、`max_completion_tokens` 等字段映射。
  - 修复 Claude → OpenAI `tool_choice` 固定为 `auto`，补齐 `stop_sequences` / `metadata` 与 URL 图像。
  - Grok → Responses 流式改用 `ResponsesSseEmitter`，输出标准生命周期事件。
  - 修复 Codex 长工具名反向映射（请求/响应共用 requestId，请求状态跨实例共享）。
  - 修复 OpenAI → Claude usage-only 尾帧重复发送 `message_start`。
- **P2 保真与鲁棒性**：
  - Claude → Gemini 统一使用 `thinkingLevel`，并支持 adaptive thinking。
  - 补齐 OpenAI/Claude/Responses → Gemini 的 `required` / `any` tool_choice。
  - URL 图片/文档增加 `fileData` / `image_url` / 占位文本兜底。
  - Gemini → Responses 非流式输出标准 reasoning item。
  - 映射 `response.incomplete`，`response.failed` / `error` 向上抛出。
  - 收紧 Responses → Claude 无签名 thinking 回放策略，修正 SSE 生命周期顺序与 usage 统计。
- **P3 清理**：
  - 删除 Codex `if(true)` 死代码、Grok 占位解构、未使用 Emitter API/常量、pipeline 不可达 Gemini 分支。
  - 移除 Grok 静态共享 UUID/baseUrl，改为请求级状态。
  - 新增 `tests/cross-protocol-v4-fixes.test.js`（18 个回归测试）。
- 文档：跨协议转译复评后续收敛到 [`docs/archive/CROSS_PROTOCOL_REVIEW_19MODELS_2026-10-23.md`](docs/archive/CROSS_PROTOCOL_REVIEW_19MODELS_2026-10-23.md)（历史复评文档已在 v4.1.7 清理）。

### Verification

- `npm test -- --runInBand`：21 suites / 327 tests 全绿。

## [v4.0.0] - 2026-10-21

> 本次发布为破坏性变更：下游协议收敛为 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 三种；Gemini 仅保留为上游 provider 协议。OpenAI Images 下游入口保持不变。

### Changed (变更)

- **下游协议收敛**：客户端只再暴露 `/v1/chat/completions`、`/v1/responses`、`/v1/messages` 与 `/v1/models`。
- **Gemini 角色调整**：Gemini/Antigravity 继续作为上游 provider，参与请求转换和响应回译；不再接受原生 Gemini 客户端请求。
- **OpenCode 示例迁移**：`gemini-antigravity` 示例从 `@ai-sdk/google` + `/v1beta` 改为 `@ai-sdk/openai-compatible` + `/v1`。
- **文档同步**：跨协议架构、Antigravity 说明、CLI 技能文档、启动信息和 API 文档统一标注下游/上游协议边界。

### Removed (移除)

- `GET /v1beta/models`
- `POST /v1beta/models/{model}:generateContent`
- `POST /v1beta/models/{model}:streamGenerateContent`
- `ENDPOINT_TYPE.GEMINI_CONTENT`、`ENDPOINT_TYPE.GEMINI_MODEL_LIST`、`API_ACTIONS`
- `request-pipeline` 中 Gemini 客户端协议映射、模型列表构造、错误格式与流式结束标记
- `GeminiStrategy.extractModelAndStreamInfo`
- Provider 池的 Gemini 模型列表格式
- 转换器中目标协议为 Gemini/Codex/Grok 的响应、流式与模型列表不可达分支（约 2.2k 行）
- Gemini 作为客户端协议的请求转换方法
- 未使用的 `getOpenAIStreamChunkStop`、`ContentProcessor`、`ToolProcessor`

### Kept (保留)

- `POST /v1/images/generations`、`POST /v1/images/edits` 及 Playground 图片入口
- Gemini/Antigravity、Codex、Grok、Kiro、Zed、Trae 等上游 provider
- 上游 Gemini → OpenAI/Claude/Responses 的响应与流式转换
- OpenAI/Claude/Responses → Gemini/Codex/Grok 的上游请求转换

### Verification

- `npm test -- --runInBand`：20 suites / 309 tests 全绿。
- 所有修改的 JS 文件通过 `node --check`。
- `request-pipeline` import smoke 通过。
- `tests/api-integration.test.js` 在未设置 `TEST_API_KEY` 时按既有逻辑跳过。

## [v3.17.0] - 2026-10-20

> 本次发布汇总 `v3.14.1` 之后的全部变更。过程里程碑标签：`v3.15.0`（模型能力统一）、`v3.16.0`（正向模型选择）、`v3.16.1`（Zed Gemini 3+ 修复）。

### Added (新增)

- **节点正向模型选择**：
  - 节点候选来自上游 `model_list`，默认全选；取消勾选即表示该节点不使用该模型。
  - 新增 `supportedModelsBaseline`，上游后续新增模型默认自动选中。
  - 分组最终模型列表 = 活跃节点选择集并集 ∪ 该分组的自定义模型。
  - 自定义模型只参与分组最终集与路由，不进入节点候选列表。
  - model_id 全程大小写敏感。
- **统一的模型能力与路由读取**：
  - `resolveNodeCapability()` 输出 `candidateModels` / `selectedModels` / `selectionMode`。
  - `/api/providers` 节点新增候选集、选择集与能力来源元数据。
  - `detect-models` 改为任意 provider 均可刷新的能力刷新入口。
- **一次性旧字段清理脚本**：
  - 新增 `src/scripts/purge-legacy-model-fields.js`，默认 dry-run，`--write` 才落盘。
- **跨协议架构入口**：
  - 新增 `docs/CROSS_PROTOCOL_ARCHITECTURE.md`，收敛当前协议链路、模型代际、流式状态与硬约束。

### Changed (变更)

- **模型代际收敛**：GPT-5+、Claude 4+、Gemini 3+；删除 Claude 3 回退、Zed o1/o3、Trae 旧 GPT/Claude 别名。
- **Gemini 思考配置统一**：删除 Gemini 2.5 `thinkingBudget` 双轨，统一为 `thinkingLevel`。
- **文档治理**：已实施方案归档到 `docs/archive/`；修复 Adapter Guide 的失效相对链接；更新配置示例、OpenClaw/OpenCode 示例与教程字段。
- **已移除 provider 清理**：删除 `gemini-cli-oauth`、`openai-qwen-oauth`、`openai-iflow` 在配置示例、UI 文案、config-scanner 与 CLI 注释中的残留。

### Fixed (修复)

- **Zed Gemini 3+ 思考配置**：`reasoning_effort` 正确映射为 `thinkingConfig.thinkingLevel`，修复 `gemini-4-argon` 等模型返回 500 的问题。
- **冷启动能力缓存**：刷新失败且无历史发现时回退静态基线，不把失败的空结果当成可靠发现。
- **自定义模型路由**：补齐非流式凭证重试的路由意图；自定义模型 `actualModel` 不再被上游候选集误拦截。
- **保存残留**：provider 更新时清除旧负向字段与运行时模型元数据，避免 spread 残留。

### Removed (移除)

- 移除 `notSupportedModels`、`disabledModels`、节点 `availableModels` 与 `includeDisabled`。
- 移除 `GET /api/provider-models/{type}`。
- 移除 `updateProviderModels()`、`getConfiguredNotSupportedModels*`、`filterNotSupportedModelsFromModelList()` 等旧逻辑。

### Verification

- `npm test`：21 suites / 326 tests 全绿。
- 文档本地链接检查：0 个失效链接。
- 32 个 provider/model 组合冒烟通过；Zed `gemini-4-argon` 在 `reasoning_effort=high` 下验证通过。

## [v3.14.1] - 2026-10-18

> 跨协议转译优化系列（Phase 0-4 全部落地 + 加固收尾；历史优化文档已在 v4.1.7 清理，可在 git 历史中查看）。过程里程碑标签：`v3.10.1`（Phase 0）、`v3.11.0`（Phase 1）、`v3.12.0`（Phase 2）、`v3.13.0`（Phase 3）、`v3.14.0`（Phase 4）。

### Added (新增)
- **Schema Polyfill 降级编译器**（Phase 1，里程碑 v3.11.0）：
  - 新增 `src/converters/schema-polyfill.js`，`$ref` 静态内联展开（循环检测 + 深度上限 10，超限安全坍缩）。
  - 被白名单剥除的约束（pattern/format/default/const/数值边界/长度/items 等 12 类）以 `[Constraints: k=v]` 格式注入 description，单字段 200 字符、整 schema 1000 字符双重上限，原始描述永不裁剪。
  - `oneOf`/`anyOf` 同型保留 type、异型删除 type 并注入分支摘要；`allOf` 浅合并 properties/required 并集。
  - env 开关 `CONVERT_SCHEMA_POLYFILL`（默认 on）与 `CONVERT_SCHEMA_POLYFILL_MAX_DESC`（默认 1000）。
- **签名金库 Signature Vault**（Phase 2，里程碑 v3.12.0）：
  - 新增 `src/converters/signature-vault.js`，无状态 HMAC 虚拟思考签名（`vsig1.<payload>.<hmac>`），进程级密钥（`SIGNATURE_VAULT_SECRET` 或启动随机生成），无 TTL。
  - X→Claude 响应侧（AnthropicSseEmitter + 各非流式组装路径）自动为无签名 thinking 块补签；Claude→非 Claude 四方向入口及 Claude 协议上游管道层无条件剥离虚拟签名，真签名永不剥离。
  - HMAC 校验失败仍按前缀安全剥离，永不因签名问题阻断请求；`SIGNATURE_VAULT` / `SIGNATURE_VAULT_STRIP` 独立开关。
- **Responses SSE Emitter 状态所有权收编**（Phase 3，里程碑 v3.13.0）：
  - 新增 `src/converters/responses-sse-emitter.js`，严格镜像 `AnthropicSseEmitter` 生命周期（start/textDelta/reasoningDelta/toolCall*/complete 全幂等）。
  - 全局单例 `streamStateManager` 彻底消除，流式状态收编实例字段 + `StreamSessionStore` 并发隔离；`openai-responses-events.js` 事件生成器纯函数化。
  - OpenAI / Gemini / Claude 三转换器 Responses 流式方向全量迁移，既有 golden 流式测试零回归。
- **跨协议可选增强**（Phase 4，里程碑 v3.14.0）：
  - 三处 parts 级同角色合并逻辑提取为 `mergeConsecutiveSameRoleContents` 纯函数。
  - tools 数组按 name 稳定排序（env `CONVERT_SORT_TOOLS`，默认 off），消除工具顺序抖动对隐式前缀缓存的干扰。
  - `cache_control` 跨协议丢弃补 debug 日志（`logOmittedCacheControl`），消灭静默丢弃。

### Fixed (修复)
- **Phase 0 定点修复包**（里程碑 v3.10.1）：
  - 统一思考预算换算：新阈值 `low<=2048 / medium<=8192 / high>8192`，修复常规预算全量坍缩为 high、medium 档名存实亡的问题；四份漂移换算表归一至 `src/converters/thinking-budget.js`。
  - Responses→Gemini 思考配置恢复：`toGeminiRequest` 按 `reasoning.effort` 生成 thinkingConfig（Gemini 3 thinkingLevel / 2.5 thinkingBudget 双轨）。
  - Responses→OpenAI 保留 reasoning item（折入 assistant 消息，`CONVERT_PRESERVE_REASONING_ITEM` 默认 on）与响应侧 `reasoning_content` 回填；`item_reference` 显式 debug 日志跳过。
  - Claude document 块四方向处理：→Gemini 原生 inlineData（>20MB 占位降级）、→Responses input_file、→Codex 占位（`CODEX_PDF_AS_INPUT_FILE=1` 尝鲜）、→OpenAI 占位 + warn 告警。
  - 思考签名闭环加固：<50 字符短签名放行 + debug、流式 `signature_delta` 转发携带 thoughtSignature 的 Gemini chunk、`redacted_thinking` 占位 + warn。

### Changed (变更)
- **加固收尾（P0-P3）**：清理 Phase 1/3 遗留死代码 436 行；所有转换层功能开关（`CONVERT_*` / `SIGNATURE_VAULT*`）统一经 `config-manager` 读取；Responses 事件生成器切断全局状态镜像；`polyfillSchemaForGemini` 补齐 `dialect` 预留接口。
- **测试体系**：新增 thinking-budget / schema-polyfill / signature-vault / responses-sse-emitter / phase4-enhancements 五个测试套件，全量 19 套件 288 用例通过。

## [v3.10.0] - 2026-10-16

### Added (新增)
- **Codex 动态模型发现与自动同步**：
  - 对接 `/backend-api/codex/models?client_version=...` 端点动态查询账号可用的最新模型目录，设置 10 分钟本地缓存与节点元数据。
  - 动态拉取的模型自动与基准模型库合并，自动衍生 `-fast` 变体并保留 `gpt-image-2` 虚拟图像模型。
  - 扩充预置基准模型池，新增 `gpt-6-luna`、`gpt-6-astra`、`gpt-6.1-sol`、`gpt-6-sol` 等全新一代模型支持。
- **Codex WebUI 客户端版本号配置**：
  - 在 `openai-codex-oauth` 节点编辑表单中增加 `CODEX_VERSION` 输入项，支持针对不同账号独立配置客户端版本号。
  - 完善中英文多语言字典（提供商字段与占位提示），编辑保存版本号时即时作废缓存，下次调用立即按新版本号拉取最新模型。
- **Codex 订阅类型解析与权限门禁过滤**：
  - 新增 `parseCodexTokenMetadata` 自动解析 OAuth Token 中的 `chatgpt_plan_type` 订阅类型与 `account_id`。
  - 自动过滤 `supported_in_api: false` 以及需要升级付费计划（`upgrade`）的门禁模型，防止调用越权模型报错。

### Fixed (修复)
- **Codex 非流式响应误判修复**：修复上游返回有效非流式响应时，因响应结构校验误判为空响应而触发 5 次无意义重试并最终报错的问题。
- **流式思考增量放行**：放行 OpenAI 协议下的 reasoning delta 思考增量内容，保障思维链平滑透传展示。
- **客户端断开连接健康度判定修复**：修复客户端主动提前断开请求（如用户取消生成）时被误判为节点上游超时错误而扣减健康度的问题，保护节点号池稳定性。
- **思考后空响应拦截**：修复上游模型输出思考内容后直接断开且无正文（`MALFORMED_FUNCTION_CALL`）被静默放行的问题，及时捕获异常并介入重试或熔断。

### Changed (变更)
- **版本解析去暗箱化与去阻塞优化**：彻底移除 `child_process.execSync('codex --version')` 同步子进程探测，消除主线程事件循环阻塞与不同环境暗箱探测行为漂移风险。
- **架构解耦**：移除顶层单例 `CODEX_VERSION`，各 `CodexApiService` 实例独立持有自身的 `this.version`，实现多节点状态解耦。

## [v3.9.1] - 2026-10-13

### Fixed (修复)
- **发布卫生**：补齐 v3.9.0 缺失的版本 bump（v3.9.0 tag 指向的提交 package.json 仍为 3.8.0，CHANGELOG 仍挂 Unreleased）。
- **trae 存量配置兼容迁移**：config 加载时自动迁移历史 `trae-agent_v3` 池键至 `trae-solo_work_lite`（按 uuid 去重）、节点历史 `TRAE_CHANNEL_MODE`（`agent_v3`/`legacy`）改写为 `solo_work_lite` 并原子回写持久化；`resolveTraeChannelMode` 与 `MODEL_PROVIDER` 归一化同步容忍历史值——v3.8.0 及更早配置升级后不再抛 `Unsupported model provider`。
- **Responses API**：`response.completed` 的 `safety_identifier` 不再每次生成随机值（置空，与 usage 全零兜底同一治理原则，杜绝伪造数据）。
- **AnthropicSseEmitter**：`delta()` 增加误用守卫（multi 模式误调或无活动块时抛错并指引 `deltaAt`），杜绝静默产出 `index:-1` 的非法 SSE 事件。
- **provider-api**：`validateTraeProviderConfig` 改为显式 `TRAE_CHANNEL_MODE` 恒优先于 providerType（与通道判定「显式优先」原则一致），修复矛盾组合（如 `trae` + `solo_work_lite`）下的误拒/误放行。

### Changed (变更)
- **分层治理**：`mapFinishReason`/`sanitizeToolId` 下沉至 `src/utils/protocol-utils.js`（`converters/utils.js` 再导出保持兼容），消除 zed-core 对 converters 层的反向依赖。
- **重构清理**：移除 `TRAE_CHANNEL_PRESETS` 无消费方的 `name`/`label` 死字段、`getChannelConfig` 不可达 preset 兜底、OpenAIConverter responses 流状态死初始化；`CodexConverter.streamParams` 更名 `streamSessions`；trae-core 别名表种类改为构造期一次解析缓存；`getOpenAIStreamIdentity` 缺 requestId 时按 store 一次性告警（并发共享 default 键风险可观测）。
- **文档**：修正 TRAE 通道指南残留旧模型数对照表（25/25/29 → 24/19/20，与 provider-models 实际清单一致）。

## [v3.9.0] - 2026-10-13

### Fixed (修复)
- **zed**：修复 open_ai 模型工具调用后 `response.completed` 的 stop_reason 恒为 `end_turn` 的问题（改用独立的 sawToolUse 标志）；google 路径补全整体缺失的工具能力（tools→functionDeclarations、tool_choice→functionCallingConfig、tool_use/tool_calls→functionCall、tool_result→functionResponse），工具 id 统一经 `sanitizeToolId` 清洗还原函数名。
- **converters**：Gemini->Claude 流式补齐 `message_start`/`content_block_start`、块 index 递增与 `message_stop` 收尾，产出合规 Anthropic SSE；Responses API 无 usage 时不再伪造随机 token 数（改全零兜底）；非流式 status 移除非法的 `requires_action`/`in_progress`（stop/tool_calls→completed，length/content_filter→incomplete+incomplete_details）；流式 chunk id/created 在同次请求中保持稳定；responses output_index 与 sequence_number 严格递增；快照式 arguments 按 diff 增量下发；Claude->OpenAI 的 finish_reason 不透传 anthropic 专有词表。
- **trae**：修复 CUSTOM 模式且 URL 含 `llm_utils_chat`（个人版自定义端点）时错误走 ToB 接口与别名表的问题；别名表剔除上游已下线/开关关闭的型号；WebUI Trae 授权弹窗默认 Host 按通道区分。
- **Gemini->Claude stop_reason 合规**：SAFETY/RECITATION 等安全拦截类终态统一映射为 Anthropic 合法值 `refusal`（原 `stop_sequence`/`safety`/`recitation`/`other` 语义错误或非法）。
- **grok**：修复 Grok->Claude 委托调用未透传 requestId 导致的并发流状态交叉（缺 responseId 时 message_start 每帧重发、messageId/usage 跨请求污染）；拆除重复包装层，首帧 message_start 由两个恢复为一个（合规 Anthropic SSE）。

### Changed (变更)
- **Trae 通道重构 (Breaking)**：彻底废除历史 `trae-agent_v3` 通道（经核实 `agent_v3` 仅为上游网关路径层级而非业务 function），重新确立 `trae-solo_work_lite`（SOLO Agent，19 模型）与 `trae-chat_v3`（侧边栏 Chat，20 模型）为独立一级提供商；废除动态拉取模型列表时的"基准兜底合并"与"强制追加 auto 虚拟别名"机制，模型列表 100% 对应上游真实活跃模型（trae 24 / solo_work_lite 19 / chat_v3 20）；请求时保留向后兼容的别名归一化。
- **Trae 通道判定收敛**：新增 `trae-channel.js` 纯函数模块作为 single source of truth（resolveTraeChannelMode/isSoloFamilyChannel/resolveAliasTableKind/TRAE_PROVIDER_DEFAULTS），trae-core/provider-api/service-manager 六处判定点统一委托；**通道模式优先级明确为「显式 configuredMode 恒优先于 providerType 与 URL 推断」**，修复个人版节点手改 `custom` 逃生口被 providerType 静默覆盖的问题。
- **Anthropic SSE 骨架统一**：新增 `AnthropicSseEmitter`（sequential/multi 双语义、done 终态守卫、finish 自动补 message_start），GeminiConverter claude 流首个迁移（净减 74 行），为后续 Codex/OpenAI 机器统一奠基。
- **重构清理**：`sanitizeToolId`、`getOpenAIStreamIdentity` 收敛为共享导出（消除逐字节重复定义）；zed-core 的 gemini finishReason 内联映射收编至共享 `mapFinishReason`；删除 GeminiConverter claude 流状态的 completed 死逻辑与 trae-core 的恒等冗余条件。

## [v3.8.0] - 2026-10-10

### Added (新增)
- **Trae 独立双通道拆分 (Breaking / Major)**：
  - 将 Trae 正式拆分为两个完全独立的一级提供商：`trae`（企业原生 ToB Raw Chat）与 `trae-agent_v3`（SOLO Agent v3 / chat_v3）。
  - 双通道各自拥有完全隔离的端点配置、请求 Header 指纹、请求体构建与动态模型发现。
  - `trae` 独立对接企业端点 `https://api.enterprise.trae.cn/api/ide/v2/llm_raw_chat`（`function: "chat"`）。
  - `trae-agent_v3` 独立对接端点 `https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat`（`function: "solo_work_lite"`）。
- **两端专属动态模型发现**：
  - `trae` 动态拉取企业 `batch_get_detail_param`（25 个模型，包括专属 `Doubao_1_6`、`glm-5v-turbo`、`minimax-m2.7`、`kimi-k2.8-preview`）。
  - `trae-agent_v3` 动态拉取个人版 `get_detail_param`（25 个模型，包括专属 `kimi-k2.6`、`glm-5`、`glm-5-turbo`、`DeepSeek-V4-Flash`）。
  - 经全量实测 50/50 模型请求 100% 成功。
- **配置安全与防呆校验**：
  - 提供商表单与 API 新增 `validateTraeProviderConfig` 交叉校验，严防 ToB 与 Agent v3 的 URL 错配。
  - PAT / OAuth 登录自定义 Host 沿 options 链完整透传至新节点 `TRAE_BASE_URL`。
  - `autoLinkProviderConfigs` 引入双重磁盘池合并防御，严禁局部写入覆盖整个号池文件。
- **技术规范文档**：
  - 新增 `docs/TRAE_CHANNELS_UPSTREAM_GUIDE.md`，深度剖析上游 `solo_work_lite`、`chat_v3` 与企业 `chat` 的协议与参数差异。

### Changed (变更)
- **WebUI 配置表单精简**：彻底移除“通道模式 (Channel Mode)”选择框与表格列，简化用户配置心智模型。
- **测试环境严格隔离**：单元测试注入独立临时文件，杜绝污染生产配置。

---

## [v3.7.1] - 2026-10-09

### Added (新增)
- **流式会话状态存储器 (StreamSessionStore)**：
  - 引入统一的带 TTL 的 `StreamSessionStore` 管理多协议转码过程中的临时会话上下文，解决长连接会话泄漏隐患。
- **架构设计规范**：
  - 新增 `docs/archive/CONVERTER_STREAM_DESIGN.md` 流式转换共享层设计规范。

### Changed (变更)
- **finish_reason 统一归一化**：
  - 将各协议转码器散落的终止原因映射统一收敛至共享的 `mapFinishReason`。

---

## [v3.7.0] - 2026-10-09

### Removed (移除 - Breaking Changes)
- **彻底下线 4 个废弃提供商**：
  - 彻底移除 `FORWARD_API`、`QWEN_API`、`IFLOW_API`、`GEMINI_CLI` 的适配器、业务核心、WebUI、认证逻辑与相关映射常量，默认 `MODEL_PROVIDER` 调整为 `gemini-antigravity`。

### Refactored (架构重构)
- **底层解耦与循环依赖消除**：
  - 新建 `src/utils/protocol.js` 下沉协议基础能力，消除 `common.js` 的全部静态循环依赖。
  - 将庞大的请求处理管线迁出至独立的 `src/handlers/request-pipeline.js`，`common.js` 代码体积大幅下降。
- **用量解析收敛**：
  - 抽取共享模块 `usage-normalizer.js`，统一 `api-potluck` 与 `model-usage-stats` 的统计提取逻辑。
- **依赖瘦身**：
  - 移除未使用的运行时依赖 `lodash`、`openai`、`@ai-sdk/openai`、`ai`，`undici` 归入 devDependencies。

---

## [v3.6.2] - 2026-10-08

### Fixed (修复)
- **转码器多轮工具调用**：
  - 合并连续 assistant 工具调用消息，修复并发 `tool_calls` 导致的流中断 (上游 4027 错误)。
  - 修复 Anthropic 协议 Harness 工具调用转换、响应块顺序与流式状态机。
  - 修复多协议转码工具调用上下文丢失与轮次校验问题。
- **Gemini Protobuf 冲突消除**：
  - 统一 `thinkingConfig` 中的 `includeThoughts` 命名，消除 Protobuf oneof 字段冲突。
- **用量统计修复**：
  - 修复 Trae 模型使用统计为 0 及 Token 累加逻辑。
  - 修复 Zed Provider 缓存命中 Token (Cached) 统计为 0 的问题。
  - 修复托管 Provider 丢失自定义模型及 Playground 不显示 OpenAI Custom 模型问题。

---

## [v3.6.1] - 2026-10-05

### Added (新增)
- **Zed 推理能力升级**：
  - 完整支持 OpenAI 思考模型的 5 档推理强度（Reasoning Effort）双向映射。
- **Antigravity 模型提取优化**：
  - 优雅提取 `agentModelSorts` 与生图模型，自动排除 medium/low/lite 降级模型。

### Fixed (修复)
- 修复 Antigravity 节点模型隔离与禁用节点时模型列表动态同步失效问题。
- 修复 Zed `claude-sonnet-5-5` 400 校验错误及测试配置污染问题。
- WebUI Playground 移除多余的 Temperature 与 MaxTokens 参数显示。

---

## [v3.6.0] - 2026-10-01

### Added (新增)
- **Trae (SOLO) 深度提供商接入**：
  - 支持 WebUI OAuth 授权与 PAT (Personal Access Token) 凭据导入管理。
  - 支持自 `api.enterprise.trae.cn` 与 `trae-api-cn.mchost.guru` 动态拉取模型元数据。
  - 动态提取 `context_window`（最高 1M Tokens）与 `max_tokens`（最高 64k Tokens）。
  - 双向映射思考深度参数 `reasoning_effort`。
  - 完整支持 OpenAI 兼容工具调用 (Tool Call) 与 SSE 流式聚合。
  - 生产级多租户隔离架构。
