import type { IncomingMessage, ServerResponse } from 'node:http';


import { existsSync, readFileSync } from 'fs';
import logger from '../utils/logger.ts';
import { getRequestBody } from '../utils/common.ts';
import { broadcastEvent } from './event-broadcast.ts';
import { CONFIG } from '../core/config-manager.ts';
import { withFileLock, atomicWriteFile } from '../utils/file-lock.ts';
import { sendJson, sendJsonError, sendOperationError } from './http-helpers.ts';
import type { DynamicPayload } from '../../types/dynamic-payload.js';

function syncRuntimeCustomModels(currentConfig: DynamicPayload, customModels: DynamicPayload[]): void {
    const normalizedCustomModels = Array.isArray(customModels) ? customModels : [];
    currentConfig.customModels = normalizedCustomModels;
    CONFIG.customModels = normalizedCustomModels;
}

function customModelsPath(currentConfig: DynamicPayload): string {
    return currentConfig.CUSTOM_MODELS_FILE_PATH || 'configs/custom_models.json';
}

function readCustomModelsFile(filePath: string): DynamicPayload[] | null {
    if (!existsSync(filePath)) return null;
    try {
        return JSON.parse(readFileSync(filePath, 'utf-8')) as DynamicPayload[];
    } catch (caught) {
        const error = caught as DynamicPayload;
        logger.warn('[UI API] Failed to parse custom models file:', error.message);
        return null;
    }
}

/**
 * 获取自定义模型列表
 */
export async function handleGetCustomModels(res: ServerResponse, currentConfig: DynamicPayload): Promise<boolean> {
    const filePath = customModelsPath(currentConfig);
    const loaded = readCustomModelsFile(filePath);
    const customModels = loaded ?? (Array.isArray(currentConfig.customModels) ? currentConfig.customModels : []);
    return sendJson(res, 200, customModels);
}

/**
 * 添加自定义模型
 */
export async function handleAddCustomModel(req: IncomingMessage, res: ServerResponse, currentConfig: DynamicPayload): Promise<boolean> {
    try {
        const body = await getRequestBody(req);
        const filePath = CONFIG.CUSTOM_MODELS_FILE_PATH || 'configs/custom_models.json';
        return await withFileLock(filePath, () => _handleAddCustomModel(res, currentConfig, body));
    } catch (err) {
        return sendOperationError(res, 500, err, 'File operation failed: ');
    }
}
async function _handleAddCustomModel(res: ServerResponse, currentConfig: DynamicPayload, body: DynamicPayload): Promise<boolean> {
    try {
        const newModel = body;

        if (!newModel.id) {
            return sendJsonError(res, 400, 'Model ID is required');
        }

        const filePath = customModelsPath(currentConfig);
        const customModels = readCustomModelsFile(filePath) ?? [];

        // Check for duplicates
        if (customModels.some((m: DynamicPayload) => m.id === newModel.id)) {
            return sendJsonError(res, 400, `Model ID '${newModel.id}' already exists`);
        }

        customModels.push(newModel);

        // Save to file
        await atomicWriteFile(filePath, JSON.stringify(customModels, null, 2), 'utf-8');
        syncRuntimeCustomModels(currentConfig, customModels);

        logger.info(`[UI API] Added custom model: ${newModel.id}`);

        broadcastEvent('config_update', {
            action: 'add_custom_model',
            filePath,
            model: newModel,
            timestamp: new Date().toISOString()
        });

        return sendJson(res, 200, { success: true, model: newModel });
    } catch (error) {
        return sendOperationError(res, 500, error);
    }
}

/**
 * 更新自定义模型
 */
export async function handleUpdateCustomModel(req: IncomingMessage, res: ServerResponse, currentConfig: DynamicPayload, modelId: string): Promise<boolean> {
    try {
        const body = await getRequestBody(req);
        const filePath = CONFIG.CUSTOM_MODELS_FILE_PATH || 'configs/custom_models.json';
        return await withFileLock(filePath, () => _handleUpdateCustomModel(res, currentConfig, modelId, body));
    } catch (err) {
        return sendOperationError(res, 500, err, 'File operation failed: ');
    }
}
async function _handleUpdateCustomModel(res: ServerResponse, currentConfig: DynamicPayload, modelId: string, body: DynamicPayload): Promise<boolean> {
    try {
        const updatedModel = body;

        const filePath = customModelsPath(currentConfig);
        const customModels = readCustomModelsFile(filePath) ?? [];

        const index = customModels.findIndex((m: DynamicPayload) => m.id === modelId);
        if (index === -1) {
            return sendJsonError(res, 404, 'Model not found');
        }

        // Ensure ID stays consistent if not explicitly changing it (or handle ID change)
        if (updatedModel.id && updatedModel.id !== modelId) {
            if (customModels.some((m: DynamicPayload) => m.id === updatedModel.id)) {
                return sendJsonError(res, 400, `New Model ID '${updatedModel.id}' already exists`);
            }
        }

        customModels[index] = { ...customModels[index], ...updatedModel };

        // Save to file
        await atomicWriteFile(filePath, JSON.stringify(customModels, null, 2), 'utf-8');
        syncRuntimeCustomModels(currentConfig, customModels);

        logger.info(`[UI API] Updated custom model: ${modelId}`);

        broadcastEvent('config_update', {
            action: 'update_custom_model',
            filePath,
            model: customModels[index],
            timestamp: new Date().toISOString()
        });

        return sendJson(res, 200, { success: true, model: customModels[index] });
    } catch (error) {
        return sendOperationError(res, 500, error);
    }
}

/**
 * 删除自定义模型
 */
export async function handleDeleteCustomModel(res: ServerResponse, currentConfig: DynamicPayload, modelId: string): Promise<boolean> {
    try {
        const filePath = CONFIG.CUSTOM_MODELS_FILE_PATH || 'configs/custom_models.json';
        return await withFileLock(filePath, () => _handleDeleteCustomModel(res, currentConfig, modelId));
    } catch (err) {
        return sendOperationError(res, 500, err, 'File operation failed: ');
    }
}
async function _handleDeleteCustomModel(res: ServerResponse, currentConfig: DynamicPayload, modelId: string): Promise<boolean> {
    try {
        const filePath = customModelsPath(currentConfig);
        const customModels = readCustomModelsFile(filePath) ?? [];

        const index = customModels.findIndex((m: DynamicPayload) => m.id === modelId);
        if (index === -1) {
            return sendJsonError(res, 404, 'Model not found');
        }

        const deletedModel = customModels.splice(index, 1)[0];

        // Save to file
        await atomicWriteFile(filePath, JSON.stringify(customModels, null, 2), 'utf-8');
        syncRuntimeCustomModels(currentConfig, customModels);

        logger.info(`[UI API] Deleted custom model: ${modelId}`);

        broadcastEvent('config_update', {
            action: 'delete_custom_model',
            filePath,
            model: deletedModel,
            timestamp: new Date().toISOString()
        });

        return sendJson(res, 200, { success: true, deletedModel });
    } catch (error) {
        return sendOperationError(res, 500, error);
    }
}
