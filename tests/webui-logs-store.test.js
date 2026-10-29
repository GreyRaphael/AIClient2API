import { describe, test, expect, beforeEach } from '@jest/globals';
import {
    entries,
    appendLog,
    clearEntries,
    MAX_LOG_ENTRIES
} from '@ui/store/logs.js';

describe('logs store', () => {
    beforeEach(() => {
        clearEntries();
    });

    test('日志条目封顶，保留最新记录', () => {
        for (let i = 0; i < MAX_LOG_ENTRIES + 5; i++) {
            appendLog({ timestamp: new Date(2026, 0, 1, 0, 0, i % 60).toISOString(), level: 'info', message: `m${i}` });
        }
        expect(entries.value.length).toBe(MAX_LOG_ENTRIES);
        expect(entries.value[0].message).toBe('m5');
        expect(entries.value.at(-1).message).toBe(`m${MAX_LOG_ENTRIES + 4}`);
    });

    test('id 唯一且非字符串 message 会序列化', () => {
        appendLog({ level: 'error', message: { code: 500 } });
        appendLog({ level: 'info', message: 'plain' });
        expect(entries.value[0].id).not.toBe(entries.value[1].id);
        expect(entries.value[0].message).toBe('{"code":500}');
        expect(entries.value[0].level).toBe('error');
    });

    test('clearEntries 清空所有条目', () => {
        appendLog({ message: 'a' });
        clearEntries();
        expect(entries.value).toEqual([]);
    });
});
