# 正向模型选择方案（Positive Model Selection）

- 状态：已实施
- 日期：2026-10-20
- 范围：`src/providers/**`、`src/handlers/request-pipeline.js`、`src/ui-modules/**`、`static/app/**`、配置样例、测试与文档
- 目标：把节点模型配置从“排除不支持模型”改为“勾选要使用的模型”，并让分组最终模型列表在所有入口保持一致
- 非目标：模型可调用性探测、上游协议适配、自定义模型参数体系改造、按模型配置采样参数

---

## 1. 已确认决策

本方案以下列决策为硬约束，不再保留兼容分支：

1. **上游 model_list 默认全选**：节点首次配置时，候选列表中的模型全部处于勾选状态。
2. **model_id 大小写敏感**：`DeepSeek-V4.1-Flash` 与 `deepseek-v4.1-flash` 是两个不同模型，不做大小写归一化。
3. **节点候选列表只与上游 model_list 一致**：自定义模型不得进入节点候选列表。
4. **上游新增 model_id 默认选中**：即使节点已经保存过显式选择，后续上游新增的模型也自动进入选中集。
5. **不考虑向后兼容**：`notSupportedModels`、`disabledModels`、节点 `availableModels` 及相关加减法逻辑、UI、文档、测试全部彻底删除。

---

## 2. 核心模型

### 2.1 术语与集合

| 符号 | 含义 |
|---|---|
| `C_node` | 节点候选集：该节点上游发现到的 model_list；无发现能力时回退静态基线 |
| `S_node` | 节点选择集：用户在节点配置中勾选的模型，默认等于 `C_node`，并自动吸收上游新增模型 |
| `M_group` | 分组自定义模型集：`customModels` 中 `listProvider` 等于该分组且 `enabled !== false` 的模型 ID |
| `F_group` | 分组最终模型集：`F_group = dedupe( ∪ S_node(活跃节点) ∪ M_group )` |

关键约束：

- `C_node` **不包含自定义模型**。
- `M_group` **只参与分组最终集与路由解析**，不参与节点候选列表。
- `S_node` 只能包含 `C_node` 中的模型；显式配置了但上游不存在的模型会被交集丢弃。

### 2.2 节点配置字段

```json
{
  "uuid": "bedb2578-5f2d-436a-ae5a-1541f5e7bee9",
  "supportedModels": ["DeepSeek-V4.1-Flash", "glm-5.3"],
  "supportedModelsBaseline": ["DeepSeek-V4.1-Flash", "glm-5.3", "kimi-k3"]
}
```

字段语义：

| 字段 | 必填 | 含义 |
|---|---|---|
| `supportedModels` | 否 | 用户显式勾选的模型。**字段不存在/null = 跟随上游全选；数组（包括空数组）= 显式选择集** |
| `supportedModelsBaseline` | 否 | 上次保存时节点候选集 `C_node` 的快照，仅用于识别“之后新增的上游模型”。不参与最终列表的直接过滤 |

为什么需要 `supportedModelsBaseline`：

- 正向白名单本身无法区分“上游新增模型”与“用户之前主动取消的模型”；
- 保存时的候选快照是识别新增模型的最小必要状态；
- 该字段只在用户保存节点配置时写入，运行期发现模型**不写回** `provider_pools.json`。

### 2.3 候选集 `C_node`

```text
if capability 有可靠发现结果（live / persisted）:
    C_node = capability.models
else:
    C_node = 静态基线 PROVIDER_MODELS[providerType]
             （静态 provider 没有上游发现能力时，这是唯一可用列表）
```

规则：

- 发现结果存在但为空数组时，`C_node = []`，**不回退静态基线**。
- 不再读取节点配置中的 `availableModels`。
- 不再把 `checkModelName` 塞进候选集。
- 不再把自定义模型注入候选集。
- 大小写完全按上游返回的原样保留。

### 2.4 节点选择集 `S_node`

```text
if (!Array.isArray(supportedModels)):
    S_node = C_node
else:
    B = Array.isArray(supportedModelsBaseline) ? supportedModelsBaseline : C_node
    newModels = C_node \ B
    S_node = (supportedModels ∪ newModels) ∩ C_node
```

解释：

- **未保存过选择**：直接全选上游候选。
- **保存过显式选择**：保留用户勾选，同时把 `C_node` 中相对上次快照新增的模型自动加入。
- **上游删除模型**：`∩ C_node` 使其自动从选择集消失。
- **上游删除后又重新出现**：是否选中取决于它是否在 `supportedModels` 中，不会因为“重新出现”而自动选中。
- **`supportedModelsBaseline` 缺失**：视为 `B = C_node`，即不自动吸收新模型，优先尊重已有显式选择。
- **空数组**：`supportedModels: []` 表示用户明确一个都不选；此时只有真正新增的模型会被自动加入。

### 2.5 分组最终集 `F_group`

```text
activeNodes = 节点中 !isDisabled && isHealthy !== false 的节点
S_group = ∪ S_node(activeNodes)
M_group = customModels
          .filter(enabled !== false)
          .filter(listProvider === group || group.startsWith(listProvider + '-'))
          .map(id)
F_group = dedupeCaseSensitive(S_group ∪ M_group)
```

规则：

