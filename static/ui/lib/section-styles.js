/**
 * 按需加载 section 专属样式。
 *
 * 控制台有 10 个 section，但用户一次只看一个。index.html 里原本一次性加载
 * 全部 10 份 section CSS（gzip 后约 29 KB，占首屏 CSS 的 63%），其中大部分
 * 在首屏根本用不到。
 *
 * **插入位置很重要**：控制台的层叠顺序按约定是
 *
 *   base → shared → 外壳组件 → 各 section 组件 → mobile.css → alignment.css
 *
 * 动态插入的 section 样式必须落在 mobile.css **之前**、外壳组件之后，
 * 否则会破坏两条既有约定：
 *  - 排在 mobile.css 之后 → 组件规则（同特异性、更晚）反过来压掉移动端媒体查询，
 *    390px 下 dashboard 的移动端样式会整体失效（这是实际踩过的坑）；
 *  - 排在 alignment.css 之后 → 反过来覆盖对齐修正层。
 * 所以取 mobile.css 作为插入锚点，找不到时再退回 alignment.css 之前。
 */

/**
 * section -> 需要加载的样式文件（相对 static 根）。
 *
 * 多数 section 只有一份 section-<id>.css，但有两类例外必须显式列出：
 *  - dashboard 有一个内部子组件（赞助商区块）单独一份；
 *  - access / plugins / config 之间有共享的表单原子样式（.password-input-wrapper、
 *    .toggle-slider 等），这些类在多个组件的 CSS 里各写了一份。这是 P2-2
 *    作用域化之前的历史遗留：只要一个 section 用到了别的 section 定义的原子类，
 *    就必须把那份样式也一起加载，否则会出现"样式缺失"。
 *
 * 这几个额外依赖是从实际 DOM 反查出来的（不是猜测）：
 *   access 的密码框 .password-input-wrapper 样式定义在 section-config.css
 *   plugins / custom-models 的开关 .toggle-slider 样式定义在 section-config.css
 */
const SECTION_STYLES = {
    dashboard: ['/ui/styles/components/section-dashboard.css', '/ui/styles/components/section-sponsors.css'],
    access: ['/ui/styles/components/section-access.css', '/ui/styles/components/section-config.css'],
    plugins: ['/ui/styles/components/section-plugins.css', '/ui/styles/components/section-config.css'],
    config: ['/ui/styles/components/section-config.css'],
    'custom-models': ['/ui/styles/components/section-custom-models.css', '/ui/styles/components/section-config.css'],
    providers: ['/ui/styles/components/section-providers.css', '/ui/styles/components/section-config.css'],
    'upload-config': ['/ui/styles/components/section-upload-config.css', '/ui/styles/components/section-config.css']
};

/** @param {string} sectionId */
function stylesFor(sectionId) {
    return SECTION_STYLES[sectionId] || [`/ui/styles/components/section-${sectionId}.css`];
}

/** 已请求过的 section 样式，避免重复插入（也避免同一份 CSS 反复触发下载） */
const loaded = new Set();

/** 进行中的插入，避免并发重复 */
const pending = new Map();

/** 层叠锚点：section 样式要插在这个文件之前（mobile.css 先，缺失时退回 alignment.css） */
function layerAnchor() {
    return /** @type {HTMLLinkElement|null} */ (
        document.querySelector('link[rel="stylesheet"][href*="mobile.css"]')
        || document.querySelector('link[rel="stylesheet"][href*="alignment.css"]')
    );
}

/** 把 section 样式插到 mobile.css 之前，保持移动端媒体查询与其后的修正层仍然最后生效 */
function insertLink(link) {
    const anchor = layerAnchor();
    if (anchor && anchor.parentNode) {
        anchor.parentNode.insertBefore(link, anchor);
        return;
    }
    document.head.appendChild(link);
}

/**
 * 确保某个 section 的样式已加载。
 * @param {string} sectionId
 * @returns {Promise<void>} 加载完成（或失败）后 resolve；样式不可用时静默降级
 */
export function loadSectionStyles(sectionId) {
    if (!sectionId || loaded.has(sectionId)) return Promise.resolve();
    const inFlight = pending.get(sectionId);
    if (inFlight) return inFlight;

    const hrefs = stylesFor(sectionId);

    const promise = Promise.all(hrefs.map((href) => new Promise((resolve) => {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = href;
        link.dataset.sectionStyle = sectionId;
        // load / error 都要 resolve：样式缺失不应该阻塞页面渲染
        link.addEventListener('load', resolve, { once: true });
        link.addEventListener('error', () => {
            console.warn(`[styles] 加载 section 样式失败: ${href}`);
            resolve();
        }, { once: true });
        insertLink(link);
    }))).then(() => {
        loaded.add(sectionId);
        pending.delete(sectionId);
    });

    pending.set(sectionId, promise);
    return promise;
}

/** 测试用：复位内部状态 */
export function __resetSectionStyles() {
    loaded.clear();
    pending.clear();
}