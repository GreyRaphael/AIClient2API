/**
 * 自定义模型的路由解析与模型列表拼装。
 *
 * 从 request-pipeline.ts 拆出。这部分只做纯数据变换
 * （读 config.customModels → 产出 provider/actualModel 映射，或把自定义模型
 * 追加进 /v1/models 的响应体），不碰任何网络、串行化或错误处理，
 * 因此与「请求管线」耦合度为零，是最干净的一刀。
 */

import { MODEL_PROVIDER } from '../../utils/constants.ts';
import { ENDPOINT_TYPE } from '../../utils/protocol.ts';
import {
    getCustomModelConfig,
    getCustomModelActualProvider,
    getCustomModelListProvider
} from '../../providers/provider-models.ts';
import { applyCustomModelMetadata } from '../../providers/custom-model-metadata.ts';
import type { DynamicPayload } from '../../../types/dynamic-payload.js';

export function getCustomModelEntriesForProvider(
    config: DynamicPayload | null | undefined,
    providerType: string | null = null,
    options: DynamicPayload = {}
): DynamicPayload[] {
    const customModels: DynamicPayload[] = Array.isArray(config?.customModels) ? config.customModels : [];
    const entries: DynamicPayload[] = [];

    customModels.forEach((modelConfig: DynamicPayload) => {
        if (!modelConfig?.id || modelConfig.enabled === false) {
            return;
        }

        const modelProvider = getCustomModelListProvider(modelConfig);
        const actualProvider = getCustomModelActualProvider(modelConfig);
        const isMatch = !providerType ||
            modelProvider === providerType ||
            (modelProvider && providerType.startsWith(modelProvider + '-'));

        if (!isMatch) {
            return;
        }

        const modelId = modelConfig.id;
        if (!modelId) {
            return;
        }

        const responseId = options.prefixProvider && modelProvider
            ? `${modelProvider}:${modelId}`
            : modelId;

        entries.push({
            id: responseId,
            modelId,
            provider: modelProvider || providerType || MODEL_PROVIDER.AUTO,
            actualProvider: actualProvider || modelProvider || providerType || MODEL_PROVIDER.AUTO,
            config: modelConfig
        });
    });

    return entries;
}

export function resolveCustomModelRouting(
    model: string,
    currentProvider: string | null,
    customModelConfig: DynamicPayload | null = getCustomModelConfig(model, currentProvider)
): DynamicPayload {
    if (!customModelConfig) {
        return {
            isCustomModel: false,
            model,
            provider: currentProvider,
            actualModel: model,
            actualProvider: currentProvider,
            config: null
        };
    }

    const customActualProvider = getCustomModelActualProvider(customModelConfig);
    const customActualModel = customModelConfig.actualModel || customModelConfig.id || model;

    return {
        isCustomModel: true,
        model: customActualModel,
        provider: customActualProvider || currentProvider,
        actualModel: customActualModel,
        actualProvider: customActualProvider || currentProvider,
        config: customModelConfig
    };
}

export function appendCustomModelsToModelList(
    clientModelList: DynamicPayload,
    customEntries: DynamicPayload[],
    providerType: string,
    listEndpointType: string
): DynamicPayload {
    const entries = Array.isArray(customEntries) ? customEntries : [];

    if (!entries.length) {
        return clientModelList;
    }

    if (listEndpointType === ENDPOINT_TYPE.OPENAI_MODEL_LIST) {
        const models = Array.isArray(clientModelList?.data) ? clientModelList.data : [];

        entries.forEach((entry: DynamicPayload) => {
            const existingModel = models.find((model: DynamicPayload) => model?.id === entry.id);
            if (existingModel) {
                // 自定义配置优先级高于上游元数据
                applyCustomModelMetadata(existingModel, entry.config);
                return;
            }

            // 添加新模型
            const modelResponse: DynamicPayload = {
                id: entry.id,
                object: 'model',
                created: Math.floor(Date.now() / 1000),
                owned_by: entry.provider || providerType || 'custom',
                display_name: entry.config.name || entry.id
            };

            applyCustomModelMetadata(modelResponse, entry.config);

            models.push(modelResponse);
        });

        return {
            ...clientModelList,
            object: 'list',
            data: models
        };
    }

    return clientModelList;
}

