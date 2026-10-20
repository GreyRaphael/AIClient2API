# 模型能力统一方案（Model Capability Unification）

- 状态：待评审
- 范围：`src/providers/**`、`src/ui-modules/provider-api.js`、`src/handlers/request-pipeline.js`、`src/providers/provider-pool-manager.js`
- 目标：消除“上游模型已更新，但模型列表 / Playground / 路由校验不同步”的一类问题
- 非目标：实时同步、上游协议变更自动适配、模型可调用性探测

---

## 1. 背景与问题

### 1.1 现象

同一个模型在不同入口出现不一致：

- Provider 详情（`/api/providers`）能看到上游新模型；
- Playground / 模型列表（`/api/provider-models`）看不到；
- `/auto/v1/models` 看不到；
- `/{provider}/v1/models` 有时能看到，又被过滤掉；
- 点击“健康检查”后，部分 provider（antigravity）自动恢复，部分 provider（trae）无变化。

### 1.2 根因

模型列表同时被当作“用户配置”“运行时缓存”“静态基线”使用，且有多条读取路径：

1. **节点 `availableModels` 是持久化快照，但没有刷新写入路径**
   - 仅由历史 UI 保存写入，当前代码只读不写；
   - 对 trae 而言，它在 `getNodeAvailableModels()` 中优先于动态结果
     （`src/providers/provider-pool-manager.js:1465-1479`）。
2. **动态结果写入了错误的层级**
   - trae/zed/codex 把动态列表写入模块级 `PROVIDER_MODELS`
     （`src/providers/trae/trae-core.js:1216`、
     `src/providers/zed/zed-core.js:1393`、
     `src/providers/openai/codex-core.js:1188`）；
   - 该结构是全局的、按 providerType 共享的、进程重启即丢失的。
3. **集合差被反推成“用户排除”**
   - `getEffectiveExcludedModels()` 用 `allKnown − active` 推导排除集
     （`src/providers/provider-pool-manager.js:1568-1597`），
     导致“已发现但不在旧快照里”的模型被判为不支持。
4. **刷新触发方式不一致**
   - antigravity 初始化时同步拉取模型（`src/providers/gemini/antigravity-core.js:1257-1346`）；
   - codex 初始化时异步预热（`src/providers/openai/codex-core.js:203-214`）；
   - zed 获取 token 时后台刷新（`src/providers/zed/zed-core.js:250-253`）；
   - trae 只有显式 `listModels()` 才刷新（`src/providers/trae/trae-core.js:1273-1290`）；
   - 健康检查被隐式当作刷新触发器，但只对部分 provider 有效。
5. **端点读取路径分叉**
   - `/api/providers` 走实时 adapter（`src/ui-modules/provider-api.js:261-294`）；
   - `/api/provider-models` 走 pool manager 的同步聚合（`src/ui-modules/provider-api.js:518-547`）；
   - `/api/provider-models/{type}` 又是另一套分支（`src/ui-modules/provider-api.js:557-612`）；
   - `/auto/v1/models` 走 `getAllAvailableModels()`（`src/providers/provider-pool-manager.js:1604-1686`）；
   - `/{provider}/v1/models` 走 live `listModels()` + 反推排除（`src/handlers/request-pipeline.js:1310-1341`）。

### 1.3 现状矩阵

| Provider | 动态发现 | 动态结果存放 | 聚合读取 | 陈旧快照遮蔽 | 结论 |
|---|---|---|---|---|---|
| `trae` / `trae-solo_work_lite` / `trae-chat_v3` | `fetchRemoteModels()`（仅 `listModels` 触发） | 全局 `PROVIDER_MODELS`（整体替换） | 节点 `availableModels` 优先 | **是，持续存在** | 确认同类 bug |
| `gemini-antigravity` | `initialize()` 内 `fetchAvailableModels()` | 实例 `availableModels` | 实例优先，未初始化回退快照/基线 | 仅初始化前 | 健康检查/预热后自动恢复 |
| `openai-codex-oauth` | `initialize()` 异步预热 | 实例 `availableModels` + 全局合并 | 实例优先，未初始化回退快照 | 仅初始化前 | 与 antigravity 同类 |
| `zed` | 获取 token 时后台刷新 | 实例 `modelsCache` + 全局并集 | 全局 `PROVIDER_MODELS` | 无快照遮蔽 | 新增可同步；下线不生效、节点差异丢失 |
| `claude-kiro-oauth` | 无（静态 `KIRO_MODELS`） | 无 | 静态 | — | 不会自动同步 |
| `grok-web` | 无（静态 `GROK_MODELS`） | 无 | 静态 | — | 不会自动同步 |
| `grok-cli-oauth` | 无（静态 `GROK_CLI_MODELS`） | 无 | 静态 | — | 不会自动同步，模块加载时快照 |
| 托管（`openai-custom` 等 6 类） | 有 `listModels()` 但聚合不用 | `supportedModels` / `customModels` | 配置驱动 | — | 设计上不自动发现 |

