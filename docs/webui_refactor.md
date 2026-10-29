# WebUI 重构方案：Preact + htm（免构建）

> 状态：**已确认，实施中**（决策见 §13；进度见 §14）。
> 范围：`static/` 下管理控制台（`index.html` + `app/*` + `components/*`），以及 `login.html`、`potluck*.html`、`model-usage-stats.html` 三类独立页面。
> 后端 `src/ui-modules/*.ts` 的 `/api/*` 接口**不改动**（仅 `ui-manager.ts` 的静态文件服务有小幅调整，见 §9）。

---

## 1. 目标与非目标

### 目标
1. **保持免构建**：不引入 Vite/Webpack/Babel/JSX 编译，浏览器直接加载 ES Module；`git clone` 后 `npm start` 即可用。
2. **消除手写 DOM**：用声明式组件替换 `innerHTML = \`...\`` + `addEventListener` + `onclick=` + `window.xxx` 全局挂载。
3. **统一基础能力**：弹窗、Toast、表单、分页、i18n、API 客户端、SSE 只保留一份实现。
4. **渐进迁移**：每个阶段结束都是可发布状态；任何时刻新旧代码可共存，可单步回滚。
5. **保持外观不变**：沿用现有全局 CSS（不使用 Shadow DOM、不引入 CSS-in-JS），避免视觉回归。
6. **离线可用**：所有依赖（含 Font Awesome）本地化到 `static/vendor/`，不依赖 CDN。

### 非目标
- 不重写后端 API，不改鉴权协议（`Authorization: Bearer` + `/api/events?token=`）。
- 不在本次重构中重做视觉设计、不合并/重写 CSS（仅在 §10 列出后续可选项）。
- 不引入 TypeScript 编译产物；类型检查只通过 JSDoc + `tsc --checkJs`（不输出文件）。

---

## 2. 现状诊断（基于代码实测）

