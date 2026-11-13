import { describe, test } from 'node:test';
import { expect, jest } from './support/harness.mjs';
import render from 'preact-render-to-string';
import { html } from '@ui/html.js';
import { StatusBadge } from '@ui/components/StatusBadge.js';
import { ToastHost } from '@ui/components/Toast.js';
import { Sidebar } from '@ui/layout/Sidebar.js';
import { Spinner } from '@ui/components/Spinner.js';
import { EmptyState } from '@ui/components/EmptyState.js';
import { Switch } from '@ui/components/Switch.js';
import { CopyButton } from '@ui/components/CopyButton.js';
import { toasts } from '@ui/store/toast.js';
import { Modal } from '@ui/components/Modal.js';
import { ConfirmDialogHost } from '@ui/components/ConfirmDialog.js';
import { Pagination } from '@ui/components/Pagination.js';

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
        // 使用指南页已彻底删除
        expect(markup).not.toContain('data-section="guide"');
    });

    test('Sidebar 把模型用量统计排在实时日志之前（主菜单第 10 项）', () => {
        // model-usage-stats 从插件迁为核心功能后加入主菜单，位置紧挨「实时日志」上方。
        const markup = render(html`<${Sidebar} current="model-usage-stats" />`);
        expect(markup).toContain('data-section="model-usage-stats"');
        expect(markup).toContain('href="#model-usage-stats"');
        // 图标必须是完整字面量（FA 子集靠字面量扫描收集）
        expect(markup).toContain('fas fa-chart-line');
        expect(markup).toContain('nav-item active');

        const order = [...markup.matchAll(/data-section="([\w-]+)"/g)].map((m) => m[1]);
        expect(order).toHaveLength(11);
        expect(order.indexOf('model-usage-stats')).toBe(order.indexOf('logs') - 1);
        // 首尾不变：仪表盘仍在最前，实时日志仍在最后
        expect(order[0]).toBe('dashboard');
        expect(order[order.length - 1]).toBe('logs');
    });

    test('ToastHost 渲染 store 队列', () => {
        toasts.value = [{ id: 1, title: '完成', message: '已保存', type: 'success' }];
        const markup = render(html`<${ToastHost} />`);
        expect(markup).toContain('toast success');
        expect(markup).toContain('已保存');
        toasts.value = [];
    });

    test('Spinner / EmptyState 渲染默认文案', () => {
        expect(render(html`<${Spinner} />`)).toContain('加载中');
        expect(render(html`<${EmptyState} message="暂无数据" />`)).toContain('暂无数据');
    });

    test('Switch 输出旧 .toggle-switch 结构', () => {
        const markup = render(html`<${Switch} checked=${true} />`);
        expect(markup).toContain('class="toggle-switch"');
        expect(markup).toContain('type="checkbox"');
        expect(markup).toContain('checked');
        expect(markup).toContain('toggle-slider');
    });

    test('Modal / Pagination / ConfirmDialog SSR', () => {
        const modal = render(html`<${Modal} title="标题"><p>内容</p><//>`);
        expect(modal).toContain('role="dialog"');
        expect(modal).toContain('标题');
        expect(modal).toContain('×');
        expect(modal).not.toContain('&times;');
        expect(render(html`<${ConfirmDialogHost} />`)).toBe('');
        const pager = render(html`<${Pagination} page=${2} pageSize=${10} total=${35} onChange=${() => {}} />`);
        expect(pager).toContain('第 2/4 页');
    });

    test('CopyButton 保留文本与按钮结构', () => {
        const copy = render(html`<${CopyButton} value="abc" />`);
        expect(copy).toContain('btn btn-secondary btn-sm');
        expect(copy).toContain('fas fa-copy');
    });
});
