# AIClient-2API 发布说明 (v8.9.2)

> ## 🧹 请求管线解耦版本
>
> **版本重点**：把仓库内改动最密集的 2641 行 `request-pipeline.ts` 按职责拆成 6 个模块
> （净减 53%），并显式设定测试并发。**纯内部重构，无任何行为变更**，
> 无破坏性变更，可直接升级。

---

## ⚠️ 兼容性说明

**本版本无破坏性变更，也无行为变更**，从 v8.9.0 / v8.9.1 可直接升级。

- 不涉及存储结构、配置键、HTTP 接口、环境变量的任何变化。
- `request-pipeline.ts` 保留了全部 27 个原有导出（含新增的 5 个 re-export 项），
  外部导入方无需改动。
- 唯一可见变化：`npm test` 跑得更快（见下文第二节）。

---

## 一、为什么拆这个文件

选择它作为重构目标，依据是**改动密度**而不是行数：

```
src/handlers/request-pipeline.ts     最近 40 个提交中 39 个真实修改它
                                     累计 +3510 / −869 行
src/providers/model-capability.ts    12 个
src/converters/.../ClaudeConverter   16 个
```

40 个提交里 39 个动它，且多个提交标题本身就是修 bug（token 预扣生命周期泄漏、
4xx/5xx 误判、重试状态泄漏、号池槽位未释放等）。同时它内部存在明显的认知负担：

- `handleStreamRequest` 614 行、`handleUnaryRequest` 293 行、`handleError` 家族 126 行；
- 在 stream 函数内部，**127 行代码位于 5 层以上嵌套**（最深 7 层）。

这类文件的问题不在于「长」，而在于改动时的心理负担：任何一个横切改动都要在
600 行上下文里确认自己没碰坏旁边不相关的分支。

---

## 二、本次变更

### 1. 拆分 `request-pipeline.ts`：2641 行 → 1248 行（−53%）

拆出 6 个模块到 `src/handlers/pipeline/`：

| 模块 | 行数 | 职责 |
|---|---:|---|
| `error-response.ts` | 476 | 错误响应构造与投递（`handleError` / `createErrorResponse` / 状态码解析） |
| `unary-handler.ts` | 490 | 非流式请求处理 + 空响应重试预算 + 号池健康映射 |
| `protocol-plan.ts` | 401 | 协议感知判定：终态原因、桥接计划（0-Hop / 1-Hop）、有效内容识别、文本提取 |
| `model-routing.ts` | 139 | 自定义模型路由解析与 `/v1/models` 拼装 |
| `stream-writer.ts` | 89 | 背压感知帧写出 + 零窗口防挂死 |
| `error-types.ts` | 22 | 两侧共用的 `PipelineError` 形状（纯类型，编译后擦除） |

**两条拆分依据都经过实测，而不是凭直觉**：

- **非流式路径与流式路径零耦合**：逐符号检查 `handleUnaryRequest` 对
  `writeFrameWithBackpressure` / `PreContentBuffer` / `streamState` /
  `clientDisconnected` / `anyDataSent` 等 stream 专有符号的引用数，**全为 0**，
  因此可整体搬走而不改变语义。
- **错误模块只依赖 `PipelineError` 的形状**：错误簇（452 行）对文件其余部分的
  符号引用**仅有 `PipelineError` 一处**，边界天然干净。

### 2. 显式设定测试并发

`npm test` 默认并发设为 5（本机 4 核 + 1 个额外 worker），并支持
`TEST_CONCURRENCY` 环境变量覆盖。三次重复实测：

```
concurrency=4（原隐式默认）   17.5 / 19.1 / 17.8 s
concurrency=5                 16.7 / 17.3 / 16.6 s
```

稳定快约 6%。多派一个 worker 能掩盖部分文件的 I/O 等待——有 4 个测试文件要起
真实 HTTP 服务、跑 TLS 握手、读写临时文件。

**为什么没有更大的提速空间**：单文件开销有硬下限。实测空文件 265 ms、
带 `--import` hook 256 ms、仅加载业务模块 238 ms——三者几乎一样，说明这
~240 ms 是 node 启动 + 测试框架初始化，与加载多少代码无关。
105 文件 ÷ 5 ≈ 5 s 是纯开销，剩余约 11.8 s 才是真实执行时间。
（串行时总耗时 45 s，所以并行本身已经是主要收益来源。）

同时把并发写进脚本，避免行为随 Node 版本默认值漂移。

---

## 三、过程中修掉的两个真实问题

重构本身就暴露了两处隐患，都已修复：

1. **引入并消除了一处运行时循环依赖**。拆出 `unary-handler` 后它需要
   `request-pipeline` 的 `extractResponseText` / `getMonitorRequestId`，
   形成双向 import，`check:cycles` 直接报出
   `request-pipeline -> unary-handler -> request-pipeline`。
   把三个「按协议选策略」的纯函数（含 `extractPromptText`）下沉到
   `protocol-plan.ts` 后循环消失——它们本就属于协议层，放在管线里是历史遗留。

2. **一次过度清理导致测试从 1098 掉到 990**。曾把 `isTerminalEmptyFinishReason`
   从 `request-pipeline` 的 re-export 列表里删掉，导致
   `cross-protocol-bridging.test.mjs` 整文件加载失败（该文件有 109 项用例）。
   已恢复 re-export。这也正好说明**测试数量本身就是拆分的安全网**：
   任何导出面被误伤都会立刻变红。

---

## 四、没有做的事（诚实说明）

`handleStreamRequest` 拆分后**仍是 614 行**。它内部有 2 处**自递归**
（凭证切换重试、空响应重试），递归时要把 `res` / `streamState` /
`abortController` / `clientSignal` / `clientDisconnected` / `streamRequestId`
等 **12 项状态**打包传给下一帧。

强行抽出 retry-controller 会变成「把 614 行拆成 400 行 + 一个 200 行的状态搬运层」，
复杂度不降反升。真要处理需要先把递归改写成「循环 + 显式状态对象」的重试状态机，
那是独立的、需要单独设计的一项工作，不在本版本范围。

---

## 五、质量门禁与验证

- **`npm run verify` 11 个步骤全绿**：typecheck、typecheck:webui、check:strict、
  check:any、check:imports（139 个源文件）、check:cycles（**0 循环依赖**）、
  lint:css、gen:webui-html:check、vendor:webui:check、test、test:runtime。
- **1098 项测试全部通过**，与重构前**数量一致**——这是本次「不改行为」的核心证据：
  拆分为纯文件搬迁，没有任何用例因重构而新增、删除或修改。
- **导出面运行时校验**：逐个断言 `request-pipeline.ts` 的 27 个导出在运行时可用。
- **`check:cycles` 是本次真正的守门人**：拆模块最容易引入的就是循环依赖，
  它在我引入后立刻报出并被我修掉。

> 说明：本仓库不提供覆盖率门禁（理由见 v8.9.1 发布说明第二节）。
> 本次重构的等效验证手段是「测试数量不变 + 导出面逐个断言 + 循环依赖检查」。

---

## 六、升级建议

- **运行时环境要求**：Node.js >= 26.0.0（与 v8.9.0 相同）
- **升级步骤**：

  ```bash
  git pull
  npm ci --ignore-scripts
  npm start
  ```

- **无需迁移**：不涉及存储、配置或数据格式变更。
- **对使用者无感知**：本版本不修复也不引入任何功能或行为变化。
  若你在 v8.9.1 上运行正常，本版本同样正常，且 `npm test` 更快。

---

**完整变更明细**：见 [CHANGELOG.md](https://github.com/GreyRaphael/AIClient2API/blob/main/CHANGELOG.md)
