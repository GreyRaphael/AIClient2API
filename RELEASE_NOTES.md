# AIClient-2-API 发布说明 (v3.17.0)

> 本次 **v3.17.0** 汇总 `v3.14.1` 之后的全部变更，核心是**节点模型配置从“排除不支持模型”迁移为“正向勾选启用模型”**，并同步收敛模型代际、路由守卫、能力缓存与文档结构。
>
> 过程里程碑标签：
> - `v3.15.0`：模型能力统一与路由基础
> - `v3.16.0`：正向模型选择
> - `v3.16.1`：Zed Gemini 3+ 思考配置修复
> - `v3.17.0`：模型代际收敛与文档清理（本次正式发布）

---

## 🌟 核心更新亮点

### 1. 正向模型选择（重点）

节点模型配置不再维护“不支持模型”黑名单，改为直接勾选要使用的模型：

- **候选来自上游 `model_list`**，默认全选。
- 取消勾选即表示该节点不使用该模型。
- 新增 `supportedModelsBaseline`：上游后续新增的模型默认自动选中。
- **分组最终模型列表** = 活跃节点选择集并集 ∪ 该分组的自定义模型。
- 自定义模型只参与分组最终集与路由，**不会进入节点候选列表**。
- `model_id` 全程大小写敏感，`Model` 与 `model` 视为两个模型。
- 节点候选只与上游列表一致；上游删除模型后自动从选择集消失。

配置示例：

```json
{
  "uuid": "node-1",
  "supportedModels": ["gemini-3.8-flash-high", "claude-sonnet-4-6"],
  "supportedModelsBaseline": ["gemini-3.8-flash-high", "claude-sonnet-4-6", "gemini-3.1-pro-high"]
}
```

- `supportedModels` 缺失：跟随上游全选。
- `supportedModels` 为数组：显式选择集。
- `supportedModelsBaseline`：上次保存时的候选快照，用于识别新增模型。

### 2. 模型列表与端点统一

以下入口现在统一使用同一份分组最终集：

- `/api/provider-models`
- `/api/providers`
- `/auto/v1/models`
- `/{provider}/v1/models`
- Playground 模型下拉框

同时：

- `/api/providers` 节点新增 `candidateModels`、`selectedModels`、`selectionMode`、`modelsSource` 等元数据。
- `detect-models` 改为任意 provider 均可调用的能力刷新入口。
- 删除旧的 `GET /api/provider-models/{type}`。

### 3. 路由与能力缓存修复

- 路由守卫改用节点 `selectedModels`。
- 自定义模型按 `actualModel` 走 `candidateModels` 校验，避免“列表可见但不可用”。
- 补齐非流式凭证重试中的自定义模型路由意图。
- 冷启动刷新失败且无历史发现时回退静态基线，不把失败的空结果当成可靠发现。
- 保存 provider 时清除旧字段与运行时模型元数据，避免 spread 残留。

### 4. 模型代际收敛

当前项目只保证以下模型家族的新代际：

- OpenAI：GPT-5+
- Anthropic：Claude 4+
- Google：Gemini 3+

同步清理：

- 删除 Claude 3 回退模型列表。
- 删除 Zed 对 `o1/o3` 的判断。
- 删除 Trae 中 `claude-3.5/3.7`、`gpt-4o` 系列旧别名。
- 删除 Gemini 2.5 `thinkingBudget` 双轨，统一使用 `thinkingLevel`。
- 删除 `gemini-cli-oauth`、`openai-qwen-oauth`、`openai-iflow` 在配置示例、UI 文案、config-scanner 与 CLI 注释中的残留。

### 5. Zed Gemini 3+ 修复

修复 Playground 默认 `reasoning_effort=high` 时 `zed:gemini-4-argon` 报错：

```text
Zed API error (500):
```

原因：Zed 的 Gemini 分支把 `reasoning_effort` 转成了 `thinkingBudget`，而 Gemini 3+ 只接受 `thinkingLevel`。

修复后：

```json
{ "thinkingConfig": { "thinkingLevel": "HIGH" } }
```

Zed 实际调用验证通过。

### 6. 文档与工程清理

- 新增 `docs/CROSS_PROTOCOL_ARCHITECTURE.md` 作为当前跨协议架构入口。
- 已实施方案归档到 `docs/archive/`：
  - `MODEL_CAPABILITY_UNIFICATION_PLAN.md`
  - `POSITIVE_MODEL_SELECTION_PLAN.md`
  - `CROSS_PROTOCOL_EVALUATION_AND_OPTIMIZATION.md`
  - `CROSS_PROTOCOL_OPTIMIZATION_PLAN.md`
- `CONVERTER_STREAM_DESIGN.md` 状态更新为“已落地”。
- 修复 `PROVIDER_ADAPTER_GUIDE.md` 中失效的相对链接。
- 更新配置示例、OpenClaw/OpenCode 示例、教程字段与 API 文档。

---

## ⚠️ 破坏性变更

本次发布明确不考虑向后兼容，以下内容已移除：

- 节点配置中的 `notSupportedModels`
- 节点配置中的 `disabledModels`
- 节点配置中的 `availableModels`
- `includeDisabled` 选项
- `GET /api/provider-models/{type}`
- `updateProviderModels()`
- 旧 GPT-4 / Claude 3 / Gemini 2.5 兼容分支与旧模型别名

升级后：

- 旧排除项不再生效，所有上游模型默认启用。
- 节点 `availableModels` 不再读取。
- 需要重新在节点配置中勾选要使用的模型。

---

## 🚀 升级步骤

1. 备份配置：

```bash
cp configs/provider_pools.json configs/provider_pools.json.bak
```

2. 清理旧字段（默认 dry-run）：

```bash
node src/scripts/purge-legacy-model-fields.js
```

确认后落盘：

```bash
node src/scripts/purge-legacy-model-fields.js --write
```

3. 重启服务。

4. 打开“提供商池管理”，进入节点编辑：

- 候选模型默认全选；
- 取消不需要的模型；
- 保存后写入 `supportedModels` 与 `supportedModelsBaseline`。

5. 浏览器强制刷新，确保加载新的前端资源与 i18n 文案。

---

## 🧪 验证结果

- `npm test`：**21 suites / 326 tests 全绿**
- `tests/static-syntax.test.js`：26 tests 全绿
- 文档本地链接检查：**0 个失效链接**
- 32 个 provider/model 组合冒烟通过
- Zed `gemini-4-argon` 在 `reasoning_effort=high` 下验证通过

---

## 🐳 Docker

发布后 Docker 镜像标签：

- `docker.io/<DOCKERHUB_USERNAME>/aiclient-2-api:3.17.0`
- `docker.io/<DOCKERHUB_USERNAME>/aiclient-2-api:latest`

---

## 📚 相关文档

- [当前跨协议架构](docs/CROSS_PROTOCOL_ARCHITECTURE.md)
- [Provider 接入指南](docs/PROVIDER_ADAPTER_GUIDE.md)
- [流式转换设计](docs/CONVERTER_STREAM_DESIGN.md)
- [Trae 三通道指南](docs/TRAE_CHANNELS_UPSTREAM_GUIDE.md)
- [历史方案归档](docs/archive/)
