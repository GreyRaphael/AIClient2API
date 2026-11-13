import type { ProviderStrategy } from '../../utils/provider-strategy-base.ts';

import type { DynamicPayload } from '../../../types/dynamic-payload.js';

/**
 * Gemini provider strategy implementation.
 */
class GeminiStrategy implements ProviderStrategy {
    /**
     * Gemini 的 model 通常在 URL 路径里（`/v1beta/models/{model}:generateContent`），
     * 而非请求体；`stream` 也不在体内（由 `:streamGenerateContent` 端点决定）。
     *
     * 当前网关的 content-generation 路由只接 OpenAI / Responses / Claude 三种下游协议，
     * 因此这个方法实际上不会被调用。但把它留在契约里、给出可辩护的实现，
     * 好过让 `ProviderStrategy` 变成「有一半方法靠运行时 throw」的假接口——
     * 那正是本次把它从抽象类改成 interface 要消除的问题。
     */
    extractModelAndStreamInfo(_req: unknown, requestBody: DynamicPayload): { model: string; isStream: boolean } {
        const model = typeof requestBody?.model === 'string' ? requestBody.model : '';
        const isStream = requestBody?.stream === true;
        return { model, isStream };
    }

    extractResponseText(response: DynamicPayload): string {
        if (response.candidates && response.candidates.length > 0) {
            const candidate = response.candidates[0];
            if (candidate.content && candidate.content.parts && candidate.content.parts.length > 0) {
                return candidate.content.parts.map((part: DynamicPayload) => part.text).join('');
            }
        }
        return '';
    }

    extractPromptText(requestBody: DynamicPayload): string {
        if (requestBody.contents && requestBody.contents.length > 0) {
            const lastContent = requestBody.contents[requestBody.contents.length - 1];
            if (lastContent.parts && lastContent.parts.length > 0) {
                return lastContent.parts.map((part: DynamicPayload) => part.text).join('');
            }
        }
        return '';
    }


}

export { GeminiStrategy };

