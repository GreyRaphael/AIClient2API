/**
 * Google Gemini GenerateContent 协议类型声明
 */

export interface GeminiBlob {
    mimeType: string;
    data: string;
}

export interface GeminiFileData {
    mimeType?: string;
    fileUri: string;
}

export interface GeminiFunctionCall {
    name: string;
    args: Record<string, any>;
}

export interface GeminiFunctionResponse {
    name: string;
    response: Record<string, any>;
}

export interface GeminiExecutableCode {
    language: 'LANGUAGE_UNSPECIFIED' | 'PYTHON' | string;
    code: string;
}

export interface GeminiCodeExecutionResult {
    outcome: 'OUTCOME_UNSPECIFIED' | 'OUTCOME_OK' | 'OUTCOME_FAILED' | 'OUTCOME_DEADLINE_EXCEEDED' | string;
    output: string;
}

export interface GeminiPart {
    text?: string;
    thought?: boolean;
    inlineData?: GeminiBlob;
    fileData?: GeminiFileData;
    functionCall?: GeminiFunctionCall;
    functionResponse?: GeminiFunctionResponse;
    executableCode?: GeminiExecutableCode;
    codeExecutionResult?: GeminiCodeExecutionResult;
    [key: string]: any;
}

export interface GeminiContent {
    role?: 'user' | 'model' | 'system' | string;
    parts: GeminiPart[];
}

export interface GeminiFunctionDeclaration {
    name: string;
    description?: string;
    parameters?: Record<string, any>;
    parametersJsonSchema?: Record<string, any>;
}

export interface GeminiTool {
    functionDeclarations?: GeminiFunctionDeclaration[];
    codeExecution?: Record<string, any>;
    googleSearch?: Record<string, any>;
    googleSearchRetrieval?: Record<string, any>;
    [key: string]: any;
}

export interface GeminiFunctionCallingConfig {
    mode?: 'MODE_UNSPECIFIED' | 'AUTO' | 'ANY' | 'NONE' | 'auto' | 'any' | 'none';
    allowedFunctionNames?: string[];
}

export interface GeminiToolConfig {
    functionCallingConfig?: GeminiFunctionCallingConfig;
    [key: string]: any;
}

export interface GeminiSafetySetting {
    category: string;
    threshold: string;
}

export interface GeminiThinkingConfig {
    thinkingBudget?: number;
    includeThoughts?: boolean;
}

export interface GeminiImageConfig {
    aspectRatio?: string;
    imageFormat?: string;
}

export interface GeminiGenerationConfig {
    temperature?: number;
    topP?: number;
    topK?: number;
    candidateCount?: number;
    maxOutputTokens?: number;
    stopSequences?: string[];
    responseMimeType?: string;
    responseSchema?: Record<string, any>;
    thinkingConfig?: GeminiThinkingConfig;
    imageConfig?: GeminiImageConfig;
    [key: string]: any;
}

export interface GeminiGenerateContentRequest {
    contents: GeminiContent[];
    tools?: GeminiTool[];
    toolConfig?: GeminiToolConfig;
    safetySettings?: GeminiSafetySetting[];
    systemInstruction?: GeminiContent;
    generationConfig?: GeminiGenerationConfig;
    model?: string;
    [key: string]: any;
}

export interface GeminiCandidate {
    content?: GeminiContent;
    finishReason?: 'FINISH_REASON_UNSPECIFIED' | 'STOP' | 'MAX_TOKENS' | 'SAFETY' | 'RECITATION' | 'OTHER' | string;
    index?: number;
    safetyRatings?: any[];
    citationMetadata?: any;
    groundingMetadata?: any;
    [key: string]: any;
}

export interface GeminiUsageMetadata {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    cachedContentTokenCount?: number;
}

export interface GeminiGenerateContentResponse {
    candidates?: GeminiCandidate[];
    promptFeedback?: any;
    usageMetadata?: GeminiUsageMetadata;
    modelVersion?: string;
    [key: string]: any;
}

export type GeminiStreamChunk = GeminiGenerateContentResponse;
