import { describe, test, expect } from '@jest/globals';
import {
    sortConfigs,
    filterConfigs,
    formatFileSize,
    getExpiration,
    getLinkedNodes,
    getQuickLinkCandidates,
    getUnboundDeleteCandidates,
    paginate
} from '@ui/sections/upload-config/upload-utils.js';

describe('upload config helpers', () => {
    const configs = [
        { name: 'a.json', path: 'configs/antigravity/a.json', modified: '2026-01-01T00:00:00Z', isUsed: false, size: 1024 },
        { name: 'b.json', path: 'configs/kiro/b.json', modified: '2026-02-01T00:00:00Z', isUsed: true, size: 2048 },
        { name: 'c.txt', path: 'configs/misc/c.txt', modified: '2026-03-01T00:00:00Z', isUsed: false, size: 10 }
    ];

    test('未关联优先，其次修改时间倒序', () => {
        expect(sortConfigs(configs).map((config) => config.name)).toEqual(['c.txt', 'a.json', 'b.json']);
    });

    test('搜索/状态/提供商过滤', () => {
        expect(filterConfigs(configs, { search: 'a.json' }).map((config) => config.name)).toEqual(['a.json']);
        expect(filterConfigs(configs, { status: 'used' }).map((config) => config.name)).toEqual(['b.json']);
        expect(filterConfigs(configs, { provider: 'gemini-antigravity' }).map((config) => config.name))
            .toEqual(['a.json']);
        expect(filterConfigs(configs, { provider: 'other' }).map((config) => config.name))
            .toEqual(['c.txt']);
    });

    test('文件大小与过期信息', () => {
        expect(formatFileSize(0)).toBe('0 B');
        expect(formatFileSize(2048)).toBe('2 KB');
        expect(getExpiration({ expiresIn: 0, expiresAt: new Date().toISOString() })?.expired).toBe(true);
        expect(getExpiration({ expiresIn: 3600, expiresAt: new Date().toISOString() })?.warning).toBe(true);
        expect(getExpiration({ expiresIn: 48 * 3600, expiresAt: new Date().toISOString() })?.warning).toBe(false);
    });

    test('关联节点去重与批量候选', () => {
        const nodes = getLinkedNodes({
            usageInfo: {
                usageDetails: [
                    { type: 'Provider Pool', nodeName: 'n1', isHealthy: true },
                    { type: 'Provider Pool', nodeName: 'n1', isHealthy: true },
                    { type: 'Main Config', typeLabel: 'x' }
                ]
            }
        });
        expect(nodes.map((node) => node.name)).toEqual(['n1', 'main_config']);
        expect(getQuickLinkCandidates(configs).map((config) => config.name)).toEqual(['a.json']);
        expect(getUnboundDeleteCandidates(configs).map((config) => config.name)).toEqual(['a.json', 'c.txt']);
    });

    test('分页切片', () => {
        const result = paginate([1, 2, 3, 4, 5], 2, 2);
        expect(result).toEqual({ totalPages: 3, current: 2, items: [3, 4] });
    });
});