---

## 2. 设计原则

> **配置只存“用户意图”，模型列表只存“运行时缓存”，静态基线只做最后兜底。**

由此推导出五条硬规则：

1. **单一事实来源**：节点能力缓存（per `providerType:uuid`）。
2. **单一读取入口**：所有端点、路由、健康检查都调用同一个 capability resolver。
3. **单一刷新入口**：单飞、TTL、退避、持久化，只在一个地方实现。
4. **不做集合差反推**：排除项只来自用户显式配置。
5. **不把基线伪装成实时**：`source` 必须可观测。

---

## 3. 目标架构

### 3.1 数据模型

#### 运行时能力缓存（新文件，不写入 provider_pools.json）

`configs/model-capability-cache.json`（权限 600，原子写入）：

```json
{
  "version": 1,
  "nodes": {
    "trae:bedb2578-5f2d-436a-ae5a-1541f5e7bee9": {
      "providerType": "trae",
      "uuid": "bedb2578-5f2d-436a-ae5a-1541f5e7bee9",
      "models": ["DeepSeek-V4.1-Flash-1017", "DeepSeek-V4.1-Flash"],
      "fetchedAt": 1792457345697,
      "source": "live",
      "lastError": null,
      "consecutiveFailures": 0
    }
  }
}
```

设计要点：

- 缓存可随时删除，不影响配置正确性；
- 只有成功的发现结果才写入；
- `models: []` 是合法结果（上游明确返回空），**不等于“没有缓存”**；
- 进程启动时 rehydrate，随后后台刷新。

#### 节点配置（只保留用户意图）

```js
{
  uuid,
  disabledModels: [],        // 用户显式排除；迁移期兼容 notSupportedModels
  supportedModels: [],       // 仅托管 provider 使用
  modelAliases: {},          // 可选：用户显式别名
}
```

`availableModels` 标记为 deprecated：迁移后再忽略，不参与任何读取。

#### 静态基线（不可变）

- `PROVIDER_MODELS` 保留为基线，建议语义重命名为 `BASELINE_PROVIDER_MODELS`（保留旧导出别名）；
- 动态发现**不再调用** `updateProviderModels()`；
- `getBaselineModels(providerType)` 只返回基线 + 静态内置模型。

### 3.2 解析器 API

新增 `src/providers/model-capability.js`：

```js
export const CAPABILITY_SOURCE = {
  LIVE: 'live',
  PERSISTED: 'persisted',
  BASELINE: 'baseline',
  CONFIGURED: 'configured',
  STATIC: 'static'
};

/** 同步：立即返回，不发起网络请求 */
export function resolveNodeCapability(providerType, nodeConfig) {
  return {
    models,        // 应用 disabledModels 后
    discovered,    // 原始发现集合
    source,        // live | persisted | baseline | configured | static
    fetchedAt,     // 0 表示未知
    stale,         // 超过 TTL 或从未成功
    known          // 是否已有可靠发现结果（用于路由守卫）
  };
}

/** 同步聚合：display 并集 / routing 逐节点 */
export function resolveProviderCapability(providerType, nodes, { mode = 'display' } = {}) {
  return {
    models,
    nodes: [{ uuid, models, source, fetchedAt, stale, known }],
    source,
    fetchedAt,
    stale
  };
}

/** 异步刷新：单飞 + 退避 */
export async function refreshNodeCapability(providerType, nodeConfig, { force = false, reason = 'manual' } = {});
export async function refreshProviderCapabilities(providerType, nodes, { force = false, reason = 'manual' } = {});
```

解析优先级（唯一规则）：

