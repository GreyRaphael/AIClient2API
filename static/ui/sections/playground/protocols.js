/** Playground 协议适配（Chat / Responses / Messages），纯函数。 */

export const TEXT_INTERFACES = new Set(['chat', 'responses', 'messages']);
export const CLAUDE_MAX_TOKENS = 8192;

export const RESPONSES_REASONING_DELTA_TYPES = new Set([
    'response.reasoning_summary_text.delta',
    'response.reasoning_text.delta',
    'response.reasoning.delta',
    'response.reasoning_summary.delta'
]);

export function parseDataUrl(url) {
    const match = /^data:([^;,]+);base64,(.+)$/.exec(url || '');
    return match ? { mediaType: match[1], data: match[2] } : null;
}

export function getImageUrl(part) {
    return typeof part?.image_url === 'string' ? part.image_url : part?.image_url?.url;
}

/** 内部 Chat 风格历史 -> Responses input items。 */
export function toResponsesInputItem(message) {
    if (typeof message.content === 'string') {
        return { role: message.role, content: [{ type: 'input_text', text: message.content }] };
    }
    const content = (Array.isArray(message.content) ? message.content : [])
        .map((part) => {
            if (part?.type === 'text') return { type: 'input_text', text: part.text || '' };
            if (part?.type === 'image_url') {
                const url = getImageUrl(part);
                return url ? { type: 'input_image', image_url: url } : null;
            }
            return null;
        })
        .filter(Boolean);
    return { role: message.role, content };
}

/** 内部 Chat 风格历史 -> Anthropic Messages 消息。 */
export function toClaudeMessage(message) {
    if (typeof message.content === 'string') {
        return { role: message.role, content: message.content };
    }
    const content = (Array.isArray(message.content) ? message.content : [])
        .map((part) => {
            if (part?.type === 'text') return { type: 'text', text: part.text || '' };
            if (part?.type === 'image_url') {
                const url = getImageUrl(part);
                if (!url) return null;
                const parsed = parseDataUrl(url);
                if (parsed) {
                    return {
                        type: 'image',
                        source: { type: 'base64', media_type: parsed.mediaType, data: parsed.data }
                    };
                }
                if (/^https?:\/\//.test(url)) {
                    return { type: 'image', source: { type: 'url', url } };
                }
            }
            return null;
        })
        .filter(Boolean);
    return { role: message.role, content };
}

export function extractResponsesOutput(json) {
    let content = '';
    let reasoning = '';
    for (const item of Array.isArray(json?.output) ? json.output : []) {
        if (item?.type === 'message') {
            for (const part of item.content || []) {
                if (part?.type === 'output_text') content += part.text || '';
                if (part?.type === 'refusal') content += part.refusal || '';
            }
        }
        if (item?.type === 'reasoning') {
            for (const part of item.summary || []) reasoning += part.text || '';
            for (const part of item.content || []) reasoning += part.text || '';
        }
    }
    return { content, reasoning };
}

