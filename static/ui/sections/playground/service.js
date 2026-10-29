/** Playground 请求/流式服务：读写全局 store，切页后继续可用。 */
import { t } from '../../lib/i18n.js';
import { api } from '../../lib/api.js';
import { getProviderConfigs } from '../../lib/provider-configs.js';
import {
    pgMessages,
    pgStreaming,
    pgPendingFiles,
    pgLoaded,
    pgApiKey,
    pgProviders,
    pgModels,
    pgConfig,
    createMessageId,
    PROVIDER_STORAGE_KEY,
    MODEL_STORAGE_KEY
} from './store.js';
import {
    TEXT_INTERFACES,
    getTextProtocol,
    buildUserContent,
    dataUrlToBlob
} from './protocols.js';

let currentAbortController = null;

// 提供商数据变化时（旧 modal.js 会派发该事件）失效缓存，下次进入或当前页面立即刷新
if (typeof window !== 'undefined') {
    window.addEventListener('playground:refresh', () => {
        pgLoaded.value = false;
        if (document.getElementById('playground')) {
            void loadPlaygroundData(true);
        }
    });
}

/** @param {any[]} next */
function setMessages(next) {
    pgMessages.value = next;
}

/** @param {any} message */
function appendMessage(message) {
    pgMessages.value = [...pgMessages.value, message];
}

/** @param {number} id @param {any} patch */
function updateMessage(id, patch) {
    pgMessages.value = pgMessages.value.map((message) => (
        message.id === id ? { ...message, ...patch } : message
    ));
}

/**
 * @param {number} id
 * @param {string} content
 * @param {string} reasoning
 * @param {boolean} streaming
 */
function updatePreview(id, content, reasoning, streaming) {
    updateMessage(id, { content, reasoning, streaming });
}

export function updatePgConfig(patch) {
    const next = { ...pgConfig.value, ...patch };
    pgConfig.value = next;
    if ('provider' in patch) {
        localStorage.setItem(PROVIDER_STORAGE_KEY, next.provider || '');
        if ('model' in patch) localStorage.setItem(MODEL_STORAGE_KEY, next.model || '');
    } else if ('model' in patch) {
        localStorage.setItem(MODEL_STORAGE_KEY, next.model || '');
    }
}

export async function loadPlaygroundData(force = false) {
    if (pgLoaded.value && !force) return;

    try {
        const [access, models] = await Promise.all([
            api.get('/access-info'),
            api.get('/provider-models').catch(() => ({}))
        ]);

        pgApiKey.value = access?.apiKey || '';
        const providers = access?.providers || [];
        const providerMap = new Map(providers.map((provider) => [provider.id, provider]));
        const options = getProviderConfigs(providers.map((provider) => provider.id))
            .filter((config) => {
                const provider = providerMap.get(config.id);
                return provider && (provider.usableNodes || 0) > 0;
            })
            .map((config) => {
                const provider = providerMap.get(config.id);
                return {
                    id: config.id,
                    name: config.name,
                    usableNodes: provider.usableNodes || 0,
                    totalNodes: provider.totalNodes || 0
                };
            });

        pgProviders.value = options;
        pgModels.value = models || {};

        const savedProvider = localStorage.getItem(PROVIDER_STORAGE_KEY);
        const savedModel = localStorage.getItem(MODEL_STORAGE_KEY);
        const patch = {};
        if (savedProvider && options.some((provider) => provider.id === savedProvider)) {
            patch.provider = savedProvider;
            if (savedModel && (pgModels.value[savedProvider] || []).includes(savedModel)) {
                patch.model = savedModel;
            }
        }
        if (Object.keys(patch).length > 0) {
            pgConfig.value = { ...pgConfig.value, ...patch };
        }
        pgLoaded.value = true;
    } catch (error) {
        console.error('[Playground] Failed to load provider data:', error);
    }
}

export function stopConversation() {
    currentAbortController?.abort();
    currentAbortController = null;
}

export function clearConversation() {
    stopConversation();
    setMessages([]);
    pgPendingFiles.value = [];
    pgStreaming.value = false;
}