- 去重使用精确字符串，不做 `toLowerCase()`。
- 自定义模型元数据（显示名、上下文长度等）优先于同名上游模型。
- 分组没有任何活跃节点时，不对外暴露该分组的模型列表；即使存在自定义模型也不暴露（无法提供服务）。
- 若所有节点都没有可靠发现结果，则使用各节点静态基线计算 `S_node`；若至少一个节点有可靠发现结果，则只让这些已知节点参与聚合，避免未知节点的静态基线污染实时列表。该规则沿用当前 `resolveProviderCapability` 的 known-preferred 语义。

### 2.6 路由语义

| 请求类型 | 节点是否可选 |
|---|---|
| 上游模型 `model` | `model ∈ S_node`；`known=false` 的节点不设守卫 |
| 自定义模型 `customId` | 先解析为 `actualProvider/actualModel`；目标节点满足 `actualModel ∈ C_node` 或 `known=false` 即可路由，**不要求** `actualModel ∈ S_node` |

说明：

- 自定义模型被用户显式创建，且通过 `M_group` 进入最终列表；如果因为节点没有勾选其 `actualModel` 就拒绝路由，会出现“列表可见但不可用”。
- 自定义模型的 `actualProvider` 与 `listProvider` 不同时，沿用现有请求管线逻辑切换 provider。
- 实现上，`handleContentGenerationRequest()` 在识别到自定义模型时，必须把 `allowUnselectedModel: true`（名称可调整）透传到 `getApiServiceWithFallback` / `acquireSlotWithFallback` / `_doSelectProvider`，使路由守卫使用 `candidateModels` 而不是 `selectedModels`。
- 保留现有 `-high` / `-thinking` 后缀兼容规则。
- 大小写敏感：`Model` 不能匹配 `model`。

### 2.7 与 capability 状态的关系

- `source` 继续表示候选集来源：`live` / `persisted` / `baseline` / `static`。
- 新增派生字段 `selectionMode`：`all`（`supportedModels` 缺失）或 `explicit`（数组）；该字段只用于 API/UI，不落盘。
- `stale` 只影响候选集可信度，不改变选择规则。
- 上游发现失败时保留 last-known 候选集；没有 last-known 时回退静态基线。
- 运行期刷新只写 `configs/model-capability-cache.json`，不写 `provider_pools.json`。

---

## 3. 代码改造

### 3.1 `src/providers/model-capability.js`

当前实现（写方案时）：

- `readLegacyModels()`：`106-115`
- `getDisabledModels()`：`117-122`
- `resolveNodeCapability()`：`263-353`
- 减法应用：`332-334`
- `resolveProviderCapability()`：`361-399`
- `nodeSupportsModel()`：`406-417`

改造：

1. 删除 `readLegacyModels()`、`getDisabledModels()`、`getConfiguredCustomModelIds()`、`disabledSet`、`includeDisabled` 选项。
   - 删除 `resolveNodeCapability()` 中 managed 分支对 `supportedModels` 的提前替换（`283-306`）；`supportedModels` 只在 `S_node` 阶段应用，不能改变候选集来源。
   - `getConfiguredCustomModelIds()` 的自定义模型注入改由 `resolveProviderCapability()` 计算 `M_group` 完成。
2. `resolveNodeCapability()` 新返回结构：

```js
{
  candidateModels,   // C_node，只含上游/静态基线，不含自定义模型
  selectedModels,    // S_node
  models,            // 与 selectedModels 相同，保留给路由调用方
  selectionMode,     // 'all' | 'explicit'
  source,
  fetchedAt,
  stale,
  known,
  entry
}
```

3. `candidateModels` 来源：
   - 有 `entry.models`：直接使用；
   - 否则使用纯静态基线 `getProviderModels(providerType)`；
   - 不再使用 `nodeConfig.availableModels`、`nodeConfig.checkModelName`、自定义模型注入。
4. `selectedModels` 按 2.4 的公式计算。
5. `resolveProviderCapability()`：
   - 对活跃节点逐个计算 `S_node`；
   - 聚合 `S_group`；
   - 追加 `M_group`；
   - 返回 `models = F_group`、`nodeCapabilities`、`customModels`、`selectionMode`。
6. `nodeSupportsModel()`：
   - 继续使用 `capability.models`（即 `S_node`）；
   - 保持 `known=false` 放行与后缀兼容；
   - 不做大小写归一化。
7. `refreshNodeCapability()` 保持现有单飞、TTL、退避、持久化逻辑不变。
8. `resolveProviderCapabilityWithRefresh()` / `ensureProviderCapability()` 保持现有 SWR 行为不变。

### 3.2 `src/providers/provider-models.js`

当前实现：

- `updateProviderModels()`：`226-241`（当前已无 `src/` 调用方，只剩测试引用）
- `normalizeModelIds()`：`262-269`
- `getConfiguredSupportedModels()`：`336-342`
- `getConfiguredNotSupportedModels()`：`344-346`
- `getProviderModels()`：`353-382`（会注入自定义模型）

改造：

