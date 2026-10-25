# AIClient-2-API 发布说明 (v5.0.5)

> **v5.0.5** 是 v5.0.4 的 CI / 覆盖率工具链修复版本。
>
> - 移除“本地存在用户插件时覆盖率高于 clean checkout”导致的 CI 门槛误判；
> - 覆盖率基线改为在 clean checkout 生成，并分别在 Node.js 22 / 24 下验证；
> - **无运行时、API、配置或数据格式变更**，可直接从 v5.0.4 升级。

---

## 🐛 修复

### 覆盖率门槛在 CI 中误判

`src/plugins-user/` 是 gitignored 的本地用户插件目录：

- 本地工作区存在该目录时，Jest 会把其中的文件计入覆盖率；
- CI clean checkout 中不存在该目录，覆盖率的分子/分母与本地不同；
- 结果是同一份代码在本地通过、在 CI 失败。

修复内容：

- Jest `collectCoverageFrom` 排除 `src/plugins-user/**`；
- `check-coverage` 解析 LCOV 时同步跳过该目录；
- 覆盖率基线改为在 clean checkout 生成；
- 新增回归测试，确保用户插件目录不会进入仓库基线。

## 🧪 验证结果

| 项目 | 结果 |
|---|---:|
| GitHub Actions CI（Node 22.x / 24.x） | **通过** |
| `npm run verify` | **通过** |
| 单元测试 | **44 suites / 593 tests 全绿** |
| TypeScript strict | **0 errors** |
| 覆盖率门槛 | **通过** |
| clean checkout 覆盖率 | **行 30.01% / 分支 31.21% / 函数 33.07%** |

## 📦 兼容性

- 无运行时、API、配置或数据格式变更；
- 无 provider 增删；
- 运行要求保持不变：Node.js `^22.18.0 || >=23.6.0`。

## 🚀 升级建议

- 源码：

  ```bash
  git fetch --tags
  git checkout v5.0.5
  npm install
  npm start
  ```

- Docker：

  ```bash
  docker pull justlikemaki/aiclient-2-api:5.0.5
  ```

- 本次升级不涉及配置迁移；如无 CI/覆盖率需求，运行时代码与 v5.0.4 等价。
