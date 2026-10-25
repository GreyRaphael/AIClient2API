import logger from '../../utils/logger.ts';
import type { DynamicPayload } from '../../../types/dynamic-payload.js';

export const KIRO_PLACEHOLDER_TOOL_NAME = 'no_tool_available';

type KiroMessage = DynamicPayload;

interface KiroToolNameMapper {
    toKiroName(name: string): string;
}

// 判断一个 Anthropic 消息是否"实质为空"：没有非空文本，也没有工具调用/工具结果/图片/思考内容。
// 这类空轮次通常是客户端的占位或流式残留，塞进 Kiro 历史里既会撑大请求体、又可能触发 400，
// 之前的做法是填充 "Continue"，反而污染了上下文。
function isMeaningfulContentPart(part: KiroMessage | null | undefined): boolean {
    if (!part || typeof part !== 'object') return false;
    if (part.type === 'text') {
        return typeof part.text === 'string' && part.text.trim() !== '';
    }
    // tool_use / tool_result / image / thinking / redacted_thinking 及其它未知类型都视为有意义，避免误删数据
    return true;
}

function isEmptyAnthropicMessage(message: KiroMessage | null | undefined): boolean {
    if (!message) return true;
    const content = message.content;
    if (content == null) return true;
    if (typeof content === 'string') return content.trim() === '';
    if (Array.isArray(content)) {
        return content.length === 0 || !content.some(isMeaningfulContentPart);
    }
    return false;
}

function buildKiroPlaceholderTool() {
    return {
        toolSpecification: {
            name: KIRO_PLACEHOLDER_TOOL_NAME,
            description: 'Internal no-op placeholder. Never call this tool (or any tool) in this turn. Do not announce or promise actions such as reading files or running commands. Instead, write your full and complete answer directly as natural-language text in this single reply, based on the information already available to you.',
            inputSchema: {
                json: {
                    type: "object",
                    properties: {}
                }
            }
        }
    };
}

/** 克隆、过滤并合并 Anthropic 历史消息，保持 Kiro 的交替轮次约束。 */
export function normalizeKiroMessages(messages: KiroMessage[]) {
    const processedMessages = messages.map((message: KiroMessage): KiroMessage => ({
        ...message,
        content: Array.isArray(message.content) ? [...message.content] : message.content
    }));

    if (processedMessages.length === 0) {
        throw new Error('No user messages found');
    }

    // 判断最后一条消息是否为 assistant,如果是则移除
    const lastMessage = processedMessages[processedMessages.length - 1];
    if (processedMessages.length > 0 && lastMessage.role === 'assistant') {
        if (lastMessage.content[0].type === "text" && lastMessage.content[0].text === "{") {
            logger.info('[Kiro] Removing last assistant with "{" message from processedMessages');
            processedMessages.pop();
        }
    }

    // 移除实质为空的历史轮次（空文本、无工具调用/结果/图片/思考）。这些空轮次以前会被填成
    // "Continue" 污染上下文并撑大请求体。在合并前移除后，相邻同 role 消息会被下面的合并步骤归并，
    // 因此不会破坏 Kiro 要求的 user/assistant 交替。若过滤后为空则保留原数组，交由后续兜底逻辑处理。
    if (processedMessages.length > 1) {
        const nonEmptyMessages = processedMessages.filter((m: KiroMessage) => !isEmptyAnthropicMessage(m));
        if (nonEmptyMessages.length > 0 && nonEmptyMessages.length < processedMessages.length) {
            logger.info(`[Kiro] Removed ${processedMessages.length - nonEmptyMessages.length} empty message turn(s) before building history`);
            processedMessages.length = 0;
            processedMessages.push(...nonEmptyMessages);
        }
    }

    // 合并相邻相同 role 的消息
    const mergedMessages: KiroMessage[] = [];
    for (let i = 0; i < processedMessages.length; i++) {
        const currentMsg = processedMessages[i];

        if (mergedMessages.length === 0) {
            mergedMessages.push(currentMsg);
        } else {
            const lastMsg = mergedMessages[mergedMessages.length - 1];

            // 判断当前消息和上一条消息是否为相同 role
            if (currentMsg.role === lastMsg.role) {
                // 合并消息内容
                if (Array.isArray(lastMsg.content) && Array.isArray(currentMsg.content)) {
                    // 如果都是数组,合并数组内容
                    lastMsg.content.push(...currentMsg.content);
                } else if (typeof lastMsg.content === 'string' && typeof currentMsg.content === 'string') {
                    // 如果都是字符串,用换行符连接
                    lastMsg.content += '\n' + currentMsg.content;
                } else if (Array.isArray(lastMsg.content) && typeof currentMsg.content === 'string') {
                    // 上一条是数组,当前是字符串,添加为 text 类型
                    lastMsg.content.push({ type: 'text', text: currentMsg.content });
                } else if (typeof lastMsg.content === 'string' && Array.isArray(currentMsg.content)) {
                    // 上一条是字符串,当前是数组,转换为数组格式
                    lastMsg.content = [{ type: 'text', text: lastMsg.content }, ...currentMsg.content];
                }
                // logger.info(`[Kiro] Merged adjacent ${currentMsg.role} messages`);
            } else {
                mergedMessages.push(currentMsg);
            }
        }
    }

    // 用合并后的消息替换原消息数组
    processedMessages.length = 0;
    processedMessages.push(...mergedMessages);
    return processedMessages;
}