1. 删除 `getConfiguredNotSupportedModels()`。
2. 删除 `updateProviderModels()`。保留仍被 adapter / tests 使用的 `BASE_*` 常量，仅删除确实只为 `updateProviderModels()` 服务的导出（以实际引用为准）。动态发现只进 capability cache，不再改写全局 `PROVIDER_MODELS`。
3. `getConfiguredSupportedModels()`：
   - 去掉 `usesManagedModelList()` 限制；
   - 对所有 providerType 返回 `normalizeModelIds(providerConfig.supportedModels)`；
   - 保留大小写敏感去重。
4. `getProviderModels()`：
   - 回归“纯静态基线”语义，只读取 `PROVIDER_MODELS`，不注入 `CONFIG.customModels`；
   - 作为 `C_node` 的静态基线来源；
   - 不新增同义的 `getStaticBaselineModels()`，避免重复入口；
   - 自定义模型统一由 `M_group` 在分组最终集中处理；
   - 若适配器确实需要自定义模型，应显式合并 `CONFIG.customModels` 中 `listProvider` 匹配的模型，而不是依赖隐式注入。
5. 更新所有 `getProviderModels()` 调用方（`antigravity-core`、`claude-kiro`、`grok-cli-core`、`codex-core`、`usage-service` 等），确认它们只需要纯静态基线；如个别调用方需要自定义模型，显式合并。
6. `normalizeModelIds()`：
   - 保持去空格、去空值、精确大小写去重；
   - 不允许加入 `toLowerCase()`。

### 3.3 `src/providers/provider-pool-manager.js`

当前实现：

- 自定义模型辅助：`23-50`
- `_doSelectProvider()` 路由过滤：`1061-1114`
- `getNodeAvailableModels()`：`1499-1503`
- `getActiveProviderModels()`：`1513-1530`
- `getAllAvailableModels()`：`1537-1619`

改造：

1. `_doSelectProvider()`：
   - 删除 `notSupportedModels` 判断（`1108-1113`）；
   - 删除 `getConfiguredSupportedModels()` 提前分支；
   - 新增 `options.allowUnselectedModel`：
     - `false`（默认）：上游模型必须 `model ∈ selectedModels`；
     - `true`：自定义模型的 `actualModel` 只要 `model ∈ candidateModels` 即可；
   - 自定义模型仍先走 `resolveCustomModelRouting()` / `_getCustomModelRoutingCandidates()`；
   - `acquireSlotWithFallback()` 中的 fallback 类型检查（`getProviderModels(currentType)`，`1192`、`1245`、`1336`、`1402`）改为使用目标类型的 `resolveProviderCapability(...).models` 或 `candidateModels`，不能再用全局静态基线判断。
2. `getNodeAvailableModels()`：
   - 改为返回 `resolveNodeCapability().selectedModels`；
   - `known=false` 时返回 `null` 的现有行为保留。
3. `getActiveProviderModels()`：
   - 只保留 `resolveProviderCapabilityWithRefresh(...).models`；
   - 删除 `usesManagedModelList` 分支和 `DEFAULT_HEALTH_CHECK_MODELS` 兜底；
   - 无节点时返回 `[]`（自定义模型仍由分组最终集逻辑决定，但对外端点不暴露无节点分组）。
4. `getAllAvailableModels()`：
   - 删除 `customModelIds` 分支（`1562-1573`）；
   - 直接使用 `resolveProviderCapabilityWithRefresh(providerType, activeNodes).models`；
   - 结果已经是 `F_group`，不再单独拼 `configuredSupportedModels`；
   - 删除 `customAliases` 减法逻辑；
   - 保留 `${providerType}:${model}` 前缀输出。
5. 保留 `getCustomModelIdsForProvider()` / `getCustomModelListProvider()`，供分组最终集与路由使用。
6. 删除不再使用的 `getCustomModelAliasesForProvider()`（若确认无其他调用方）。

### 3.4 `src/handlers/request-pipeline.js`

当前实现：

- `getConfiguredNotSupportedModelsFromPool()`：`39-69`
- `filterNotSupportedModelsFromModelList()`：`78-109`
- `getCustomModelEntriesForProvider()`：`111-149`
- 单 provider 模型列表：`1262-1301`

改造：

1. 删除 `getConfiguredNotSupportedModelsFromPool()`、`filterNotSupportedModelsFromModelList()` 及其导出/测试。
2. 删除 `CONFIG.notSupportedModels` 读取。
3. 单 provider 模型列表：
   - 删除 `customModelIds.length > 0` 时“完全使用自定义模型”的分支（`1273-1276`）；
   - 统一使用 `resolveProviderCapabilityWithRefresh(toProvider, nodes).models`；
   - 该结果已经是 `S_group ∪ M_group`，不再二次过滤、不再二次拼接自定义模型。
4. 自定义模型路由：
   - `handleContentGenerationRequest()` 在 `customModelConfig` 命中时，向 `getApiServiceWithFallback()` 透传 `allowUnselectedModel: true`；
   - `service-manager.js` 继续把该 option 透传给 `acquireSlotWithFallback()` / `selectProviderWithFallback()`；
   - 确保 `_doSelectProvider()` 能区分“上游模型选择”与“自定义模型 actualModel 路由”。
5. `AUTO` 模式：
   - `getAllAvailableModels()` 已包含各分组最终集；
   - `appendCustomModelsToModelList()` 仅用于补充/覆盖自定义模型元数据，需保证按 ID 去重，不产生重复项。
6. 删除不再使用的 `normalizeModelIds` / `getCustomModelListProvider` 导入（以实际引用为准）。

