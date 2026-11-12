# AIClient-2API 发布说明 (v8.9.3)

> ## 🧪 E2E 测试矩阵版本
>
> **版本重点**：新增一套**模型列表驱动**的通用 E2E 矩阵——3 个客户端协议 × 3 种场景，
> 每个模型自动跑 9 个用例。同时修复了一处让**所有 E2E 都无法启动**的既有缺陷。
> 纯测试改动，不涉及运行时代码，无破坏性变更。

---

## ⚠️ 兼容性说明

**本版本无破坏性变更，也无运行时行为变更**，从 v8.9.0 / v8.9.1 / v8.9.2 可直接升级。

- 不涉及存储结构、配置键、HTTP 接口、环境变量的任何变化。
- 唯一新增的是 npm script `test:e2e:matrix`，以及一条既有测试脚本的修复。
- 对生产运行的服务**零影响**：本版本没有改动任何 `src/` 下的代码。

---

## 一、新增：通用 E2E 矩阵

### 1. 矩阵定义

每个模型跑 **3 × 3 = 9** 个用例：

| 维度 | 取值 |
|---|---|
| **3 个客户端入口协议** | `/v1/chat/completions`（OpenAI Chat）<br>`/v1/messages`（Anthropic Messages）<br>`/v1/responses`（OpenAI Responses） |
| **3 种交互场景** | 非流式文本<br>流式文本<br>工具调用 |

覆盖的核心价值在于**跨协议转译**：客户端用三种不同协议发请求，网关要正确翻译成
上游 Provider 的原生协议（gemini / claude / openai / codex / trae），
再把响应翻译回客户端期望的协议。任何一环的字段映射错了，对应用例就会失败。

### 2. 通用性：模型列表驱动，不硬编码

这是本次设计的核心目标——**模型列表完全来自 `/auto/v1/models`**，
测试代码里不出现任何具体模型名。

下次 `model_list` 增删模型、或某个 Provider 改了模型名，**不需要改测试文件**，
矩阵会按新列表自动伸缩。

已实测验证的三种变化：

| 场景 | 结果 |
|---|---|
| 全量 11 个模型 | 排除生图后 10 个 → **90 个用例，90/90 通过** |
| 显式指定 2 个模型 | 自动生成 **18 个用例，18/18 通过** |
| 混入生图模型 | 自动排除并打印说明，其余照跑，**9/9 通过** |

生图模型通过 `isImageOnlyModel()` 按**名字形态**（含 `image`）排除，
而不是硬编码一份清单——上游新增生图模型时同样会被自动排除，
由 `image-generation.e2e.test.mjs` 负责覆盖。

### 3. 断言强度

刻意避免「只要能返回字就算通过」这种弱断言：

- **文本场景**：断言答案确实包含 `391`（17 × 23 的正确答案）。
  模型答错、或转译过程中丢了内容，都会失败。
- **工具场景**：断言确实产出了 `get_weather` 工具调用，并校验工具名。
  仅返回一句「我不能调用工具」的纯文本会失败。
- **流式场景**：额外断言流内没有错误事件（`streamError`），
  避免「HTTP 200 但流里塞了 error 帧」被当成成功。

失败原因采用**收集式**而非遇错即断：单个场景失败不会掩盖其余场景的结论，
一次跑完就能看到完整矩阵报告。

### 4. 运行方式

```bash
npm run test:e2e:matrix                        # 默认收敛模型集
AICLIENT_E2E_ALL_MODELS=1 npm run test:e2e:matrix   # 全量模型
AICLIENT_E2E_MODELS=a:b,c:d npm run test:e2e:matrix # 只跑指定模型
```

---

## 二、修复：所有 E2E 都无法启动的既有缺陷

`tests/e2e/global-setup.js` 仍在导入 `MODELS_CACHE_FILE` 常量，
但 `tests/e2e/e2e-helpers.js` 早已把它改成**惰性求值的 `modelsCacheFile()` 函数**
（目的是支持测试中修改 env 后重新读取，因为 ESM 模块记录无法清除）。

两者不匹配的后果是：`node --import ./tests/e2e/global-setup.js` 在
**模块解析阶段就抛 `SyntaxError: does not provide an export named 'MODELS_CACHE_FILE'`**，
**一个用例都跑不起来**——包括原有的 `cross-protocol.e2e.test.mjs`、
`image-generation.e2e.test.mjs`、`provider-canaries.e2e.test.mjs` 全部无法启动。

已改为调用函数。这个缺陷不是本次改动引入的，是此前把常量重构为函数时漏改了调用方。

---

## 三、验证结果

| 项目 | 结果 |
|---|---|
| E2E 矩阵（10 模型 × 9 场景） | **90 / 90 通过** |
| 生图 E2E（text-to-image、image-to-image） | **2 / 2 通过**（均真实产出图片） |
| 单元测试 | **1098 / 1098 通过**，未受影响 |
| `typecheck` / `typecheck:webui` | 通过 |
| `check:strict`（strict 棘轮） | 0 错误 |
| `check:any`（any 棘轮） | 0 any |
| `check:imports` | 通过 |
| `check:cycles` | 0 循环依赖 |
| `lint:css` | 通过 |

矩阵实际覆盖的 10 个模型（由 `/auto/v1/models` 自动得出，非硬编码）：

```
openai-custom:deepseek-v4.1-flash
openaiResponses-custom:deepseek-flash
claude-custom:deepseek-flash
gemini-antigravity:claude-sonnet-5-5-medium
gemini-antigravity:gemini-3.8-flash-medium
openai-codex-oauth:gpt-6-luna
trae:DeepSeek-V4.1-Flash-1017
trae:glm-5.3-flashx
trae-chat_v3:deepseek-v4.1-flash
trae-chat_v3:glm-5.3-flashx
```

---

## 四、已知限制（诚实说明）

- **未验证组合入口**：`npm run test:e2e`（同时含 matrix + cross-protocol + image）
  没有完整跑过。原因是它需要真实上游、耗时较长。
  各自单独跑通已验证（matrix 90/90、image 2/2）。
  若要跑组合入口，注意 `--test-timeout=300000`（5 分钟）对 90 个用例串行
  （约 90 秒）+ 现有 e2e 可能偏紧，必要时调大该值。
- **E2E 依赖真实上游**：需要网关在运行、有可用凭据、且各 Provider 配额充足。
  配额耗尽时用例会失败，这是上游状态而非代码缺陷。
- **本版本不含运行时改动**：若你在 v8.9.2 上运行正常，升级到 v8.9.3 对运行的服务
  没有任何影响，唯一的收益是 E2E 能跑了、且多了一套矩阵覆盖。

---

## 五、升级建议

- **运行时环境要求**：Node.js >= 26.0.0（与 v8.9.0 相同）
- **升级步骤**：

  ```bash
  git pull
  npm ci --ignore-scripts
  npm start
  ```

- **无需迁移**：不涉及存储、配置或数据格式变更。
- **新增可选验证**：升级后如需跑完整 E2E，先确保网关已启动并配好凭据，然后：

  ```bash
  npm run test:e2e:matrix
  ```

---

**完整变更明细**：见 [CHANGELOG.md](https://github.com/GreyRaphael/AIClient2API/blob/main/CHANGELOG.md)
