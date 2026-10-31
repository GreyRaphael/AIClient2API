# AIClient-2-API 发布说明 (v6.0.1)

> **v6.0.1** 是 v6.0.0 之后的**修复版本，建议所有 v6.0.0 用户升级**。
>
> 本版本修好了三处会让界面「看着正常、实际不能用」的问题：插件页里 `potluck` / `model-usage-stats` 等入口链接点不动、登录页与左上角 Logo 依赖原作者服务器、以及 README 里的品牌图片仍是原作者素材。**无破坏性变更，无需修改配置**。

---

## 🐞 本次修复

### 插件页的插件入口链接恢复了

插件描述里用相对路径指向自己的页面：

```html
API 大锅饭 - Key 管理和用量统计插件<br>管理端：<a href="potluck.html">potluck.html</a>
```

但 `sanitizeHtml` 的链接白名单只认三种：`#` 锚点、`/` 开头的绝对路径、`http(s)` / `mailto`。其余一律交给 `new URL(value)` 判断，而 `new URL('potluck.html')` 没有 base 时会**直接抛错**，于是落到 `catch { return false }`，`href` 被整个移除。

结果是：页面上的 `potluck.html`、`potluck-user.html`、`model-usage-stats.html` 三处文字还带着链接样式，**但点了没反应**——看着像链接，其实已经不是链接了。

修复方式不是给 `URL` 打补丁，而是显式处理同源相对路径，仍然拒绝这三类危险写法：

- 协议相对地址（`//evil.example`、`/\evil.example`）
- 含反斜杠的路径（Windows 风格绕过）
- 含 `..` 的路径穿越

`javascript:` / `data:` / `vbscript:` 等危险协议照旧拒绝。允许与拒绝两个方向都补了单元测试。

### 品牌图片不再依赖原作者服务器

登录页头像、主界面左上角 Logo、以及两个入口 HTML 的 favicon，此前都在引用：

```
https://src.hex2077.dev/logo/favicon.ico
```

这是原作者自己服务器上的文件。也就是说：**对方关站、或你的部署环境没有外网，这些图标就直接加载失败**（favicon 更是在浏览器标签页上空白）。

现在改为仓库内的本地 SVG：

| 文件 | 用途 |
|---|---|
| `static/assets/logo.svg` | 主界面左上角 Logo、favicon |
| `static/assets/user-avatar.svg` | 登录页头像 |
| `static/assets/qr-placeholder.svg` | README 赞助商二维码占位 |

`logo.svg` 的图形是**三路上游汇聚为单一输出**——正好对应项目在做的事：把 Antigravity / Codex / Kiro 等多个仅客户端可用的 API，统一成一个 OpenAI 兼容接口。配色沿用主题渐变（`#059669 → #6366f1`），缩到 24px 的 Header 尺寸依然清晰。

### README 品牌素材清理

- 头部图标：原作者卡通插画 `logo-mid.webp` → 新的 `logo.svg`
- 赞助商二维码：真实微信二维码图片 `wechat.png` → `qr-placeholder.svg`（虚线占位框，自带深色模式配色，GitHub 深色主题下不会看不见）
- 修正了「请扫描左侧微信二维码」的过时文案（左侧现在是占位图）
- 删除已无引用的 `logo-mid.webp`、`logo-mid0.webp`、`web.png`、`wechat.png`

## 🧹 顺手精简

- **Header 去掉两个原作者推广入口**：B 站「视频教程」与第三方「小卖部」，头部控件从 8 个减到 6 个（点 Star、连接状态、主题、语言、登出、重载），两套渐变胶囊按钮样式一并删除。
- **Font Awesome 子集**：139 → 137 个图标（`fa-video` 随推广链接失效），woff2 体积同步减小。
- **locale 词典**：743 → 741 条，中英始终保持逐条对齐。

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

## 🧹 仪表盘与控制台精简

- **更新面板**：删除版本下拉框（它有三个已确认缺陷：已是最新时下拉框显示空白、`(当前)` 标记永不出现、点击「检查更新」会覆盖用户已选版本）。现在只有两个按钮——**检查更新**（有更新时提示版本号）与 **立即更新**（有更新时才出现），点击即更新到 GitHub 最新版本。**不再支持选择或降级到历史版本**。
- **二维码占位**：联系方式与赞助卡片的四张二维码图片已删除，改为同尺寸（190×190，含响应式档位）内联 SVG 占位框，位置与尺寸不变，便于后续替换为真实二维码。
- **赞助商引导卡片**：「成为赞助商」卡片已删除——它只是在解释上方微信二维码的用法，属于自解释冗余。
- **模型列表**：「可用模型列表」的 `<details>` 折叠包装已删除（默认永远展开、折叠无实际意义），改为静态面板并保留标题。
- **自定义模型**：列表默认按第一列（ID）升序排序，不再依赖接口返回顺序；表头仍支持升序 → 降序 → 不排序三态循环。
- 顺带清理：3 个不可见的 `.qr-description` 节点、孤儿图片 `static/ip2node.png`、孤儿 CSS（`.optional-tag`、`.become-sponsor`、迁移遗留的折叠样式）与死 locale key（772 → 743 条，中英对齐）。

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
| `npm test` | **72 suites / 854 tests 全绿** |
| WebUI E2E | **42/42 通过** |
| `npm run verify` | **通过**（typecheck / plugins / strict / any / imports / cycles / coverage / runtime smoke） |
| `npm run typecheck` | **通过** |
| `npm run typecheck:webui` | **通过** |
| `npm run vendor:webui:check` | **通过** |
| Font Awesome 子集 | **137 icons** |

E2E 覆盖登录、10 个控制台页面、中英/明暗切换、SSE 状态、Provider 节点 CRUD、授权弹窗、Kiro AWS 单条/批量导入、Playground 流式对话、插件页、日志页、登出，以及 4 个独立页面。

## 📦 升级建议

- 源码：

  ```bash
  git fetch --tags
  git checkout v6.0.1
  npm install
  npm start
  ```

- Docker：发布工作流在检测到 `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` 时会构建并推送 `6.0.1` 与 `latest` 镜像；未配置凭据时跳过，可稍后手动运行工作流。

- **若你仍在使用 v5.2.0 或更早版本**：那些版本存在鉴权绕过（`Bearer __proto__` 等可直接通过），升级后请立即更换管理员密码与 `REQUIRED_API_KEY`，历史密钥应视为已泄露。

- 升级后请重启服务并硬刷新 WebUI，以加载新的 `static/ui/` 模块与本地 Font Awesome 子集。

- **从 v6.0.0 升级到 v6.0.1 无需任何操作**：本版本只修界面与品牌资源，不涉及配置、数据库或接口变更。升级后硬刷新一次浏览器即可看到新 Logo 与可点击的插件入口。
- 若你此前在 `configs/config.json` 里配过 `SYSTEM_PROMPT_FILE_PATH` / `SYSTEM_PROMPT_MODE` / `SYSTEM_PROMPT_REPLACEMENTS`，请在 v6.0.0 或更早版本时期按 v6.0.0 的说明清理这些字段——v6.0.1 不会读取它们，残留也不影响启动。
