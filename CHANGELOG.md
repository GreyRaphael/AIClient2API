# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [v3.6.0] - 2026-10-01

### Added (新增)
- **Trae (SOLO) 深度提供商接入**：
  - 支持 WebUI OAuth 授权与 PAT (Personal Access Token) 凭据导入管理。
  - 支持自 `api.enterprise.trae.cn` 与 `trae-api-cn.mchost.guru` 动态拉取模型元数据。
  - 彻底去除对本地 `~/.trae/cli/models_cache.json` 静态文件的依赖。
  - 动态提取 `context_window`（自动激活上游 Max 档位，最高支持 1M / 1,000,000 Tokens）。
  - 动态提取 `max_tokens`（自动提取物理最大档位，最高支持 64,000 Tokens）。
  - 双向映射思考深度参数 `reasoning_effort`（`low`/`high`/`xhigh` $\leftrightarrow$ `light`/`high`/`extra_high`），并原生对齐 Kimi 模型默认 `xhigh` 思考配置。
  - 优雅过滤 `custom_` 企业自定义与外部映射模型，保障官方纯正底层技术 ID（如 `DeepSeek-V4-Pro-Official`）。
  - 完整支持 OpenAI 兼容工具调用 (Tool Call / Function Calling) 及其在 SSE 流式响应中的增量分片聚合。
  - 生产级多租户隔离架构：多账号凭据、通道映射与缓存完全隔离。
- **自动化测试**：
  - 新增完备的 Trae 单元测试套件 (`tests/trae-provider.test.js`)，9/9 测试通过。

### Changed (变更)
- 将上游空响应最大重试次数 `EMPTY_RESPONSE_MAX_RETRIES` 调整为 5 并支持面板动态配置。
- 模块文件命名重构：规范化命名以消除同名异构与单复数混淆。
- 跨协议数据流类型约束与轻量级守卫加固。

### Fixed (修复)
- 过滤 Gemini API 工具声明中 `enum` 属性出现的空字符串值，避免上游 400 校验错误。
- 修复 Antigravity 和 Gemini 账号用量查询错误显示为 Free 的问题。
- 修复全局刷新用量与 Antigravity 周配额显示异常。
- 清理项目中的废弃代码与冗余模块。
