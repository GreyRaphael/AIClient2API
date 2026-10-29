/** 推理实验室（Playground）页面（Phase 4 迁移）。 */
import { html, useEffect, useRef, useState } from '../../html.js';
import { t } from '../../lib/i18n.js';
import { copyToClipboard } from '../../lib/clipboard.js';
import { toast } from '../../store/toast.js';
import {
    pgMessages,
    pgStreaming,
    pgPendingFiles,
    pgLoaded,
    pgProviders,
    pgModels,
    pgConfig
} from './store.js';
import {
    loadPlaygroundData,
    updatePgConfig,
    sendChat,
    stopConversation,
    clearConversation
} from './service.js';
import { TEXT_INTERFACES } from './protocols.js';
import { renderMarkdown } from './markdown.js';

/**
 * @param {{message: any, streaming: boolean, index: number, onRetry: (index: number) => void}} props
 */
function PgMessageView({ message, streaming, index, onRetry }) {
    const [reasoningCollapsed, setReasoningCollapsed] = useState(true);
    const bubbleRef = useRef(/** @type {HTMLDivElement|null} */ (null));
    const isAssistant = message.role === 'assistant';
    const displayText = message.displayText || (typeof message.content === 'string' ? message.content : '');

    const copyMessage = async () => {
        const textToCopy = message.content || bubbleRef.current?.innerText || '';
        const success = await copyToClipboard(String(textToCopy));
        if (success) toast.success(t('common.success'), t('common.copy.success'));
        else toast.error(t('common.error'), t('common.copy.failed'));
    };

    return html`
        <div class=${`pg-message ${message.role} ${message.error ? 'error' : ''}`}>
            <div class="pg-avatar">
                <i class=${`fas ${isAssistant ? 'fa-microchip' : 'fa-user'}`}></i>
            </div>
            <div class="pg-message-content">
                <div class="pg-message-bubble" ref=${bubbleRef}>
                    ${message.reasoning ? html`
                        <div class=${`pg-reasoning ${reasoningCollapsed ? 'collapsed' : ''}`}
                            onClick=${() => setReasoningCollapsed(!reasoningCollapsed)}>
                            <div class="pg-reasoning-title"><i class="fas fa-brain"></i>${t('playground.thinking')}</div>
                            <div class="pg-reasoning-content">${message.reasoning}</div>
                        </div>` : null}

                    ${message.images?.length ? message.images.map((src, imageIndex) => html`
                        <img src=${src} alt="generated" key=${imageIndex}
                            style="max-width:100%;border-radius:12px;margin:0.5rem 0;display:block" />`) : null}

                    ${isAssistant
                        ? (message.content
                            ? html`<div dangerouslySetInnerHTML=${{ __html: renderMarkdown(message.content) }}></div>`
                            : (streaming && !message.reasoning
                                ? html`<div class="pg-thinking"><span></span><span></span><span></span></div>`
                                : null))
                        : html`<span>${displayText}</span>`}

                    ${streaming ? html`<span class="pg-cursor"></span>` : null}
                </div>

                ${isAssistant && message.content && !streaming ? html`
                    <div class="pg-message-actions">
                        <div class="pg-action-link" title=${t('playground.copyText')} onClick=${() => void copyMessage()}>
                            <i class="fas fa-copy"></i>
                        </div>
                    </div>` : null}

                ${!isAssistant && !streaming ? html`
                    <div class="pg-message-actions">
                        <div class="pg-action-link" title=${t('playground.retryConversation')}
                            onClick=${() => onRetry(index)}>
                            <i class="fas fa-sync-alt"></i>
                        </div>
                    </div>` : null}
            </div>
        </div>`;
}

