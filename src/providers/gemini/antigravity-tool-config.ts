import type { DynamicPayload } from '../../../types/dynamic-payload.js';

const ANTIGRAVITY_SERVER_SIDE_TOOL_FIELDS = [
    'googleSearch',
    'googleSearchRetrieval',
    'urlContext',
    'googleMaps',
    'fileSearch',
    'codeExecution',
    'google_search',
    'google_search_retrieval',
    'url_context',
    'google_maps',
    'file_search',
    'code_execution'
];

function hasAntigravityFunctionDeclarations(tools: DynamicPayload[] | null | undefined): boolean {
    return Array.isArray(tools) && tools.some((tool: DynamicPayload) =>
        Array.isArray(tool?.functionDeclarations) && tool.functionDeclarations.length > 0
    );
}

function hasAntigravityServerSideTools(tools: DynamicPayload[] | null | undefined): boolean {
    return Array.isArray(tools) && tools.some((tool: DynamicPayload) => {
        if (!tool || typeof tool !== 'object') return false;
        return ANTIGRAVITY_SERVER_SIDE_TOOL_FIELDS.some((field: string) =>
            Object.prototype.hasOwnProperty.call(tool, field)
        );
    });
}

function removeAntigravityServerSideToolFields(tool: DynamicPayload | null | undefined): DynamicPayload | null | undefined {
    if (!tool || typeof tool !== 'object') return tool;
    const cleaned: DynamicPayload = { ...tool };
    ANTIGRAVITY_SERVER_SIDE_TOOL_FIELDS.forEach((field: string) => {
        delete cleaned[field];
    });
    return cleaned;
}

function stripServerSideToolsWhenFunctionCalling(request: DynamicPayload): void {
    if (!hasAntigravityFunctionDeclarations(request.tools) ||
        !hasAntigravityServerSideTools(request.tools)) {
        return;
    }

    request.tools = request.tools
        .map((tool: DynamicPayload) => removeAntigravityServerSideToolFields(tool))
        .filter((tool: DynamicPayload | null | undefined): tool is DynamicPayload => Boolean(tool && Object.keys(tool).length > 0));
}

function normalizeAntigravityToolConfigShape(toolConfig: DynamicPayload | null | undefined): void {
    if (!toolConfig || typeof toolConfig !== 'object') return;

    if (toolConfig.function_calling_config && !toolConfig.functionCallingConfig) {
        toolConfig.functionCallingConfig = toolConfig.function_calling_config;
    }
    delete toolConfig.function_calling_config;

    delete toolConfig.includeServerSideToolInvocations;
    delete toolConfig.include_server_side_tool_invocations;
}

export function normalizeAntigravityToolConfig(request: DynamicPayload | null | undefined, isClaudeModel = false): void {
    if (!request || typeof request !== 'object') return;

    stripServerSideToolsWhenFunctionCalling(request);

    if (request.tool_config && !request.toolConfig) {
        request.toolConfig = request.tool_config;
    }
    delete request.tool_config;

    if (request.toolConfig) {
        normalizeAntigravityToolConfigShape(request.toolConfig);
    }

    if (request.toolConfig && isClaudeModel) {
        if (!request.toolConfig.functionCallingConfig) {
            request.toolConfig.functionCallingConfig = {};
        }
        request.toolConfig.functionCallingConfig.mode = 'VALIDATED';
    }

    if (request.toolConfig && Object.keys(request.toolConfig).length === 0) {
        delete request.toolConfig;
    }
}
