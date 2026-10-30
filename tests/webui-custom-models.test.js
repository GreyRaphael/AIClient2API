import { describe, test, expect } from '@jest/globals';
import {
    nextSortState,
    sortModels,
    buildModelPayload,
    modelToForm,
    formatCompactNumber
} from '@ui/sections/custom-models/custom-models-utils.js';

describe('custom models helpers', () => {
    test('排序状态三态循环', () => {
        let state = { field: null, order: null };
        state = nextSortState(state, 'id');
        expect(state).toEqual({ field: 'id', order: 'asc' });
        state = nextSortState(state, 'id');
        expect(state).toEqual({ field: 'id', order: 'desc' });
        state = nextSortState(state, 'id');
        expect(state).toEqual({ field: null, order: null });
    });

    test('默认按第一列（id）升序，而不是依赖后端返回顺序', () => {
        // 页面初始 sort 状态为 { field: 'id', order: 'asc' }，
        // 因此乱序输入也必须按 id 数字感知升序输出
        const models = [
            { id: 'model-10', alias: 'b' },
            { id: 'model-2', alias: 'a' },
            { id: 'model-1', alias: 'c' }
        ];
        expect(sortModels(models, { field: 'id', order: 'asc' }).map((m) => m.id))
            .toEqual(['model-1', 'model-2', 'model-10']);
    });

    test('按 id/alias 数字感知排序', () => {
        const models = [
            { id: 'model-10', alias: 'b' },
            { id: 'model-2', alias: 'a' },
            { id: 'model-2', alias: 'z' }
        ];
        expect(sortModels(models, { field: 'id', order: 'asc' }).map((m) => m.alias))
            .toEqual(['a', 'z', 'b']);
        expect(sortModels(models, { field: 'id', order: 'desc' }).map((m) => m.alias))
            .toEqual(['b', 'z', 'a']);
    });

    test('新增时省略空数字字段，编辑时保留', () => {
        const form = {
            modelId: 'm1',
            modelName: 'M',
            customModelProvider: 'p1',
            customModelActualProvider: 'p2',
            support_images: 'true',
            support_efforts: 'high,max',
            enabled: true,
            context_length: '',
            max_output_tokens: ''
        };
        const created = buildModelPayload(form, false);
        expect(created).not.toHaveProperty('context_length');
        expect(created.support_images).toBe(true);
        expect(created.support_efforts).toEqual(['high', 'max']);

        const edited = buildModelPayload(form, true);
        expect(edited.context_length).toBeNull();
    });

    test('modelToForm 还原表单字段', () => {
        const form = modelToForm({
            id: 'm1',
            name: 'M',
            provider: 'p1',
            actualProvider: 'p2',
            context_length: 8192,
            support_images: true,
            support_efforts: ['max'],
            enabled: false
        });
        expect(form.customModelProvider).toBe('p1');
        expect(form.customModelActualProvider).toBe('p2');
        expect(form.support_images).toBe('true');
        expect(form.support_efforts).toBe('max');
        expect(form.enabled).toBe(false);
        expect(formatCompactNumber(8192)).toBe('8K');
    });
});
