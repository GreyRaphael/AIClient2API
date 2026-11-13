import { describe, test } from 'node:test';
import { expect } from './support/harness.mjs';
import {
    formatNumber,
    buildModelMetadataText,
    getModelParamBadges
} from '@ui/sections/dashboard/models-utils.js';
import {
    formatUsageNumber,
    formatUsageDate,
    getUsageItemLabelKey,
    getValidInstances,
    groupUsage
} from '@ui/sections/usage/usage-utils.js';
import {
    buildFieldKeys,
    filterNodes,
    normalizeModelList,
    buildProviderConfig,
    BASE_FIELDS
} from '@ui/sections/providers/providers-utils.js';
import { buildForm, buildPayload } from '@ui/sections/config/config-model.js';
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
import {
    TEXT_PROTOCOLS,
    toResponsesInputItem,
    toClaudeMessage,
    extractResponsesOutput
} from '@ui/sections/playground/protocols.js';
import { renderMarkdown, isSafeImageUrl, isSafeVideoUrl } from '@ui/sections/playground/markdown.js';
import {
    nextSortState,
    sortModels,
    buildModelPayload,
    modelToForm,
    formatCompactNumber
} from '@ui/sections/custom-models/custom-models-utils.js';

describe('dashboard model helpers', () => {
    test('formatNumber 生成紧凑 token 数', () => {
        expect(formatNumber(1000000)).toBe('1M');
        expect(formatNumber(1048576)).toBe('1M');
        expect(formatNumber(1500)).toBe('1.5K');
        expect(formatNumber(384000)).toBe('384K');
        expect(formatNumber(0)).toBe('0');
        expect(formatNumber('')).toBe('');
    });

    test('buildModelMetadataText 只输出存在的字段', () => {
        const text = buildModelMetadataText('gemini-antigravity', 'gemini-3-flash', {
            context_length: 1000000,
            max_output_tokens: 8192,
            support_images: false,
            support_efforts: null,
            display_name: 'Gemini 3 Flash'
        });
        const payload = JSON.parse(text);
        expect(payload).toEqual({
            provider: 'gemini-antigravity',
            id: 'gemini-3-flash',
            display_name: 'Gemini 3 Flash',
            context_length: 1000000,
            max_output_tokens: 8192,
            support_images: false,
            support_efforts: null
        });
    });

    test('getModelParamBadges 生成参数徽标', () => {
        const badges = getModelParamBadges('m', {
            context_length: 128000,
            support_images: true,
            support_efforts: ['low', 'high']
        });
        expect(badges.map((badge) => badge.key)).toEqual(['id', 'ctx', 'vision', 'efforts']);
        expect(badges.find((badge) => badge.key === 'ctx')?.text).toBe('128K');
        expect(badges.find((badge) => badge.key === 'efforts')?.text).toBe('low/high');
    });
});

describe('usage helpers', () => {
    test('formatUsageNumber 保留两位并向上取整', () => {
        expect(formatUsageNumber(1.234)).toBe('1.24');
        expect(formatUsageNumber(0)).toBe('0.00');
        expect(formatUsageNumber(null)).toBe('0.00');
    });

    test('过滤未初始化实例', () => {
        const instances = getValidInstances({
            instances: [
                { uuid: 'a' },
                { uuid: 'b', error: 'provider not initialized' },
                { uuid: 'c', error: 'network' }
            ]
        });
        expect(instances.map((instance) => instance.uuid)).toEqual(['a', 'c']);
    });

    test('按配置顺序分组并过滤不可见提供商', () => {
        const providers = {
            'openai-codex-oauth': { instances: [{ uuid: 'c1' }] },
            'gemini-antigravity': { instances: [{ uuid: 'a1' }] },
            hidden: { instances: [{ uuid: 'h1' }] }
        };
        const configs = [
            { id: 'gemini-antigravity', visible: true },
            { id: 'openai-codex-oauth', visible: true },
            { id: 'hidden', visible: false }
        ];
        const groups = groupUsage(providers, configs);
        expect(groups.map((group) => group.type)).toEqual(['gemini-antigravity', 'openai-codex-oauth']);
    });

    test('条目名称映射与日期格式化', () => {
        expect(getUsageItemLabelKey({ id: 'gemini-5h' })).toBe('usage.antigravity.gemini5h');
        expect(getUsageItemLabelKey({ label: 'Weekly Limit' })).toBe('usage.weeklyLimit');
        expect(getUsageItemLabelKey({ id: 'other', label: 'Other' })).toBeNull();
        expect(formatUsageDate('', 'zh-CN')).toBe('--');
        expect(formatUsageDate('2026-01-02T03:04:00Z', 'zh-CN')).toContain('2026');
    });
});

