import { isWhitespaceOnly } from './kiro-stream-parser.ts';
import type { ClaudeStreamEvent } from '../../../types/protocols/claude.js';

export interface KiroClaudeStreamState {
    thinkingRequested: boolean;
    buffer: string;
    pendingTextBeforeThinking: string;
    inThinking: boolean;
    thinkingExtracted: boolean;
    thinkingBlockIndex: number | null;
    textBlockIndex: number | null;
    nextBlockIndex: number;
    stoppedBlocks: Set<number>;
    stripThinkingLeadingNewline: boolean;
    stripTextLeadingNewlinesAfterThinking: boolean;
    hasVisibleText: boolean;
    hasThinkingContent: boolean;
    ensureBlockStart(blockType: string): ClaudeStreamEvent[];
    stopBlock(index: number | null): ClaudeStreamEvent[];
    createTextDeltaEvents(text: string): ClaudeStreamEvent[];
    createThinkingDeltaEvents(thinking: string): ClaudeStreamEvent[];
}

/** 维护 Kiro → Claude 流的内容块生命周期，避免文本、思考和工具块重叠。 */
export function createKiroClaudeStreamState(thinkingRequested: boolean): KiroClaudeStreamState {
    const streamState: KiroClaudeStreamState = {
        thinkingRequested,
        buffer: '',
        pendingTextBeforeThinking: '',
        inThinking: false,
        thinkingExtracted: false,
        thinkingBlockIndex: null,
        textBlockIndex: null,
        nextBlockIndex: 0,
        stoppedBlocks: new Set(),
        stripThinkingLeadingNewline: false,
        stripTextLeadingNewlinesAfterThinking: false,
        hasVisibleText: false,
        hasThinkingContent: false,

        ensureBlockStart(blockType: string): ClaudeStreamEvent[] {
            if (blockType === 'thinking') {
                if (streamState.thinkingBlockIndex != null &&
                    !streamState.stoppedBlocks.has(streamState.thinkingBlockIndex)) return [];
                const idx = streamState.nextBlockIndex++;
                streamState.thinkingBlockIndex = idx;
                return [{
                    type: 'content_block_start',
                    index: idx,
                    content_block: { type: 'thinking', thinking: '' }
                }];
            }
            if (blockType === 'text') {
                if (streamState.textBlockIndex != null &&
                    !streamState.stoppedBlocks.has(streamState.textBlockIndex)) return [];
                const idx = streamState.nextBlockIndex++;
                streamState.textBlockIndex = idx;
                return [{
                    type: 'content_block_start',
                    index: idx,
                    content_block: { type: 'text', text: '' }
                }];
            }
            return [];
        },

        stopBlock(index: number | null): ClaudeStreamEvent[] {
            if (index == null) return [];
            if (streamState.stoppedBlocks.has(index)) return [];
            streamState.stoppedBlocks.add(index);
            return [{ type: 'content_block_stop', index }];
        },

        createTextDeltaEvents(text: string): ClaudeStreamEvent[] {
            if (!text) return [];
            if (!isWhitespaceOnly(text)) {
                streamState.hasVisibleText = true;
            }
            const events: ClaudeStreamEvent[] = [];
            // Anthropic 内容块不能重叠；正文开始前先关闭仍处于打开状态的思考块。
            events.push(...streamState.stopBlock(streamState.thinkingBlockIndex));
            events.push(...streamState.ensureBlockStart('text'));
            const decodedText = text.replace(/(?<!\\)\\n/g, '\n');
            events.push({
                type: 'content_block_delta',
                index: streamState.textBlockIndex,
                delta: { type: 'text_delta', text: decodedText }
            });
            return events;
        },

        createThinkingDeltaEvents(thinking: string): ClaudeStreamEvent[] {
            if (thinking) {
                streamState.hasThinkingContent = true;
            }
            const events: ClaudeStreamEvent[] = [];
            // 兼容内联 <thinking> 出现在正文后的情况，保证任一时刻只有一个内容块打开。
            events.push(...streamState.stopBlock(streamState.textBlockIndex));
            events.push(...streamState.ensureBlockStart('thinking'));
            const decodedThinking = thinking.replace(/(?<!\\)\\n/g, '\n');
            events.push({
                type: 'content_block_delta',
                index: streamState.thinkingBlockIndex,
                delta: { type: 'thinking_delta', thinking: decodedThinking }
            });
            return events;
        }
    };

    return streamState;
}
