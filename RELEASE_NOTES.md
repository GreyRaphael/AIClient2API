# AIClient-2API 发布说明 (v8.9.4)

> ## 🔧 缺陷修复与 Node 26 / TS 7 架构精简版本
>
> **版本重点**：围绕 v8.9.3 代码评审开展系统性治理——修复 5 个高优先级缺陷与残余边界 Bug，
> 清理跨模块死代码与冗余封装，并将核心请求管线、转换器与调度结构充分收敛到
> **Node.js 26** 与 **TypeScript 7** 原生能力。

---

## ⚠️ 升级与兼容性说明

- **运行时要求**：Node.js >= 26.0.0（与 v8.9.x 系列一致）。
- **兼容性**：无破坏性 HTTP API 或配置文件格式变更，可直接从 v8.9.0 ~ v8.9.3 升级。

---

## 一、核心缺陷修复（Stability & Bug Fixes）

1. **模型能力刷新退避与 Antigravity 重试边界收敛**
   - 区分能力刷新意图 `'respect-backoff' | 'force'`：常规模型查询与后台预热严格遵守退避窗口，仅显式触发刷新时强制穿透，避免失败节点在每次 `/v1/models` 请求时反复打满上游。
   - 在 `antigravity-core.ts` 抽取 `#prepareRetryStep` 统一 `callApi` 与 `streamApi` 重试步进，修正 `429` 重试次数上限并在限流与网络错误重试时重置 `baseURLIndex`，同步修正 `retry.ts` 的 `limitFor` 上限钳位。

2. **Codex 响应信封显式契约（告别静默 `null`）**
   - 移除易在对象拷贝/序列化后丢失的不可枚举属性与 `_codexToolNameMap` 隐式挂载；新增 `unwrapCodexEnvelope` / `requireCodexEnvelope`，对未识别上游响应直接抛出 `502`，并收窄 `CodexConverter` 同步转换返回契约。

3. **超长工具名截断与碰撞哈希统一**
   - 将分散的 5 份截断逻辑统一到 `src/converters/tool-name.ts`，修复超长 `mcp__` 工具名碰撞后哈希截取异常及 `buildToolNameMap` 去重后缀超过 64 字符上限的溢出隐患。

4. **其他稳定性细节**
   - 修复 `--log-prompts file` 启动横幅未正确读取运行时派生日志文件名的问题。
   - 收口 `provider-api.ts` 与 `access-api.ts` 的文件路径与并发文件锁（`withProviderPoolsLock` / `providerPoolsPath`），统一使用 `resolveErrorStatusCode` 解析异常状态码。

---

## 二、Node 26 / TypeScript 7 工程化与结构重整

- **连接生命周期与流式管线解耦**：
  - 将 12 个位置参数收敛为 `RequestHandlerContext`。
  - 为 `StreamAbortScope` 实现原生 `Disposable`（`[Symbol.dispose]()`），结合 Node 26 `using` 声明、Native `AbortSignal.any()` 与 `createSlotReleaser` 统一管理客户端断连中止与并发槽位释放。
  - 将 `handleStreamRequest` 拆分为 `openUpstreamStream`、`pumpUpstreamStream`、`buildOutboundFrames`、`flushFramesWithBackpressure`、`finalizeUpstreamOutcome` 与 `handleStreamFailureRetry`。
- **转换器与路由收敛**：
  - `OpenAIResponsesConverter.toClaudeStreamChunk` 迁移到 `AnthropicSseEmitter`（`multi` 模式），消除手写块状态与签名拼接逻辑。
  - `ui-manager.ts` 管理路由改写为有序声明式路由表 `UI_ROUTES`；`provider-pool-manager.ts` 移除冗余镜像字段改为 `get` 访问器委托；`trae-core.ts` 为账户缓存增加 256 项 LRU 上界并拆分 `prepareRequestBody`。
- **类型契约与死代码清理**：
  - `ApiServiceAdapter` 与 `BaseConverter` 改为真正的编译期 `abstract class` 契约；删除死文件 `types/converters.d.ts`、无用导出与冗余参数（`noUnusedParameters` 纳入 `tsconfig` 归零），`any` AST 节点基线由 `98` 收紧至 `94`（`: any` / `as any` / `strict` 错误均为 `0`）。
  - 统一 `vendor:fa:check` 字体子集校验并消除冗余 CSS 与过时 shim。

---

## 三、全量验证结果

| 检查项 | 结果 |
|---|---|
| `typecheck` / `typecheck:webui` | 通过（0 错误） |
| `check:strict` / `check:any` | 0 严格错误；0 `any` 注解（94 AST nodes） |
| `check:imports` / `check:cycles` | 142 个文件全部通过（0 循环依赖） |
| `lint:css` / `gen:webui-html:check` / `vendor:webui:check` / `vendor:fa:check` | 全部通过 |
| 核心单元测试与回归测试（`npm test`） | **1122 / 1122 通过**（250 个套件） |
| 运行时冒烟测试（`npm run test:runtime`） | 通过 |

---

**完整变更明细**：见 [CHANGELOG.md](https://github.com/GreyRaphael/AIClient2API/blob/main/CHANGELOG.md)