describe('providers helpers', () => {
    test('字段顺序包含基础字段与预定义字段', () => {
        const keys = buildFieldKeys('openai-custom', {
            uuid: 'u1',
            customName: 'n',
            checkModelName: '',
            checkHealth: false,
            concurrencyLimit: 0,
            queueLimit: 0,
            OPENAI_API_KEY: 'k',
            OPENAI_BASE_URL: 'u',
            isHealthy: true,
            supportedModels: []
        });
        expect(keys.slice(0, BASE_FIELDS.length)).toEqual(BASE_FIELDS);
        expect(keys).toContain('OPENAI_API_KEY');
        expect(keys).not.toContain('isHealthy');
        expect(keys).not.toContain('supportedModels');
    });

    test('节点搜索匹配自定义名称/UUID/Key', () => {
        const nodes = [
            { uuid: 'abc-123', customName: 'Tokyo', OPENAI_API_KEY: 'sk-tokyo' },
            { uuid: 'def-456', customName: 'Osaka', OPENAI_API_KEY: 'sk-osaka' }
        ];
        expect(filterNodes(nodes, 'tokyo').map((node) => node.uuid)).toEqual(['abc-123']);
        expect(filterNodes(nodes, 'def').map((node) => node.uuid)).toEqual(['def-456']);
        expect(filterNodes(nodes, '')).toHaveLength(2);
    });

    test('模型列表去重排序', () => {
        expect(normalizeModelList([' b ', 'a', 'b', '', null])).toEqual(['a', 'b']);
    });

    test('保存 payload 转换数字/布尔并附带模型选择', () => {
        const config = buildProviderConfig({
            customName: 'n',
            checkHealth: 'true',
            concurrencyLimit: '3',
            queueLimit: ''
        }, { selected: ['m1'], candidates: ['m1', 'm2'] });
        expect(config.checkHealth).toBe(true);
        expect(config.concurrencyLimit).toBe(3);
        expect(config.queueLimit).toBe(0);
        expect(config.supportedModels).toEqual(['m1']);
        expect(config.supportedModelsBaseline).toEqual(['m1', 'm2']);
    });
});

