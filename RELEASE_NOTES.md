# AIClient-2-API 发布说明 (v7.0.0)

> ## 🚨 破坏性变更：本版本起**只支持 Node.js 24+**
>
> 系统运行基线由 `^22.18.0 || >=23.6.0` 收紧为 **`>=24.0.0`**。
> Node.js 22 及更早版本**将直接拒绝启动**并给出明确升级提示。
>
> 请注意：Node 22.18+ 同样具备原生 TypeScript 类型擦除能力，仅靠特性探测无法区分，
> 因此本版本新增了**真实主版本校验**，而不是静默通过后在运行时出现难以定位的差异。
>
> **升级前请确认运行环境**：`node -v` 应为 `v24.x.x` 或更高；
> Docker 用户请拉取新镜像（基础镜像已升级为 `node:24-alpine`）。
>
> ---
>
> **v7.0.0** 同时包含 v6.3.0 的**后端架构性能 + 转译准确性**改进
> （该版本的数字版本号未在 GitHub 单独发布，内容已并入本页）。
>
> 跨协议转译的「跳数」正式收敛：`openai-codex-oauth` 为
> **1-Hop / 0-Hop / 1-Hop**，`trae` 与 `trae-chat_v3` 为 **1-Hop / 1-Hop / 1-Hop**；
> 并修复 5 处转译准确性缺陷与生图路由的模型前缀缺陷、消除若干条热路径上的
> 重复 JSON 序列化与全量深拷贝，完成一轮插件沙箱安全加固与测试集精简。
>
> **除 Node.js 版本要求外，无其它破坏性变更**：无需修改配置，对外 API 行为零改动。
>
> > 📌 **注意**：GitHub 上一个正式 Release 是 v6.1.0。本页同时包含
> > **v6.2.0 的 WebUI「美观与简洁」深化**（详见第七节）、v6.3.0 的后端优化，
> > 以及本次 v7.0.0 的 Node.js 24+ 基线收紧。

---

## 🚨 一、运行基线收紧为 Node.js 24+（破坏性变更）

| 位置 | 变更前 | 变更后 |
|---|---|---|
| `package.json` `engines` | `^22.18.0 \|\| >=23.6.0` | **`>=24.0.0`** |
| `.nvmrc` | `22` | **`24`** |
| `Dockerfile` 基础镜像 | `node:22-alpine` | **`node:24-alpine`** |
| CI 矩阵 | `[22.x, 24.x]`（13 步 × 2） | **单版本 `24.x`** |
| 启动时版本校验 | 仅探测 `process.features.typescript` | **额外校验主版本 >= 24** |

**为什么必须加真实版本校验**：本次实测确认，Node 24 默认的
`process.features.typescript` 同样是 `'strip'`（完整 `'transform'` 需显式
`--experimental-transform-types`）。也就是说 Node 22.18+ 与 24 **在类型擦除能力上无法区分**，
仅靠特性探测会让 22.x 静默通过。现在启动入口会在加载应用模块图**之前**报错退出。

```
$ node -v
v22.18.0
$ npm start
[Master] Current Node.js (v22.18.0) is not supported.
         This build requires Node.js >= 24.0.0 (or pull the latest Docker image) before continuing.
```

配套的 `tests/runtime-check.test.js` 把该门槛固化为回归用例（含伪造 `v22.18.0` 的入口级验证）。

### 顺带清理（依赖 Node 24 基线才成立）

- **移除 `dotenv` 依赖**：改用 Node 内置 `process.loadEnvFile`。
  注意两者语义差异已对齐——`.env` 缺失时静默跳过（原生实现会抛 `ENOENT`），
  且不覆盖已有环境变量。新增 `src/services/env-loader.ts` 封装与回归测试。
- **2 处 `fileURLToPath(import.meta.url)` 改用 `import.meta.dirname`**：
  `src/core/master-core.ts`、`src/utils/tls-sidecar.ts`（后者保留 try/catch 兜底语义）。

---

## ⚡ 二、跳数收敛：更少的协议转换，更低的延迟与失真

系统下游固定为 `OpenAI Chat` / `OpenAI Responses` / `Anthropic Messages` 三种标准端点。
本版本把两种高频 Provider 的多余转换层彻底去掉：