/** 构建 Kiro 工具上下文，并在无可用工具时注入协议要求的占位工具。 */
export function buildKiroToolsContext(tools: KiroMessage[] | null, toolNameMaps: KiroToolNameMapper) {
    // 动态压缩 tools（保留全部工具，但过滤掉 web_search/websearch）
    let toolsContext: KiroMessage = {};
    if (tools && Array.isArray(tools) && tools.length > 0) {
        // 过滤掉 web_search 或 websearch 工具（忽略大小写）
        const filteredTools = tools.filter((tool: KiroMessage) => {
            const name = (tool.name || '').toLowerCase();
            const shouldIgnore = name === 'web_search' || name === 'websearch';
            if (shouldIgnore) {
                logger.info(`[Kiro] Ignoring tool: ${tool.name}`);
            }
            return !shouldIgnore;
        });

        if (filteredTools.length === 0) {
            // 所有工具都被过滤掉了，添加一个占位工具
            logger.info('[Kiro] All tools were filtered out, adding placeholder tool');
            toolsContext = { tools: [buildKiroPlaceholderTool()] };
        } else {
            const MAX_DESCRIPTION_LENGTH = 9216;

            let truncatedCount = 0;
            const kiroTools = filteredTools
                .filter((tool: KiroMessage) => {
                    // 过滤掉描述为空的工具
                    if (!tool.description || tool.description.trim() === '') {
                        logger.info(`[Kiro] Ignoring tool with empty description: ${tool.name}`);
                        return false;
                    }
                    return true;
                })
                .map((tool: KiroMessage) => {
                    let desc = tool.description || "";
                    const originalLength = desc.length;

                    if (desc.length > MAX_DESCRIPTION_LENGTH) {
                        desc = desc.substring(0, MAX_DESCRIPTION_LENGTH) + "...";
                        truncatedCount++;
                        logger.info(`[Kiro] Truncated tool '${tool.name}' description: ${originalLength} -> ${desc.length} chars`);
                    }

                    const entry = {
                        toolSpecification: {
                            name: toolNameMaps.toKiroName(tool.name),
                            description: desc,
                            inputSchema: {
                                json: tool.input_schema || {}
                            }
                        }
                    };
                    return tool.cache_control
                        ? [entry, { cachePoint: { type: "default" } }]
                        : [entry];
                }).flat();

            if (truncatedCount > 0) {
                logger.info(`[Kiro] Truncated ${truncatedCount} tool description(s) to max ${MAX_DESCRIPTION_LENGTH} chars`);
            }

            // 检查过滤后是否还有有效工具
            if (kiroTools.length === 0) {
                logger.info('[Kiro] All tools were filtered out (empty descriptions), adding placeholder tool');
                toolsContext = { tools: [buildKiroPlaceholderTool()] };
            } else {
                toolsContext = { tools: kiroTools };
            }
        }
    } else {
        // tools 为空或长度为 0 时，自动添加一个占位工具
        logger.info('[Kiro] No tools provided, adding placeholder tool');
        toolsContext = { tools: [buildKiroPlaceholderTool()] };
    }
    return toolsContext;
}
