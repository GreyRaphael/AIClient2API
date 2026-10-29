/** 二维码点击放大（迁移自旧版 image-zoom 模块）。 */
export function initImageZoom() {
    if (typeof document === 'undefined') return;
    const overlay = document.createElement('div');
    overlay.className = 'image-zoom-overlay';
    overlay.innerHTML = '<img src="" alt="Zoomed Image">';
    document.body.appendChild(overlay);
    const zoomedImg = overlay.querySelector('img');

    document.addEventListener('click', (event) => {
        const target = /** @type {HTMLElement} */ (event.target);
        if (target.classList?.contains('clickable-qr')) {
            zoomedImg.src = /** @type {HTMLImageElement} */ (target).src;
            overlay.style.display = 'flex';
            setTimeout(() => overlay.classList.add('show'), 10);
        }
        if (overlay.classList.contains('show') && (target === overlay || target === zoomedImg)) {
            overlay.classList.remove('show');
            setTimeout(() => { overlay.style.display = 'none'; }, 300);
        }
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && overlay.classList.contains('show')) {
            overlay.classList.remove('show');
            setTimeout(() => { overlay.style.display = 'none'; }, 300);
        }
    });
}
