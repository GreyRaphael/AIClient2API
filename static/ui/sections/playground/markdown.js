/** Playground 轻量 Markdown 渲染（迁移自 playground-manager.js）。 */

function escapeHtml(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function isSafeImageUrl(url) {
    return url.startsWith('data:image/') || /^https?:\/\//.test(url);
}

export function isSafeVideoUrl(url) {
    return /^https?:\/\/[^\s"'<>]+$/i.test(url)
        && /\.(mp4|webm|mov|m4v)(\?[^"'<>]*)?$/i.test(url);
}

export function renderVideoPlayer(url, label = 'Play Video') {
    if (!isSafeVideoUrl(url)) return '';
    return `<div class="pg-video-block"><video src="${url}" controls preload="metadata" playsinline></video><a href="${url}" target="_blank" rel="noopener noreferrer">${label || 'Play Video'}</a></div>`;
}

export function renderMarkdown(input) {
    let text = String(input ?? '');
    const blocks = [];

    text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
        const escaped = escapeHtml(code.trimEnd());
        const langAttr = lang ? ` class="language-${escapeHtml(lang)}"` : '';
        blocks.push(`<pre style="background:var(--bg-tertiary);padding:1rem;border-radius:8px;overflow-x:auto;margin:0.5rem 0"><code${langAttr}>${escaped}</code></pre>`);
        return `\x00BLOCK${blocks.length - 1}\x00`;
    });

    text = escapeHtml(text);

    text = text.replace(/`([^`]+)`/g, '<code style="background:var(--bg-tertiary);padding:0.1em 0.3em;border-radius:4px">$1</code>');
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/\*([^*]+)\*/g, '<em>$1</em>');

    const renderedVideos = new Set();
    text = text.replace(/\[!\[([^\]]*)\]\(([^)]+)\)\]\((https?:\/\/[^)]+)\)/g, (match, alt, thumbUrl, videoUrl) => {
        if (!isSafeVideoUrl(videoUrl)) return match;
        renderedVideos.add(videoUrl);
        return renderVideoPlayer(videoUrl, alt || 'Play Video');
    });

    text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (match, label, url) => {
        if (!isSafeVideoUrl(url)) return match;
        if (renderedVideos.has(url)) return '';
        renderedVideos.add(url);
        return renderVideoPlayer(url, label);
    });

    text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, url) => {
        if (!isSafeImageUrl(url)) return match;
        return `<img src="${url}" alt="${alt}" style="max-width:100%;border-radius:8px;margin:0.5rem 0;display:block">`;
    });
    text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

    text = text.replace(/\n/g, '<br>');

    text = text.replace(/\x00BLOCK(\d+)\x00/g, (_, index) => blocks[+index]);

    return text;
}
