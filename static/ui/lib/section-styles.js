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
 * 各 section 只有一份 section-<id>.css（由 stylesFor(sectionId) 按约定拼出）。
 * 跨 section 共享的表单原子（.form-group / .password-input-wrapper / .password-toggle /
 * .toggle-switch / .toggle-slider 等）已全部上收到 shared.css，无需再跨 section 引用。
 */
const SECTION_STYLES = {};

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
            resolve(undefined);
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