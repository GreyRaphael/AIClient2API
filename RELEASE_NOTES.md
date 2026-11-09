# AIClient-2API 发布说明 (v8.8.1)

> ## ✅ 无破坏性变更、无配置迁移
>
> 直接 `git pull && npm ci` 并重启服务即可。本次为针对 v8.8.0 后的**测试套件稳定性修复与基准测试工具校准**，不改变网关对外运行时核心行为。

---

## 一、变更重点

### 1. 修复前缀缓存基准测试（KV Cache Benchmark）

* **涉及文件**：`scripts/cache-hit-benchmark.mjs`
* **问题背景**：脚本首版构造的测试 prompt 长度仅 79–471 tokens，低于主流大模型上游 KV Cache 的最小可缓存门槛（Anthropic Sonnet/Opus 需 1024 tokens、Haiku 需 2048 tokens，OpenAI 需 1024 tokens）。导致基准测试每轮报告 0.00% 缓存命中率（或在设置 `--min-rate 0` 时形式化通过），未能起到真实门禁作用。
* **修复方案**：前置确定性生成的约 6000 字符（1500+ tokens）代码样本，保证跨轮会话前缀完全一致，真实触发上游 KV Cache。
* **实测验证**：
  * `claude-sonnet-5-5-medium`：稳态命中率 **99.0–99.2%**，总体 72.5%
  * trae `DeepSeek-V4.1-Flash`：稳态命中率 **98.2–99.1%**，总体 85.8%

### 2. 移除脆弱的一次性样式契约测试

* **涉及文件**：`tests/webui-e2e/style-contract.*`
* **原因分析**：
  * 计算样式契约（80 组合 / 1072 条断言 / 170KB 基线）是此前一次 1.2 万行 CSS 大重构时引入的一次性安全网，重构早已落地。
  * 作为长期回归测试时存在严重问题：断言依赖运行时数据状态（如 `.btn-primary` 依赖检测到 GitHub 有新版本，离线或 API 受阻时必败）；基线文件自相矛盾；捕获值多为透明背景，无法有效防范样式回归。
  * 仓库已有 26 个稳定的 Jest CSS 单元测试覆盖 CSS 变量、层叠顺序与作用域，且不依赖任何页面数据状态。
* **效果**：移除后 WebUI E2E 测试耗时从 5.5 分钟降至 1.6 分钟，消除了所有样式误报。

### 3. 修复 WebUI E2E 插件页 Mock 数据

* **涉及文件**：`tests/webui-e2e/smoke.spec.js`
* **修复内容**：更新 mock 数据中的模型 ID 为实际可用的 `gemini-3.8-flash-medium`，并补全默认视图所需的 `daily[date].models` 结构，消除因 mock 数据残缺导致的渲染异常。
* **效果**：WebUI E2E 从 42 passed / 9 failed 达到 **43 passed / 0 failed** 全通。

---

## 二、验证矩阵

- **静态与类型检查**：`typecheck` / `typecheck:plugins` / `typecheck:webui` / `check:strict` / `check:any` / `check:imports` / `check:cycles` / `lint:css` 全部通过
- **单元测试与覆盖率**：1042 tests 全部通过，覆盖率门槛 100% 达标
- **真实凭证 E2E 测试**：26 passed / 1 skipped
- **WebUI E2E**：**43 passed / 0 failed**（耗时 1.6 分钟）
- **前缀缓存基准**：稳态命中率 **98%~99%**

---

**完整变更明细**：见 [CHANGELOG.md](https://github.com/GreyRaphael/AIClient2API/blob/main/CHANGELOG.md)