### 3.5 `src/ui-modules/provider-api.js` 与 `src/services/ui-manager.js`

当前实现：

- capability 元数据：`250-262`
- `handleGetProviders()`：`267-335`
- `handleGetProviderModels()`：`405-444`
- `handleGetProviderTypeModels()`：`450-474`
- `handleDetectProviderModels()`：`524-579`
- 新增 provider 保存：`651-655`
- 更新 provider 保存：`753-764`
- 路由：`src/services/ui-manager.js:161-176`、`199-205`

改造：

1. `handleGetProviders()` / `handleGetProviderType()`：
   - 每个节点返回 `candidateModels`（`C_node`）与 `selectedModels`（`S_node`）；
   - 删除 `item.availableModels = capability.candidateModels`；
   - 保留 `modelsSource` / `modelsFetchedAt` / `modelsStale` / `modelsLastError`；
   - 可增加 `selectionMode`。
2. `handleGetProviderModels()`：
   - 使用 `resolveProviderCapabilityWithRefresh(...).models`；
   - 删除 `usesManagedModelList` + `getActiveProviderModels` 兜底分支；
   - 响应仍为 `{ providerType: string[] }`。
3. `handleGetProviderTypeModels()`：
   - 该端点只服务于旧负向选择弹窗；新 UI 直接使用 `/api/providers/{type}` 的节点级字段；
   - **删除该处理函数与 `/api/provider-models/{type}` 路由**；
   - 同步删除测试与文档中的引用。
4. `handleDetectProviderModels()`：
   - 从“仅托管 provider 可调用 live adapter”改为“任意 provider 均可刷新节点能力”；
   - 调用 `refreshNodeCapability(providerType, nodeConfig, { force: true, reason: 'ui-detect' })`；
   - 返回 `{ success, providerType, uuid, models: C_node, selectedModels: S_node, source, fetchedAt }`；
   - 静态 provider 刷新返回空时，返回静态基线并标记 `source: 'static'`。
5. 新增 provider：
   - 不写入 `supportedModels` / `supportedModelsBaseline`；
   - 删除 `notSupportedModels = []`；
   - 删除 `availableModels` / `discoveredModels` / `modelsFetchedAt` / `modelsSource` 的清理分支（改为统一剥离旧字段）。
6. 更新 provider：
   - 接受并保存 `supportedModels`、`supportedModelsBaseline`；
   - 对所有 provider 统一处理，不再区分 managed；
   - 统一剥离 `notSupportedModels`、`disabledModels`、`availableModels`、`discoveredModels`、`modelsFetchedAt`、`modelsSource`；
   - `supportedModels` 只做精确字符串去重，不做大小写归一化。
7. 健康检查选模型（`runProviderHealthCheck()`，`provider-api.js:168-183`）：
   - 保留 `checkModelName` 优先；
   - 否则从 `resolveNodeCapability().selectedModels` 中挑选；
   - 不再使用 `getConfiguredSupportedModels` + `usesManagedModelList` 分支。
8. `handleGetProviderTypeModels()` 删除后，清理 `ui-manager.js` 中 `GET /api/provider-models/{type}` 路由。

### 3.6 `static/app/modal.js`、CSS、i18n

当前实现：

- managed 判断：`17-21`
- 正向选择组件：`68-127`
- 收集保存：`129-162`
- `cachedModels`：`163`
- 初始化：`392-400`
- 分页后加载模型：`633-649`
- `loadModelsForProviderType()`：`684-725`
- 负向配置区域：`1264-1288`
- 编辑/取消/保存：`1379-1533`、`1540-1562`
- 负向选择器：`2284-2316`
- i18n：`static/app/i18n.js:752-764`、`2044-2056`

改造：

1. 删除 `usesManagedModelList()` 在 modal 中的分叉，所有 provider 使用同一套正向选择 UI。
2. 节点配置区域改为**直接渲染复选框网格**：
   - 数据源：`provider.candidateModels`；
   - 选中状态：`provider.selectedModels`；
   - 每个复选框 `value` 为原始 model_id；
   - 支持搜索、全选当前候选、清空；
   - 展示候选来源（live/persisted/baseline/static）与 stale 提示；
   - 显示“已选择 N / 共 M”。
3. 删除 `renderNotSupportedModelsSelector()`、`cachedModels`、`loadModelsForProviderType()`、负向 `.not-supported-models-*` 区域。
4. 删除独立 picker overlay 相关函数；搜索、全选、清空直接放在节点复选框网格的工具栏中。
5. `collectDraftProviderConfig()`：
   - 从正向复选框读取勾选值 → `providerConfig.supportedModels`；
   - 从容器 dataset 读取本次渲染的候选列表 → `providerConfig.supportedModelsBaseline`；
   - 不再产生 `notSupportedModels`。
6. `cancelEdit()`：
   - 恢复复选框到原始 `selectedModels`；
   - 删除负向 reset 分支。
7. 新增 provider 表单：
   - 初始不写 `supportedModels`；
   - 打开时按当前 `candidateModels` 全部勾选。
8. 进入编辑模式时：
   - 若节点 `modelsSource` 为 `baseline` / `static` 或 `modelsStale=true`，自动调用一次 `POST /api/providers/{type}/{uuid}/detect-models` 刷新上游模型；
   - 刷新期间显示 loading，完成后重建复选框并更新候选快照。
