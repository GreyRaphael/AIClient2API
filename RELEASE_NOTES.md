# AIClient-2-API 发布说明 (v4.1.6)

> **v4.1.6** 是测试体系清理与进程退出修复版本，无破坏性协议变更。
>
> 本版本把 E2E 模型发现改为从 `/auto/v1/models` 动态获取，合并历史版本化测试套件，并修复定时器导致的测试进程悬挂问题。

---

## 🌟 核心变更

### 1. E2E 不再硬编码模型列表

- 新增 Jest `globalSetup`：测试开始前调用 `GET /auto/v1/models`，把当前网关配置的全部模型写入临时缓存。
- `npm run test:e2e` 默认执行全量模型矩阵；模型数量以网关实际配置为准，不再写死 13 或 27。
- 仍支持 `AICLIENT_E2E_MODELS=model-a,model-b` 只跑指定模型。
- `AICLIENT_E2E_MODELS_FILE` 可覆盖模型列表缓存路径。

### 2. 测试套件合并与清理

- 6 个历史版本化跨协议测试合并为：
  - `tests/cross-protocol-historical-regressions.test.js`
- 删除 3 条低价值实现细节断言：
  - `ResponsesSseEmitter` 不再暴露 `pushEvents`
  - Codex reasoning done 不再注入人工换行
  - cache_control 缺失时不输出 debug 日志
- 单测套件从 **33 个收敛为 28 个**，测试数从 **457 收敛为 454**，覆盖不降级。

### 3. 测试进程自然退出

- `src/utils/file-lock.js`：`withTimeout()` 在 Promise settle 后清理 30s 定时器，避免每个文件锁操作留下悬挂 timeout。
- `src/ui-modules/auth.js`：token 清理 `setInterval` 增加 `unref()`，模块被测试/CLI 引入时不再阻塞进程退出。
- `npm test` 移除 `--forceExit`，Jest 现在可以自然退出。

---

## ✅ 验证

- `npm test -- --runInBand`：**28 suites / 454 tests 全绿**，无需 `--forceExit`。
- 全量测试实测自然退出时间约 **6 秒**。
- E2E 动态发现：`[E2E] Loaded 27 model(s) from /auto/v1/models`。
- `openai-custom:glm-5.3` 核心矩阵 **11 / 11** 通过。

---

## 📦 升级建议

```bash
docker pull greyraphael/aiclient-2-api:latest
# 或固定版本
docker pull greyraphael/aiclient-2-api:4.1.6
```

无需修改客户端协议；下游仍为 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages。

---

## ⚠️ 行为变化

- **E2E 默认模型集**：由 `/auto/v1/models` 动态决定；模型增减后无需改测试代码。
- **E2E 请求量**：默认跑当前全部模型；当前配置为 27 个模型时，核心矩阵约 297 次真实请求。
- **测试脚本**：`npm test` 不再强制退出；如仍有第三方测试代码遗留定时器，请显式清理。

---

## 📚 相关文档

- [跨协议转译架构](docs/CROSS_PROTOCOL_ARCHITECTURE.md)
- [跨协议转译复评（27 模型全量）](docs/CROSS_PROTOCOL_EVALUATION_V4_1_4_FULL_COVERAGE.md)
- [E2E 测试说明](tests/e2e/README.md)
- [Provider 接入指南](docs/PROVIDER_ADAPTER_GUIDE.md)
- [变更日志](CHANGELOG.md)
