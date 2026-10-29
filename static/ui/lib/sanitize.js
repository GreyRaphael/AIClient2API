/**
 * 极小化 HTML 白名单清洗（仅用于插件描述这类需要保留链接的富文本）。
 *
 * 允许：br / a / code / strong / em / b / i
 * 链接仅允许 http(s)、站内绝对路径、锚点与 mailto，并强制 target=_blank + rel=noopener。
 * 其余标签降级为纯文本，属性全部移除。
 */
const ALLOWED_TAGS = new Set(['BR', 'A', 'CODE', 'STRONG', 'EM', 'B', 'I']);
const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/**
 * 判断链接是否安全：
 *  - 允许 http(s)、mailto、站内绝对路径（但拒绝 `//host` 与 `/\host`）和锚点；
 *  - 其余协议（javascript:、data:、vbscript: 等）一律拒绝。
 *
 * @param {string|undefined|null} href
 * @returns {boolean}
 */
export function isSafeHref(href) {
    const value = String(href ?? '').trim();
    if (!value) return false;
    if (value.startsWith('#')) return true;
    if (value.startsWith('/')) return !/^\/[/\\]/.test(value);
    try {
        return SAFE_PROTOCOLS.has(new URL(value).protocol);
    } catch {
        return false;
    }
}

/** @param {Node} node */
function cleanNode(node) {
    for (const child of [...node.childNodes]) {
        if (child.nodeType === 3) continue;
        if (child.nodeType !== 1) {
            child.remove();
            continue;
        }

        const element = /** @type {Element} */ (child);
        if (!ALLOWED_TAGS.has(element.tagName)) {
            element.replaceWith(document.createTextNode(element.textContent || ''));
            continue;
        }

        if (element.tagName === 'A') {
            const href = element.getAttribute('href') || '';
            if (isSafeHref(href)) {
                element.setAttribute('target', '_blank');
                element.setAttribute('rel', 'noopener noreferrer');
            } else {
                element.removeAttribute('href');
            }
            for (const attribute of [...element.attributes]) {
                if (!['href', 'target', 'rel'].includes(attribute.name)) {
                    element.removeAttribute(attribute.name);
                }
            }
        } else {
            for (const attribute of [...element.attributes]) {
                element.removeAttribute(attribute.name);
            }
        }
        cleanNode(element);
    }
}

/**
 * @param {string|undefined|null} input
 * @returns {string}
 */
export function sanitizeHtml(input) {
    const source = String(input ?? '');
    if (typeof document === 'undefined') {
        return source.replace(/<[^>]*>/g, '');
    }
    const template = document.createElement('template');
    template.innerHTML = source;
    cleanNode(template.content);
    return template.innerHTML;
}