9. `getFieldOrder()`：
   - 从排除字段中删除 `notSupportedModels`（字段本身已不存在）；
   - 保留/增加 `supportedModels`、`supportedModelsBaseline` 的排除。
10. CSS：
    - 删除 `.not-supported-models-section`、`.not-supported-models-container` 及暗色主题对应规则；
    - 复用/重命名 `.models-checkbox-grid`、`.model-checkbox-label` 为正向选择样式；
    - 删除旧 `.supported-models-*` 中不再使用的样式。
11. i18n：
    - 删除 `modal.provider.unsupportedModels*`；
    - 更新 `supportedModels*` 文案为“启用的模型 / 默认全选 / 新模型自动启用”；
    - 新增“刷新上游模型”“候选来源”“共 N 个”“全选当前候选”“清空选择”等 key；
    - 删除 picker 相关 key（若 picker 被移除）。

### 3.7 配置样例与自定义模型页

1. `configs/provider_pools.json.example`：
   - 删除所有 `notSupportedModels`；
   - 增加 `supportedModels` 示例（可选）；
   - 不添加 `supportedModelsBaseline` 到示例，保持示例简洁（该字段由 UI 保存时写入）。
2. `static/components/section-custom-models.html` / `custom-models-manager.js`：
   - 增加说明：自定义模型会自动并入其“列表提供商”分组最终列表，不需要在节点候选中重复出现；
   - 自定义模型的 `actualProvider/actualModel` 仍决定实际路由。
3. 不修改自定义模型字段结构。

---

## 4. 删除清单

以下内容在实施中必须全部删除，验收时用 grep 确认。

### 4.1 配置字段

- `notSupportedModels`
- `disabledModels`
- 节点级 `availableModels`（注意：适配器实例内部的 `this.availableModels` 是运行时状态，保留）

### 4.2 函数与导出

- `src/providers/model-capability.js`
  - `readLegacyModels()`
  - `getDisabledModels()`
  - `includeDisabled` 选项及所有调用方
- `src/providers/provider-models.js`
  - `getConfiguredNotSupportedModels()`
  - `updateProviderModels()`（当前已无 `src/` 调用方）
  - 仅为 `updateProviderModels` 服务的 `BASE_*` 导出（以实际引用为准）
- `src/handlers/request-pipeline.js`
  - `getConfiguredNotSupportedModelsFromPool()`
  - `filterNotSupportedModelsFromModelList()`
- `src/ui-modules/provider-api.js`
  - `handleGetProviderTypeModels()`
  - 新增/更新保存中的 `notSupportedModels` 分支
- `static/app/modal.js`
  - `renderNotSupportedModelsSelector()`
  - `loadModelsForProviderType()`
  - `cachedModels`
  - 负向选择相关 DOM/CSS 类
- `src/utils/common.js`
  - `getConfiguredNotSupportedModels` 的 re-export

### 4.3 API 路由

- `GET /api/provider-models/{type}`（`src/services/ui-manager.js:171-176`）
- 文档与测试中的对应引用

### 4.4 测试

- `tests/model-capability.test.js`
  - legacy `availableModels` 读取用例
  - `disabledModels / notSupportedModels 只做减法` 用例
  - `includeDisabled` 用例
- `tests/antigravity-provider.test.js`
  - `getConfiguredNotSupportedModelsFromPool` 导入与用例
  - 负向过滤相关断言
- `tests/trae-provider.test.js`、`tests/zed-provider.test.js`、`tests/codex-dynamic-models.test.js`
  - `updateProviderModels` 用例改为断言全局基线不可变，或删除
- `tests/model-capability-endpoints.test.js`
  - `/api/provider-models/{type}` 用例改为 `/api/providers/{type}` 或 `/api/provider-models`

### 4.5 文档与前端静态页

- `README.md`、`README-ZH.md`、`README-JA.md` 中所有 `notSupportedModels` 配置说明
- `static/components/section-tutorial.html:287` 的 `notSupportedModels` 行
- `docs/ANTIGRAVITY_NOTES.md:97-101` 的负向过滤说明
- `docs/PROVIDER_ADAPTER_GUIDE.md:160-169` 的字段说明
- `docs/MODEL_CAPABILITY_UNIFICATION_PLAN.md` 中 `disabledModels` / `notSupportedModels` / `availableModels` 的旧语义
  - 建议在文首增加“已被 `POSITIVE_MODEL_SELECTION_PLAN.md` 取代”的说明；
  - 若要求彻底清除，则直接改写相关章节，不保留旧字段描述。

---

## 5. API 契约

### 5.1 `GET /api/providers` 与 `GET /api/providers/{type}`

节点对象新增/调整：

```json
{
  "uuid": "bedb2578-5f2d-436a-ae5a-1541f5e7bee9",
  "supportedModels": ["DeepSeek-V4.1-Flash", "glm-5.3"],
  "supportedModelsBaseline": ["DeepSeek-V4.1-Flash", "glm-5.3", "kimi-k3"],
  "candidateModels": ["DeepSeek-V4.1-Flash", "glm-5.3", "kimi-k3"],
  "selectedModels": ["DeepSeek-V4.1-Flash", "glm-5.3", "kimi-k3"],
  "selectionMode": "explicit",
  "modelsSource": "live",
  "modelsFetchedAt": 1792457345697,
  "modelsStale": false,
  "modelsLastError": null
}
```

