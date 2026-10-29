/** 实时日志页面（Phase 2 迁移）。 */
import { html, useEffect, useRef } from '../html.js';
import { t } from '../lib/i18n.js';
import { api } from '../lib/api.js';
import { toast } from '../store/toast.js';
import { entries, autoScroll, clearEntries } from '../store/logs.js';

export default function LogsSection() {
    const box = useRef(/** @type {HTMLDivElement|null} */ (null));
    const list = entries.value;
    const auto = autoScroll.value;

    // 新日志到达且自动滚动开启时滚到底部
    useEffect(() => {
        if (autoScroll.value && box.current) {
            box.current.scrollTop = box.current.scrollHeight;
        }
    }, [list.length, autoScroll.value]);

    const handleScroll = () => {
        const element = box.current;
        if (!element || !autoScroll.value) return;
        const atBottom = element.scrollTop + element.clientHeight >= element.scrollHeight - 5;
        if (!atBottom) autoScroll.value = false;
    };

    const handleClear = async () => {
        if (!confirm(t('logs.clear.confirm.msg'))) return;
        try {
            await api.post('/system/clear-log');
            clearEntries();
            toast.success(t('logs.clear.success.title'), t('logs.clear.success.msg'), 5000);
        } catch (error) {
            toast.error(t('common.error'), `${t('logs.clear.failed')}: ${error.message}`);
        }
    };

    const handleDownload = async () => {
        try {
            const blob = await api.getBlob('/system/download-log');
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = `app-${new Date().toISOString().split('T')[0]}.log`;
            document.body.appendChild(anchor);
            anchor.click();
            URL.revokeObjectURL(url);
            anchor.remove();
            toast.success(t('common.success'), t('common.downloadSuccess'));
        } catch (error) {
            toast.error(t('common.error'), `${t('common.downloadFailed')}: ${error.message}`);
        }
    };

    return html`
        <section id="logs" class="section active" aria-labelledby="logs-title">
            <h2 id="logs-title">${t('logs.title')}</h2>
            <div class="logs-controls">
                <button class="btn btn-danger" id="clearLogs" aria-label=${t('logs.clear')} onClick=${handleClear}>
                    <i class="fas fa-trash" aria-hidden="true"></i> <span>${t('logs.clear')}</span>
                </button>
                <button class="btn btn-secondary" id="downloadLogs" aria-label=${t('logs.download')} onClick=${handleDownload}>
                    <i class="fas fa-download" aria-hidden="true"></i> <span>${t('logs.download')}</span>
                </button>
                <button class="btn btn-primary" id="toggleAutoScroll" data-enabled=${String(auto)}
                    aria-label=${t('logs.autoScroll')}
                    onClick=${() => { autoScroll.value = !autoScroll.value; }}>
                    <i class="fas fa-arrow-down" aria-hidden="true"></i>
                    <span>${auto ? t('logs.autoScroll.on') : t('logs.autoScroll.off')}</span>
                </button>
            </div>
            <div class="logs-container" id="logsContainer" ref=${box} role="log" aria-live="polite"
                aria-atomic="false" onScroll=${handleScroll}>
                ${list.map((entry) => html`
                    <div class="log-entry" key=${entry.id}>
                        <span class="log-time">[${new Date(entry.timestamp).toLocaleTimeString()}]</span>
                        <span class=${`log-level-${entry.level}`}>[${entry.level.toUpperCase()}]</span>
                        <span class="log-message">${entry.message}</span>
                    </div>`)}
            </div>
        </section>`;
}
