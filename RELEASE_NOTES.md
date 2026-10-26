# AIClient-2-API 发布说明 (v5.0.7)

> **v5.0.7** 是 v5.0.6 之后的 Zed 通道重构与稳定性版本。
>
> 本轮完成 Zed 单跳协议感知转换、模型元数据运行时注册表与磁盘缓存，移除 23 个模型的内置硬编码快照；同时修复健康检查空 500、禁用模型泄漏与未知模型被静态白名单误杀等问题。保持现有 API、配置与插件公共契约不变，无需强制迁移。

---

## 🧠 Zed 单跳协议重构

- 客户端协议直接转换到模型对应的上游原生协议，不再经过 Claude 中枢二次转换。
- 同构协议零转换直通；跨协议路径由 `ConverterFactory` 统一单跳回转。
- OpenAI Responses、Gemini 与 Anthropic 原生流式事件直接透传，保留 usage、cache token、工具调用与终止原因等原始语义。
- 非流式请求先聚合上游原生事件，再单跳转换为客户端协议，避免中间协议造成的信息丢失。

## 🗂️ 模型元数据运行时化

- 新增 `ZedModelRegistry`：每个 Zed 节点独立，按账号隔离模型元数据。
- 远端 `cloud.zed.dev/models` 成功后整体替换启用模型，并原子落盘到 `configs/zed-model-metadata-cache.json`。
- 冷启动同步读取最近一次成功快照；文件损坏、版本不匹配或账户切换时安全降级。
- 远端下架或 `is_disabled` 的模型不再出现在实例元数据与 `/v1/models`。
- 删除 23 条内置模型硬编码快照，协议路由改为稳定的模型族规则；新增同族模型无需改代码。

## 🛡️ 稳定性与兼容性修复

- **Zed 健康检查**：OpenAI Responses 通道实测 `max_tokens` 低于 16 会返回空 HTTP 500；Zed 健康检查改用最小可用预算 `16`，Kiro 保持 `1`，避免有额度节点被误判为不健康。
- **未知模型宽松降级**：严格思考档位校验与 `max_output_tokens` 裁剪仅在权威元数据存在时生效；新增模型/档位不再被本地白名单误杀。
- **类型检查**：修复 Zed 重构引入的 `request-pipeline` TypeScript 类型错误，`npm run typecheck` 恢复通过。
- **Trae 清理**：移除 `solo_work_lite` 节点选项与配置展示，思考模型过滤仅保留包含 `extra_high` 的通道；已有配置中的该选项会被忽略。

## 🧪 验证结果

| 项目 | 结果 |
|---|---|
| `npm run verify` | **50 suites / 626 tests 全绿** |
| TypeScript / plugins / strict | **全部通过** |
| imports / cycles / runtime smoke | **全部通过** |
| any 棘轮 / 覆盖率门槛 | **通过** |
| 真实上游全量 E2E | **18 个模型 × 11 项核心用例（198 项）全部通过** |
| 通用定向契约 | **6 项全部通过** |
| provider 方言 canary | **4 项全部通过** |
| Zed 健康检查 | **3 个有额度节点 PASSED**；3 个账号因 credits 耗尽返回 403（账号状态，非代码问题） |

### E2E 覆盖

- 18 个模型 × 11 项核心用例：Chat / Responses / Claude 三协议非流式与流式文本、单轮工具调用、多轮工具结果、连续同角色折叠、usage 不变量等。
- 6 项通用定向契约：强制 `tool_choice`、多模态图片、上游 4xx 细节、三下游协议流式工具生命周期、Responses→Gemini developer/text.format、仅 system/developer 本地 400。
- 4 项 provider 方言 canary：Zed Gemini 工具历史降级、非法 tool id 清洗、Gemini thinking 回退、`max_tokens` 截断不触发空响应重试。
- 部分模型仅出现文档允许的非阻塞 reasoning/thinking 提示，不影响确定性断言。

### 质量基线

- `DynamicPayload` references：**1525**。
- 总覆盖率：**行 33.49% / 分支 33.91% / 函数 37.24%**。
- 同步刷新 any 与覆盖率基线，使 CI 门槛与本版本真实状态一致。

## 📦 兼容性

- 运行要求保持不变：Node.js `^22.18.0 || >=23.6.0`。
- 无 API、数据格式或插件公共契约变更。
- 无 provider 增删；Zed 模型能力改为运行时发现，首次启动会自动拉取并缓存。
- Trae `solo_work_lite` 节点选项已移除；已有配置无需手工删除，但该选项不再生效。

## ⬆️ 升级建议

- 源码：

  ```bash
  git fetch --tags
  git checkout v5.0.7
  npm install
  npm start
  ```

- Docker：发布工作流在检测到 `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` 时会构建并推送 `5.0.7` 与 `latest` 镜像；未配置凭据时按现有流程跳过，可稍后手动运行“发布版本与构建 Docker 镜像”工作流。

- Zed 用户：首次启动会自动拉取最新模型元数据并写入本地缓存；如需清空缓存，删除 `configs/zed-model-metadata-cache.json` 后重启即可。