- `candidateModels`：只含上游/静态基线，不含自定义模型。
- `selectedModels`：应用新模型自动选中规则后的节点选择集。
- 不再返回节点 `availableModels`。

### 5.2 `GET /api/provider-models`

保持现有形状：

```json
{
  "trae": ["DeepSeek-V4.1-Flash", "glm-5.3", "my-custom-model"],
  "gemini-antigravity": ["gemini-3.8-flash-high"]
}
```

值是 `F_group`，已包含 `M_group`。

### 5.3 `POST /api/providers/{type}/{uuid}/detect-models`

请求体可继续传 `providerConfig`（用于草稿配置）。

响应：

```json
{
  "success": true,
  "providerType": "trae",
  "uuid": "...",
  "models": ["DeepSeek-V4.1-Flash", "glm-5.3"],
  "selectedModels": ["DeepSeek-V4.1-Flash", "glm-5.3"],
  "source": "live",
  "fetchedAt": 1792457345697
}
```

### 5.4 `PUT /api/providers/{type}/{uuid}`

请求体中模型相关字段：

```json
{
  "providerConfig": {
    "supportedModels": ["DeepSeek-V4.1-Flash"],
    "supportedModelsBaseline": ["DeepSeek-V4.1-Flash", "glm-5.3"]
  }
}
```

- `supportedModelsBaseline` 由前端传入本次渲染的 `candidateModels`。
- 后端必须校验两个字段都是字符串数组，并做精确去重。
- 后端必须剥离所有旧字段，不写入配置文件。

### 5.5 `POST /api/providers`

不写 `supportedModels` / `supportedModelsBaseline`，保持“未配置 = 全选”。

---

## 6. 迁移与破坏性变更

本项目明确不考虑向后兼容，因此不做旧意图迁移。

### 6.1 升级后的行为

- 节点上的 `notSupportedModels` 不再读取，升级后所有上游模型默认启用。
- 节点上的 `availableModels` 不再读取；首次启动如果 capability cache 为空，动态 provider 会先显示静态基线，刷新后收敛到上游列表。
- `disabledModels` 不再读取。
- 不再有 `GET /api/provider-models/{type}`。
- UI 中不再出现“不支持的模型”。

### 6.2 配置清理

提供一次性清理脚本（建议 `src/scripts/purge-legacy-model-fields.js`）：

```text
读取 configs/provider_pools.json
对每个节点删除：
  notSupportedModels
  disabledModels
  availableModels
若文件发生变化，原子写回
```

脚本要求：

- 使用现有 `withFileLock` / `atomicWriteFile`；
- 默认 dry-run，加 `--write` 才落盘；
- 不修改 `supportedModels` / `supportedModelsBaseline`；
- 不触碰 `configs/custom_models.json`。

是否在启动时自动执行：**不自动**。避免服务启动时意外改写用户配置；由运维显式执行脚本或由 UI 保存时逐节点清理。

### 6.3 回滚

- 方案不保留运行时兼容分支，回滚依赖 `git revert`。
- 由于旧配置字段被清除，回滚后需要从备份恢复 `configs/provider_pools.json`。
- 实施前建议备份 `configs/provider_pools.json` 与 `configs/model-capability-cache.json`。

---

## 7. 测试计划

### 7.1 单元测试（model-capability）

新增/重写：

1. `supportedModels` 缺失 → `selectedModels = candidateModels`。
2. `supportedModels: []` → `selectedModels` 只包含新增模型（若 baseline 为空）或为空。
3. `supportedModels` 显式子集 → 只返回子集。
4. 上游新增模型（`candidateModels` 比 baseline 多一个）→ 自动进入 `selectedModels`。
5. 上游删除模型 → 从 `selectedModels` 消失。
6. 大小写敏感：`Model` 与 `model` 同时存在且都被保留。
7. `candidateModels` 不包含自定义模型。
8. `resolveProviderCapability` 的 `F_group` 包含各节点 `S_node` 的并集与 `M_group`。
9. 禁用/不健康节点不参与聚合。
10. `known=false` 节点不参与 known-preferred 聚合；全部未知时使用基线。
11. 静态 provider：`candidateModels = 静态基线`，`source='static'`。
12. 发现结果为空数组时不回退基线。

### 7.2 端点一致性测试

构造同一份 capability 缓存与自定义模型：

- `/api/provider-models`
- `/api/providers`
- `/api/providers/{type}`
- `/auto/v1/models`
- `/{provider}/v1/models`

断言五处返回的模型集合一致（`/auto` 带 provider 前缀）。

### 7.3 路由测试

- 勾选模型可路由。
- 未勾选但上游存在的模型不可路由。
- 自定义模型即使 `actualModel` 未勾选，也能路由到 `actualProvider`。
- 自定义模型 `actualProvider` 与 `listProvider` 不同时，请求管线正确切换 provider。
- 大小写不同的模型不会互相匹配。

### 7.4 UI 验证

无构建 ESM 前端，按现有流程验证：