| Provider | `/v1/chat/completions` | `/v1/responses` | `/v1/messages` |
|---|:---:|:---:|:---:|
| `openai-codex-oauth` | 1-Hop | ~~1-Hop~~ → **0-Hop** | 1-Hop |
| `trae` / `trae-chat_v3` | 1-Hop | ~~2-Hop~~ → **1-Hop** | ~~2-Hop~~ → **1-Hop** |
| `openai-custom` | 0-Hop | 1-Hop | 1-Hop |
| `openaiResponses-custom` | 1-Hop | 0-Hop | 1-Hop |
| `gemini-antigravity` / `zed` | 1-Hop | 1-Hop | 1-Hop |

1. **`openai-codex-oauth` 实现 `/v1/responses` 0-Hop 直通**：
   - Codex 方言清洗（`input` 归一、`system`→`developer`、`text.format` 规范化、
     `temperature`/`top_p`/`user` 剔除、超长工具名缩短）全部内聚到 Provider 层，
     不再依赖上游转换器预处理。
   - 非流式响应直接返回解包后的标准 Responses 对象；工具名缩短/还原的归属改为
     「谁缩短谁还原」，历史 `input` 里的超长工具名也会同步缩短。
2. **`trae` / `trae-chat_v3` 三端直接 1-Hop**：
   - `TraeApiService` 可一步消化三种下游协议请求体，直接构造 Trae 私有协议，
     不再经由中间 OpenAI 协议层做 2 次转换；响应侧也直接产出下游协议的事件序列。
3. **管道层引入显式「桥接计划」**：把「是否需要转换」从「协议前缀不同」升级为
   一张可推理的计划表，0-Hop / 1-Hop 场景不再误走 `convertData`。

---

## 🐛 三、转译准确性修复（5 项 + 生图路由）

| # | 模块 | 缺陷 | 影响 |
|---|---|---|---|
| 1 | `CodexConverter` | 非流式只取首个 `output_text` 块，且多段输出用覆盖而非累加 | 长回答被截断 |
| 2 | `CodexConverter` | 流式忽略 `reasoning_text.delta`，且无增量工具参数 | 思考内容与工具调用参数丢失 |
| 3 | `GeminiConverter` | 非流式忽略内联图片（`inlineData` / `inline_data`） | 生图结果在非流式路径丢失 |
| 4 | `ZedApiService` | 非流式聚合忽略 `signature_delta` | thinking 块缺签名，下游回传失败 |
| 5 | `TraeApiService` | 工具名聚合用 `+=` 无条件拼接 | 同名多帧时拼成 `get_weatherget_weather` |

此外还修复了**生图/改图路由的模型前缀缺陷**：`/v1/images/generations` 与
`/v1/images/edits` 此前会把带 `provider:` 前缀的模型 ID 原样传给上游
（如 `gemini-antigravity:gemini-3.1-flash-image`），导致必然返回 500。
现已与对话路径对齐，使用解析后的真实模型名。

---

## 🚀 四、热路径性能优化

1. **Antigravity SSE 每帧只解析一次 JSON**：删除逐帧 `JSON.parse` + `JSON.stringify`
   的字符串级清洗，改为对象级原地剥离中间帧 `usageMetadata`。
2. **非流式聚合消除三重 JSON 往返**：直接消费已解析的对象数组，去掉
   `stringify`→`join`→`split`→`parse` 的往返。
3. **请求构建深拷贝从最多 4 次降为 1 次**：非流式回退判定前移到建包之前，
   回退时复用同一份 payload；含 Base64 图片时显著减少主线程阻塞。
4. **Trae 请求体入口消除全量深拷贝**：改为浅拷贝，后续构造独立进行，不污染入参。
5. **Converter 会话级状态泄漏治理**：`buildToolNameMap` 仅在确有工具名被缩短时写入
   状态，并在非流式出口与流终止路径主动释放；配合管道层 `clearCustomTools`，
   避免请求级状态驻留至 30 分钟 TTL。

---

## 🔒 五、安全加固与代码卫生