/**
 * @param {string} text
 * @param {Array<{name: string, type: string, dataUrl: string}>} files
 */
export async function sendChat(text, files) {
    const config = pgConfig.value;
    const apiKey = pgApiKey.value;
    if (!config.provider || !config.model || pgStreaming.value || !apiKey) return;

    const completed = pgMessages.value
        .filter((message) => !message.streaming && !message.error && message.content)
        .slice(-20)
        .map((message) => ({ role: message.role, content: message.content }));

    const userContent = buildUserContent(text, files);
    const displayText = [
        text,
        ...files.map((file) => `${t('playground.attachPrefix')}${file.name}]`)
    ].filter(Boolean).join('\n');

    appendMessage({
        id: createMessageId(),
        role: 'user',
        content: userContent,
        displayText
    });

    const assistantId = createMessageId();
    appendMessage({
        id: assistantId,
        role: 'assistant',
        content: '',
        reasoning: '',
        streaming: true
    });

    pgStreaming.value = true;
    currentAbortController = new AbortController();

    const params = {
        system: config.system,
        messages: [...completed, { role: 'user', content: userContent }],
        reasoning_effort: config.effort
    };

    try {
        if (config.interfaceType === 'image' || config.interfaceType === 'image-edit') {
            await imageResponse(assistantId, apiKey, config, text, files);
        } else if (config.stream) {
            await streamResponse(assistantId, apiKey, config, params);
        } else {
            await unaryResponse(assistantId, apiKey, config, params);
        }
    } finally {
        currentAbortController = null;
        pgStreaming.value = false;
    }
}

async function parseResponseError(response) {
    const defaultMessage = `${t('playground.reqFailed')} (${response.status})`;
    try {
        const text = await response.text();
        try {
            const json = JSON.parse(text);
            return json.error?.message || json.message || text || defaultMessage;
        } catch {
            return text || defaultMessage;
        }
    } catch {
        return defaultMessage;
    }
}