1. `node --check`（复制为 `.mjs` 后执行）检查 `static/app/modal.js`、`i18n.js`。
2. 结构一致性检查：确认 `renderNotSupportedModelsSelector` 等已删除函数无残留引用。
3. 手工冒烟：
   - 打开节点配置，候选全部默认勾选；
   - 取消一个模型并保存，刷新后仍未勾选；
   - 上游新增模型后刷新，新增模型默认勾选；
   - 自定义模型不出现在候选列表，但出现在 `/api/provider-models` 与 Playground；
   - `/auto/v1/models` 与 Playground 下拉框一致。

### 7.5 回归命令

```bash
node --check src/providers/model-capability.js
node --check src/providers/provider-models.js
node --check src/providers/provider-pool-manager.js
node --check src/handlers/request-pipeline.js
node --check src/ui-modules/provider-api.js

npx jest tests/model-capability.test.js tests/model-capability-endpoints.test.js --forceExit
npx jest tests/antigravity-provider.test.js tests/trae-provider.test.js tests/zed-provider.test.js tests/codex-dynamic-models.test.js --forceExit
npm test
npm run test:integration   # 如本地实例与 TEST_API_KEY 已对齐
```

---

## 8. 验收清单

### 8.1 语义

- [ ] 节点首次打开时上游候选默认全选。
- [ ] `supportedModels` 缺失 = 全选；`[]` = 一个都不选；数组 = 显式子集。
- [ ] 上游新增模型在上述三种情况下都默认选中。
- [ ] 上游删除模型后从最终列表消失。
- [ ] model_id 大小写敏感，无 `toLowerCase()` 参与选择逻辑。
- [ ] 自定义模型不出现在节点候选列表。
- [ ] 分组最终集 = 节点选择并集 ∪ 自定义模型。
- [ ] 自定义模型可通过 `actualProvider/actualModel` 正确路由。

### 8.2 端点一致性

- [ ] `/api/provider-models`
- [ ] `/api/providers`
- [ ] `/api/providers/{type}`
- [ ] `/auto/v1/models`
- [ ] `/{provider}/v1/models`

以上入口对同一分组返回同一模型集合。

### 8.3 清理

- [ ] `rg "notSupportedModels" src static configs docs README*` 无结果（历史方案文档如保留说明，需明确标注“已废弃”）。
- [ ] `rg "disabledModels" src static configs docs README*` 无结果。
- [ ] `rg "includeDisabled" src tests` 无结果。
- [ ] `rg "getConfiguredNotSupportedModels" src tests` 无结果。
- [ ] `rg "getConfiguredNotSupportedModelsFromPool" src tests` 无结果。
- [ ] `rg "renderNotSupportedModelsSelector" static` 无结果。
- [ ] `rg "handleGetProviderTypeModels" src tests` 无结果。
- [ ] `rg "updateProviderModels" src tests` 无结果。
- [ ] 节点配置中不再出现 `availableModels`；适配器内部 `this.availableModels` 允许保留。
- [ ] `configs/provider_pools.json.example` 无旧字段。
- [ ] 三语 README、教程页、Adapter Guide 已更新。

### 8.4 回归

- [ ] `npm test` 全绿。
- [ ] `npm run test:integration` 全绿（环境可用时）。
- [ ] 手工冒烟通过。
- [ ] 无新增 ESLint / 语法错误。

---

## 9. 提交拆分

### C1：能力层正向选择

**改动**

- `src/providers/model-capability.js`
- `src/providers/provider-models.js`
- `tests/model-capability.test.js`

**内容**

- 新增 `C_node` / `S_node` / `selectionMode`。
- 新增 `supportedModelsBaseline` 新模型识别。
- 删除 `readLegacyModels`、`getDisabledModels`、`includeDisabled`。
- `getProviderModels()` 回归纯静态基线，候选集不注入自定义模型。
- 删除 `updateProviderModels()`。

**验证**

```bash
node --check src/providers/model-capability.js
node --check src/providers/provider-models.js
npx jest tests/model-capability.test.js --forceExit
```

### C2：聚合、路由与端点统一

**改动**

- `src/providers/provider-pool-manager.js`
- `src/handlers/request-pipeline.js`
- `src/ui-modules/provider-api.js`
- `src/services/ui-manager.js`
- `src/utils/common.js`
- `tests/model-capability-endpoints.test.js`
- `tests/antigravity-provider.test.js`

**内容**

- `F_group = S_group ∪ M_group`。
- 删除 custom-only 分支。
- 删除 `notSupportedModels` 二次过滤。
- 删除 `GET /api/provider-models/{type}`。
- `detect-models` 改为能力刷新。
- 保存逻辑写入 `supportedModels` / `supportedModelsBaseline`。

**验证**

```bash
npx jest tests/model-capability-endpoints.test.js tests/antigravity-provider.test.js --forceExit
npm test
```

### C3：节点复选框 UI

**改动**

- `static/app/modal.js`
- `static/components/section-providers.css`
- `static/app/i18n.js`
- `static/components/section-custom-models.html`
- `static/app/custom-models-manager.js`

**内容**

- 所有 provider 正向复选框。
- 默认全选、搜索、全选、清空。
- 上游刷新按钮与 loading。
- 删除负向选择 UI 与 picker（或改造为正向）。
- i18n 文案更新。

**验证**