describe('config form model', () => {
    test('buildForm 填充默认值', () => {
        const built = buildForm({
            SERVER_PORT: 3999,
            MODEL_PROVIDER: 'gemini-antigravity,openai-custom',
            SCHEDULED_HEALTH_CHECK: { enabled: false, startupRun: false, interval: 300000, providerTypes: ['zed'] }
        });
        expect(built.fields.SERVER_PORT).toBe(3999);
        expect(built.fields.HOST).toBe('127.0.0.1');
        expect(built.selections.modelProviders).toEqual(['gemini-antigravity', 'openai-custom']);
        expect(built.selections.healthProviders).toEqual(['zed']);
        expect(built.fields.SCHEDULED_HEALTH_CHECK_ENABLED).toBe(false);
        expect(built.fields.SCHEDULED_HEALTH_CHECK_INTERVAL).toBe(300000);
    });

    test('buildPayload 组装数组与数值', () => {
        const built = buildForm({ MODEL_PROVIDER: 'gemini-antigravity' });
        const payload = buildPayload(
            { ...built.fields, PROXY_URL: '  http://p  ' },
            {
                modelProviders: ['gemini-antigravity', 'zed'],
                proxyProviders: ['zed'],
                tlsProviders: [],
                healthProviders: ['zed']
            }
        );
        expect(payload.MODEL_PROVIDER).toBe('gemini-antigravity,zed');
        expect(payload.PROXY_URL).toBe('http://p');
        // fallback 相关字段已从配置模型移除
        expect(payload).not.toHaveProperty('providerFallbackChain');
        expect(payload).not.toHaveProperty('modelFallbackMapping');
        expect(payload).not.toHaveProperty('MODEL_FALLBACK_ENABLED');
        expect(payload.PROXY_ENABLED_PROVIDERS).toEqual(['zed']);
        expect(payload.SCHEDULED_HEALTH_CHECK.providerTypes).toEqual(['zed']);
    });

    test('空 provider 选择会抛错', () => {
        const built = buildForm({ MODEL_PROVIDER: 'gemini-antigravity' });
        expect(() => buildPayload(built.fields, {
            modelProviders: [],
            proxyProviders: [],
            tlsProviders: [],
            healthProviders: []
        })).toThrow('config.modelProviderRequired');
    });

    test('健康检查间隔被限制在 60s~1h', () => {
        const built = buildForm({ MODEL_PROVIDER: 'gemini-antigravity' });
        const build = (interval) => buildPayload(
            { ...built.fields, SCHEDULED_HEALTH_CHECK_INTERVAL: interval },
            { modelProviders: ['x'], proxyProviders: [], tlsProviders: [], healthProviders: [] }
        ).SCHEDULED_HEALTH_CHECK.interval;
        expect(build(1000)).toBe(60000);
        expect(build(99999999)).toBe(3600000);
        expect(build('bad')).toBe(600000);
    });
});

describe('upload config helpers', () => {
    const configs = [
        { name: 'a.json', path: 'configs/antigravity/a.json', modified: '2026-01-01T00:00:00Z', isUsed: false, size: 1024 },
        { name: 'b.json', path: 'configs/zed/b.json', modified: '2026-02-01T00:00:00Z', isUsed: true, size: 2048 },
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
        expect(filterConfigs(configs, { provider: 'zed' }).map((config) => config.name))
            .toEqual(['b.json']);
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

describe('playground protocols', () => {
    test('chat body 注入 system 与 reasoning_effort', () => {
        const body = TEXT_PROTOCOLS.chat.buildBody('m', {
            system: 'sys',
            messages: [{ role: 'user', content: 'hi' }],
            reasoning_effort: 'high'
        }, true);
        expect(body.messages[0]).toEqual({ role: 'system', content: 'sys' });
        expect(body.reasoning_effort).toBe('high');
        expect(body.stream).toBe(true);
    });

    test('Responses input 转换 text/image', () => {
        const item = toResponsesInputItem({
            role: 'user',
            content: [
                { type: 'text', text: 'hi' },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
            ]
        });
        expect(item.content).toEqual([
            { type: 'input_text', text: 'hi' },
            { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }
        ]);
    });

    test('Claude message 转换 data URL 为 base64 image', () => {
        const message = toClaudeMessage({
            role: 'user',
            content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,BBBB' } }]
        });
        expect(message.content[0]).toEqual({
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: 'BBBB' }
        });
    });

    test('Responses unary/terminal 解析', () => {
        const output = extractResponsesOutput({
            output: [
                { type: 'reasoning', summary: [{ text: 'think' }] },
                { type: 'message', content: [{ type: 'output_text', text: 'answer' }] }
            ]
        });
        expect(output).toEqual({ content: 'answer', reasoning: 'think' });
        const final = TEXT_PROTOCOLS.responses.finalOutput({
            type: 'response.completed',
            response: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'done' }] }] }
        });
        expect(final.content).toBe('done');
    });
});

