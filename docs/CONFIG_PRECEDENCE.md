# 配置分层与优先级

本文只说明现有配置的读取顺序，不改变运行时行为。目标是让新增 provider、模型能力和 fallback 配置时，能快速判断“最终生效的是哪一份值”。

## 1. 配置文件分工

| 文件 | 作用 | 是否提交 |
|---|---|---|
| `configs/config.json` | 全局开关、端口、日志、代理、fallback 链、能力覆盖 | 运行时配置，默认不提交 |
| `configs/provider_pools.json` | provider 节点、凭据路径、并发/队列、节点级 `capabilities` | 运行时配置，默认不提交 |
| `configs/custom_models.json` | 用户自定义模型及其归属 provider | 运行时配置，默认不提交 |
| `configs/plugins.json` | 插件启用状态 | 运行时配置，默认不提交 |
| `configs/model-capability-cache.json` | 上游模型发现结果缓存 | 运行时缓存，默认不提交 |
| `configs/usage-cache.json` | 用量查询缓存 | 运行时缓存，默认不提交 |
| `configs/model-usage-stats.json` | 请求/Token 统计 | 运行时统计，默认不提交 |
| `configs/*.example` | 上述配置的结构示例 | 提交 |

## 2. 开关读取顺序

`src/core/config-manager.js` 的 `getConfigToggle` / `getConfigPositiveInt` 统一按以下顺序读取：

1. `process.env[KEY]`（进程内动态覆盖，优先级最高）
2. `CONFIG[KEY]`（`config.json` 或启动参数归一化后的值）
3. 代码默认值

布尔开关统一识别 `true/false/1/0/on/off`（见 `TOGGLE_ON_VALUES` / `TOGGLE_OFF_VALUES`）。

## 3. Provider 能力优先级

`src/providers/provider-capabilities.js` 的 `resolveProviderCapabilities` 按以下顺序叠加，后者覆盖前者：

1. `DEFAULT_PROVIDER_CAPABILITIES`
2. `BUILTIN_PROVIDER_RULES`（按 `providerType` 前缀匹配）
3. 上游模型元数据（`capabilities` / snake_case 布尔字段）
4. 全局 `PROVIDER_CAPABILITIES[providerType]`（支持 `models` 通配与 `rules`）
5. 节点级 `capabilities`（`provider_pools.json` 节点字段，优先级最高）

## 4. 模型列表与路由优先级

模型列表由 `src/providers/model-capability.js` 统一读取，来源优先级：

1. `live`：本次从上游发现
2. `persisted`：`model-capability-cache.json` 中的历史发现
3. `static`：`PROVIDER_MODELS` 静态基线
4. `baseline`：节点配置中的 `supportedModelsBaseline`

自定义模型（`custom_models.json`）只进入分组最终集，不参与节点候选列表；启用状态由 `enabled !== false` 控制。

## 5. Fallback 顺序

- `providerFallbackChain`：跨 provider 类型降级，键为 provider 类型。
- `modelFallbackMapping`：请求模型不存在时的模型/提供商重定向。
- `MODEL_FALLBACK_ENABLED`：控制是否允许自动 fallback。

两者用途不同，不是重复配置；排查时先确认是“类型级”还是“模型级”降级。

## 6. 已知历史兼容项

以下字段/取值仅为兼容存量配置，新增部署不建议继续使用：

- `GEMINI_PASS_MAX_OUTPUT_TOKENS`：旧的 Gemini 输出上限开关。
- Trae `agent_v3` / `legacy` 通道标识：启动时会迁移到 `trae-solo_work_lite`。
- `provider_pools.json` 中的 `notSupportedModels` / `disabledModels` / `availableModels`：运行时不再读取，可用一次性脚本清理。

## 7. 排查顺序建议

1. 先看 `process.env` 是否覆盖了同名配置。
2. 再看 `configs/config.json` 中的全局值与 toggle。
3. 节点级问题看 `provider_pools.json` 的节点字段与 `capabilities`。
4. 模型列表问题看 `model-capability-cache.json` 与 `supportedModelsBaseline`。
5. 最后再检查 `PROVIDER_CAPABILITIES` 与内置 provider 规则。
