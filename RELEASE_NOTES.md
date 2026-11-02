# AIClient-2-API 发布说明 (v6.2.0)

> **v6.2.0** 是 v6.1.0 之后的**架构规范与性能深化版本，建议所有用户升级**。
>
> 本版本在 v6.1.0 样式体系重构的基础上，进一步完成了 WebUI 第二轮「美观与简洁」深度收敛：
> 首屏传输量在 v6.1.0 的基础上再次大幅压降（仪表盘首屏 312.4 KB → 101.6 KB，降幅达 **67.5%**），
> 统一了设计尺度（密集 UI 字号收敛至 7 档、间距 2px 网格化、圆角全部令牌化），
> 并完成了密码输入、流式导入、文件下载等关键公共逻辑与组件的收敛。
> **无破坏性变更、无需修改配置、对外 API 零改动**。升级后硬刷新一次浏览器即可。

---

## ⚡ 性能与传输量深化

| 指标 | v6.1.0 | v6.2.0 | 优化幅度 |
|---|---|---|---|
| Dashboard 首屏资源传输量 | 312.4 KB | **101.6 KB** | **-67.5%** |
| 赞助商等图片资源体积 | 219.9 KB | **9.0 KB** | **-95.9%** |
| `static/` 静态目录总大小 | 1.8 MB | **1.3 MB** | **-27.8%** |
| `mobile.css` 移动端样式体积 | 29.6 KB | **17.9 KB** | **-39.5%** |
| 有效密集字号取值 | 39 种字面量 | **7 档权威值** | 尺度归一 |

---

## 🎨 一、设计尺度与样式体系收敛

1. **统一设计尺度令牌**：
   - 在 `base.css` 中引入 `--space-1` ~ `--space-20`（2px 网格基线）与 `--text-xs` ~ `--text-2xl`（7 档字号规范）。
   - 圆角全面对齐 `--radius-*` 语义令牌，淘汰裸像素字面量；字号与间距写法统一（px/rem 规范化）。
2. **共享原子类上收与跨模块解耦**：
   - 密码框（`.password-input-wrapper` / `.password-toggle`）与开关（`.toggle-switch` / `.toggle-slider`）收拢至 `shared.css` 权威定义。
   - 解除 `section-styles.js` 中各业务面板对 `section-config.css` 的跨模块隐式依赖。
3. **移动端规则回迁与各页面去重**：
   - 将 `mobile.css` 中只服务于特定业务 section 的响应式规则回迁至对应 `section-*.css`，全局 `mobile.css` 瘦身至 18 KB 以下。
   - `alignment.css` 剥离专有微调规则并回迁，仅保留全局对齐基准。
   - `plugin-shared.css` 统一作为 potluck、potluck-user 与 model-usage-stats 的共享样式底座，大幅消除独立页面 CSS 冗余。

---

## 🧩 二、公共组件与工具函数抽取

1. **通用密码输入组件 `PasswordInput`**：
   - 服务端仅下发打码值，仅在编辑态允许按需回读明文；明文展示期间输入框强制只读，收起时自动恢复脱敏，杜绝误保存明文风险。
   - 统一 `config/fields.js` 与 `ProviderManagerModal.js` 中的密码脱敏展示。
2. **流式批量导入统一封装 `streamBatchImport`**：
   - 统合 POST + SSE 流式批量导入协议，统一处理鉴权、401 自动跳转、非 2xx 错误 JSON 解析以及 progress / complete / error 事件。
   - 接入 `AuthDialog` 与 `KiroAwsImportModal`。
3. **文件下载封装 `downloadBlob`**：
   - 在 `lib/api.js` 中提供轻量安全的 Blob 下载辅助函数，消除各业务模块重复的 `<a>` 标签挂载与 URL revoke 样板代码。
4. **统计分布组件 `DistributionList` 升级**：
   - 支持自定义格式化与空状态插槽，在 `model-usage-stats.js` 中复用以淘汰重复的局部条形图实现。
5. **统一弹窗与脚手架规范**：
   - `plugins.js` 支付弹窗统一接入 `Modal` 组件；
   - `lib/page-boot.js` 收敛 4 份独立页面的启动挂载样板；
   - `lib/credential-api.js` 统一插件页面的凭据鉴权请求；
   - `store/toast.js` 提供 `toastError` 统一错误提示入口。

---

## 🛡️ 三、自动化护栏与测试覆盖

- **HTML 外壳单一真源**：新增 `scripts/webui-html-shell.mjs` 与 `scripts/gen-webui-html-head.mjs`，5 份 HTML 外壳的一致性纳入 CI 校验。
- **计算样式契约守护**：所有视觉/尺度变更经由全元素计算样式快照验证，并通过 `tests/webui-e2e/style-contract.json` 固化。
- **新增多项护栏测试**：`ui-static-assets`（图片尺寸与引用审计）、`webui-html-shell`（HTML 外壳与主题脚本位置）、`ui-design-scale`（设计尺度规范）、`ui-mobile-scope`（移动端体积与作用域）、`webui-api-client`、`webui-page-boot`、`webui-no-hardcoded-color`。
- **全量测试通过**：Jest 84 suites / 929 tests 全绿，`npm run verify` 全部通过。