function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (event) => resolve(event.target.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

export default function PlaygroundSection() {
    const [text, setText] = useState('');
    const [tab, setTab] = useState('chat');
    const fileInput = useRef(/** @type {HTMLInputElement|null} */ (null));
    const textarea = useRef(/** @type {HTMLTextAreaElement|null} */ (null));
    const messagesBox = useRef(/** @type {HTMLDivElement|null} */ (null));

    const config = pgConfig.value;
    const messages = pgMessages.value;
    const streaming = pgStreaming.value;
    const files = pgPendingFiles.value;
    const providers = pgProviders.value;
    const models = pgModels.value[config.provider] || [];
    const ready = !!(config.provider && config.model && !streaming);
    const streamable = TEXT_INTERFACES.has(config.interfaceType);

    useEffect(() => {
        void loadPlaygroundData();
    }, []);

    useEffect(() => {
        const box = messagesBox.current;
        if (box) box.scrollTop = box.scrollHeight;
    }, [messages]);

    const resizeTextarea = () => {
        const element = textarea.current;
        if (!element) return;
        element.style.height = 'auto';
        element.style.height = `${Math.min(element.scrollHeight, 240)}px`;
    };

    const patchConfig = (patch) => updatePgConfig(patch);

    const handleProviderChange = (providerId) => {
        patchConfig({ provider: providerId, model: '' });
    };

    const handleFiles = async (fileList) => {
        if (!fileList?.length) return;
        const added = [];
        for (const file of fileList) {
            added.push({ name: file.name, type: file.type, dataUrl: await readFileAsDataUrl(file) });
        }
        pgPendingFiles.value = [...pgPendingFiles.value, ...added];
        if (fileInput.current) fileInput.current.value = '';
    };

    const removeFile = (index) => {
        pgPendingFiles.value = pgPendingFiles.value.filter((_, fileIndex) => fileIndex !== index);
    };

    const send = async () => {
        const content = text.trim();
        const pending = pgPendingFiles.value;
        if (!ready || (!content && pending.length === 0)) return;

        setText('');
        pgPendingFiles.value = [];
        if (textarea.current) textarea.current.style.height = 'auto';
        await sendChat(content, pending);
    };

    const retryAt = async (index) => {
        if (streaming) return;
        const message = pgMessages.value[index];
        if (!message || message.role !== 'user') return;

        let retryText = '';
        if (typeof message.content === 'string') retryText = message.content;
        else retryText = message.content?.find?.((part) => part.type === 'text')?.text || '';

        pgMessages.value = pgMessages.value.slice(0, index);
        setText('');
        await sendChat(retryText, []);
    };

    const clear = () => {
        clearConversation();
        setText('');
        if (textarea.current) textarea.current.style.height = 'auto';
    };

    return html`
        <section id="playground" class=${`section active pg-workspace active-tab-${tab}`}>
            <header class="pg-workspace-header">
                <div class="pg-title-group">
                    <h2><i class="fas fa-flask"></i> <span>${t('nav.playground')}</span></h2>
                    <div class=${`pg-indicator ${ready ? 'active' : 'inactive'}`} id="pg-active-indicator">
                        <span class="dot"></span>
                        <span id="pg-status-text">${ready
                            ? t('playground.status.ready')
                            : streaming ? t('playground.generating') : t('playground.status.unready')}</span>
                    </div>
                </div>
                <div class="pg-header-tools">
                    <button class="pg-btn-icon" id="pg-clear-btn" title=${t('playground.clearChat')}
                        onClick=${clear}>
                        <i class="fas fa-redo-alt"></i>
                    </button>
                </div>
            </header>

            <div class="pg-mobile-tabs">
                ${[['chat', 'fa-comments', 'playground.tab.chat'], ['settings', 'fa-sliders-h', 'playground.tab.settings'], ['parameters', 'fa-cog', 'playground.tab.parameters']].map(([key, icon, labelKey]) => html`
                    <button class=${`pg-tab-btn ${tab === key ? 'active' : ''}`} data-tab=${key} key=${key}
                        onClick=${() => setTab(key)}>
                        <i class=${`fas ${icon}`}></i> <span>${t(labelKey)}</span>
                    </button>`)}
            </div>

            <div class="pg-main-layout">
                <aside class="pg-side-nav">
                    <div class="pg-nav-section">
                        <label class="pg-label">${t('playground.provider')}</label>
                        <select id="pg-provider-select" class="pg-input-field" value=${config.provider}
                            disabled=${!pgLoaded.value}
                            onChange=${(event) => handleProviderChange(event.currentTarget.value)}>
                            <option value="">${pgLoaded.value ? t('playground.selectProvider') : t('playground.loading')}</option>
                            ${providers.map((provider) => html`
                                <option value=${provider.id} key=${provider.id}>
                                    ● ${provider.name} (${provider.usableNodes}/${provider.totalNodes})
                                </option>`)}
                        </select>
                    </div>
                    <div class="pg-nav-section">
                        <label class="pg-label">${t('playground.model')}</label>
                        <select id="pg-model-select" class="pg-input-field" value=${config.model}
                            disabled=${!config.provider}
                            onChange=${(event) => patchConfig({ model: event.currentTarget.value })}>
                            <option value="">${config.provider ? t('playground.selectModel') : t('playground.providerFirst')}</option>
                            ${models.map((model) => html`<option value=${model} key=${model}>${model}</option>`)}
                        </select>
                    </div>
                    <div class="pg-nav-section">
                        <label class="pg-label">${t('playground.interface')}</label>
                        <select id="pg-interface-select" class="pg-input-field" value=${config.interfaceType}
                            onChange=${(event) => patchConfig({ interfaceType: event.currentTarget.value })}>
                            ${[['chat', 'playground.interface.chat'], ['responses', 'playground.interface.responses'], ['messages', 'playground.interface.messages'], ['image', 'playground.interface.image'], ['image-edit', 'playground.interface.imageEdit']].map(([value, key]) => html`
                                <option value=${value} key=${value}>${t(key)}</option>`)}
                        </select>
                    </div>
                    <div class="pg-nav-section">
                        <div class="pg-stream-toggle-wrap" style=${streamable ? undefined : 'opacity: 0.5;'}>
                            <label class="pg-label" style="margin-bottom: 0;">${t('playground.stream')}</label>
                            <label class="pg-switch">
                                <input type="checkbox" id="pg-stream-checkbox" checked=${config.stream}
                                    disabled=${!streamable}
                                    onChange=${(event) => patchConfig({ stream: event.currentTarget.checked })} />
                                <span class="pg-switch-slider"></span>
                            </label>
                        </div>
                    </div>

                    <div class="pg-nav-divider"></div>
                    <button class="pg-mobile-start-chat-btn" style="display: none;" onClick=${() => setTab('chat')}>
                        <span>${t('playground.startTesting')}</span> <i class="fas fa-arrow-right"></i>
                    </button>
                </aside>

                <main class="pg-chat-column">
                    <div class="pg-messages-wrapper" id="pg-messages" ref=${messagesBox}>
                        ${messages.length === 0 ? html`
                            <div class="pg-welcome" id="pg-empty">
                                <div class="welcome-card">
                                    <div class="welcome-icon"><i class="fas fa-microchip"></i></div>
                                    <h3>${t('playground.welcome')}</h3>
                                    <p>${t('playground.emptyHint')}</p>
                                </div>
                            </div>` : messages.map((message, index) => html`
                                <${PgMessageView} key=${message.id} message=${message}
                                    streaming=${!!message.streaming} index=${index} onRetry=${retryAt} />`)}
                    </div>

                    <div class="pg-input-boundary">
                        <div class="pg-input-box">
                            <div id="pg-attachments-preview" class="pg-previews">
                                ${files.map((file, index) => html`
                                    <div class="pg-attachment-tag" key=${`${file.name}-${index}`}
                                        style="display:inline-flex;align-items:center;background:var(--bg-tertiary);padding:4px 10px;border-radius:8px;margin-right:8px;font-size:0.8rem;border:1px solid var(--border-color);">
                                        <i class="fas fa-file" style="margin-right:6px"></i>
                                        <span>${file.name}</span>
                                        <button style="border:none;background:none;margin-left:6px;cursor:pointer;color:var(--text-tertiary)"
                                            onClick=${() => removeFile(index)}>×</button>
                                    </div>`)}
                            </div>
                            <div class="pg-input-inner">
                                <button class="pg-inner-btn" id="pg-attach-btn" title=${t('playground.attachTitle')}
                                    onClick=${() => fileInput.current?.click()}>
                                    <i class="fas fa-paperclip"></i>
                                </button>
                                <textarea id="pg-input" class="pg-textarea-auto" rows="1" ref=${textarea}
                                    placeholder=${t('playground.inputPlaceholder')}
                                    disabled=${!config.provider || !config.model || streaming}
                                    value=${text}
                                    onInput=${(event) => { setText(event.currentTarget.value); resizeTextarea(); }}
                                    onKeyDown=${(event) => {
                                        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
                                            event.preventDefault();
                                            void send();
                                        }
                                    }}></textarea>
                                ${streaming ? html`
                                    <button class="pg-stop-pill" id="pg-stop-btn" style="display:flex;"
                                        onClick=${stopConversation}>
                                        <i class="fas fa-stop"></i>
                                    </button>` : html`
                                    <button class="pg-send-pill" id="pg-send-btn" disabled=${!ready
                                        || (!text.trim() && files.length === 0)}
                                        onClick=${() => void send()}>
                                        <i class="fas fa-paper-plane"></i>
                                    </button>`}
                            </div>
                        </div>
                    </div>
                </main>

                <aside class="pg-config-panel">
                    <div class="pg-panel-section">
                        <div class="section-header">
                            <label class="pg-label">${t('playground.systemRole')}</label>
                        </div>
                        <textarea id="pg-system-input" class="pg-system-textarea"
                            placeholder=${t('playground.systemRolePlaceholder')}
                            value=${config.system}
                            onInput=${(event) => patchConfig({ system: event.currentTarget.value })}></textarea>
                    </div>

                    <div class="pg-nav-divider"></div>

                    <div class="pg-panel-section">
                        <label class="pg-label">${t('playground.hyperparameters')}</label>
                        <div class="pg-slider-group" style="margin-bottom: 0;">
                            <div class="slider-info" style="margin-bottom: 0;">
                                <span>${t('playground.reasoningEffort')}</span>
                                <select id="pg-reasoning-effort" class="pg-select-inline" value=${config.effort}
                                    onChange=${(event) => patchConfig({ effort: event.currentTarget.value })}>
                                    ${['none', 'low', 'medium', 'high', 'xhigh', 'max'].map((effort) => html`
                                        <option value=${effort} key=${effort}>${effort}</option>`)}
                                </select>
                            </div>
                        </div>
                    </div>
                    <div class="pg-nav-divider pg-mobile-only-divider" style="display: none;"></div>
                    <button class="pg-mobile-start-chat-btn" style="display: none;" onClick=${() => setTab('chat')}>
                        <span>${t('playground.startTesting')}</span> <i class="fas fa-arrow-right"></i>
                    </button>
                </aside>
            </div>

            <input type="file" id="pg-file-input" accept="image/*,.pdf" multiple style="display:none;"
                ref=${fileInput} onChange=${(event) => void handleFiles(event.currentTarget.files)} />
        </section>`;
}
