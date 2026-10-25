# AIClient-2-API 发布说明 (v5.0.6)

> **v5.0.6** 是 v5.0.5 之后的稳定性与可维护性升级版本。
>
> 本轮完成 P0–P2 后续重构：强化质量门槛和核心链路回归保护，拆分 Zed、Kiro、Provider Pool 与 Pipeline 热点，并继续收敛协议动态类型。保持现有 API、配置及插件调用约定，无需配置迁移。

---

## 🛡️ 质量门槛与类型安全

- 修复 strict 门槛的假阴性：TypeScript 编译器失败、非 `src/` 严格错误及失败的 baseline 更新都会可靠返回非零。
- 主源码与内置插件全面启用 `noUnusedLocals`，清理无用 import、局部变量、catch 绑定和死代码。
- 公共响应/流联合移除 `any` catch-all，请求扩展载荷改为 `unknown`；Claude → OpenAI usage 使用真实 DTO。
- `AnyKeyword` 收敛至 **336**；`DynamicPayload` 引用从 **1539 降至 1499** 并锁定新基线。

## 🧩 核心模块重构

- **Zed**：按 OpenAI、Google、Anthropic 通道拆分请求构建器。
- **Kiro**：提取请求归一化、工具上下文和 Claude 流内容块状态管理。
- **Provider Pool**：提取模型过滤/评分选点协作者与三级刷新调度器，保留重初始化后的状态访问契约。
- **Pipeline**：提取流重试上下文和协议终止事件处理，保持增量流、断开连接与重试收尾语义。
- Zed、Kiro 重构前后 golden 对比零差异；三组跨协议 golden stream 27 项全部通过。

## 🧪 验证结果

| 项目 | 结果 |
|---|---|
| `npm run verify` | **49 suites / 618 tests 全绿** |
| TypeScript strict / noUnusedLocals | **0 errors / 0 diagnostics** |
| imports / cycles / any 棘轮 / 覆盖率门槛 | **全部通过** |
| 真实 Node 启动与 `/health` smoke | **通过** |
| clean checkout 覆盖率 | **行 32.88% / 分支 33.41% / 函数 36.20%** |
| GitHub Actions（Node 22.x / 24.x） | **通过** |

### 真实上游 E2E

- **18 个模型 × 11 项核心用例 = 198 项全部通过**。
- **6 项通用定向契约全部通过**：强制 tool_choice、多模态、4xx 错误细节、三下游流式工具生命周期、Responses→Gemini developer/text.format、仅 system/developer 本地 400。
- **4 项 provider 方言 canary 全部通过**：Zed Gemini 工具历史、非法 tool id 清洗、Gemini thinking 回退、max_tokens 截断。
- 部分模型仅出现文档允许的非阻塞 reasoning/thinking 提示，不影响确定性断言。

## 🚀 性能基准

测试模型：`openai-custom:glm-5.3`；每种模式 20 个请求、并发 3、单请求超时 60 秒。

| 模式 | 成功率 | 总耗时 | 吞吐量 | 平均延迟 | P50 | P90 | P95 | P99 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 非流式 | 20/20（100%） | 9388 ms | 2.13 req/s | 1378.65 ms | 1291 ms | 1664 ms | 1720 ms | 2130 ms |
| 流式 | 20/20（100%） | 12153 ms | 1.65 req/s | 1764.30 ms | 1638 ms | 2064 ms | 2120 ms | 2830 ms |

> 延迟包含真实上游网络与模型生成时间，以上数据用于记录当前版本的实测表现，不作为与 v5.0.5 的严格对比基准。

## 📦 兼容性

- 运行要求保持不变：Node.js `^22.18.0 || >=23.6.0`。
- 无 API、配置、数据格式或插件公共契约变更。
- 无 provider 增删；无需配置迁移。

## ⬆️ 升级建议

- 源码：

  ```bash
  git fetch --tags
  git checkout v5.0.6
  npm install
  npm start
  ```

- Docker：本次发布工作流未检测到 Docker Hub 凭据，镜像构建与推送已按现有流程跳过。需要 Docker 部署时，请先在仓库 secrets 中配置 `DOCKERHUB_USERNAME` 和 `DOCKERHUB_TOKEN`，再手动运行“发布版本与构建 Docker 镜像”工作流。
