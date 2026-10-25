import { KiroApiService } from '../src/providers/claude/claude-kiro.ts';

function createService(config = {}) {
    const service = new KiroApiService(config);
    service.isInitialized = true;
    service._prepareAccessTokenForRequest = jest.fn().mockResolvedValue(undefined);
    service.estimateInputTokens = jest.fn().mockReturnValue(7);
    service.countTextTokens = jest.fn((text) => String(text).length);
    return service;
}

async function collectStream(service, requestBody = { messages: [{ role: 'user', content: 'hi' }] }) {
    const events = [];
    for await (const event of service.generateContentStream('claude-sonnet-4-5', requestBody)) {
        events.push(event);
    }
    return events;
}

describe('Kiro request characterization', () => {
    test('keeps a single user turn in currentMessage and injects the required placeholder tool', async () => {
        const service = createService();
        const request = await service.buildCodewhispererRequest(
            [{ role: 'user', content: [{ type: 'text', text: 'Hello Kiro' }] }],
            'claude-sonnet-4-5',
            null,
            'System instruction'
        );

        const state = request.conversationState;
        const current = state.currentMessage.userInputMessage;
        expect(state.history).toBeUndefined();
        expect(current.modelId).toBe('claude-sonnet-4.5');
        expect(current.content).toContain('System instruction');
        expect(current.content).toContain('Hello Kiro');
        expect(current.content.indexOf('System instruction')).toBeLessThan(current.content.indexOf('Hello Kiro'));
        expect(current.userInputMessageContext.tools).toHaveLength(1);
        expect(current.userInputMessageContext.tools[0].toolSpecification.name).toBe('no_tool_available');
        expect(request._kiroToolNameMaps).toBeDefined();
    });

    test('preserves thinking and tool history while deduplicating results and mapping long tool names', async () => {
        const longName = `mcp__weather__${'x'.repeat(80)}`;
        const messages = [
            { role: 'user', content: 'Weather?' },
            {
                role: 'assistant',
                content: [
                    { type: 'thinking', thinking: 'Need weather' },
                    { type: 'text', text: 'Checking' },
                    { type: 'tool_use', id: 'toolu_1', name: longName, input: { city: 'Paris' } }
                ]
            },
            {
                role: 'user',
                content: [
                    { type: 'tool_result', tool_use_id: 'toolu_1', content: '18C' },
                    { type: 'tool_result', tool_use_id: 'toolu_1', content: '18C' },
                    { type: 'text', text: 'Thanks' }
                ]
            },
            { role: 'assistant', content: 'All done' }
        ];
        const service = createService({ profileArn: 'arn:test' });
        service.profileArn = 'arn:test';
        const request = await service.buildCodewhispererRequest(
            messages,
            'claude-sonnet-4-5',
            [{ name: longName, description: 'Read weather', input_schema: { type: 'object' } }],
            null
        );

        const history = request.conversationState.history;
        expect(history.map((entry) => Object.keys(entry)[0])).toEqual([
            'userInputMessage',
            'assistantResponseMessage',
            'userInputMessage',
            'assistantResponseMessage'
        ]);
        const assistantWithTool = history[1].assistantResponseMessage;
        const kiroName = assistantWithTool.toolUses[0].name;
        expect(kiroName.length).toBeLessThanOrEqual(64);
        expect(request._kiroToolNameMaps.fromKiroName(kiroName)).toBe(longName);
        expect(assistantWithTool.content).toBe('<thinking>Need weather</thinking>\n\nChecking');
        expect(history[2].userInputMessage.userInputMessageContext.toolResults).toHaveLength(1);
        expect(history[3].assistantResponseMessage.content).toBe('All done');
        expect(request.conversationState.currentMessage.userInputMessage.content).toBe('Continue');
        expect(request.profileArn).toBe('arn:test');
        expect(messages[2].content).toHaveLength(3);
    });

    test('rejects an empty message list instead of manufacturing a conversation', async () => {
        const service = createService();
        await expect(service.buildCodewhispererRequest([], 'claude-sonnet-4-5'))
            .rejects.toThrow('No user messages found');
    });
});

describe('Kiro stream characterization', () => {
    test('emits ordered thinking and text blocks across split thinking tags', async () => {
        const service = createService();
        service.streamApiReal = async function* () {
            yield { type: 'content', content: '<thinking>\nThought' };
            yield { type: 'content', content: '</thinking>\n\nAnswer' };
        };

        const events = await collectStream(service, {
            thinking: { type: 'enabled' },
            messages: [{ role: 'user', content: 'hi' }]
        });

        expect(events[0].type).toBe('message_start');
        expect(events.at(-1).type).toBe('message_stop');
        expect(events.filter((event) => event.type === 'message_start')).toHaveLength(1);
        const thinkingDelta = events.find((event) => event.delta?.type === 'thinking_delta' && event.delta.thinking);
        const textDelta = events.find((event) => event.delta?.type === 'text_delta' && event.delta.text === 'Answer');
        expect(thinkingDelta.delta.thinking).toBe('Thought');
        expect(textDelta).toBeDefined();
        expect(events.indexOf(thinkingDelta)).toBeLessThan(events.indexOf(textDelta));
        expect(events.find((event) => event.type === 'message_delta').delta.stop_reason).toBe('end_turn');

        const starts = events.filter((event) => event.type === 'content_block_start');
        const stops = events.filter((event) => event.type === 'content_block_stop');
        for (const start of starts) {
            expect(stops.some((stop) => stop.index === start.index)).toBe(true);
        }
    });

    test('streams tool argument deltas and closes the tool block exactly once', async () => {
        const service = createService();
        service.streamApiReal = async function* () {
            yield { type: 'toolUse', toolUse: { name: 'get_weather', toolUseId: 'tool-1', input: '{"city":' } };
            yield { type: 'toolUseInput', input: '"Paris"}' };
            yield { type: 'toolUseStop', stop: true };
        };

        const events = await collectStream(service);
        const toolStart = events.find((event) => event.content_block?.type === 'tool_use');
        const deltas = events.filter((event) => event.delta?.type === 'input_json_delta');
        const toolStops = events.filter((event) => event.type === 'content_block_stop' && event.index === toolStart.index);

        expect(toolStart.content_block).toMatchObject({ id: 'tool-1', name: 'get_weather' });
        expect(deltas.map((event) => event.delta.partial_json).join('')).toBe('{"city":"Paris"}');
        expect(toolStops).toHaveLength(1);
        expect(events.find((event) => event.type === 'message_delta').delta.stop_reason).toBe('tool_use');
        expect(events.at(-1).type).toBe('message_stop');
    });

    test('withholds message_start and signals a retryable empty response when upstream yields nothing', async () => {
        const service = createService();
        service.streamApiReal = async function* () {};
        const events = [];

        await expect((async () => {
            for await (const event of service.generateContentStream('claude-sonnet-4-5', { messages: [] })) {
                events.push(event);
            }
        })()).rejects.toMatchObject({ isEmptyUpstreamResponse: true });
        expect(events).toEqual([]);
    });
});
