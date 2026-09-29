import {
    isOpenAIRequest,
    isClaudeRequest,
    isGeminiRequest,
    isOpenAIResponsesRequest,
    validateToolSchema
} from '../src/converters/type-guards.js';

describe('Cross-Protocol Type Guards & Schema Validation', () => {
    describe('isOpenAIRequest', () => {
        test('identifies valid OpenAI chat completion requests', () => {
            expect(isOpenAIRequest({
                model: 'gpt-4o',
                messages: [{ role: 'user', content: 'hello' }]
            })).toBe(true);

            expect(isOpenAIRequest({
                model: 'gpt-4o',
                messages: []
            })).toBe(true);
        });

        test('rejects non-OpenAI requests and invalid types', () => {
            expect(isOpenAIRequest(null)).toBe(false);
            expect(isOpenAIRequest(undefined)).toBe(false);
            expect(isOpenAIRequest('string')).toBe(false);
            expect(isOpenAIRequest({ model: 'gpt-4o' })).toBe(false);
            expect(isOpenAIRequest({ messages: 'not an array' })).toBe(false);
            expect(isOpenAIRequest({ messages: [{ noRole: 'here' }] })).toBe(false);
        });
    });

    describe('isClaudeRequest', () => {
        test('identifies valid Claude messages requests', () => {
            expect(isClaudeRequest({
                model: 'claude-3-5-sonnet-20241022',
                messages: [{ role: 'user', content: 'hello' }]
            })).toBe(true);

            expect(isClaudeRequest({
                model: 'claude-3-5-sonnet-20241022',
                messages: [{ role: 'assistant', content: 'hi' }]
            })).toBe(true);
        });

        test('rejects empty or invalid Claude requests', () => {
            expect(isClaudeRequest(null)).toBe(false);
            expect(isClaudeRequest({ messages: [] })).toBe(false);
            expect(isClaudeRequest({ messages: [{ role: 'system', content: 'prompt' }] })).toBe(false);
            expect(isClaudeRequest({ model: 'claude' })).toBe(false);
        });
    });

    describe('isGeminiRequest', () => {
        test('identifies valid Gemini generateContent requests', () => {
            expect(isGeminiRequest({
                contents: [{
                    role: 'user',
                    parts: [{ text: 'hello' }]
                }]
            })).toBe(true);

            expect(isGeminiRequest({
                contents: []
            })).toBe(true);
        });

        test('rejects invalid Gemini requests', () => {
            expect(isGeminiRequest(null)).toBe(false);
            expect(isGeminiRequest({})).toBe(false);
            expect(isGeminiRequest({ contents: [{ role: 'user' }] })).toBe(false);
            expect(isGeminiRequest({ contents: 'not an array' })).toBe(false);
        });
    });

    describe('isOpenAIResponsesRequest', () => {
        test('identifies valid OpenAI responses requests', () => {
            expect(isOpenAIResponsesRequest({
                model: 'gpt-4o',
                input: 'generate a greeting'
            })).toBe(true);

            expect(isOpenAIResponsesRequest({
                model: 'gpt-4o',
                instructions: 'system instructions'
            })).toBe(true);
        });

        test('rejects standard Chat Completion or empty payloads', () => {
            expect(isOpenAIResponsesRequest(null)).toBe(false);
            expect(isOpenAIResponsesRequest({ messages: [{ role: 'user' }] })).toBe(false);
            expect(isOpenAIResponsesRequest({})).toBe(false);
        });
    });

    describe('validateToolSchema', () => {
        test('validates OpenAI tool schema', () => {
            const validTool = {
                type: 'function',
                function: {
                    name: 'get_weather',
                    parameters: { type: 'object', properties: {} }
                }
            };
            expect(validateToolSchema(validTool, 'openai')).toEqual({ valid: true, errors: [] });

            const invalidType = { type: 'not_function', function: { name: 'fn' } };
            expect(validateToolSchema(invalidType, 'openai').valid).toBe(false);

            const missingFn = { type: 'function' };
            expect(validateToolSchema(missingFn, 'openai').valid).toBe(false);

            const invalidName = { type: 'function', function: { name: 123 } };
            expect(validateToolSchema(invalidName, 'openai').valid).toBe(false);
        });

        test('validates Claude tool schema', () => {
            const validTool = {
                name: 'get_weather',
                input_schema: {
                    type: 'object',
                    properties: { location: { type: 'string' } }
                }
            };
            expect(validateToolSchema(validTool, 'claude')).toEqual({ valid: true, errors: [] });

            const missingName = { input_schema: { type: 'object' } };
            expect(validateToolSchema(missingName, 'claude').valid).toBe(false);

            const invalidSchemaType = { name: 'test', input_schema: { type: 'array' } };
            expect(validateToolSchema(invalidSchemaType, 'claude').valid).toBe(false);
        });

        test('validates Gemini tool schema', () => {
            const validTool = {
                functionDeclarations: [
                    { name: 'get_weather', parameters: { type: 'OBJECT' } }
                ]
            };
            expect(validateToolSchema(validTool, 'gemini')).toEqual({ valid: true, errors: [] });

            const invalidFn = {
                functionDeclarations: [
                    { name: '' }
                ]
            };
            expect(validateToolSchema(invalidFn, 'gemini').valid).toBe(false);

            const invalidDeclarations = { functionDeclarations: 'not-array' };
            expect(validateToolSchema(invalidDeclarations, 'gemini').valid).toBe(false);
        });
    });
});
