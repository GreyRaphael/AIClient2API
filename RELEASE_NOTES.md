# AIClient-2-API 发布说明 (v5.3.0)

> **v5.3.0** 是 v5.2.0 之后的安全加固与 WebUI 精修版本，**建议所有 v5.2.0 用户升级**。
>
> 本版本修复了一个可无密码读取全部明文密钥的鉴权绕过，以及 UI 请求可能永久挂起、明文密钥被写入可编辑缓冲等问题；同时新增按需回读明文的接口、Antigravity / Zed 客户端版本字段，并下掉使用指南页与客户端配置片段卡片。后端 API、Hash 路由、localStorage 键与插件静态路径保持兼容。

---

## 🎨 WebUI 无构建重构

- **技术栈**：Preact 11 + htm + `@preact/signals`，浏览器原生 ES Module + import map，无需 Vite/Webpack/JSX 编译。
- **目录统一**：新代码全部位于 `static/ui/`，第三方依赖入库到 `static/vendor/`，Font Awesome 使用本地子集（139 icons）。
- **页面迁移**：
  - 控制台 10 个页面：dashboard / access / config / providers / custom-models / upload-config / usage / plugins / playground / logs（使用指南页已移除）。
  - 独立页面：login、potluck、potluck-user、model-usage-stats。
- **基础能力统一**：`Modal` / `ConfirmDialog` / `Pagination` / `Toast`、`useApi` / `useEvent` / `useInterval`、统一 API 客户端与 SSE 连接。
- **i18n**：拆分为 `locales/zh-CN.js` 与 `locales/en-US.js`，`en-US` 按需加载；移除 `data-i18n` 全页扫描与 `MutationObserver`。
- **清理**：删除旧 `static/app/*.js`、`static/components/*.html`；全站 `window.*` 顶层赋值与内联 `onclick=` 清零。
- **样式**：CSS 仅移动到 `static/ui/styles/`，未做大规模重写，以降低视觉回归风险。

## 🔐 Kiro AWS 账号导入

- 恢复旧版 `aws-import` 认证入口。
- 支持 AWS SSO cache JSON 文件上传与多文件字段合并。
- 支持直接粘贴单个凭据对象或凭据数组（批量）。
- 自动校验 `clientId` / `clientSecret` / `accessToken` / `refreshToken`，并补齐 `authMethod: builder-id`。
- 提供敏感字段脱敏预览、重复凭据提示与批量 SSE 实时进度。
- 单条与批量均使用 `POST /api/kiro/import-aws-credentials`，成功后自动刷新提供商列表。

## 🛡️ 安全与稳定性

- **鉴权绕过修复（重要）**：`verifyToken` 此前直接以 `tokens[token]` 从 JSON.parse 结果取值，
  `Authorization: Bearer __proto__` / `constructor` / `toString` 会命中 `Object.prototype` 成员
  （真值、无 `expiryTime`，而 `Date.now() > undefined` 为假），从而无密码通过鉴权，可读取
  `/api/config/secret`、`/api/providers/:type/:uuid/secret` 的全部明文密钥并可增删提供商节点。
  现在 token store 归一化为无原型对象，并要求自身属性命中 + 过期时间为有限数字。
- **请求挂起修复**：UI 路由处理链未包 `try/catch`，非法百分号转义（`%E0%A4%A`）或
  `providerType=__proto__` 触发的异常会逃逸到 `unhandledRejection`，响应永不写回、客户端等到超时。
  现在统一兜住并回 500，非法百分号转义前置拒绝为 400。
- **明文回读加固**：两个回读接口仅返回白名单字段、响应带 `no-store` 禁止缓存、错误信息不回显调用方字段；
  前端仅编辑态可回读，展开期间输入框强制只读，避免明文被写入草稿缓冲后随保存落盘（会损坏凭据）。
- `sanitizeHtml()` 链接策略改为按 URL 协议校验：
  - 允许 `http(s)`、`mailto`、站内路径与锚点；
  - 拒绝 `//host`、`/\host`、`javascript:`、`data:`、`vbscript:` 等绕过方式；
  - 保留白名单标签，移除事件属性与未知属性。
- OAuth 授权继续使用「自动本地回调 + 手动粘贴回调 URL + `oauth_success`」方案，不依赖跨域子窗口轮询。
- 插件描述富文本继续使用白名单清洗后注入，链接强制 `target="_blank"` 与 `rel="noopener noreferrer"`。

## 🧹 兼容性与已知说明

- Hash 路由：`#dashboard`、`#access`、`#config`、`#providers`、`#custom-models`、`#upload-config`、`#usage`、`#plugins`、`#playground`、`#logs`；已移除 `#guide`（旧书签会回落仪表盘）。
- `localStorage` 键保持不变：`authToken`、`authTokenExpiry`、`language`、`theme`。
- 插件 `staticPaths` 保持不变：`potluck.html`、`potluck-user.html`、`model-usage-stats.html`。
- 后端 `/api/*` 接口与鉴权协议未改动，无需迁移配置。
- 最低浏览器版本：Chrome / Edge 105+、Firefox 121+、Safari 16.4+。
- 有意保留的取舍：CSS 未按页面合并重写；三个插件独立页仍保持中文文案；`upload-config` 保留 20 条/页的前端分页。

## 🧪 验证结果

| 项目 | 结果 |
|---|---|
| `npm test` | **72 suites / 852 tests 全绿** |
| WebUI E2E | **36/36 通过** |
| `npm run verify` | **通过**（typecheck / plugins / strict / any / imports / cycles / coverage / runtime smoke） |
| `npm run typecheck` | **通过** |
| `npm run typecheck:webui` | **通过** |
| `npm run vendor:webui:check` | **通过** |
| Font Awesome 子集 | **139 icons** |

E2E 覆盖登录、10 个控制台页面、中英/明暗切换、SSE 状态、Provider 节点 CRUD、授权弹窗、Kiro AWS 单条/批量导入、Playground 流式对话、插件页、日志页、登出，以及 4 个独立页面。

## 📦 升级建议

- 源码：

  ```bash
  git fetch --tags
  git checkout v5.3.0
  npm install
  npm start
  ```

- Docker：发布工作流在检测到 `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` 时会构建并推送 `5.3.0` 与 `latest` 镜像；未配置凭据时跳过，可稍后手动运行工作流。

- **升级后建议立即更换管理员密码与 `REQUIRED_API_KEY`**：v5.2.0 及更早版本存在鉴权绕过（`Bearer __proto__` 等可直接通过），若服务曾暴露在公网，历史密钥应视为已泄露。

- 升级后请重启服务并硬刷新 WebUI，以加载新的 `static/ui/` 模块与本地 Font Awesome 子集。

- 从 v5.2.0 升级无需修改配置；已有 Provider 池、插件配置与自定义模型配置继续可用。
