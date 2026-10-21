/**
 * Phase 4 可选增强测试套件
 * 
 * 覆盖：
 * 1. 连续相同角色 Content 合并公共提取（mergeConsecutiveSameRoleContents 纯函数及三协议端到端接入）
 * 2. 工具列表确定性排序（sortToolsByName、isSortToolsEnabled 与全转换器端到端接入）
 * 3. Claude cache_control 跨协议转换日志化（logOmittedCacheControl）
 */

import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import logger from '../src/utils/logger.js';
import configManager from '../src/core/config-manager.js';
import {
    mergeConsecutiveSameRoleContents,
    isSortToolsEnabled,
    sortToolsByName,
    logOmittedCacheControl
} from '../src/converters/utils.js';
import { OpenAIConverter } from '../src/converters/strategies/OpenAIConverter.js';
import { ClaudeConverter } from '../src/converters/strategies/ClaudeConverter.js';
import { OpenAIResponsesConverter } from '../src/converters/strategies/OpenAIResponsesConverter.js';
import { CodexConverter } from '../src/converters/strategies/CodexConverter.js';

describe('Phase 4: 跨协议可选增强测试套件', () => {
    let originalEnv;

    beforeEach(() => {
        originalEnv = process.env.CONVERT_SORT_TOOLS;
    });

    afterEach(() => {
        if (originalEnv !== undefined) {
            process.env.CONVERT_SORT_TOOLS = originalEnv;
        } else {
            delete process.env.CONVERT_SORT_TOOLS;
        }
    });

    describe('4.1 连续相同角色 Content 合并 (mergeConsecutiveSameRoleContents)', () => {
        test('空或无效输入返回空数组', () => {
            expect(mergeConsecutiveSameRoleContents(null)).toEqual([]);
            expect(mergeConsecutiveSameRoleContents(undefined)).toEqual([]);
            expect(mergeConsecutiveSameRoleContents([])).toEqual([]);
            expect(mergeConsecutiveSameRoleContents('not-an-array')).toEqual([]);
        });

        test('过滤没有 parts 或 parts 为空的无效项', () => {
            const input = [
                { role: 'user', parts: [] },
                { role: 'user', parts: [{ text: 'hello' }] },
                { role: 'model', invalid: true },
                null
            ];
            const result = mergeConsecutiveSameRoleContents(input);
            expect(result).toHaveLength(1);
            expect(result[0]).toEqual({
                role: 'user',
                parts: [{ text: 'hello' }]
            });
        });

        test('合并连续相同角色的 parts，并保持独立副本', () => {
            const input = [
                { role: 'user', parts: [{ text: 'part 1' }] },
                { role: 'user', parts: [{ text: 'part 2' }, { text: 'part 3' }] },
                { role: 'model', parts: [{ text: 'reply 1' }] },
                { role: 'model', parts: [{ text: 'reply 2' }] },
                { role: 'user', parts: [{ text: 'follow up' }] }
            ];

            const result = mergeConsecutiveSameRoleContents(input);
            expect(result).toHaveLength(3);
            expect(result[0].role).toBe('user');
            expect(result[0].parts).toEqual([
                { text: 'part 1' },
                { text: 'part 2' },
                { text: 'part 3' }
            ]);
            expect(result[1].role).toBe('model');
            expect(result[1].parts).toEqual([
                { text: 'reply 1' },
                { text: 'reply 2' }
            ]);
            expect(result[2].role).toBe('user');
            expect(result[2].parts).toEqual([{ text: 'follow up' }]);
        });

        test('支持通过 rolePair 映射归一化角色后合并', () => {
            const rolePair = {
                assistant: 'model',
                model: 'model',
                user: 'user'
            };
            const input = [
                { role: 'user', parts: [{ text: 'hi' }] },
                { role: 'assistant', parts: [{ text: 'chunk 1' }] },
                { role: 'model', parts: [{ text: 'chunk 2' }] }
            ];
            const result = mergeConsecutiveSameRoleContents(input, rolePair);
            expect(result).toHaveLength(2);
            expect(result[0].role).toBe('user');
            expect(result[1].role).toBe('model');
            expect(result[1].parts).toHaveLength(2);
        });

        test('端到端集成：OpenAIConverter.toGeminiRequest 连续 user/assistant 消息合并', () => {
            const converter = new OpenAIConverter();
            const openaiReq = {
                model: 'gemini-3.8-flash-high',
                messages: [
                    { role: 'user', content: 'hello' },
                    { role: 'user', content: 'world' },
                    { role: 'assistant', content: 'answering' }
                ]
            };
            const geminiReq = converter.toGeminiRequest(openaiReq);
            expect(geminiReq.contents).toHaveLength(2);
            expect(geminiReq.contents[0].role).toBe('user');
            expect(geminiReq.contents[0].parts).toEqual([
                { text: 'hello' },
                { text: 'world' }
            ]);
            expect(geminiReq.contents[1].role).toBe('model');
            expect(geminiReq.contents[1].parts).toEqual([{ text: 'answering' }]);
        });

        test('端到端集成：ClaudeConverter.toGeminiRequest 连续相同角色消息合并', () => {
            const converter = new ClaudeConverter();
            const claudeReq = {
                model: 'gemini-3.8-flash-high',
                messages: [
                    { role: 'user', content: 'query 1' },
                    { role: 'user', content: 'query 2' },
                    { role: 'assistant', content: 'answer 1' },
                    { role: 'assistant', content: 'answer 2' }
                ]
            };
            const geminiReq = converter.toGeminiRequest(claudeReq);
            expect(geminiReq.contents).toHaveLength(2);
            expect(geminiReq.contents[0].role).toBe('user');
            expect(geminiReq.contents[0].parts).toEqual([
                { text: 'query 1' },
                { text: 'query 2' }
            ]);
            expect(geminiReq.contents[1].role).toBe('model');
            expect(geminiReq.contents[1].parts).toEqual([
                { text: 'answer 1' },
                { text: 'answer 2' }
            ]);
        });

        test('端到端集成：OpenAIResponsesConverter.toGeminiRequest 连续相同角色消息合并', () => {
            const converter = new OpenAIResponsesConverter();
            const responsesReq = {
                model: 'gemini-3.8-flash-high',
                input: [
                    {
                        type: 'message',
                        role: 'user',
                        content: [{ type: 'input_text', text: 'part A' }]
                    },
                    {
                        type: 'message',
                        role: 'user',
                        content: [{ type: 'input_text', text: 'part B' }]
                    }
                ]
            };
            const geminiReq = converter.toGeminiRequest(responsesReq);
            expect(geminiReq.contents).toHaveLength(1);
            expect(geminiReq.contents[0].role).toBe('user');
            expect(geminiReq.contents[0].parts).toEqual([
                { text: 'part A' },
                { text: 'part B' }
            ]);
        });
    });

    describe('4.2 工具列表确定性排序 (sortToolsByName)', () => {
        test('开关识别：默认关闭，支持环境变量 true/1/on 开启', () => {
            delete process.env.CONVERT_SORT_TOOLS;
            expect(isSortToolsEnabled()).toBe(false);

            process.env.CONVERT_SORT_TOOLS = 'true';
            expect(isSortToolsEnabled()).toBe(true);

            process.env.CONVERT_SORT_TOOLS = '1';
            expect(isSortToolsEnabled()).toBe(true);

            process.env.CONVERT_SORT_TOOLS = 'on';
            expect(isSortToolsEnabled()).toBe(true);

            process.env.CONVERT_SORT_TOOLS = 'false';
            expect(isSortToolsEnabled()).toBe(false);

            process.env.CONVERT_SORT_TOOLS = '0';
            expect(isSortToolsEnabled()).toBe(false);
        });

        test('关闭状态下，保持原顺序不改变', () => {
            process.env.CONVERT_SORT_TOOLS = 'false';
            const tools = [
                { name: 'zeta' },
                { name: 'alpha' },
                { name: 'beta' }
            ];
            const sorted = sortToolsByName(tools);
            expect(sorted.map(t => t.name)).toEqual(['zeta', 'alpha', 'beta']);
        });

        test('开启状态下，支持各种协议工具格式按 name 稳定升序排序', () => {
            process.env.CONVERT_SORT_TOOLS = 'true';

            // Claude / Responses 格式: { name }
            const claudeTools = [
                { name: 'write_file' },
                { name: 'bash' },
                { name: 'read_file' }
            ];
            expect(sortToolsByName(claudeTools).map(t => t.name)).toEqual(['bash', 'read_file', 'write_file']);

            // OpenAI 格式: { function: { name } }
            const openaiTools = [
                { type: 'function', function: { name: 'query_db' } },
                { type: 'function', function: { name: 'analyze_ast' } },
                { type: 'function', function: { name: 'fetch_url' } }
            ];
            expect(sortToolsByName(openaiTools).map(t => t.function.name)).toEqual(['analyze_ast', 'fetch_url', 'query_db']);

            // Gemini functionDeclarations 顶层包装格式: { functionDeclarations: [{ name }] }
            const geminiTools = [
                { functionDeclarations: [{ name: 'tool_z' }] },
                { functionDeclarations: [{ name: 'tool_a' }] }
            ];
            expect(sortToolsByName(geminiTools).map(t => t.functionDeclarations[0].name)).toEqual(['tool_a', 'tool_z']);
        });

        test('边界情况：空或单元素数组直接返回', () => {
            process.env.CONVERT_SORT_TOOLS = 'true';
            expect(sortToolsByName([])).toEqual([]);
            expect(sortToolsByName(null)).toEqual([]);
            const single = [{ name: 'only' }];
            expect(sortToolsByName(single)).toEqual(single);
        });

        test('端到端集成：OpenAIConverter 转换 tools 时受开关控制', () => {
            const converter = new OpenAIConverter();
            const inputTools = [
                { type: 'function', function: { name: 'z_tool', description: 'z' } },
                { type: 'function', function: { name: 'a_tool', description: 'a' } }
            ];

            // 1. 关闭时顺序保持原样
            process.env.CONVERT_SORT_TOOLS = 'false';
            const claudeReqUnsorted = converter.toClaudeRequest({ model: 'claude-sonnet-4-6', messages: [], tools: inputTools });
            expect(claudeReqUnsorted.tools.map(t => t.name)).toEqual(['z_tool', 'a_tool']);

            const geminiReqUnsorted = converter.toGeminiRequest({ model: 'gemini-3.8-flash-high', messages: [], tools: inputTools });
            expect(geminiReqUnsorted.tools[0].functionDeclarations.map(t => t.name)).toEqual(['z_tool', 'a_tool']);

            const respReqUnsorted = converter.toOpenAIResponsesRequest({ model: 'gpt-5.5', messages: [], tools: inputTools });
            expect(respReqUnsorted.tools.map(t => t.name)).toEqual(['z_tool', 'a_tool']);

            // 2. 开启时顺序按 name 升序排序
            process.env.CONVERT_SORT_TOOLS = 'true';
            const claudeReqSorted = converter.toClaudeRequest({ model: 'claude-sonnet-4-6', messages: [], tools: inputTools });
            expect(claudeReqSorted.tools.map(t => t.name)).toEqual(['a_tool', 'z_tool']);

            const geminiReqSorted = converter.toGeminiRequest({ model: 'gemini-3.8-flash-high', messages: [], tools: inputTools });
            expect(geminiReqSorted.tools[0].functionDeclarations.map(t => t.name)).toEqual(['a_tool', 'z_tool']);

            const respReqSorted = converter.toOpenAIResponsesRequest({ model: 'gpt-5.5', messages: [], tools: inputTools });
            expect(respReqSorted.tools.map(t => t.name)).toEqual(['a_tool', 'z_tool']);
        });

        test('端到端集成：ClaudeConverter 转换 tools 时受开关控制', () => {
            const converter = new ClaudeConverter();
            const claudeTools = [
                { name: 'update_user', description: 'update', input_schema: { type: 'object' } },
                { name: 'create_user', description: 'create', input_schema: { type: 'object' } }
            ];

            // 开启排序
            process.env.CONVERT_SORT_TOOLS = 'true';

            // Claude -> OpenAI
            const oaiReq = converter.toOpenAIRequest({ model: 'gpt-5.5', messages: [], tools: claudeTools });
            expect(oaiReq.tools.map(t => t.function.name)).toEqual(['create_user', 'update_user']);

            // Claude -> Gemini
            const geminiReq = converter.toGeminiRequest({ model: 'gemini-3.8-flash-high', messages: [], tools: claudeTools });
            expect(geminiReq.tools[0].functionDeclarations.map(t => t.name)).toEqual(['create_user', 'update_user']);

            // Claude -> Responses
            const respReq = converter.toOpenAIResponsesRequest({ model: 'gpt-5.5', messages: [], tools: claudeTools });
            expect(respReq.tools.map(t => t.name)).toEqual(['create_user', 'update_user']);

            // Claude -> Codex
            const codexReq = converter.toCodexRequest({ model: 'codex', messages: [], tools: claudeTools });
            expect(codexReq.tools.map(t => t.name)).toEqual(['create_user', 'update_user']);
        });

        test('端到端集成：OpenAIResponsesConverter 排序接入验证', () => {
            process.env.CONVERT_SORT_TOOLS = 'true';

            const respConverter = new OpenAIResponsesConverter();
            const respTools = [
                { type: 'function', name: 'search_logs' },
                { type: 'function', name: 'delete_logs' }
            ];

            const oaiReq = respConverter.toOpenAIRequest({ model: 'gpt-5.5', input: [], tools: respTools });
            expect(oaiReq.tools.map(t => t.function.name)).toEqual(['delete_logs', 'search_logs']);

            const claudeReq = respConverter.toClaudeRequest({ model: 'claude-sonnet-4-6', input: [], tools: respTools });
            expect(claudeReq.tools.map(t => t.name)).toEqual(['delete_logs', 'search_logs']);

            const geminiReq = respConverter.toGeminiRequest({ model: 'gemini-3.8-flash-high', input: [], tools: respTools });
            expect(geminiReq.tools[0].functionDeclarations.map(t => t.name)).toEqual(['delete_logs', 'search_logs']);
        });
    });

    describe('4.3 Claude cache_control 显式降级与日志化 (logOmittedCacheControl)', () => {
        let debugSpy;

        beforeEach(() => {
            debugSpy = jest.spyOn(logger, 'debug').mockImplementation(() => {});
        });

        afterEach(() => {
            debugSpy.mockRestore();
        });

        test('当包含 cache_control 时输出 debug 日志', () => {
            logOmittedCacheControl('Test location', {
                type: 'text',
                text: 'content',
                cache_control: { type: 'ephemeral' }
            });
            expect(debugSpy).toHaveBeenCalledTimes(1);
            expect(debugSpy).toHaveBeenCalledWith(
                expect.stringContaining('[CacheControl] cache_control omitted during conversion at Test location')
            );
        });

        test('当不包含 cache_control 或非对象时不输出日志', () => {
            logOmittedCacheControl('Test location', { type: 'text', text: 'content' });
            logOmittedCacheControl('Test location', null);
            logOmittedCacheControl('Test location', 'string');
            expect(debugSpy).not.toHaveBeenCalled();
        });

        test('端到端集成：Claude 转换至 OpenAI 时，丢弃的 cache_control 触发日志', () => {
            const converter = new ClaudeConverter();
            const claudeReq = {
                model: 'gpt-5.5',
                system: [
                    { type: 'text', text: 'System prompt', cache_control: { type: 'ephemeral' } }
                ],
                messages: [
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: 'Prompt with cache control', cache_control: { type: 'ephemeral' } }
                        ]
                    }
                ],
                tools: [
                    {
                        name: 'cached_tool',
                        description: 'test',
                        input_schema: { type: 'object' },
                        cache_control: { type: 'ephemeral' }
                    }
                ]
            };

            converter.toOpenAIRequest(claudeReq);
            // 应该分别记录 system、message content 与 tool 的 cache_control 丢弃
            const calls = debugSpy.mock.calls.map(c => c[0]);
            expect(calls.some(msg => msg.includes('Claude->OpenAI system'))).toBe(true);
            expect(calls.some(msg => msg.includes('Claude->OpenAI message content'))).toBe(true);
            expect(calls.some(msg => msg.includes('Claude->OpenAI tool'))).toBe(true);
        });

        test('端到端集成：Claude 转换至 Gemini 时，丢弃的 cache_control 触发日志', () => {
            const converter = new ClaudeConverter();
            const claudeReq = {
                model: 'gemini-3.8-flash-high',
                system: [
                    { type: 'text', text: 'System prompt', cache_control: { type: 'ephemeral' } }
                ],
                messages: [
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: 'User message', cache_control: { type: 'ephemeral' } }
                        ]
                    }
                ],
                tools: [
                    {
                        name: 'cached_tool',
                        description: 'test',
                        input_schema: { type: 'object' },
                        cache_control: { type: 'ephemeral' }
                    }
                ]
            };

            converter.toGeminiRequest(claudeReq);
            const calls = debugSpy.mock.calls.map(c => c[0]);
            expect(calls.some(msg => msg.includes('Claude->Gemini system'))).toBe(true);
            expect(calls.some(msg => msg.includes('Claude->Gemini message content'))).toBe(true);
            expect(calls.some(msg => msg.includes('Claude->Gemini tool'))).toBe(true);
        });
    });

    describe('4.4 Codex reasoning effort 透传', () => {
        test('显式 null 不写入 effort，显式等级原样保留', () => {
            const converter = new CodexConverter();

            const fromResponses = converter.toOpenAIResponsesToCodexRequest({
                model: 'gpt-5',
                input: [],
                reasoning_effort: null
            }, 'test-null');
            expect(fromResponses.reasoning.effort).toBeUndefined();

            const fromOpenAI = converter.toOpenAIRequestToCodexRequest({
                model: 'gpt-5',
                messages: [],
                reasoning_effort: null
            }, 'test-null');
            expect(fromOpenAI.reasoning.effort).toBeUndefined();

            const explicit = converter.toOpenAIResponsesToCodexRequest({
                model: 'gpt-5',
                input: [],
                reasoning_effort: 'high'
            }, 'test-high');
            expect(explicit.reasoning.effort).toBe('high');
        });
    });
});