1. **封堵插件沙箱绕过**：此前插件只要执行 `Error.stackTraceLimit = 0`（或劫持
   `Error.prepareStackTrace`）就能让调用栈判定失效，从而绕过 `fs` 写保护。
   现在取栈前会临时抬升 `stackTraceLimit` 到安全下限并还原原始 `prepareStackTrace`，
   三种绕过手法均已封堵，并补充了子进程回归用例。
2. **清理 12 个安全审计 PoC 插件**：移除越权写文件的演示插件及其配置条目。
3. **删除 6 个单行 `.js` 转发桩**：`src/plugins/` 下的 import 统一指向 `.ts`，
   仅保留进程启动入口。

---

## 🧪 六、测试集精简与 E2E 收敛

- **删除 8 个冗余测试文件**，但严格保留 `claude-custom` 与 `claude-kiro-oauth`
  相关的全部用例。其中 `error-helper-regression` 并非纯冗余（含唯一覆盖插件市场
  降级回退的用例），其有效断言已迁移至更准确的测试文件后再删除。
- **E2E 默认收敛到 7 Provider × 10 代表模型**，真实上游请求量从数百次降到
  约 110 次；需要全量回归时用 `AICLIENT_E2E_ALL_MODELS=1` 恢复。
- 把此前**未接线的 `typecheck:webui` 正式纳入 `verify` 与 CI**，确保删除
  `static-syntax` / `static-import-graph` 后静态守护不出现真空。

---

## 🎨 七、附带：v6.2.0 WebUI「美观与简洁」深化（此前未在 GitHub 发布）

若你从 v6.1.0 升级，以下前端改进一并在本版本中生效：

- **首屏传输量 312.4 KB → 101.6 KB（-67.5%）**：大图改为 webp，仅被 README 引用的
  图片移出 `static/`（`static/` 1.8 MB → 1.3 MB）。
- **设计尺度收敛**：字号从 39 种有效取值收敛到 7 档，圆角全部走 `--radius-*` 令牌，
  间距按 2px 网格化。
- **移动端样式瘦身**：单 section 的响应式规则回迁入各自文件，
  `mobile.css` 从 29.6 KB 降至 17.9 KB。
- **公共组件与工具抽取**：`PasswordInput`（仅编辑态可回读明文）、`streamBatchImport`、
  `downloadBlob`、`DistributionList`、`useResource`、`toastError` 等统一入口。
- **HTML 外壳单一真源**：`gen:webui-html:check` 纳入 CI，5 份 HTML 的 import map 与
  主题引导脚本保持一致。

---

## 📊 验证结果

| 项目 | 结果 |
|---|---|
| 运行环境 | Node.js **v24.22.2**（CI 单版本 `24.x`） |
| 单元测试 | **87 suites / 881 tests 全绿** |
| 线上跨协议 E2E | **4 suites / 46 tests 全绿**（7 Provider / 10 代表模型） |
| `npm run verify` | 全链路通过（tsc / strict / any 棘轮 / imports / cycles / CSS / 覆盖率 / runtime smoke） |
| 类型债务 | `DynamicPayload` 引用 1549 → 1506（低于基线，未放宽门槛） |
| 启动门槛 | 伪造 `v22.18.0` 启动被拒绝（exit 1），`v24.x` 正常 |

---

## ⬆️ 升级说明

### 🚨 升级前必读

1. **确认 Node.js 版本为 24 或更高**：
   ```bash
   node -v     # 必须 >= v24.0.0
   ```
   低于该版本将直接拒绝启动，不会降级运行。
2. **Docker 用户必须拉取新镜像**：基础镜像已由 `node:22-alpine` 升级为
   `node:24-alpine`，沿用旧镜像不受影响但无法获得本次改进。
3. **本地开发建议执行 `nvm use`**：`.nvmrc` 已更新为 `24`。

### 其它

- 除 Node.js 版本要求外**无其它破坏性变更**，无需修改任何配置，
  对外 API 行为保持一致（仅更准确、更快）。
- 升级后重启服务即可；WebUI 用户建议硬刷新一次浏览器。
- 若你使用 `trae` / `openai-codex-oauth` 的 Responses 端点，可留意首字延迟与
  工具调用完整性的改善。

---

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)