async function imageResponse(assistantId, apiKey, config, prompt, files) {
    const controller = currentAbortController;
    const imageFiles = files.filter((file) => file.type.startsWith('image/'));
    const isEdit = config.interfaceType === 'image-edit'
        || (config.interfaceType === 'image' && imageFiles.length > 0);

    try {
        if (isEdit && imageFiles.length === 0) {
            throw new Error(t('playground.imageEditRequired'));
        }

        let response;
        if (isEdit) {
            const formData = new FormData();
            formData.append('model', config.model);
            formData.append('prompt', prompt || '');
            formData.append('response_format', 'b64_json');
            imageFiles.forEach((file) => formData.append('image', dataUrlToBlob(file.dataUrl), file.name));

            response = await fetch('/v1/images/edits', {
                method: 'POST',
                headers: { Authorization: `Bearer ${apiKey}`, 'model-provider': config.provider },
                body: formData,
                signal: controller.signal
            });
        } else {
            response = await fetch('/v1/images/generations', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${apiKey}`,
                    'model-provider': config.provider
                },
                body: JSON.stringify({ model: config.model, prompt, response_format: 'b64_json' }),
                signal: controller.signal
            });
        }

        if (!response.ok) {
            throw new Error(await parseResponseError(response));
        }

        const json = await response.json();
        const images = (json.data || []).map((item) => (
            item.b64_json ? `data:image/png;base64,${item.b64_json}` : item.url
        )).filter(Boolean);
        if (images.length === 0) throw new Error(t('playground.reqFailed'));

        updateMessage(assistantId, { images, streaming: false });
    } catch (error) {
        const message = error.name === 'AbortError' ? t('playground.aborted') : (error.message || t('playground.reqFailed'));
        updateMessage(assistantId, { content: message, error: true, streaming: false });
    }
}

async function unaryResponse(assistantId, apiKey, config, params) {
    const controller = currentAbortController;
    const protocol = getTextProtocol(config.interfaceType);

    try {
        const response = await fetch(protocol.endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
                'model-provider': config.provider
            },
            body: JSON.stringify(protocol.buildBody(config.model, params, false)),
            signal: controller.signal
        });

        if (!response.ok) {
            throw new Error(await parseResponseError(response));
        }

        const json = await response.json();
        const { content, reasoning } = protocol.extractUnary(json);
        updateMessage(assistantId, {
            content,
            reasoning,
            streaming: false
        });
    } catch (error) {
        const message = error.name === 'AbortError' ? t('playground.aborted') : (error.message || t('playground.reqFailed'));
        updateMessage(assistantId, { content: message, error: true, streaming: false });
    }
}

async function streamResponse(assistantId, apiKey, config, params) {
    const controller = currentAbortController;
    const protocol = getTextProtocol(config.interfaceType);

    let accumulated = '';
    let accumulatedReasoning = '';
    let revealedContent = 0;
    let revealedReasoning = 0;
    let previewTimer = null;
    let errorMessage = '';

    const revealMore = () => {
        const contentPending = accumulated.length - revealedContent;
        const reasoningPending = accumulatedReasoning.length - revealedReasoning;
        if (contentPending <= 0 && reasoningPending <= 0) {
            if (previewTimer) {
                clearInterval(previewTimer);
                previewTimer = null;
            }
            return;
        }
        const stepFor = (pending) => Math.max(1, Math.ceil(pending / 16));
        if (contentPending > 0) {
            revealedContent = Math.min(accumulated.length, revealedContent + stepFor(contentPending));
        }
        if (reasoningPending > 0) {
            revealedReasoning = Math.min(accumulatedReasoning.length, revealedReasoning + stepFor(reasoningPending));
        }
        updatePreview(
            assistantId,
            accumulated.slice(0, revealedContent),
            accumulatedReasoning.slice(0, revealedReasoning),
            true
        );
    };

    try {
        const response = await fetch(protocol.endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
                'model-provider': config.provider
            },
            body: JSON.stringify(protocol.buildBody(config.model, params, true)),
            signal: controller.signal
        });

        if (!response.ok) {
            throw new Error(await parseResponseError(response));
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let sseBuffer = '';

        outer: while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            sseBuffer += decoder.decode(value, { stream: true });
            const lines = sseBuffer.split('\n');
            sseBuffer = lines.pop();

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6).trim();
                if (data === '[DONE]') break outer;

                try {
                    const json = JSON.parse(data);
                    const streamError = protocol.streamError(json);
                    if (streamError) throw new Error(streamError || t('playground.reqFailed'));

                    const delta = protocol.extractStreamDelta(json);
                    if (delta.content || delta.reasoning) {
                        if (delta.reasoning) accumulatedReasoning += delta.reasoning;
                        if (delta.content) accumulated += delta.content;
                        if (!previewTimer) previewTimer = setInterval(revealMore, 20);
                    }

                    if (protocol.isTerminal(json)) {
                        const final = protocol.finalOutput?.(json);
                        if (final) {
                            accumulated = accumulated || final.content;
                            accumulatedReasoning = accumulatedReasoning || final.reasoning;
                        }
                        break outer;
                    }
                } catch (parseError) {
                    if (parseError.message && !parseError.message.startsWith('Unexpected')) throw parseError;
                }
            }
        }
    } catch (error) {
        if (error.name === 'AbortError') {
            accumulated = accumulated || t('playground.aborted');
        } else {
            console.error('[Playground] Stream error:', error.message);
            errorMessage = error.message || t('playground.reqFailed');
        }
    } finally {
        if (previewTimer) {
            clearInterval(previewTimer);
            previewTimer = null;
        }
        if (!errorMessage) {
            const deadline = Date.now() + 800;
            while ((revealedContent < accumulated.length || revealedReasoning < accumulatedReasoning.length)
                && Date.now() < deadline) {
                revealMore();
                await new Promise((resolve) => setTimeout(resolve, 16));
            }
        }

        if (errorMessage) {
            updateMessage(assistantId, { content: errorMessage, error: true, streaming: false });
        } else {
            updateMessage(assistantId, {
                content: accumulated,
                reasoning: accumulatedReasoning,
                streaming: false
            });
        }
    }
}
