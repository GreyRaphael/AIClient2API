import { describe, test, beforeEach, afterEach } from 'node:test';
import { expect } from './support/harness.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveModels } from './e2e/e2e-helpers.js';

/**
 * E2E 模型缓存「辅助模型隔离」回归。
 *
 * 默认收敛模式下，globalSetup 会把 10 个代表模型 **加上** 仅用于 opt-in 图像
 * 用例的辅助模型（如 `gemini-antigravity:gemini-3.1-flash-image`）一起写入
 * 同一份模型缓存。若通用文本/工具矩阵直接消费这份缓存，就会拿生图模型去跑
 * 文本、工具、多轮用例，实测稳定 429 / 返回空内容，导致整套 E2E 变红。
 *
 * 因此 resolveModels({ excludeAuxiliary: true }) 必须把辅助模型过滤掉，
 * 而图像用例继续使用不带该选项的全量列表。
 */

let cacheFile;

function writeCache(models) {
    fs.writeFileSync(cacheFile, JSON.stringify(models, null, 2));
}

describe('E2E 模型缓存的辅助模型隔离', () => {
    let savedEnv;

    beforeEach(() => {
        savedEnv = {
            models: process.env.AICLIENT_E2E_MODELS,
            file: process.env.AICLIENT_E2E_MODELS_FILE,
            all: process.env.AICLIENT_E2E_ALL_MODELS
        };
        delete process.env.AICLIENT_E2E_MODELS;
        delete process.env.AICLIENT_E2E_ALL_MODELS;
        cacheFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-models-')), 'models.json');
        process.env.AICLIENT_E2E_MODELS_FILE = cacheFile;
    });

    afterEach(() => {
        if (savedEnv.models === undefined) delete process.env.AICLIENT_E2E_MODELS;
        else process.env.AICLIENT_E2E_MODELS = savedEnv.models;
        if (savedEnv.all === undefined) delete process.env.AICLIENT_E2E_ALL_MODELS;
        else process.env.AICLIENT_E2E_ALL_MODELS = savedEnv.all;
        if (savedEnv.file === undefined) delete process.env.AICLIENT_E2E_MODELS_FILE;
        else process.env.AICLIENT_E2E_MODELS_FILE = savedEnv.file;
        try {
            fs.rmSync(path.dirname(cacheFile), { recursive: true, force: true });
        } catch {}
    });

    test('默认缓存含辅助生图模型时，通用矩阵默认会误把它算进去', () => {
        writeCache([
            'openai-custom:deepseek-v4.1-flash',
            'gemini-antigravity:gemini-3.1-flash-image'
        ]);

        // 不带选项 = 全量（图像用例依赖此行为）
        expect(resolveModels()).toContain('gemini-antigravity:gemini-3.1-flash-image');
        // 带选项 = 通用矩阵视图，排除辅助模型
        const general = resolveModels({ excludeAuxiliary: true });
        expect(general).toContain('openai-custom:deepseek-v4.1-flash');
        expect(general).not.toContain('gemini-antigravity:gemini-3.1-flash-image');
    });

    test('过滤后为空时报清晰错误，而不是静默跑 0 个用例', () => {
        writeCache(['gemini-antigravity:gemini-3.1-flash-image']);
        expect(() => resolveModels({ excludeAuxiliary: true })).toThrow(/only auxiliary models/i);
    });

    test('显式 AICLIENT_E2E_MODELS 列表不受辅助模型过滤影响', () => {
        writeCache(['openai-custom:deepseek-v4.1-flash']);
        process.env.AICLIENT_E2E_MODELS = 'gemini-antigravity:gemini-3.1-flash-image,openai-custom:deepseek-v4.1-flash';
        // 显式列表是用户意图，原样返回
        expect(resolveModels({ excludeAuxiliary: true })).toEqual([
            'gemini-antigravity:gemini-3.1-flash-image',
            'openai-custom:deepseek-v4.1-flash'
        ]);
    });
});