```text
1. 托管 provider 且 supportedModels 非空  → configured
2. 存在发现记录（live / persisted）       → 使用记录
3. 否则                                   → baseline
最后统一减去 disabledModels
```

注意：

- 只有 `supportedModels` 为空时才进入发现/基线链路；
- 发现记录存在但 `models` 为空时，返回空集合，**不回退基线**；
- `baseline` 的 `known = false`（动态 provider）或 `true`（静态 provider）。

### 3.3 Adapter 契约

基类已有 `getNodeAvailableModels()`（`src/providers/adapter.js:92-94`），要求全部显式实现：

| Provider | 实现 |
|---|---|
| `gemini-antigravity` | 返回实例 `availableModels`；必要时 `initialize()`；支持 `force` |
| `openai-codex-oauth` | 返回 `getSupportedModels()`；必要时 `fetchRemoteModels()` |
| `trae*` | 返回 `listModels()` 的 id 列表 |
| `zed` | 返回实例 `modelsCache` 的 id 列表；必要时 `fetchRemoteModels()` |
| `claude-kiro-oauth` | 返回 `null`（无节点级发现） |
| `grok-web` / `grok-cli-oauth` | 返回 `null`（无节点级发现） |
| 托管 provider | 返回 `null`（由 `supportedModels` 决定） |

`ProviderPoolManager.getNodeAvailableModels()` 改为薄委托：

```js
getNodeAvailableModels(providerType, nodeConfig) {
  return resolveNodeCapability(providerType, nodeConfig).models;
}
```

删除对 `antigravityApiService` / `codexApiService` 内部字段的直接嗅探。

### 3.4 刷新机制（SWR）

#### TTL

```js
MODEL_CACHE_TTL_MS = {
  'gemini-antigravity': 30 * 60_000,
  'openai-codex-oauth': 30 * 60_000,
  'trae':               60 * 60_000,
  'trae-solo_work_lite': 60 * 60_000,
  'trae-chat_v3':       60 * 60_000,
  'zed':                60 * 60_000,
  default:              60 * 60_000
}
```

支持配置覆盖：`MODEL_CACHE_TTL_MS`、`MODEL_CACHE_COLD_START_TIMEOUT_MS`（默认 2000ms）。

#### 行为

- **读路径永不阻塞**：返回缓存并标记 `stale`；
- **stale 时后台刷新**（stale-while-revalidate）；
- **冷启动且无缓存**：允许一次带超时的 await；超时返回 baseline 并标记 `source`；
- **单飞**：按 `${providerType}:${uuid}` 合并并发刷新；
- **失败退避**：1m → 2m → 4m → … → 30m，成功清零；保留 last-known；
- **只刷新启用节点**，且刷新全部节点，不再只取 `nodes[0]`；
- **只持久化成功结果**。

#### 触发时机

- 启动：rehydrate + 后台刷新所有活跃节点；
- TTL 过期；
- 用户显式“刷新模型”；
- 配置更新 / adapter invalidate 后刷新对应节点；
- 凭证或 token 刷新成功后（统一收口）；
- **健康检查不再承担模型刷新职责**。

### 3.5 聚合与路由语义

| 场景 | 规则 |
|---|---|
| **display**（模型列表 / Playground / `/auto/v1/models`） | 活跃节点 `models` 的并集，已应用各自 `disabledModels` |
| **routing**（`_doSelectProvider` / `/{provider}/v1/models`） | 只保留 `known && models.includes(requested)` 的节点；`known=false` 时不做守卫 |
| **managed** | `supportedModels` 非空 → 用它；否则按发现/基线 |
| **静态 provider** | baseline，`source='static'`，不发起发现 |
| **健康检查选模型** | capability resolver + 现有默认表兜底 |

不再使用“所有节点共同排除”的 `commonExcluded` 推导。

---

## 4. 端点改造映射

