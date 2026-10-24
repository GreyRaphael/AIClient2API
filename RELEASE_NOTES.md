# AIClient-2-API 发布说明 (v5.0.0)

> **v5.0.0** 是一次以“收敛与减负”为主的破坏性版本：彻底移除 `grok-cli-oauth` provider，统一前后端 provider 元数据，启用 `src` 类型检查与 CI，并重构 E2E 测试体系。
>
> 除 Grok CLI 外，其他 provider（Antigravity、Kiro、Codex、OpenAI、Claude、Zed、Trae）的接入方式与协议行为保持不变。

---

## ⚠️ 破坏性变更

### 1. 移除 `grok-cli-oauth` provider

- 删除 Grok CLI core、OAuth、适配器注册、模型清单、号池、用量查询、OAuth/批量导入路由以及前端入口。
- 删除前端 provider 卡片、授权弹窗、路由示例、i18n 与相关配置示例。
- `MODEL_PROVIDER.GROK_CLI` 常量与 `grok-cli-oauth` 注册项不再存在。

**升级前请处理：**

- 删除 `configs/grok-cli/` 下的凭据文件；
- 从 `configs/provider_pools.json` 删除 `grok-cli-oauth` 节点；
- 清理 `model-capability-cache.json`、`usage-cache.json`、`model-usage-stats.json` 中的 Grok CLI 缓存/统计（可选）。

> 这些属于 gitignored 运行时数据，本次发布不会自动删除。

### 2. 工程与测试结构调整

- `npm run test:e2e` 现在只运行核心矩阵 + 6 项通用定向契约；
- 原 4 项 provider 方言用例改为 `npm run test:e2e:providers` 显式运行；
- 移除依赖模型采样/质量的 E2E（GPT 采样、DeepSeek consistency、CoT 回放、oneOf、重复多 system 用例），对应逻辑由确定性单测覆盖。

---

## 🌟 核心改进

### 1. Provider 元数据单一来源

- 新增 `static/app/provider-registry.js`：前端 provider 名称、图标、默认模型、目录、OAuth 能力与上传路径统一维护。
- 新增 `src/providers/provider-registry.js`：后端 provider 类型、协议、健康检查模型、凭据字段、静态模型与动态能力 TTL 统一维护。
- `provider-models`、`model-capability`、`provider-pool-manager`、`provider-utils`、`protocol`、`service-manager`、`config-scanner` 均改为从注册表派生。
- 新增 provider 或移除 provider 时，不再需要逐文件修改十几份映射表。

### 2. 类型检查与 CI

- `tsconfig.json` 纳入 `src/**/*.js`，开启 `checkJs`。
- 新增 `npm run typecheck`，并在 GitHub Actions 中执行 typecheck + 单测。
- 类型检查发现并修复了多个实际缺陷：
  - 生图监控钩子的 `prompt` 越界引用；
  - `api-potluck` 缺少 `mkdirSync` 导入；
  - `update-api` 的 `arrayBuffer()` 返回类型错误；
  - header 可能为数组导致 `startsWith` 崩溃；
  - `config-scanner` 漏导入注册表函数。
- 11 个大型动态文件暂时使用 `@ts-nocheck`，后续可逐文件补齐 JSDoc 后移除。

### 3. P0 工程精简

- 统一使用 npm，删除 `pnpm-lock.yaml` 与安装脚本中的 pnpm 分支；
- Docker 构建优先 `npm ci`；
- 移除未使用依赖 `ws`、`supertest`、`jest-environment-node`；
- 删除未引用 `favicon0.ico` 与一次性迁移脚本；
- 过期评审/设计文档归档到 `docs/archive/`。

### 4. 测试体系精简

- 4 个按版本分桶的回归测试合并为 2 个领域文件，126 个历史用例全部保留；
- 通用 E2E 定向契约压缩为 6 项，provider 方言 canary 独立为 4 项 opt-in；
- 定向用例不再硬编码模型，按 `/auto/v1/models` 的 provider 前缀动态选择；模型下线时自动 skip；
- 动态 provider 静态模型清单压缩为少量冷启动 baseline。

### 5. 配置文档

- 新增 `docs/CONFIG_PRECEDENCE.md`，明确 env/config/default 读取顺序、provider 能力优先级、模型列表与 fallback 优先级，并标注历史兼容字段。

---

## ✅ 验收结果

| 项目 | 结果 |
|---|---:|
| 单元测试 | 27 suites / 486 tests |
| TypeScript checkJs | 0 errors |
| 静态语法检查 | 27 / 27 |
| 默认 E2E（19 模型） | 25 / 25 |
| Provider canary | 4 / 4 |
| 核心矩阵 | 19 个模型 × 11 项 |

> E2E 仍有少量非阻塞 `[E2E warnings]`（部分模型/通道不返回 reasoning block），不影响网关正确性断言。

---

## 📦 升级建议

1. 升级到 v5.0.0 前，先移除所有 `grok-cli-oauth` 配置与凭据。
2. 使用 npm 安装依赖：
   ```bash
   npm install
   ```
3. 如之前使用 pnpm lockfile，请改用 `package-lock.json`。
4. 其他 provider 无需修改配置。

---

## 📚 相关文档

- [配置分层与优先级](docs/CONFIG_PRECEDENCE.md)
- [跨协议架构](docs/CROSS_PROTOCOL_ARCHITECTURE.md)
- [Provider 适配指南](docs/PROVIDER_ADAPTER_GUIDE.md)
- [E2E 测试说明](tests/e2e/README.md)