export const TEXT_PROTOCOLS = {
    chat: {
        endpoint: '/v1/chat/completions',
        buildBody(model, params, stream) {
            const messages = [];
            if (params.system) messages.push({ role: 'system', content: params.system });
            messages.push(...params.messages);
            return {
                model,
                messages,
                ...(params.reasoning_effort && params.reasoning_effort !== 'none'
                    ? { reasoning_effort: params.reasoning_effort }
                    : {}),
                stream
            };
        },
        extractUnary(json) {
            const message = json.choices?.[0]?.message || {};
            return {
                content: typeof message.content === 'string' ? message.content : '',
                reasoning: message.reasoning_content || message.thinking || ''
            };
        },
        extractStreamDelta(json) {
            const delta = json.choices?.[0]?.delta || {};
            return {
                content: typeof delta.content === 'string' ? delta.content : '',
                reasoning: typeof delta.reasoning_content === 'string'
                    ? delta.reasoning_content
                    : (typeof delta.thinking === 'string' ? delta.thinking : '')
            };
        },
        streamError(json) {
            return json.error?.message || '';
        },
        isTerminal() {
            return false;
        }
    },
    responses: {
        endpoint: '/v1/responses',
        buildBody(model, params, stream) {
            return {
                model,
                ...(params.system ? { instructions: params.system } : {}),
                input: params.messages.map(toResponsesInputItem),
                ...(params.reasoning_effort && params.reasoning_effort !== 'none'
                    ? { reasoning: { effort: params.reasoning_effort, summary: 'auto' } }
                    : {}),
                stream
            };
        },
        extractUnary: extractResponsesOutput,
        extractStreamDelta(json) {
            if (json.type === 'response.output_text.delta') {
                return { content: json.delta || '', reasoning: '' };
            }
            if (RESPONSES_REASONING_DELTA_TYPES.has(json.type)) {
                return { content: '', reasoning: json.delta || '' };
            }
            return { content: '', reasoning: '' };
        },
        streamError(json) {
            if (json.type === 'response.failed') {
                return json.response?.error?.message || json.error?.message || json.message || '';
            }
            if (json.type === 'error') return json.error?.message || json.message || '';
            return json.error?.message || '';
        },
        isTerminal(json) {
            return json.type === 'response.completed'
                || json.type === 'response.incomplete'
                || json.type === 'response.failed';
        },
        finalOutput(json) {
            if (json.type === 'response.completed' || json.type === 'response.incomplete') {
                return extractResponsesOutput(json.response || {});
            }
            return null;
        }
    },
    messages: {
        endpoint: '/v1/messages',
        buildBody(model, params, stream) {
            return {
                model,
                ...(params.system ? { system: params.system } : {}),
                max_tokens: CLAUDE_MAX_TOKENS,
                messages: params.messages.map(toClaudeMessage),
                ...(params.reasoning_effort && params.reasoning_effort !== 'none'
                    ? { thinking: { type: 'adaptive' }, output_config: { effort: params.reasoning_effort } }
                    : {}),
                stream
            };
        },
        extractUnary(json) {
            let content = '';
            let reasoning = '';
            for (const block of Array.isArray(json?.content) ? json.content : []) {
                if (block?.type === 'text') content += block.text || '';
                if (block?.type === 'thinking') reasoning += block.thinking || '';
            }
            return { content, reasoning };
        },
        extractStreamDelta(json) {
            if (json.type !== 'content_block_delta') return { content: '', reasoning: '' };
            const delta = json.delta || {};
            if (delta.type === 'text_delta') return { content: delta.text || '', reasoning: '' };
            if (delta.type === 'thinking_delta') return { content: '', reasoning: delta.thinking || '' };
            return { content: '', reasoning: '' };
        },
        streamError(json) {
            if (json.type === 'error') return json.error?.message || json.message || '';
            return json.error?.message || '';
        },
        isTerminal(json) {
            return json.type === 'message_stop';
        }
    }
};

export function getTextProtocol(interfaceType) {
    return TEXT_PROTOCOLS[interfaceType] || TEXT_PROTOCOLS.chat;
}

/**
 * @param {string} text
 * @param {Array<{name: string, type: string, dataUrl: string}>} files
 */
export function buildUserContent(text, files) {
    if (files.length === 0) return text;
    const parts = [];
    if (text) parts.push({ type: 'text', text });
    files.forEach((file) => {
        if (file.type.startsWith('image/')) {
            parts.push({ type: 'image_url', image_url: { url: file.dataUrl } });
        } else {
            parts.push({ type: 'text', text: `[File: ${file.name}]\n${file.dataUrl}` });
        }
    });
    return parts;
}

export function dataUrlToBlob(dataUrl) {
    const [meta, data] = dataUrl.split(',');
    const mime = (meta.match(/:(.*?);/) || [])[1] || 'image/png';
    const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
    return new Blob([bytes], { type: mime });
}