| 位置 | 现状 | 改造后 |
|---|---|---|
| `/api/providers`（`src/ui-modules/provider-api.js:261`） | 逐节点实时调用 adapter | `resolveProviderCapability` + 元数据 |
| `/api/provider-models`（`src/ui-modules/provider-api.js:518-547`） | `getActiveProviderModels` | `resolveProviderCapability({ mode:'display' })` |
| `/api/provider-models/{type}`（`src/ui-modules/provider-api.js:557-612`） | 多分支 | 与上者同口径 |
| `/auto/v1/models`（`src/providers/provider-pool-manager.js:1604-1686`） | `getAllAvailableModels` | `resolveProviderCapability({ mode:'display' })` |
| `/{provider}/v1/models`（`src/handlers/request-pipeline.js:1310-1341`） | live `listModels` + 反推排除 | `resolveProviderCapability({ mode:'routing' })` |
| `_doSelectProvider`（`src/providers/provider-pool-manager.js:1049-1083`） | `getNodeAvailableModels` | capability resolver |
| 健康检查选模型（`src/providers/provider-pool-manager.js:2428-2430`） | 默认表 | resolver + 默认表兜底 |

响应保持兼容：

- `/api/provider-models` 仍返回 `{ providerType: string[] }`；
- 可选 `?details=1` 返回 `{ models, source, fetchedAt, stale }`；
- `/api/providers` 每个节点增加 `modelsSource`、`modelsFetchedAt`、`modelsStale`、`modelsLastError`。

---

## 5. 删除清单

以下逻辑整体删除，不再保留并行实现：

- `ProviderPoolManager.getNodeAvailableModels()` 的内部 service 字段嗅探（`1465-1479`）
- `ProviderPoolManager.getEffectiveExcludedModels()`（`1568-1597`）
- `ProviderPoolManager.getActiveProviderModels()`（`1487-1560`）
- `ProviderPoolManager.getAllAvailableModels()` 内的模型推导（`1604-1686`）
- `provider-api.js` 的 `getManagedSupportedModels()`、`getActiveProviderModels()`、`resolveNodeAvailableModels()` 中重复逻辑
- `provider-api.js` 的 `warmProviderNodeModels()`（`449-481`）
- `provider-api.js` 的 `triggerProviderDynamicModelRefresh()`（`486-513`）
- 动态 provider 的 `updateProviderModels()` 调用：
  - `src/providers/trae/trae-core.js:1216`
  - `src/providers/zed/zed-core.js:1393`
  - `src/providers/openai/codex-core.js:1188`
- 保存 provider 时对 `notSupportedModels` 的实时列表裁剪（`src/ui-modules/provider-api.js:851-855`）
- 节点配置 `availableModels` 的读写

---

## 6. 迁移方案

1. 启动时扫描 `provider_pools.json`：
   - 若节点存在 `availableModels`，写入能力缓存，`source='persisted'`、`fetchedAt=0`；
   - 原字段保留但忽略，便于回滚。
2. `notSupportedModels` 作为 `disabledModels` 读取；写入期可双写。
3. `PROVIDER_MODELS` 静态化，动态结果只进能力缓存。
4. 下一版本删除 `availableModels` 字段与 `notSupportedModels` 双写。
5. 提供 `MODEL_CAPABILITY_MODE=legacy|unified` 开关，默认 `unified`，可一键回退读路径。

迁移完成后，节点配置只包含用户意图，不再被运行时状态污染。

---

## 7. 可观测性

- 日志：
  - `[ModelCapability] trae/bedb... refreshed: 22 models (live, 1.2s)`
  - `[ModelCapability] trae/bedb... refresh failed (attempt 3), next in 4m: <error>`
  - `[ModelCapability] trae/bedb... using baseline (no discovery yet)`
- `/api/providers` 暴露 `modelsSource` / `modelsFetchedAt` / `modelsStale` / `modelsLastError`。
- UI 可选展示“模型来源 / 最后更新 / 刷新模型”按钮。

---

## 8. 测试策略

### 单元测试

- 优先级：live > persisted > baseline；空发现结果不回退基线。
- `disabledModels` 只做减法，永不新增排除项。
- display 并集 / routing 节点级过滤 / `known=false` 不守卫。
- 单飞、TTL、退避、失败保留 last-known。
- 缓存文件损坏时不抛错。

### 集成测试

- 构造“旧缓存缺新模型”的场景，刷新后以下端点一致：
  `/api/provider-models`、`/api/provider-models/{type}`、`/api/providers`、`/auto/v1/models`、`/{provider}/v1/models`。
- Trae：缓存含 `DeepSeek-V4.1-Flash-1017` 时，以上端点全部可见且路由可选中。
- Antigravity：未初始化时 `source` 明确，不把静态 5.5 Claude 伪装成 live；初始化后收敛到真实列表。
- Zed：新增可同步、下线可移除、节点差异可表达。
- 上游失败：所有端点一致返回 last-known 或 baseline，并带 `stale=true`。
- 重启：缓存 rehydrate 成功，首次请求不回退静态基线。

