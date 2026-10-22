import { describe, test, expect, jest } from '@jest/globals';
import {
    OpenAIApiService,
    normalizeToolChoiceForProvider
} from '../src/providers/openai/openai-core.js';
import { resolveEmptyUpstreamResponseRetry } from '../src/handlers/request-pipeline.js';

const weatherTool = {
    type: 'function',
    function: {
        name: 'get_weather',
        description: 'Get current weather',
        parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }
    }
};

const specificChoice = {
    type: 'function',
    function: { name: 'get_weather' }
};

describe('OpenAI provider tool_choice 能力降级', () => {
    test('能力支持时原样透传', () => {
        const body = { tools: [weatherTool], tool_choice: specificChoice };
        expect(normalizeToolChoiceForProvider(body, { supportsForcedToolChoice: true })).toBe(body);
    });

    test('不支持指定 function 时收窄 tools 并降级为 required', () => {
        const otherTool = { type: 'function', function: { name: 'other' } };
        const normalized = normalizeToolChoiceForProvider(
            { tools: [weatherTool, otherTool], tool_choice: specificChoice },
            { supportsForcedToolChoice: false }
        );

        expect(normalized.tools).toEqual([weatherTool]);
        expect(normalized.tool_choice).toBe('required');
    });

    test('找不到同名工具时降级为 auto', () => {
        const normalized = normalizeToolChoiceForProvider(
            { tools: [weatherTool], tool_choice: { type: 'function', function: { name: 'missing' } } },
            { supportsForcedToolChoice: false }
        );

        expect(normalized.tool_choice).toBe('auto');
        expect(normalized.tools).toEqual([weatherTool]);
    });

    test('字符串 required 降级为 auto', () => {
        const normalized = normalizeToolChoiceForProvider(
            { tools: [weatherTool], tool_choice: 'required' },
            { supportsForcedToolChoice: false }
        );

        expect(normalized.tool_choice).toBe('auto');
    });
});

describe('OpenAI provider 空响应 tool_choice 兜底', () => {
    test('指定 function 返回空 body 时自动用 required 重试一次', async () => {
        const service = new OpenAIApiService({
            OPENAI_API_KEY: 'test-key',
            OPENAI_BASE_URL: 'http://example.invalid/v1',
            MODEL_PROVIDER: 'openai-custom',
            REQUEST_MAX_RETRIES: 0,
            // 显式覆盖内置降级规则，单独验证“能力声明为支持”时的空响应兜底
            PROVIDER_CAPABILITIES: {
                'openai-custom': { supportsForcedToolChoice: true }
            }
        });

        const requestMock = jest.fn()
            .mockResolvedValueOnce({ data: '', headers: { 'content-type': 'application/json' } })
            .mockResolvedValueOnce({
                data: {
                    choices: [{
                        message: {
                            content: '',
                            tool_calls: [{
                                id: 'call_1',
                                type: 'function',
                                function: { name: 'get_weather', arguments: '{"city":"Paris"}' }
                            }]
                        }
                    }]
                },
                headers: { 'content-type': 'application/json' }
            });
        service.axiosInstance.request = requestMock;

        const result = await service.callApi('/chat/completions', {
            model: 'glm-5.3-prime',
            messages: [{ role: 'user', content: 'Weather in Paris?' }],
            tools: [weatherTool],
            tool_choice: specificChoice,
            stream: false
        });

        expect(result.choices[0].message.tool_calls[0].function.name).toBe('get_weather');
        expect(requestMock).toHaveBeenCalledTimes(2);

        const firstBody = requestMock.mock.calls[0][0].data;
        const secondBody = requestMock.mock.calls[1][0].data;
        expect(firstBody.tool_choice).toEqual(specificChoice);
        expect(secondBody.tool_choice).toBe('required');
        expect(secondBody.tools).toEqual([weatherTool]);
    });
});

describe('空响应重试墙钟预算', () => {
    test('超过 EMPTY_RESPONSE_MAX_TOTAL_MS 时不再重试', async () => {
        const outcome = await resolveEmptyUpstreamResponseRetry(
            {
                EMPTY_RESPONSE_MAX_RETRIES: 5,
                EMPTY_RESPONSE_RETRY_DELAY_MS: 0,
                EMPTY_RESPONSE_MAX_TOTAL_MS: 1
            },
            'test-model',
            0,
            '[Test]',
            'test-provider',
            Date.now() - 10
        );

        expect(outcome).toEqual({ retry: false, budgetExhausted: true });
    });
});