| 维度 | 现状 | 问题 |
|---|---|---|
| 规模 | `static/app/*.js` 约 **17.9k 行**；`components/*.html` 约 1.55k 行；CSS 约 240KB | 单文件过大：[`provider-manager.js`](file:///home/gewei/AIClient2API/static/app/provider-manager.js) 4302 行、[`modal.js`](file:///home/gewei/AIClient2API/static/app/modal.js) 2190 行、[`i18n.js`](file:///home/gewei/AIClient2API/static/app/i18n.js) 2060 行 |
| 渲染 | 约 168 处 `innerHTML`，273 处 `document.getElementById`，约 200 处 `addEventListener`/`onclick=` | 易丢事件/状态；手写 `escapeHtml`，遗漏即 XSS |
| 全局耦合 | [`app.js`](file:///home/gewei/AIClient2API/static/app/app.js) 挂载约 25 个 `window.*`；`modal.js` 19 个；`onclick="xxx()"` 约 40 处依赖这些全局 | 模块间通过全局互相调用，无法静态分析、无法 tree-shake、难测试 |
| 状态 | [`constants.js`](file:///home/gewei/AIClient2API/static/app/constants.js) 的 `let` 全局 + `setXxx()`；`elements` getter 按 id 取 DOM | 状态变化后需手动同步多处 DOM |
| 页面装配 | [`component-loader.js`](file:///home/gewei/AIClient2API/static/app/component-loader.js) `fetch` 11 个 section HTML；[`navigation.js`](file:///home/gewei/AIClient2API/static/app/navigation.js) 切 `.active` 类；`sectionLoaders` 回调 | 全量预加载；`app.js` 里 `componentsLoaded` / `DOMContentLoaded` 双入口判断 |
| i18n | 每个元素 `data-i18n*`，`MutationObserver` 监听整个 `body` 并重译；`t()` 用 `replace` 仅替换首个 `{param}` | 全页扫描；zh/en 两套共 ~1900 行同在一个文件、首屏全量加载 |
| 事件流 | [`event-stream.js`](file:///home/gewei/AIClient2API/static/app/event-stream.js) 事件：`log` / `provider` / `provider_update` / `config_update` / `oauth_success`；通过 `setProviderLoaders()` 等注入回调避免循环依赖 | 日志无上限地 append DOM；回调注入是循环依赖的补丁 |
| 外部依赖 | Font Awesome 6.4.0 走 `cdnjs`（`index.html`、`login.html`、`potluck*.html`、`model-usage-stats.html`） | 内网/离线环境图标缺失 |
| 测试 | 仅 `tests/frontend-provider-utils.test.js`、`tests/provider-registry-parity.test.js` 引用前端纯函数模块；Jest 为 `node` 环境，无 jsdom | 组件层零覆盖 |
| 静态服务 | [`ui-manager.ts`](file:///home/gewei/AIClient2API/src/services/ui-manager.ts) `serveStaticFiles`：MIME 表只有 html/css/js/png/jpg/svg/json/ico；文本资源统一 `no-store` | 缺 `.mjs`/`.woff2` MIME；vendor 文件每次都重下 |

### 必须保持不变的"契约"
- `static/app/provider-manager-utils.js`、`static/app/provider-registry.js` 被 Jest 直接 `import`，且 `provider-registry` 与后端 `src/providers/provider-registry.ts` 有 parity 测试。→ 这两个文件保持**纯 ESM、无 DOM 副作用**，迁移时仅 `git mv` 并同步改测试 import 路径。
- Hash 路由 `#dashboard / #access / #guide / #config / #providers / #custom-models / #upload-config / #usage / #plugins / #playground / #logs`（用户书签、文档可能引用）。
- `localStorage` 键：`authToken`、`authTokenExpiry`、`language`、主题键（见 `theme-switcher.js`）。
- 插件 `staticPaths`（`src/plugins/api-potluck`、`model-usage-stats`）指向 `static/potluck*.html`、`static/model-usage-stats.html`，文件路径不能变。

---

## 3. 技术选型与依赖锁定

| 包 | 版本（npm 实测 latest） | 用途 | 浏览器端文件（raw 大小） |
|---|---|---|---|
| `preact` | 11.1.0 | 组件/渲染 | `dist/preact.mjs` 12KB |
| `preact/hooks` | 同上 | `useState/useEffect/useRef…` | `hooks/dist/hooks.mjs` 3.6KB |
| `htm` | 3.1.1 | 标签模板 → `h()`，免 JSX 编译 | `dist/htm.mjs` 1.2KB |
| `@preact/signals` | 2.11.4 | 全局 store（细粒度响应式） | `dist/signals.mjs` 4.2KB |
| `@preact/signals-core` | 1.14.5 | signals 依赖 | `dist/signals-core.mjs` 5.7KB |
| `@fortawesome/fontawesome-free` | **6.7.2**（刻意停在 6.x） | 图标（现为 6.4.0 CDN；升到 7.x 可能有图标差异，故不升）。**只作为生成子集的源**，不直接入库 | 入库的是**子集产物** `fa-subset.css` + `fa-solid-subset.woff2` + `fa-brands-subset.woff2`（见下方“图标子集”） |

合计运行时 JS ≈ **27KB raw**（gzip 后更小），远小于现有 JS 体量。
> 说明：Preact 11 的 `package.json#exports` 中 `.` 与 `./hooks` 均指向 `.mjs`，`@preact/signals` 内部 `import ... from "preact" / "preact/hooks" / "@preact/signals-core"`，因此**必须用 import map 统一解析到同一份 Preact 实例**，不能使用 `htm/preact/standalone`（它自带另一份 Preact，会与 hooks/signals 冲突）。

### 依赖管理方式：devDependencies 为源，vendor 目录入库
- 在 `package.json` 的 `devDependencies` 新增上述包（**仅用于：锁版本、类型提示、同步 vendor、Jest SSR 测试**，运行时不依赖 `node_modules`）。
- 新增脚本 `scripts/sync-webui-vendor.mjs`：把需要的文件从 `node_modules` 复制到 `static/vendor/<name>@<version>/`（不改写内容、不带 `.map`）。命令：`npm run vendor:webui`。
- `static/vendor/` **提交入库**（用户部署无需 `npm install` 之外的步骤；Docker `COPY . .` 已覆盖）。
- 路径带版本号 → 可对 `/vendor/` 设置 `immutable` 强缓存，升级版本时 import map 变化即自动失效（`index.html` 本身 `no-store`）。

### 图标子集（已决策：减小体积）
- 旧标记 `<i class="fas fa-xxx">` 在 HTML 字符串/组件中大量使用（约 136 个 solid + 5 个 brands），因此**保持 class 写法不变**，仅缩小字体与 CSS。
- `scripts/subset-fontawesome.mjs`（dev 工具，需 `subset-font` devDependency，纯 JS/WASM，无需 Python）：
  1. 扫描 `static/**/*.{html,js,css}` 中出现的 `fa-[a-z0-9-]+` 字面量；
  2. 解析 FA 6.7.2 `all.min.css`，保留基础/工具类规则（`fa-spin`、`fa-fw` 等）与**已用图标**的字形规则，丢弃其余；
  3. 用 `subset-font` 按已用码点裁剪 `fa-solid-900` / `fa-brands-400` 为 woff2；
  4. 输出到 `static/vendor/fontawesome@6.7.2/`。
- 新增图标后需重新运行 `npm run vendor:fa`；Jest 测试 `fa-subset` 校验“代码中引用的每个 `fa-*` 都存在于子集 CSS”，防止漏跑导致图标缺失。
- 动态拼接的类名（如 `'fa-' + name`）扫描不到——约定图标类名必须以完整字面量出现在源码中。

### import map（`index.html`）
```html
<script type="importmap">
{
  "imports": {
    "preact": "/vendor/preact@11.1.0/preact.mjs",
    "preact/hooks": "/vendor/preact@11.1.0/hooks.mjs",
    "htm": "/vendor/htm@3.1.1/htm.mjs",
    "@preact/signals": "/vendor/signals@2.11.4/signals.mjs",
    "@preact/signals-core": "/vendor/signals-core@1.14.5/signals-core.mjs",
    "@ui/": "/ui/"
  }
}
</script>
```
- `@ui/` 前缀别名让深层目录不必写 `../../..`。
- import map 必须出现在任何 `<script type="module">` 之前。
- 现代浏览器要求：Chrome/Edge 89+、Firefox 108+、Safari 16.4+。管理控制台属于运维工具，可接受；需在 README 注明最低浏览器版本。

---

## 4. 目标目录结构

迁移期间新代码放 `static/ui/`，与旧 `static/app/` 并存，最后删除 `app/`。

```
static/
├── index.html                 # 极简外壳：importmap + <div id="app"> + modal/toast 根 + main.js
├── login.html                 # Phase 5 迁移
├── vendor/                    # 入库的第三方文件（带版本号目录）
│   ├── preact@11.1.0/ …
│   └── fontawesome@6.7.2/ {all.min.css, webfonts/}
├── ui/
│   ├── main.js                # 入口：鉴权 → 挂载 <App/> → 启动 SSE
│   ├── html.js                # export const html = htm.bind(h)
│   ├── app.js                 # <App/>：Header + Sidebar + 当前 Section
│   ├── sections.js            # section 注册表（id/图标/i18n key/懒加载入口）
│   ├── lib/
│   │   ├── api.js             # ApiClient（沿用 auth.js 行为）+ 错误码翻译
│   │   ├── auth.js            # token 存取、过期、logout
│   │   ├── i18n.js            # lang signal + t()；locales 懒加载
│   │   ├── router.js          # hash 路由（useRoute）
│   │   ├── theme.js           # 主题 signal（沿用 data-theme）
│   │   ├── format.js          # formatUptime/…（来自 utils.js）
│   │   ├── provider-registry.js        # ← 自 app/ 迁入（纯函数，Jest 引用）
│   │   └── provider-manager-utils.js   # ← 同上
│   ├── store/
│   │   ├── events.js          # 唯一 EventSource + 事件总线（on/off）+ connection signal
│   │   ├── system.js          # 系统信息、serviceMode、运行时长
│   │   ├── providers.js       # 提供商池、supportedProviders、统计
│   │   ├── logs.js            # entries(上限 N)、autoScroll
│   │   ├── config.js
│   │   ├── toast.js           # toasts signal 队列
│   │   └── modal.js           # 弹窗栈 signal
│   ├── hooks/
│   │   ├── useApi.js          # {data, loading, error, reload}，含并发去重
│   │   ├── useInterval.js
│   │   └── useEvent.js        # 订阅 store/events 事件，卸载自动取消
│   ├── components/            # 与业务无关的原子组件
│   │   ├── Icon.js  Button.js  Field.js  Switch.js  Badge.js
│   │   ├── Modal.js  ConfirmDialog.js  Toast.js  Pagination.js
│   │   ├── CopyButton.js  Spinner.js  EmptyState.js  CodeBlock.js
│   ├── layout/
│   │   ├── Header.js  Sidebar.js  LegacySection.js   # 过渡适配器，Phase 6 删除
│   ├── sections/              # 每个页面一个目录/文件
│   │   ├── logs.js  plugins.js  guide.js  access/  dashboard/
│   │   ├── config/  upload-config/  usage/  custom-models/  playground/
│   │   └── providers/         # 最重：见 §7.4
│   └── locales/
│       ├── zh-CN.js   en-US.js        # 拆自 app/i18n.js（扁平 key 不变）
├── app/                       # 旧代码，逐步删除（最终只保留被 Jest 引用的文件→已迁至 ui/lib）
└── components/                # 旧 HTML 片段，随迁移删除；CSS 文件保留（样式不动）
```

命名约定：文件名 `kebab-case.js`，组件函数 `PascalCase`，store 导出 `signal` 对象；一个文件一个主要导出。

---

## 5. 核心基础层设计

### 5.1 `html.js`
```js
import { h } from 'preact';
import htm from 'htm';
export const html = htm.bind(h);
export { render, Fragment } from 'preact';
export { useState, useEffect, useRef, useMemo, useCallback } from 'preact/hooks';
```
统一再导出，业务文件只写 `import { html, useState } from '@ui/html.js'`。

htm 书写规则（写进开发约定）：
- 组件：`<${Modal} title=${x}>…<//>`；props 展开 `...${props}`；列表必须带 `key`。
- 事件 `onClick` / `onInput` / `onChange`；`class` 可直接用（Preact 兼容），不必 `className`。
- 受控表单：`value=${v}` + `onInput=${e => set(e.currentTarget.value)}`；复选框用 `checked`。
- **默认转义**；确需注入受信 HTML（如带 `<a>` 的赞助商 i18n 文案 `data-i18n-html`）才用 `dangerouslySetInnerHTML=${{__html: t(key)}}`，且仅限 i18n 字典内容，**不得用于接口返回数据**。

### 5.2 `lib/api.js`（直接继承 `auth.js` 中 `ApiClient` 的全部行为）
保留项（来自 [`auth.js`](file:///home/gewei/AIClient2API/static/app/auth.js)）：
- Bearer 头、401 → 清 token 并跳转 `/login.html`；
- 非 2xx 时优先用 `data.error.messageCode` / `data.messageCode` 做 i18n 翻译，其次 `message`；
- 同一 GET URL 并发请求去重（`inflightGetRequests`）；
- JSON/text 自动判断。

新增项：`signal`（`AbortController`）支持，供 `useApi` 在组件卸载时取消；`postForm()` 封装 `FormData` 上传（现有 `fetch('/api/plugins/upload')`、批量导入等散落的裸 `fetch` 统一走这里，自动带 token）。
> 现有约 20 处裸 `fetch('/api/...')`（usage、upload-configs download、kiro/codex/gemini 批量导入、restart-service 等）逐步收敛到 `api.*`，避免漏带 token / 漏处理 401。`/v1/images/*` 属于模型接口（Playground 用），保留独立 `fetch`，但封装在 playground 自己的 service 里。

### 5.3 `lib/i18n.js`（兼容旧 API，同时让组件自动重渲染）
```js
import { signal } from '@preact/signals';
export const lang = signal(localStorage.getItem('language') || 'zh-CN');
const dict = { 'zh-CN': null, 'en-US': null };           // 懒加载
export async function setLanguage(l) {
  dict[l] ??= (await import(`@ui/locales/${l}.js`)).default;
  lang.value = l; localStorage.setItem('language', l);
  document.documentElement.lang = l;
}
export function t(key, params) {
  const l = lang.value;                                  // 在组件渲染中读取 signal ⇒ 自动订阅
  let s = dict[l]?.[key] ?? dict['zh-CN']?.[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, v);   // 修复：旧实现只替换首个
  return s;
}
```
- 组件里直接 `t('nav.dashboard')`，切换语言时所有读取过 `lang.value` 的组件自动重渲染，**不再需要 `data-i18n*` 属性、`MutationObserver`、`languageChanged` 事件**。
- `zh-CN` 同步预加载（首屏必需且是回退语言），`en-US` 在选择时动态 `import()`。
- 迁移期桥接：`static/app/i18n.js` 的 `t`/`setLanguage`/`getCurrentLanguage` 改为转发到 `ui/lib/i18n.js`（旧模块不用改调用点），旧的 DOM 扫描逻辑保留到最后一个 `data-i18n` 消失（`grep -r "data-i18n" static` 为 0）再删除。
- 仪表盘赞助商图片随语言切换（旧 `updateDashboardImages`）→ 在组件内用 `lang.value` 选 `src`。
- 新增 Jest 测试：zh-CN 与 en-US key 集合一致、无空值、`{param}` 占位符一致。

### 5.4 `store/events.js`：唯一 SSE 连接，取代回调注入
```js
import { signal } from '@preact/signals';
export const connection = signal('connecting');          // 'connecting' | 'connected' | 'disconnected'
const handlers = new Map();                              // eventName -> Set<fn>
export const on = (name, fn) => { /* 返回 off() */ };
export function startEvents(token) {
  const es = new EventSource(token ? `/api/events?token=${encodeURIComponent(token)}` : '/api/events');
  es.onopen  = () => (connection.value = 'connected');
  es.onerror = () => (connection.value = 'disconnected');   // EventSource 自带重连
  for (const name of ['log','provider','provider_update','config_update','oauth_success'])
    es.addEventListener(name, e => handlers.get(name)?.forEach(fn => fn(JSON.parse(e.data))));
}
```
- 彻底取代 `setProviderLoaders()/setConfigLoaders()` 这类注入：谁关心谁 `useEvent('provider_update', fn)`。
- `logs` store 订阅 `log` 事件，`entries` 设上限（建议 2000 条，超出丢弃最旧）——旧实现无限 append DOM。
- `oauth_success` 目前转成 `window` 自定义事件 `oauth_success_event`；迁移后授权向导直接 `useEvent('oauth_success', …)`，过渡期保留 `window.dispatchEvent` 以兼容未迁移代码。
- 注意：`/api/events` 的 `token` 在 URL 中是现有契约，保持不变。

### 5.5 统一的 UI 原语
- **`Modal`**：渲染到 `#modal-root`（`index.html` 预留），内置 ESC 关闭、遮罩点击、焦点回收、`aria-modal`、滚动锁；props：`title`、`onClose`、`size`、`footer`。替代 `provider-manager.js`/`modal.js`/`custom-models-manager.js` 里各自拼的弹窗 HTML（`modal.js` 的 `.provider-modal` 等 CSS 类名保留，复用现有样式）。
- **`ConfirmDialog` / `confirm()`**：返回 Promise 的 `await confirmDialog({title, message, danger})`，替换原生 `window.confirm`（如 `index.html` 中登出确认、重载/重启确认）。
- **`Toast`**：`toast.success/error/info(title, msg)`；`store/toast.js` 维护队列；旧 `utils.showToast(title, message, type)` 改为转发到该 store，保证新旧共存期间只有一个 Toast 容器。
- **`Field`**：label + 控件 + 描述 + 错误；`config` 页 100+ 个表单项（`section-config.html` 有 104 个 i18n 标记）用"字段声明数组 + `<Field>` 循环渲染"代替 423 行手写 HTML。
- **`useApi(fn, deps)`**：`{data, loading, error, reload}`，卸载自动 `abort`。
- 复用既有 CSS 类：`btn btn-primary/secondary/danger`、`stats-grid`、`stat-card`、`.section`、`.nav-item`、`.modal*` 等，**组件内部使用与旧 DOM 相同的 class 与层级**，样式零改动。

### 5.6 路由 `lib/router.js`
```js
export const route = signal(location.hash.slice(1) || 'dashboard');
addEventListener('hashchange', () => (route.value = location.hash.slice(1) || 'dashboard'));
export const navigate = id => (location.hash = id);
```
- 沿用 hash 路由；未知 id 回落 `dashboard`（旧 `activateSection` 对未知 id 是直接忽略）。
- 切换页面时**卸载上一个 Section、挂载新 Section**；需要跨页保留的状态（日志缓冲、Playground 会话、提供商列表）放 `store/*`，而不是组件内 `useState`。
- Section 通过 `import()` 懒加载（`sections.js` 注册表里 `load: () => import('@ui/sections/logs.js')`），首屏只加载 Dashboard 相关代码。

### 5.7 类型检查（不引入编译）
- 新增 `tsconfig.webui.json`：`allowJs/checkJs/noEmit`，`lib: ["ES2022","DOM","DOM.Iterable"]`，`moduleResolution: "Bundler"`，`paths: {"@ui/*": ["static/ui/*"]}`，`include: ["static/ui/**/*.js"]`；脚本 `npm run typecheck:webui`（与现有 `typecheck`、`typecheck:plugins` 并列，**不放进 `npm test`**，先作为参考告警，稳定后纳入 CI）。
- 约定：组件 props、store 数据用 JSDoc `@typedef` 标注；接口返回类型可 `@import` 后端 `src/ui-modules/*.ts` 的类型。
- 诚实限制：htm 模板是字符串，**模板内的 props 不会被类型检查**；缓解方式是把逻辑放在带类型的 hooks/store/纯函数中，模板只做展示。
- 编辑器：推荐安装 `lit-plugin` 或 `es6-string-html` 获得 `html\`\`` 高亮（写入 `docs`/CONTRIBUTING 说明，不强制）。

---

## 6. 新旧共存（Strangler）策略

核心思路：**先换"外壳"（Header/Sidebar/路由），旧 Section 通过 `LegacySection` 适配器原样运行**，再逐个把 Section 换成组件。这样"装配方式"一次性现代化，之后每迁一个页面只是替换注册表里的一行。

### 6.1 `LegacySection` 适配器（Phase 1 引入，Phase 6 删除）
```js
export function LegacySection({ id, src, active, onActivate }) {
  const host = useRef();
  useEffect(() => {
    let alive = true;
    loadComponentHtml(src).then(markup => {            // 沿用 component-loader 的 fetch + 缓存
      if (!alive) return;
      host.current.innerHTML = markup;                 // 旧片段含 <link> 与 <section id class="section">
      legacyReady(id);                                 // 全部旧片段就绪后派发 'componentsLoaded'，触发旧 initApp
    });
    return () => { alive = false; };
  }, [src]);
  useEffect(() => {                                    // 取代旧 navigation.js 切换 .active
    host.current?.querySelector('section.section')?.classList.toggle('active', active);
    if (active) onActivate?.();                        // 取代旧 sectionLoaders[id]()
  }, [active]);
  return html`<div ref=${host} style="display:contents" />`;   // Preact 不接管其子节点
}
```
- 旧 `app.js` 的 `initApp()` 保持原样（仍监听 `componentsLoaded`），旧 manager 的 `initXxx()` 依然在 DOM 就绪后运行。
- `sections.js` 中未迁移项形如：`{ id:'usage', legacy:{ src:'components/section-usage.html', onActivate: loadUsagePageData } }`；已迁移项形如：`{ id:'logs', load: () => import('@ui/sections/logs.js') }`。

### 6.2 外壳接管时需要处理的 "DOM 接触点"（已核实）
| 旧代码 | 迁移方式 |
|---|---|
| `constants.js#elements.serverStatus` + `event-stream.js#updateServerStatus()` 直接改 DOM | 改为写 `connection` signal，`Header` 内 `<${StatusBadge}/>` 读取 |
| `elements.restartBtn` + `provider-manager.js#updateRestartButton(mode)` | `system.serviceMode` signal，`Header` 渲染重启按钮 |
| `elements.navItems/sections` + `navigation.js` | 删除；由 `Sidebar` + `route` signal 取代（保持 `nav-item active` class 与 `#id` href） |
| `app.js#initMobileMenu()` 手动切 `display` | `Header` 内 `useState(menuOpen)` |
| `index.html` 内联脚本（登出按钮、主题/语言初始化、`window.initAuth/logout`） | 收敛到 `main.js` 与 `Header` |
| `window.loadProviders` 等被 `onclick=` 字符串调用的全局 | 仍保留在 `window` 直到对应模板被迁移（见 §8 清单列），最终删除 |
| `language-switcher.js`、`theme-switcher.js` 操作按钮 DOM | 改为 `Header` 内组件 + `lang`/`theme` signal |

### 6.3 回滚
- 每个 Section 迁移为独立提交；`sections.js` 把该项改回 `legacy:{...}` 即可回滚（旧文件在对应 Phase 结束前不删除，**删除旧文件单独成提交**）。
- 整体回滚点：Phase 1 完成前 `git revert` 外壳提交即回到旧装配。

---

## 7. Section 迁移映射与设计要点

难度：⭐ 低 / ⭐⭐ 中 / ⭐⭐⭐ 高。行数来自当前仓库。

| Section | 旧代码（行） | 新结构 | 难度 | 设计要点 |
|---|---|---|---|---|
| `logs` | `event-stream.js` 日志部分 + `event-handlers.js` 清空/下载/自动滚动 + html 7 | `sections/logs.js` + `store/logs.js` | ⭐ | `entries` 封顶；`useEffect` 控制自动滚动；清空走 `/api/system/clear-log`，下载用现有接口；日志消息直接作为文本节点渲染（自动转义，无需 `escapeHtml`） |
| `guide` | html 59 | `sections/guide.js` | ⭐ | 纯展示；含 `data-i18n-html` 的富文本用 `dangerouslySetInnerHTML`（仅字典内容） |
| `plugins` | `plugin-manager.js` 443 + html 112 | `sections/plugins.js` | ⭐⭐ | 列表 + 开关 + 上传（`postForm`）；`togglePlugin` 的 `window` 挂载随之删除 |
| `access` | `access-manager.js` 625 + `routing-examples.js` 294 + html 153 | `sections/access/` | ⭐⭐ | API Key 展示/复制/生成（`generateApiKey`）、接入示例按当前 `location.origin` 生成；`CodeBlock` + `CopyButton` 复用 |
| `dashboard` | `provider-manager.js` 中 `loadSystemInfo/Update/Restart/时间显示`（约 600 行）+ html 244 | `sections/dashboard/`：`SystemInfo`、`ProviderStatusOverview`、`UpdatePanel`、`Sponsors`、`RoutingExamples` | ⭐⭐ | `useInterval` 取代 `setInterval`（时间 5s、系统信息 10s）；更新/降级/需重启提示改用 `ConfirmDialog`；`dashboard.update.*` 文案已齐全 |
| `config` | `config-manager.js` 673 + html 423 | `sections/config/` | ⭐⭐ | 字段声明数组驱动表单，按 provider 类型条件显示（来自 `utils.js#getProviderTypeFields` 的 361 行规则→迁为数据）；保存时只提交变更字段；`admin-password`、`reload-config` 沿用现有接口 |
| `upload-config` | `upload-config-manager.js` 1339 + `file-upload.js` 213 + html 62 | `sections/upload-config/` | ⭐⭐⭐ | 文件列表 + 过滤/分页 + 预览弹窗 + 批量删除/下载；订阅 `config_update` 事件自动刷新（替代 `setConfigLoaders`） |
| `usage` | `usage-manager.js` 704 | `sections/usage/` | ⭐⭐ | 按 provider 分组卡片；`refresh=true`、重置接口走 `api`；缓存逻辑保留 |
| `custom-models` | `custom-models-manager.js` 542 + html 140 | `sections/custom-models/` | ⭐⭐ | 表单弹窗 + 列表；`window.customModelsManager` 实例删除 |
| `playground` | `playground-manager.js` 1197 + html 149 | `sections/playground/` | ⭐⭐⭐ | 流式输出（`ReadableStream` 读取）放到独立 service；**会话/消息放 `store/playground.js`，切页不丢**；图片生成/编辑（`/v1/images/*`）、文件拖拽上传 |
| `providers` | `provider-manager.js` 4302 + `modal.js` 2190 + html 80 | `sections/providers/`（见下） | ⭐⭐⭐ | 工作量与风险最大，单独拆解 |

### 7.4 `providers`（最重）的拆分方案
`provider-manager.js` 中函数分布（节选，行号为当前文件）：
- 页面级：`renderProviders`(262–530)、`renderProviderStatusOverview`(531–632)、`updateProviderStatsDisplay`
- 授权向导：`showZedAuthSelector`、`showTraeAuthSelector`、`showCodexAuthMethodSelector`、`showKiroAuthMethodSelector`、`showGeminiAuthMethodSelector`、`showAuthModal`（3438–3892，约 450 行）
- 批量/外部导入：`showCodexBatchImportModal`(1209–1505)、`showCodexExternalImportModal`(1506–1761)、`showGeminiBatchImportModal`(1933–2227)、`showKiroBatchImportModal`(2228–2506)、`showKiroAwsImportModal`(2507–3360，约 850 行)
- 通用：`showSimplePrompt`、`showAddProviderGroupModal`

`modal.js`（提供商池管理弹窗）：列表分页/过滤、节点详情、编辑/取消/保存、新增表单（动态字段）、模型选择网格、健康检查、批量操作（重置健康、删除不健康、刷新 UUID）。

目标结构：
```
sections/providers/
├── index.js                  # 页面：统计卡片 + ProviderTypeCard 网格
├── ProviderTypeCard.js       # 单个 provider 类型卡片（含授权/注册/文档/添加分组按钮）
├── manager/                  # 原 modal.js
│   ├── ProviderManagerModal.js   # 搜索 + 分页 + 批量操作栏
│   ├── NodeRow.js                # 折叠详情
│   ├── NodeEditForm.js           # 编辑/新增共用（字段由 provider-registry 驱动）
│   ├── ModelSelection.js         # 模型勾选网格 + 汇总
│   └── useProviderNodes.js       # CRUD/健康检查/批量操作 hook（调用 /api/providers/*）
├── auth/
│   ├── AuthMethodPicker.js       # Zed/Trae/Codex/Kiro/Gemini 选择器：配置数组驱动，不再各写一份
│   ├── AuthUrlModal.js           # 授权链接 + 轮询/oauth_success + 手动回调(/oauth/manual-callback)
│   └── BatchImportModal.js       # 通用批量导入：{ provider, endpoint, placeholder, example, parse }
└── services.js                   # 与 UI 无关的请求拼装（可单测）
```
关键判断（需实施前先做的确认）：
1. **去重**：4 个 `Batch/External Import` 弹窗合计约 1700 行，结构大概率高度相似（输入框 + 示例 + 解析 + 提交 + 结果统计）。迁移第一步先做**逐段 diff**，若确认可参数化，则合并为一个 `BatchImportModal` + 4 份配置；若差异较大再按 provider 拆。这是整个重构里**行数缩减最大的点**。
2. **字段驱动**：新增/编辑表单字段来自 `provider-registry.js` 与 `utils.js#getProviderTypeFields`，迁为数据后 `NodeEditForm` 无 provider 分支。
3. **弹窗层级**：授权向导、批量导入、`AuthUrlModal` 可能叠加在 `ProviderManagerModal` 之上 → `store/modal.js` 用栈结构，`Modal` 带 `z-index` 递增。
4. **SSE 联动**：旧逻辑"若当前打开的弹窗就是该 providerType 则刷新弹窗，否则刷新主列表"→ `useEvent('provider_update')` 在 `useProviderNodes` 中以 `providerType` 过滤。
5. 实施顺序：`ProviderTypeCard`/页面 → `useProviderNodes` + `ProviderManagerModal` → `AuthUrlModal` → `AuthMethodPicker` → `BatchImportModal`，每步合入后保持旧入口可用（旧 `window.*` 全局在对应调用点替换完才删）。

### 7.5 独立页面
| 页面 | 现状 | 方案 |
|---|---|---|
| `login.html`（385 行） | 内联 `<script type="module">` + CDN FA | Phase 5 迁为 `ui/login.js`，复用 `lib/api.js`、`lib/i18n.js`、`lib/theme.js`（登录成功写 `authToken`/`authTokenExpiry`，保持 7 天"记住我"逻辑） |
| `potluck.html`（1397）、`potluck-user.html`（908）、`model-usage-stats.html`（1291） | 由插件 `staticPaths` 提供，内联脚本，各自实现主题/语言/请求 | **已决策纳入**，安排在 Phase 5（主应用稳定之后）。先做 FA 子集、主题/语言/api 复用 `ui/lib/*`，再将页面渲染迁为 Preact（入口 `ui/pages/*.js`）；**HTML 文件路径不变**（保持为极简外壳），插件 `staticPaths` 无需改动 |

---

## 8. 分阶段计划与验收标准

> 工作量为粗略估计（单人、含 AI 辅助），用于排期参考，非承诺。

### Phase 0 — 基础设施（≈1 天）
- 新增 devDependencies（含 `@playwright/test`、`subset-font`）；`scripts/sync-webui-vendor.mjs`、`scripts/subset-fontawesome.mjs`；生成并提交 `static/vendor/`（Font Awesome 为子集产物）。
- Playwright 配置与首个冒烟用例（旧 UI 基线：登录页/主页加载、11 个 hash 页面可切换、无 console error），作为后续每个 Phase 的回归网。
- `index.html` 增加 import map；`ui/html.js`、`ui/lib/{api,auth,i18n,router,theme}.js` 骨架（先**复用**旧模块行为，不改旧调用点）。
- `ui-manager.ts`：MIME / 缓存头调整（§9）。
- `tsconfig.webui.json` + `typecheck:webui`；Jest 增加 `moduleNameMapper`：`@ui/(.*)` → `static/ui/$1`，`preact`/`htm`/`@preact/signals` → `node_modules`，并新增 `preact-render-to-string`(dev) 用于组件 SSR 冒烟测试。
- **验收**：`npm test` 全绿；打开现有页面无变化；浏览器访问 `/vendor/...mjs` 返回 `text/javascript`。

### Phase 1 — 外壳 + 适配器（≈2 天）
- 实现 `App/Header/Sidebar/StatusBadge/LanguageSwitcher/ThemeToggle`、`router`、`LegacySection`、`Toast`（并让 `utils.showToast` 转发）、`store/events`。
- `index.html` 精简为外壳；11 个 section 全部以 `LegacySection` 挂载；`component-loader.js` 缩减为 `loadComponentHtml`；删除 `navigation.js`、`language-switcher.js`、`theme-switcher.js`。
- **验收（手动清单）**：11 个页面可切换且 `#hash` 直达有效；中英切换、明暗主题切换正常；SSE 状态徽标随断开/重连变化；重启/重载/登出可用；移动端菜单可用；刷新后停留在当前 hash；所有旧功能与迁移前一致。

### Phase 2 — 简单页面（≈2–3 天）
`logs` → `guide` → `plugins` → `access`。同步建立并沉淀 `Field/Switch/CodeBlock/CopyButton/Spinner` 等原子组件，验证 `useApi/useEvent` 模式。
- **验收**：各页面功能对等；对应旧 manager 文件与 html 片段删除；新增组件 SSR 冒烟测试；i18n key 对等测试上线。

### Phase 3 — 中等页面（≈5–7 天）
`dashboard` → `config` → `usage` → `custom-models` → `upload-config`。重点沉淀 `Modal/ConfirmDialog/Pagination` 并替换对应 `window.confirm`。
- **验收**：对应 `window.*` 与 `onclick=` 清零；`config` 保存、`upload-config` 批量操作、更新/重启流程回归通过。

### Phase 4 — 重型页面（≈8–12 天）
`playground` → `providers`（按 §7.4 顺序拆成多个 PR）。
- **验收**：授权（OAuth 生成链接→回调→`oauth_success`）、批量导入（Kiro/Codex/Gemini）、节点增删改查、健康检查、模型刷新、流式 Playground 全部回归；`provider-manager.js`、`modal.js` 删除。

### Phase 5 — i18n 拆分与独立页面（≈3 天）
- 拆 `i18n.js` → `locales/zh-CN.js`、`en-US.js`，`en-US` 懒加载；移除 `MutationObserver` 与 `data-i18n` 扫描（前置条件：`grep -r "data-i18n" static` 为 0）。
- `login.html` 迁移；`potluck.html`、`potluck-user.html`、`model-usage-stats.html` 迁为 `ui/pages/*.js`（HTML 保留为外壳），复用 `ui/lib/*` 与原子组件。

### Phase 6 — 清理（≈1 天）
- 删除 `LegacySection`、`static/app/*`（`provider-registry.js`/`provider-manager-utils.js` 已迁至 `ui/lib/`，同步修改两个 Jest 测试的 import）、旧 `components/*.html`；`components/*.css` 按需并入 `ui/` 对应目录（仅移动，不改样式）。
- 确认 `window.*` 全局仅剩调试用途或清零；`CHANGELOG.md` / README（浏览器要求、开发约定）更新。

---

## 9. 后端静态服务调整（`src/services/ui-manager.ts#serveStaticFiles`）

| 项 | 现状 | 调整 |
|---|---|---|
| MIME | 缺 `.mjs`、`.woff2`、`.woff`、`.webp`、`.gif` | 增加：`.mjs → text/javascript`、`.woff2 → font/woff2`、`.woff → font/woff`、`.webp`、`.gif`。**缺 `.mjs` 的 JS MIME 会导致浏览器拒绝加载模块** |
| 缓存 | `.html/.css/.js/.json` 一律 `no-store`（为"无构建 + 即时生效"） | ① `/vendor/` 下带版本号文件：`Cache-Control: public, max-age=31536000, immutable`；② 其余文本资源建议改 `no-cache` + `ETag`（再验证、命中 304），避免 80+ 个模块在远程访问时每次全量下载（可选，但强烈建议，因为模块数量会增加）；③ `index.html` 保持 `no-store` |
| 预加载 | 无 | `index.html` 中对 `main.js`、`app.js`、dashboard 入口加 `<link rel="modulepreload">` 缩短瀑布 |
| 路径安全 | `path.join(cwd, 'static', pathParam.replace('/static/',''))` | **需确认上游是否已规范化路径**（`api-server.js` 解析 URL 的方式）；若没有，增加 `resolved.startsWith(staticRoot + path.sep)` 校验防目录穿越。属于顺带发现的潜在问题，建议单独提交 |
| 插件静态路径 | 先查 `static/`，再查插件 | 不变 |

---

## 10. 测试与质量保障

1. **保留**：`frontend-provider-utils`、`provider-registry-parity` 两个现有测试（仅改 import 路径）。
2. **新增（Jest，node 环境，无需 jsdom）**：
   - `i18n-parity`：zh/en key 集合与占位符一致；`t()` 多占位符替换。
   - `ui-components-ssr`：用 `preact-render-to-string` 对原子组件与各 Section 的"纯展示部分"喂 fixture 渲染，断言不抛错、关键文本存在；**约束：组件模块 import 时不得访问 `window/document/localStorage`**（放到 `main.js` 或 effect 内）。
   - `webui-importmap`：解析 `index.html` 的 import map，断言每个目标文件存在、版本与 `package.json` 一致、`vendor` 无 `.map`。
   - `services`/`store` 纯逻辑（provider 请求拼装、批量导入解析、日志封顶、`useApi` 去重）。
3. **手动回归清单**：每个 Phase 的"验收"项即为清单；建议整理为 `docs/webui_regression_checklist.md` 并随迁移更新。
4. **E2E（已决策引入 Playwright）**：`@playwright/test` 作为 devDependency，配置见 `playwright.config.js`；不进入 `npm test`，单独 `npm run test:webui:e2e`。测试启动一个使用临时配置/临时目录的服务实例（不触碰用户真实 `configs/`），覆盖：登录 → 切换 11 个页面 → 无 console error / 无失败请求 → 中英与明暗切换 → SSE 状态徽标 → 各已迁移页面的关键交互。随每个 Phase 增量补充。
5. **CI 门槛**：`npm test` + `npm run typecheck`（现有）；`typecheck:webui` 先 warn 后 enforce。

---

## 11. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| `providers` 迁移体量大、行为细节多（OAuth、批量导入、动态字段） | 回归 | 拆 PR、先去重分析、保留旧入口到最后；逐流程手动回归 |
| i18n 在迁移期双轨 | 文案漏翻/不刷新 | 旧 `t` 转发到新 `t`；DOM 扫描器保留到最后；key parity 测试 |
| 全局 CSS 依赖旧 DOM 层级（如 `.section > h2`、`alignment.css` 的修正层） | 视觉回归 | 组件沿用同样 class 与层级；Phase 1 起逐页截图对比（明/暗 + 移动端） |
| htm 模板无类型/无编译期检查 | 笔误运行时才暴露 | SSR 冒烟测试覆盖渲染；逻辑下沉到带 JSDoc 的 hooks/store |
| Preact 11 为较新大版本，社区资料多基于 10.x | 兼容问题 | 只用稳定 API（hooks/signals）；版本锁定入库；import map 一处即可降级到 10.x（需同步 vendor 与 signals 版本） |
| `LegacySection` 与旧 `initApp` 时序（`componentsLoaded`） | 偶发初始化失败 | 适配器统一在"所有旧片段就绪"后派发一次事件；`initApp` 已有 `isAppInitialized` 幂等保护 |
| `no-store` + 模块数增多 → 远程访问慢 | 体验 | §9 的 ETag/`no-cache` 与 `modulepreload` |
| 浏览器兼容（import map） | 极旧浏览器不可用 | README 标明最低版本；运维工具场景可接受 |
| Font Awesome 本地化后体积（solid+brands woff2 约 250KB） | 首次加载 | `immutable` 强缓存；后续可选用图标子集（当前约 136 个 solid + 5 个 brands） |

---

## 12. 预期收益（估计，非承诺）

- 代码量：消除手写 DOM/事件绑定/重复弹窗与批量导入模板后，前端 JS 预计下降约 30–40%（主要来自 `provider-manager.js`/`modal.js`）。
- 安全：默认转义，淘汰 `escapeHtml` 手工调用与大部分 `innerHTML` 拼接。
- 可维护：全局 `window.*` 约 60 个 → 0；i18n 不再依赖全页扫描；日志不再无限增长 DOM。
- 性能：Section 按需 `import()`；`en-US` 字典懒加载；vendor 强缓存。
- 可部署：零构建、零 CDN，离线/内网可用。

---

## 13. 决策记录（已确认）

| # | 事项 | 决策 |
|---|---|---|
| 1 | 先做“外壳 + LegacySection” | **是** |
| 2 | Playwright E2E | **引入**（Phase 0 起） |
| 3 | `potluck*.html` / `model-usage-stats.html` | **纳入**（Phase 5，完整迁移渲染层） |
| 4 | 文本资源缓存 `no-store` → `no-cache + ETag` | **同意** |
| 5 | Font Awesome | **图标子集**，减小体积 |
| 6 | 新代码目录 | **`static/ui/`** |
| 7 | 最低浏览器 | **Chrome/Edge 89+、Firefox 108+、Safari 16.4+** |

## 14. 实施进度

| Phase | 状态 |
|---|---|
| 文档确认 | ✅ |
| Phase 0 基础设施 | ✅ |
| Phase 1 外壳 + 适配器 | ✅ |
| Phase 2 简单页面 | ✅ |
| Phase 3 中等页面 | ✅ |
| Phase 4 重型页面 | ✅ |
| Phase 5 i18n 拆分与独立页面 | ⏳ 下一步 |
| Phase 6 清理 | ⬜ |

### 14.1 实施记录

- **Phase 0（已完成）**
  - `scripts/sync-webui-vendor.mjs` / `scripts/subset-fontawesome.mjs` + `static/vendor/`（Preact 11.1.0、htm 3.1.1、signals、FA 6.7.2 子集）入库。
  - `ui-manager.ts#serveStaticFiles`：补齐 `.mjs`/字体 MIME、`/vendor/` immutable、其余文本 `no-cache + ETag`、static 根目录校验。
  - Playwright E2E（`tests/webui-e2e/`）在临时目录 + 独立端口启动隔离实例；`AICLIENT_NO_AUTO_OPEN=1`。
  - `tsconfig.webui.json` + `typecheck:webui`；Jest `@ui/` 映射与 preact/htm/signals 转换（`babel.config.cjs`）。
  - `index.html` import map、`ui/html.js` 与 `ui/lib/{api,auth,i18n,router,theme}.js` 骨架；Jest 新增 importmap、SSR、FA 子集、i18n parity 测试。
- **Phase 1（已完成）**
  - `static/ui/` 接管 Header / Sidebar / hash 路由 / SSE 连接 / Toast；迁移期旧片段通过 LegacySection 挂载。
  - 旧 `app.js` 保留未迁移模块初始化，外壳派发 `componentsLoaded` 后运行；页面数据加载延迟到旧初始化完成。
  - 删除 `static/app/navigation.js`；SSE 改为 `store/events.js` 单一连接；`utils.showToast` 转发到 `store/toast.js`。
  - 服务模式通过 `store/system.js#serviceMode` 同步，Header 的重启/重载按钮文案随模式与语言更新。
- **Phase 2（已完成）**
  - 新增原子组件 `Spinner/EmptyState/Switch/CopyButton/CodeBlock/Field` 与 hooks `useApi/useEvent/useInterval`；`provider-registry`、`provider-manager-utils` 提前迁入 `ui/lib/`。
  - `logs`：`store/logs.js`（2000 条封顶、autoScroll）+ `sections/logs.js`；旧日志 DOM/状态/绑定全部删除。
  - `guide`：`sections/guide.js` 纯展示，FAQ 中英切换由 signal 驱动。
  - `plugins`：列表/开关/卸载、市场/安装/更新、付费弹窗与 ZIP 上传；`sanitize.js` 清洗插件描述富文本；`plugin_update` 自动刷新。
  - `access`：接入信息、默认供应商、客户端片段（Markdown/ENV/JSON）、端点复制与 curl。
- **Phase 3（已完成）**
  - 新增 `Modal/ConfirmDialog/Pagination` 原语；原生 `confirm` 全部替换为 `confirmDialog()`。
  - `dashboard`：系统信息/运行时间、更新检查与降级、提供商状态概览、模型列表、赞助商。
  - `config`：字段声明驱动表单（基础/代理/治理/OAuth/健康检查/日志/高级）。
  - `usage`：分组/实例卡片、单实例/单 provider/全量刷新、Codex 额度重置、授权文件下载。
  - `custom-models`：表格、三态排序、启停、编辑/新增 Modal、删除确认。
  - `upload-config`：搜索/状态/提供商过滤、20 条分页、查看/下载/删除/强制过期/一键关联/批量关联/删除未关联/打包下载。
  - 对应旧 manager 文件与 HTML 片段全部删除；E2E 增至 16 个。
- **Phase 4（已完成）**
  - `playground`：会话与选择存入 `store/playground.js`（切页不丢）；chat/responses/messages 三协议、流式打字机、停止/重试/复制、图片生成/编辑、附件上传与 Markdown 渲染。
  - `providers`：统计卡片、搜索、provider 类型卡片、添加分组、授权入口；`ProviderManagerModal` 覆盖节点列表/卡片视图、分页/搜索、增删改、启停、单节点/批量健康检查、重置健康、刷新 UUID/模型、模型勾选与 OAuth 凭据上传。
  - 授权：`AuthDialog` 覆盖 Kiro/Codex/Gemini 认证方式选择、Zed 邮箱、Trae PAT、授权链接 + 手动回调、`oauth_success` 自动关闭刷新；Kiro/Codex/Gemini 批量导入与 Codex CPA/sub2api 外部导入（SSE 实时进度）。
  - 删除旧应用层：`app.js`、`provider-manager.js`、`modal.js`、`event-handlers.js`、`event-stream.js`、`file-upload.js`、`utils.js`、`auth.js`、`constants.js`、`image-zoom.js`、`component-loader.js`、`LegacySection.js` 及全部旧 HTML 片段。
  - Header 接管重启/重载；main 直接启动 SSE；`static/components/` 只剩 CSS。
  - 测试：新增 providers/playground 单测与节点 CRUD、授权弹窗、流式 Playground E2E；全量 E2E 19 个用例。

### 14.2 与计划的偏差（有意保留）

- `static/app/theme-switcher.js`、`language-switcher.js` **暂不删除**：`login.html`、`potluck-user.html`、`model-usage-stats.html` 仍直接 import，按计划在 Phase 5 迁移独立页面后再删除。
- `static/app/i18n.js` 兼容层保留：login 页仍使用 `data-i18n` DOM 扫描；Phase 5 拆分/迁移完成后删除。
- `static/components/*.css` 保留（样式不动）；旧 HTML 片段已全部删除。
- 授权链接弹窗改为「自动本地回调 + 手动粘贴回调 URL + `oauth_success` 事件」；不再轮询跨域子窗口 URL（浏览器安全限制下不可靠）。
- Kiro 的「AWS 凭据文件导入」（旧 `aws-import`）尚未迁移；其余认证方式与批量导入已覆盖。
- 插件描述属于插件/市场提供的富文本，旧实现直接 `innerHTML`。为保持链接可用且降低 XSS 风险，改用 `ui/lib/sanitize.js` 白名单清洗后注入（仅 br/a/code/strong/em/b/i，链接限 http(s)/站内/锚点/mailto 并强制 `noopener`）。
- `upload-config` 在计划外加了 20 条/页的前端分页，避免大量凭据文件时一次性渲染过长。

## 附录 A：迁移前后对照示例（日志页）

旧（`event-stream.js`，节选）：
```js
logEntry.innerHTML = `
  <span class="log-time">[${timeStr}]</span>
  <span class="${levelClass}">[${logData.level.toUpperCase()}]</span>
  <span class="log-message">${escapeHtml(logData.message)}</span>`;
elements.logsContainer.appendChild(logEntry);
if (autoScroll) elements.logsContainer.scrollTop = elements.logsContainer.scrollHeight;
```

新（`ui/sections/logs.js`，示意）：
```js
import { html, useEffect, useRef } from '@ui/html.js';
import { t } from '@ui/lib/i18n.js';
import { entries, autoScroll, clearLogs } from '@ui/store/logs.js';

export default function LogsSection() {
  const box = useRef();
  useEffect(() => {
    if (autoScroll.value) box.current.scrollTop = box.current.scrollHeight;
  }, [entries.value.length, autoScroll.value]);

  return html`
    <section id="logs" class="section active" aria-labelledby="logs-title">
      <h2 id="logs-title">${t('logs.title')}</h2>
      <div class="logs-controls">
        <button class="btn btn-danger" onClick=${clearLogs}>
          <i class="fas fa-trash" /> <span>${t('logs.clear')}</span>
        </button>
        <button class="btn btn-primary" onClick=${() => (autoScroll.value = !autoScroll.value)}>
          <i class="fas fa-arrow-down" />
          <span>${autoScroll.value ? t('logs.autoScroll.on') : t('logs.autoScroll.off')}</span>
        </button>
      </div>
      <div class="logs-container" ref=${box} role="log" aria-live="polite">
        ${entries.value.map(l => html`
          <div class="log-entry" key=${l.id}>
            <span class="log-time">[${new Date(l.timestamp).toLocaleTimeString()}]</span>
            <span class=${'log-level-' + l.level}>[${l.level.toUpperCase()}]</span>
            <span class="log-message">${l.message}</span>
          </div>`)}
      </div>
    </section>`;
}
```
要点：无 `getElementById`、无 `escapeHtml`、无手动同步 DOM；保持原 CSS class，样式零改动。

## 附录 B：`scripts/sync-webui-vendor.mjs` 复制清单（示意）

| 来源（`node_modules/…`） | 目标（`static/vendor/…`） |
|---|---|
| `preact/dist/preact.mjs` | `preact@11.1.0/preact.mjs` |
| `preact/hooks/dist/hooks.mjs` | `preact@11.1.0/hooks.mjs` |
| `htm/dist/htm.mjs` | `htm@3.1.1/htm.mjs` |
| `@preact/signals/dist/signals.mjs` | `signals@2.11.4/signals.mjs` |
| `@preact/signals-core/dist/signals-core.mjs` | `signals-core@1.14.5/signals-core.mjs` |
| `@fortawesome/fontawesome-free/css/all.min.css`、`webfonts/fa-solid-900.woff2`、`webfonts/fa-brands-400.woff2` | `fontawesome@6.7.2/…`（CSS 内 `url(../webfonts/…)` 相对路径保持不变，需一并复制 `webfonts/` 目录结构） |

脚本需：读取各包 `package.json#version` 生成目录名；`--check` 模式比对已入库文件与 `node_modules` 是否一致（供 `webui-importmap` 测试调用）。