### 测试隔离（必须）

- `ProviderPoolManager` 增加 `persist: false` 或注入 `capabilityStore`；
- 测试与脚本不得实例化带持久化副作用的 manager；
- 缓存存储使用 `MemoryStore`，禁止写真实 `configs/`。

---

## 9. 提交拆分与验收清单

### C1：能力层与缓存存储（不接线）

**改动**

- 新增 `src/providers/model-capability.js`。
- 新增 `CapabilityCacheStore`（File / Memory 两种实现）。
- 新增单元测试 `tests/model-capability.test.js`。

**验收清单**

- [ ] 解析优先级正确：`configured > live/persisted > baseline`。
- [ ] 发现记录存在但 `models: []` 时返回空集合，不回退基线。
- [ ] `disabledModels` 只做减法，不产生新的排除项。
- [ ] 缓存存储支持原子写入、损坏文件容错、`MemoryStore` 注入。
- [ ] 不修改任何现有调用方；`npm test` 全绿。
- [ ] 测试过程零真实文件写入（可用文件 mtime 断言）。
- [ ] `node --check` 通过；无循环依赖（`model-capability` 只依赖 `provider-models` / 工具模块）。

**验证命令**

```bash
node --check src/providers/model-capability.js
npx jest tests/model-capability.test.js --forceExit
npm test
```

**回滚**：删除新文件与测试即可，无调用方影响。

---

### C2：Adapter 契约收敛

**改动**

- 为 `trae*`、`zed` 实现 `getNodeAvailableModels()`。
- 确认 antigravity / codex 的实现支持 `force`。
- 静态 provider 与托管 provider 明确返回 `null`。
- 删除动态 provider 对 `updateProviderModels()` 的调用。

**验收清单**

- [ ] `TraeApiServiceAdapter.getNodeAvailableModels()` 返回实时模型 ID（含 `DeepSeek-V4.1-Flash-1017` 时可见）。
- [ ] `ZedApiServiceAdapter.getNodeAvailableModels()` 返回当前实例的 `modelsCache`，不返回全局并集。
- [ ] `AntigravityApiServiceAdapter` / `CodexApiServiceAdapter` 行为保持兼容。
- [ ] `claude-kiro-oauth`、`grok-web`、`grok-cli-oauth`、托管 provider 返回 `null`。
- [ ] `PROVIDER_MODELS` 在发现成功后不再变化（可用测试断言引用与内容）。
- [ ] 现有 trae / codex / zed / antigravity 测试更新后全绿。

**验证命令**

```bash
npx jest tests/trae-provider.test.js tests/antigravity-provider.test.js --forceExit
npx jest tests/zed-provider.test.js tests/codex-dynamic-models.test.js --forceExit
npm test
```

**回滚**：恢复 `updateProviderModels()` 调用与 adapter 方法；C1 不受影响。

---

### C3：读取路径统一与反推删除

**改动**

- pool manager / provider-api / request-pipeline 全部切换到 capability resolver。
- 删除 `getEffectiveExcludedModels()` 与 `commonExcluded` 推导。
- 删除 `/api/provider-models/{type}` 的独立分支。
- 启动迁移：`availableModels` → 能力缓存。
- 移除保存 provider 时对 `notSupportedModels` 的裁剪。

**验收清单**

- [ ] 五个入口对同一缓存快照返回一致结果（见第 8 节集成测试）。
- [ ] `getEffectiveExcludedModels()` 已删除，代码中无集合差反推。
- [ ] `availableModels` 迁移后仅被忽略，不再参与读取；UI 保存不会写回。
- [ ] `notSupportedModels` 保存时原样保留，不被实时列表裁剪。
- [ ] Trae 缓存含 `DeepSeek-V4.1-Flash-1017` 时：
  - `/api/provider-models` 可见；
  - `/api/provider-models/trae` 可见；
  - `/auto/v1/models` 可见；
  - `/trae/v1/models` 可见；
  - 以 `trae:DeepSeek-V4.1-Flash-1017` 发起请求可选中 trae 节点。