- `node --check`（`.mjs`）通过。
- 手工冒烟：默认全选、取消保存、上游新增自动勾选、自定义模型不进入候选。

### C4：清理与文档

**改动**

- `src/scripts/purge-legacy-model-fields.js`（新增）
- `configs/provider_pools.json.example`
- `README.md` / `README-ZH.md` / `README-JA.md`
- `static/components/section-tutorial.html`
- `docs/ANTIGRAVITY_NOTES.md`
- `docs/PROVIDER_ADAPTER_GUIDE.md`
- `docs/MODEL_CAPABILITY_UNIFICATION_PLAN.md`
- 其余残留测试

**内容**

- 删除所有旧字段与旧文档。
- 增加一次性清理脚本。
- 更新模型选择说明。
- 执行 grep 验收。

**验证**

```bash
node src/scripts/purge-legacy-model-fields.js          # dry-run
node src/scripts/purge-legacy-model-fields.js --write  # 确认后执行
rg "notSupportedModels|disabledModels|getConfiguredNotSupportedModels|renderNotSupportedModelsSelector|handleGetProviderTypeModels|updateProviderModels" src static tests configs README* docs
npm test
```

---

## 10. 风险与注意事项

| 风险 | 说明 | 缓解 |
|---|---|---|
| 新模型识别依赖 baseline | `supportedModelsBaseline` 缺失或前端未传时，新模型不会自动选中 | 保存时强制由前端传本次渲染的 `candidateModels`；缺失时按 `B=C_node` 处理 |
| UI 渲染与保存期间上游变化 | 用户看到的候选与后端最新候选不同 | baseline 使用“用户本次看到的候选”，而不是保存时的最新候选 |
| 静态 provider 无上游发现 | 候选只能来自静态基线 | UI 标注 `source=static`，明确不是实时上游结果 |
| 托管 provider 首次无发现 | 候选为空，无法勾选 | 进入编辑时自动刷新一次；失败则提示并允许重试 |
| 自定义模型 actualModel 未被节点选择 | 最终列表可见但可能无节点可路由 | 自定义模型路由使用 `C_node` 而非 `S_node`；找不到候选时正常返回无可用节点 |
| 大小写敏感导致“重复”模型 | `Model` 与 `model` 同时存在 | 按确认决策保留两者，不做大小写归一化 |
| 配置体积增长 | 每个节点多一个 baseline 数组 | 可接受；baseline 只存字符串 ID |
| 删除旧端点影响外部调用 | `GET /api/provider-models/{type}` 移除 | 本项目不考虑向后兼容；文档标注为破坏性变更 |
| 删除 `availableModels` 后首次启动回退基线 | 动态 provider 暂时显示旧基线 | 启动后台刷新 + 手动刷新按钮；文档说明 |
| 运行期写配置风险 | 方案坚持发现结果不写 `provider_pools.json` | 只有 UI 保存写配置，沿用文件锁 |

---

## 11. 实施后代码索引

| 主题 | 位置 |
|---|---|
| 节点选择集计算 | `src/providers/model-capability.js:236-260` |
| 节点能力解析 | `src/providers/model-capability.js:263-311` |
| 分组最终集聚合 | `src/providers/model-capability.js:320-364` |
| 路由守卫 | `src/providers/model-capability.js:374-386` |
| 自定义模型分组辅助 | `src/providers/provider-models.js:267-279` |
| 正向选择配置读取 | `src/providers/provider-models.js:324-326` |
| 纯静态基线 | `src/providers/provider-models.js:334-350` |
| 路由选点 | `src/providers/provider-pool-manager.js:1058-1115` |
| 节点/分组模型聚合 | `src/providers/provider-pool-manager.js:1497-1548` |
| 单 provider 模型列表 | `src/handlers/request-pipeline.js:1188-1198` |
| 自定义模型候选透传 | `src/handlers/request-pipeline.js:750` |
| Provider 节点 API | `src/ui-modules/provider-api.js:311-356` |
| `/api/provider-models` | `src/ui-modules/provider-api.js:450-486` |
| `detect-models` 能力刷新 | `src/ui-modules/provider-api.js:536-580` |
| 保存字段归一化 | `src/ui-modules/provider-api.js:286-315` |
| 前端节点正向复选框 | `static/app/modal.js:167-240` |
| 前端刷新上游模型 | `static/app/modal.js:266-315` |
| 前端保存收集 | `static/app/modal.js:317-340` |
| 旧字段清理脚本 | `src/scripts/purge-legacy-model-fields.js` |

### 实施记录

| 提交 | 内容 |
|---|---|
| `d7e59c4` | 能力层正向选择、`supportedModelsBaseline`、删除负向读取 |
| `f70c78b` | 分组最终集聚合、路由/端点统一、detect-models 与保存逻辑 |
| `8012f43` | 节点正向复选框、刷新上游模型、删除负向 UI |
| `084ec40` | 旧字段清理脚本、配置示例、README 与文档更新 |
| `01eb591` | 冷启动失败回退基线、保存时清除旧字段残留 |
| `8f1d6b7` | 编辑态刷新后复选框可用、刷新保留当前勾选 |

验证结果：`npm test` 21 suites / 325 tests 全绿；`tests/static-syntax.test.js` 26 tests 全绿。
