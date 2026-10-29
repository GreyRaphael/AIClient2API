import { describe, test, expect } from '@jest/globals';
import render from 'preact-render-to-string';
import { html } from '@ui/html.js';
import { StatusBadge } from '@ui/components/StatusBadge.js';
import { ToastHost } from '@ui/components/Toast.js';
import { Sidebar } from '@ui/layout/Sidebar.js';
import { toasts } from '@ui/store/toast.js';

describe('UI 组件 SSR 冒烟', () => {
    test('StatusBadge 渲染当前连接状态', () => {
        const markup = render(html`<${StatusBadge} />`);
        expect(markup).toContain('id="serverStatus"');
        expect(markup).toContain('fas fa-circle');
        expect(markup).toContain('连接中');
    });

    test('Sidebar 渲染 11 个导航项并标记 active', () => {
        const markup = render(html`<${Sidebar} current="dashboard" />`);
        expect(markup.match(/class="nav-item/g)?.length).toBe(11);
        expect(markup).toContain('href="#dashboard"');
        expect(markup).toContain('class="nav-item active"');
        expect(markup).toContain('仪表盘');
        expect(markup).toContain('data-section="logs"');
    });

    test('ToastHost 渲染 store 队列', () => {
        toasts.value = [{ id: 1, title: '完成', message: '已保存', type: 'success' }];
        const markup = render(html`<${ToastHost} />`);
        expect(markup).toContain('toast success');
        expect(markup).toContain('已保存');
        toasts.value = [];
    });
});
