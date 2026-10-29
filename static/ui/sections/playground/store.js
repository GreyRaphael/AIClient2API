/** Playground 会话 store：切页不丢对话与选择。 */
import { signal } from '@preact/signals';

export const PROVIDER_STORAGE_KEY = 'pg_selected_provider';
export const MODEL_STORAGE_KEY = 'pg_selected_model';

/** @typedef {{id: number, role: 'user'|'assistant', content: any, displayText?: string, reasoning?: string, images?: string[], streaming?: boolean, error?: boolean}} PgMessage */

/** @type {import('@preact/signals').Signal<PgMessage[]>} */
export const pgMessages = signal([]);
export const pgStreaming = signal(false);
export const pgPendingFiles = signal([]);
export const pgLoaded = signal(false);
export const pgApiKey = signal('');
export const pgProviders = signal([]);
export const pgModels = signal({});
export const pgConfig = signal({
    provider: '',
    model: '',
    interfaceType: 'chat',
    stream: true,
    system: '',
    effort: 'high'
});

let nextMessageId = 0;
export function createMessageId() {
    return ++nextMessageId;
}
