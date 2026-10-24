import { test } from '@jest/globals';

export const MODEL_TIMEOUT_MS = Number(process.env.AICLIENT_E2E_MODEL_TIMEOUT_MS) || 300000;
export const LONG_TAIL_MODEL_TIMEOUT_MS = Math.max(MODEL_TIMEOUT_MS, 600000);
export const TARGET_TIMEOUT_MS = 180000;

/**
 * Zed Google 通道（gemini-*）存在 120s 级上游长尾；若发生一次或两次超时重试，
 * 300s 预算会在最后一个用例完成前被 Jest 终止，因此为长尾模型提供 600s 预算。
 */
export function resolveModelTimeoutMs(model) {
    if (String(model || '').startsWith('zed:gemini-')) {
        return LONG_TAIL_MODEL_TIMEOUT_MS;
    }
    return MODEL_TIMEOUT_MS;
}

/**
 * 基于 globalSetup 写入的 /auto/v1/models 列表创建模型选择器。
 * 定向用例只依赖 provider 前缀和模型名特征，不硬编码具体模型。
 */
export function createModelSelection(models) {
    function pickModel(providerPrefix, predicate = () => true) {
        return models.find(model => model.startsWith(providerPrefix + ':') && predicate(model)) || null;
    }

    function pickModelFromProviders(providerPrefixes, predicate = () => true) {
        for (const prefix of providerPrefixes) {
            const model = pickModel(prefix, predicate);
            if (model) return model;
        }
        return null;
    }

    return { pickModel, pickModelFromProviders };
}

/**
 * 注册定向用例；没有匹配模型时自动 skip，避免模型下线导致误报。
 */
export function registerTargetTest(name, model, fn, timeout = TARGET_TIMEOUT_MS) {
    const label = model ? `${name} [${model}]` : `${name} [skipped: no matching model]`;
    const run = model ? test : test.skip;
    run(label, model ? fn : () => {}, timeout);
}
