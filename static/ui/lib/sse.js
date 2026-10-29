/**
 * 读取 fetch Response 中的 text/event-stream，并按事件逐条回调。
 * 仅解析 `event:` / `data:` 字段，供批量导入等需要实时进度的接口复用。
 *
 * @param {Response} response
 * @param {(eventName: string, payload: any) => void} onEvent
 * @returns {Promise<void>}
 */
export async function streamSse(response, onEvent) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop() || '';
        for (const block of blocks) {
            let eventName = 'message';
            const dataLines = [];
            block.split('\n').forEach((line) => {
                if (line.startsWith('event: ')) eventName = line.slice(7).trim();
                else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
            });
            if (dataLines.length === 0) continue;
            let payload = null;
            try {
                payload = JSON.parse(dataLines.join('\n'));
            } catch {
                continue;
            }
            onEvent(eventName, payload);
        }
    }
}
