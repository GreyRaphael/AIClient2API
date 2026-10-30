# AIClient-2-API 发布说明 (v6.0.0)

> **v6.0.0** 是 v5.3.0 之后的**不兼容清理版本**：移除了 Fallback 机制与 System Prompt 配置两块功能，并把未知名模型的处理从「静默回退」改为「直接报错」，**升级前请阅读下方 Breaking Changes**。
>
> 同时本版本将项目归属统一为本仓库（`GreyRaphael/AIClient2API`），删除了仪表盘若干冗余元素（版本下拉框、二维码图片、赞助商引导卡片、无意义的折叠包装），并让自定义模型列表默认按 ID 升序展示。后端 API 路径、Hash 路由、`localStorage` 键与插件静态路径保持兼容。

---

## ⚠️ Breaking Changes（升级前必读）

### 移除 Fallback 机制

`providerFallbackChain`（跨类型回退链）、`modelFallbackMapping`（跨协议模型映射）与 `MODEL_FALLBACK_ENABLED` 开关已全部删除。

- `ProviderPoolManager` 只在请求指定的 provider 类型内选节点，不再跨类型回退；
- `acquireSlotWithFallback` / `selectProviderWithFallback` 保留方法名（调用方无需改动），但**恒返回 `isFallback: false`**，无可用节点时返回 `null`。

### 未知名模型现在直接报错

随开关移除，Kiro / Codex / Antigravity 遇到不在可用列表中的模型名会**抛出错误**，不再静默回退到默认模型。

此前模型名拼写错误会被静默吞掉，请求实际打到另一个模型上并计费——现在会立刻失败并暴露问题。如果你的客户端依赖过「写错名字也能跑通」的行为，需要修正模型名。

### 移除 System Prompt 配置

`SYSTEM_PROMPT_FILE_PATH`、`SYSTEM_PROMPT_MODE`、`SYSTEM_PROMPT_REPLACEMENTS` 及配置页对应 UI（文件路径、append/overwrite、多行编辑框、替换规则表）已删除。

- 请求不再被注入内置系统提示词；
- 附带移除一个真实副作用：此前**每个请求**都会把该请求的 system prompt 覆盖写入 `configs/fetch_system_prompt.txt`，属于持续磁盘写入。

### 仓库归属切换

项目以 `GreyRaphael/AIClient2API` 为准：README、FUNDING、`docker/docker-compose.yml` 与内置文档示例均已改指向本仓库与 `greyraphael/aiclient-2-api` 镜像。上游专属资源（Trendshift 徽标、原文档站）已移除。

### 升级操作

```bash
# 1) 备份配置
cp configs/config.json configs/config.json.bak

# 2) 删除已失效字段（残留会被忽略，不影响启动，但不再生效）
#    providerFallbackChain / modelFallbackMapping / MODEL_FALLBACK_ENABLED
#    SYSTEM_PROMPT_FILE_PATH / SYSTEM_PROMPT_MODE / SYSTEM_PROMPT_REPLACEMENTS

# 3) 更新代码后重启
git fetch --tags && git checkout v6.0.0
npm install && npm start
```

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
| `npm test` | **72 suites / 853 tests 全绿** |
| WebUI E2E | **38/38 通过** |
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
  git checkout v6.0.0
  npm install
  npm start
  ```

- Docker：发布工作流在检测到 `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` 时会构建并推送 `6.0.0` 与 `latest` 镜像；未配置凭据时跳过，可稍后手动运行工作流。

- **若你仍在使用 v5.2.0 或更早版本**：那些版本存在鉴权绕过（`Bearer __proto__` 等可直接通过），升级后请立即更换管理员密码与 `REQUIRED_API_KEY`，历史密钥应视为已泄露。

- 升级后请重启服务并硬刷新 WebUI，以加载新的 `static/ui/` 模块与本地 Font Awesome 子集。

- 从 v5.3.0 升级：删除上文列出的 6 个失效配置字段即可，Provider 池、插件配置与自定义模型配置继续可用。
- **请确认模型名拼写**：未知名模型现在会直接报错（此前会静默回退），受影响的自定义模型配置需修正。
