# AIClient-2-API 发布说明 (v5.0.3)

> **v5.0.3** 是 v5.0.2 的修复版本，重点修复两个运行时回归，并完成类型债治理的收尾。
>
> - 非号池部署（`providerPools` 为空）下内容生成请求 500 的问题已修复；
> - 5 个模块中自递归 `getErrorMessage` 导致的 `RangeError` 已修复；
> - `any` / `DynamicPayload` 棘轮扩展，第三方依赖类型补齐。

---

## 🐛 修复

### 1. 非号池部署请求 500（高优先级）

v5.0.2 的 `request-handler` 把延迟解析的 `apiService` 从 `undefined` 改成了 `{}`，导致非号池部署跳过 service 解析，最终返回：

```text
HTTP 500: service.generateContent is not a function
```

修复后恢复传入 `null`，并在解析后增加空 service 守卫。使用 `openai-custom` / `openaiResponses-custom` / `claude-custom` 的单 Key 部署可直接升级。

### 2. 自递归 `getErrorMessage`（高优先级）

`request-handler`、`api-manager`、`service-manager`、`plugin-installer`、`provider-api` 中的 5 个 helper 在收到 `Error` 时会无限递归，抛出：

```text
RangeError: Maximum call stack size exceeded
```

影响插件市场离线 fallback、provider 健康检查、图片生成等错误路径。现已全部改为返回 `error.message`。

## 🧪 回归测试

- 真实 standalone server + 空号池 + 本地假 OpenAI 上游，验证 `/v1/chat/completions` 返回 200（修复前为 500）。
- 插件市场网络失败时正确回退本地缓存（修复前为 `RangeError`）。
- 全源码扫描，禁止 `getErrorMessage` 自递归。

## 🧹 类型债治理

- **冻结 `DynamicPayload` 增量**：通过 TypeScript AST 统计定义数与引用数并纳入棘轮基线（当前 **51 definitions / 1567 references**），新增别名或引用会使 CI 失败。
- **补齐第三方依赖类型**：`busboy` 使用 `@types/busboy`；`adm-zip` 0.5.x 与 `multer` 使用本地最小声明（`types/adm-zip.d.ts`、`types/multer.d.ts`），移除 `types/vendor-modules.d.ts` 的整模块 `any` 声明。
- **按需收敛**：在触碰的 `event-broadcast` / `plugin-api` 中移除 `DynamicPayload`，改用 `multer.File`、`Record<string, unknown>` 与显式运行时守卫。
- **指标现状**：`: any` / `as any` **234 / 6**；AST `AnyKeyword` **393**（src=331 / types=62），其中 `security-hardening.ts` 239。

## ✅ 验证结果

| 项目 | 结果 |
|---|---:|
| TypeScript strict | **0 errors** |
| `@ts-nocheck` | **0 文件 / 0 行** |
| any / DynamicPayload 棘轮 | **OK（234/6/393；51/1567）** |
| 单元测试 | **32 suites / 497 tests 全绿** |
| 导入检查 | **128 文件通过** |
| 运行时 smoke | **OK** |
| 全量 e2e | **20 个模型，26/26 通过** |

## 📦 兼容性

- 无 API、配置或数据格式变更；
- 无 provider 增删；
- **运行要求：Node.js >= 22.18.0**（服务端直接运行 `.ts`，依赖原生类型擦除；Node 20 及更早版本无法启动）。

## 🚀 升级建议

- 源码：

  ```bash
  git fetch --tags
  git checkout v5.0.3
  npm install
  npm start
  ```

- Docker：

  ```bash
  docker pull justlikemaki/aiclient-2-api:5.0.3
  ```

- 升级前请确认 `node -v` >= 22.18.0，其余无需迁移配置。
