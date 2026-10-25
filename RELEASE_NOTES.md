# AIClient-2-API 发布说明 (v5.0.4)

> **v5.0.4** 是 v5.0.3 的修复版本，重点修复插件方法 receiver 丢失与覆盖率统计口径错误。
>
> - 插件 `init` / `destroy` / `authenticate` / `middleware` / `hooks` 恢复正确的 `this` 绑定；
> - LCOV `FNDA` 解析 off-by-one 修复，函数覆盖率由 11.39% 校正为 32.65%；
> - `npm run verify` 现在会执行覆盖率门槛，并新增失败路径回归测试。

---

## 🐛 修复

### 1. 插件方法 receiver 丢失（兼容性修复）

上一轮重构为了避免 TypeScript 的 “possibly undefined” 告警，把插件方法提取到局部变量后直接调用，导致方法内的 `this` 不再是插件对象。依赖实例状态的第三方插件可能出现静默失效。

现已改为：

```text
init.call(plugin, config)
destroy.call(plugin)
authenticate.call(plugin, req, res, url, config)
middleware.call(plugin, req, res, url, config)
hook.call(hooks, ...args)
```

并新增 5 个回归测试，覆盖初始化、销毁、启停、认证、中间件和 hooks。

### 2. 覆盖率统计 off-by-one（度量修复）

LCOV 的 `FNDA:` 前缀长度为 5，旧实现从 `slice(6)` 开始解析，会丢掉 hit count 的第一位：

- `FNDA:1,...` 被解析成空值 / 0；
- `FNDA:10,...` 被解析成 0；
- 导致函数覆盖率被系统性低估。

修复后函数覆盖率由 **11.39% 校正为 32.65%**（293 → 840 covered）。这是统计口径修复，不是测试覆盖率突然提升。

## 🧪 回归测试

- 新增 `FNDA` 解析测试：覆盖 0、1、9、10、11、100 等 hit count。
- 新增覆盖率门槛失败路径测试：基线高于实际覆盖率时，脚本必须以非零码退出。
- 新增插件 receiver 测试：确保所有被提取的方法仍以插件对象作为 `this`。

## ✅ 验证结果

| 项目 | 结果 |
|---|---:|
| `npm run verify` | **通过** |
| TypeScript strict | **0 errors** |
| any / DynamicPayload 棘轮 | **OK（340 AST nodes；1 definition / 1539 refs）** |
| 单元测试 | **44 suites / 592 tests 全绿** |
| 导入检查 / 循环依赖 | **136 文件通过 / 0 cycles** |
| 运行时 smoke | **OK** |
| 覆盖率 | **行 29.84% / 分支 31.09% / 函数 32.65%** |
| 全量 E2E | **20 个模型，26/26 通过** |
| 定向回归 E2E | **openai-custom:glm-5.3，11 项核心 + 2 项定向通过** |

## 📦 兼容性

- 无 API、配置或数据格式变更；
- 无 provider 增删；
- **运行要求：Node.js `^22.18.0 || >=23.6.0`**（服务端直接运行 `.ts`，依赖原生类型擦除）。

## 🚀 升级建议

- 源码：

  ```bash
  git fetch --tags
  git checkout v5.0.4
  npm install
  npm start
  ```

- Docker：

  ```bash
  docker pull justlikemaki/aiclient-2-api:5.0.4
  ```

- 升级前请确认 `node -v` 满足要求，其余无需迁移配置。