describe('playground markdown', () => {
    test('转义 HTML 并渲染代码块/粗体', () => {
        const htmlText = renderMarkdown('**bold** <script>x</script>\n```js\nconst a = 1 < 2;\n```');
        expect(htmlText).toContain('<strong>bold</strong>');
        expect(htmlText).not.toContain('<script>');
        expect(htmlText).toContain('language-js');
        expect(htmlText).toContain('const a = 1 &lt; 2;');
    });

    test('仅允许安全图片/视频 URL', () => {
        expect(isSafeImageUrl('data:image/png;base64,AA')).toBe(true);
        expect(isSafeImageUrl('javascript:alert(1)')).toBe(false);
        expect(isSafeVideoUrl('https://x.com/a.mp4')).toBe(true);
        expect(isSafeVideoUrl('https://x.com/a.html')).toBe(false);
        expect(renderMarkdown('![x](javascript:alert(1))')).not.toContain('<img');
    });
});

describe('custom models helpers', () => {
    test('排序状态三态循环', () => {
        let state = { field: null, order: null };
        state = nextSortState(state, 'id');
        expect(state).toEqual({ field: 'id', order: 'asc' });
        state = nextSortState(state, 'id');
        expect(state).toEqual({ field: 'id', order: 'desc' });
        state = nextSortState(state, 'id');
        expect(state).toEqual({ field: null, order: null });
    });

    test('默认按第一列（id）升序，而不是依赖后端返回顺序', () => {
        // 页面初始 sort 状态为 { field: 'id', order: 'asc' }，
        // 因此乱序输入也必须按 id 数字感知升序输出
        const models = [
            { id: 'model-10', alias: 'b' },
            { id: 'model-2', alias: 'a' },
            { id: 'model-1', alias: 'c' }
        ];
        expect(sortModels(models, { field: 'id', order: 'asc' }).map((m) => m.id))
            .toEqual(['model-1', 'model-2', 'model-10']);
    });

    test('按 id/alias 数字感知排序', () => {
        const models = [
            { id: 'model-10', alias: 'b' },
            { id: 'model-2', alias: 'a' },
            { id: 'model-2', alias: 'z' }
        ];
        expect(sortModels(models, { field: 'id', order: 'asc' }).map((m) => m.alias))
            .toEqual(['a', 'z', 'b']);
        expect(sortModels(models, { field: 'id', order: 'desc' }).map((m) => m.alias))
            .toEqual(['b', 'z', 'a']);
    });

    test('新增时省略空数字字段，编辑时保留', () => {
        const form = {
            modelId: 'm1',
            modelName: 'M',
            customModelProvider: 'p1',
            customModelActualProvider: 'p2',
            support_images: 'true',
            support_efforts: 'high,max',
            enabled: true,
            context_length: '',
            max_output_tokens: ''
        };
        const created = buildModelPayload(form, false);
        expect(created).not.toHaveProperty('context_length');
        expect(created.support_images).toBe(true);
        expect(created.support_efforts).toEqual(['high', 'max']);

        const edited = buildModelPayload(form, true);
        expect(edited.context_length).toBeNull();
    });

    test('modelToForm 还原表单字段', () => {
        const form = modelToForm({
            id: 'm1',
            name: 'M',
            provider: 'p1',
            actualProvider: 'p2',
            context_length: 8192,
            support_images: true,
            support_efforts: ['max'],
            enabled: false
        });
        expect(form.customModelProvider).toBe('p1');
        expect(form.customModelActualProvider).toBe('p2');
        expect(form.support_images).toBe('true');
        expect(form.support_efforts).toBe('max');
        expect(form.enabled).toBe(false);
        expect(formatCompactNumber(8192)).toBe('8K');
    });
});