- [ ] Provider 详情与 Playground 的模型列表一致。
- [ ] `npm test` 与 `npm run test:integration` 全绿。

**验证命令**

```bash
npm test
npm run test:integration
# 手工核对（服务运行中）
curl -s -H "Authorization: Bearer $API_KEY" http://127.0.0.1:3000/api/provider-models
curl -s -H "Authorization: Bearer $API_KEY" http://127.0.0.1:3000/api/provider-models/trae
curl -s -H "Authorization: Bearer $API_KEY" http://127.0.0.1:3000/auto/v1/models
curl -s -H "Authorization: Bearer $API_KEY" http://127.0.0.1:3000/trae/v1/models
```

**回滚**：`MODEL_CAPABILITY_MODE=legacy` 切回旧读路径；迁移字段保留。

---

### C4：刷新机制（SWR / TTL / 持久化）

**改动**

- 实现 TTL、单飞、退避、stale-while-revalidate。
- 启动 rehydrate + 后台刷新。
- 删除 `warmProviderNodeModels()` 与 `triggerProviderDynamicModelRefresh()`。
- 刷新全部启用节点，跳过 disabled。

**验收清单**

- [ ] stale 读取立即返回，不阻塞端点；后台刷新完成后结果更新。
- [ ] 冷启动无缓存时：在超时预算内等待一次刷新；超时返回 `source=baseline`。
- [ ] 并发刷新同一节点只调用一次 adapter（单飞）。
- [ ] 刷新失败：保留 last-known、`stale=true`、按退避安排下次刷新。
- [ ] 刷新成功：写入缓存文件，`source=live`，`consecutiveFailures=0`。
- [ ] 启动后首次请求不会因缓存未加载而回退静态基线（rehydrate 生效）。
- [ ] 健康检查不再直接修改模型缓存；移除 3 秒 `Promise.race` 预热。
- [ ] 缓存文件原子写入、权限 600、损坏文件不导致启动失败。
- [ ] `persist:false` / `MemoryStore` 在测试中生效，测试不写 `configs/`。

**验证命令**

```bash
npx jest tests/model-capability.test.js --forceExit
npm test
# 重启场景：重启服务后立即请求模型列表，确认 source 为 persisted/live，而非 baseline
```

**回滚**：缓存文件可删除；关闭后台刷新配置即回到按需刷新。

---

### C5：Provider 策略与 UI 元数据

**改动**

- 托管 provider：`supportedModels` 为空时回落到 adapter 发现；adapter 返回 `null` 时回落到基线。
- Zed：routing 使用节点级能力，display 使用并集。
- 静态 provider：标记 `source=static`，文档注明需发版更新。
- UI 展示 `source/fetchedAt/stale`，可选“刷新模型”操作。
- 更新 `docs/PROVIDER_ADAPTER_GUIDE.md` 与 Provider 现状表。

**验收清单**

- [ ] 托管 provider 空 `supportedModels` 时回落到 adapter 发现，发现不可用时回落到基线。
- [ ] Zed 路由按节点能力过滤；无缓存时 `known=false` 不阻断请求。
- [ ] Kiro / Grok Web / Grok CLI 的 `source=static` 在 API/UI 可见。
- [ ] 文档中的 Provider 能力矩阵与实际行为一致。
- [ ] `npm test`、`npm run test:integration` 全绿。
- [ ] 真实服务冒烟：Playground、Provider 详情、`/auto/v1/models` 三处一致。

**验证命令**

```bash
npm test
npm run test:integration
# 手工冒烟：切换 provider、刷新模型、观察 source/stale 展示
```

**回滚**：UI 元数据为增量改动，可直接回退；策略变更通过 `MODEL_CAPABILITY_MODE` 切换。

---

## 10. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 上游限流 | TTL + 随机抖动 + 退避；失败保留 last-known |
| 首次请求变慢 | 仅冷启动允许有限等待；其余 SWR |
| 多账号差异 | 节点级缓存；display 并集、routing 逐节点 |
| 迁移遗漏 | `availableModels` 保留一个版本；`legacy` 开关 |
| 测试写真实配置 | `persist:false` + `MemoryStore`；CI 断言文件 mtime |
| 静态 provider 被误判 | `source=static` 明确标记，文档说明 |

---

## 11. 非目标

- 不承诺实时：同步边界为 TTL。
- 不做“可调用性探测”：`discovered ≠ callable`（antigravity 的 `agentModelSorts` 即为账号/Plan 维度子集）。
- 不自动适配上游协议或接口变更。
- 不为没有 models 接口的静态 provider 强行造发现能力。

---

## 12. 附录

### A. 关键代码索引

| 主题 | 位置 |
|---|---|
| Pool 节点能力读取 | `src/providers/provider-pool-manager.js:1465-1479` |
| Pool display 聚合 | `src/providers/provider-pool-manager.js:1487-1560` |
| 集合差反推 | `src/providers/provider-pool-manager.js:1568-1597` |
| `/auto` 聚合 | `src/providers/provider-pool-manager.js:1604-1686` |
| 路由节点守卫 | `src/providers/provider-pool-manager.js:1049-1083` |
| 健康检查 | `src/providers/provider-pool-manager.js:2425-2485` |
| Provider 详情实时读取 | `src/ui-modules/provider-api.js:261-294` |
| 预热 | `src/ui-modules/provider-api.js:449-481` |
| fire-and-forget 刷新 | `src/ui-modules/provider-api.js:486-513` |
| `/api/provider-models` | `src/ui-modules/provider-api.js:518-547` |
| `/api/provider-models/{type}` | `src/ui-modules/provider-api.js:557-612` |
| 单 provider 模型列表 | `src/handlers/request-pipeline.js:1310-1341` |
| Antigravity 发现 | `src/providers/gemini/antigravity-core.js:1257-1346` |
| Codex 发现 | `src/providers/openai/codex-core.js:1123-1229` |
| Zed 发现 | `src/providers/zed/zed-core.js:1346-1408` |
| Trae 发现 | `src/providers/trae/trae-core.js:991-1229` |
| Adapter 基类契约 | `src/providers/adapter.js:92-94` |
| Trae adapter | `src/providers/adapter.js:624-627` |
| 静态基线 | `src/providers/provider-models.js:44-214` |
| 动态全局写入 | `src/providers/provider-models.js:227-242` |

### B. 验收证据（现状）

- 日志：`logs/app-2026-10-20.log` 中 antigravity 健康检查后 `Fetching available models...` → 列表收敛。
- 日志：`logs/app-2026-10-19.log:18481` 中 `/trae/v1/models` 将 `DeepSeek-V4.1-Flash-1017` 加入排除集。
- 实测：`/api/provider-models` 的 trae 为 10 个，`/api/provider-models/trae` 为 22 个（含 `-1017`）。

### C. 迁移检查表

- [ ] 已生成本地能力缓存文件。
- [ ] 旧 `availableModels` 已迁移且不再被读取。
- [ ] `notSupportedModels` 语义已标注为用户排除。
- [ ] `PROVIDER_MODELS` 不再被动态写入。
- [ ] 端点一致性测试通过。
- [ ] 重启后缓存 rehydrate 正常。
- [ ] 文档与 Provider 现状矩阵已更新。

---

## 13. 实施记录

| 提交 | 内容 | 状态 |
|---|---|---|
| `5797cd7` | 新增本方案文档 | ✅ |
| `b415cd4` | C1：模型能力层与 Memory/File 缓存存储 | ✅ |
| `dfcaef1` | C2：Adapter 节点模型能力契约收敛 | ✅ |
| `8a73737` | C3：统一读取路径、删除集合差反推、移除全局动态写入 | ✅ |
| `6d81d2f` | C4：SWR、启动预热、定时刷新、显式刷新接口 | ✅ |
| `90eccf9` | C5：托管/静态/Zed 策略、UI 元数据、Adapter 指南 | ✅ |

验证结果：

- `npm test`：21 suites / 314 tests 全绿。
- `tests/model-capability.test.js`：解析优先级、空结果、TTL、退避、单飞、持久化、托管/静态策略。
- `tests/model-capability-endpoints.test.js`：`trae:DeepSeek-V4.1-Flash-1017` 在 `/api/provider-models`、`/api/provider-models/trae`、`/auto/v1/models` 与路由选点中一致可见。
- `npm run test:integration` 依赖本地运行实例的 `TEST_API_KEY` 与配置一致；当前验证环境的运行实例使用不同 Key，需先对齐后再执行。

运行期新增缓存文件：`configs/model-capability-cache.json`（仅成功发现结果，权限 600，可安全删除）。
