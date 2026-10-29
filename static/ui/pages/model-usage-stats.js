/** 模型用量统计独立页（Phase 5 迁移）。 */
import { html, render, useEffect, useMemo, useState } from '../html.js';
import { initTheme, toggleTheme } from '../lib/theme.js';
import { confirmDialog } from '../store/confirm.js';
import { toast } from '../store/toast.js';
import { ToastHost } from '../components/Toast.js';
import { ConfirmDialogHost } from '../components/ConfirmDialog.js';
import { StatsCalendar } from '../components/StatsCalendar.js';
import {
    flattenModelUsage,
    formatNumber,
    formatTokenCompact,
    formatRelativeTime,
    topWithOther
} from '../lib/stats.js';

const API_BASE = '/api/model-usage-stats';
const STORAGE_KEY = 'model_usage_stats_auth';

async function requestWithCredential(url, credential, options = {}) {
    if (!credential) throw new Error('请先输入访问凭证。');
    const response = await fetch(url, {
        ...options,
        headers: {
            ...(options.headers || {}),
            Authorization: `Bearer ${credential}`,
            'x-api-key': credential
        }
    });
    const text = await response.text();
    let payload = null;
    try {
        payload = text ? JSON.parse(text) : null;
    } catch {
        throw new Error(`接口返回了非 JSON 内容: ${text || '(empty)'}`);
    }
    if (!response.ok) {
        if (payload?.error?.code === 'PLUGIN_DISABLED') {
            throw new Error('插件未启用：请先在插件管理中启用 model-usage-stats。');
        }
        throw new Error(payload?.error?.message || payload?.message || `请求失败 (${response.status})`);
    }
    return payload;
}

function Bars({ items, getValue, getLabel }) {
    if (!items.length) {
        return html`<div class="mini-box">
            <div class="mini-label">暂无数据</div>
            <div class="mini-value" style="font-size:14px">等待统计写入</div>
        </div>`;
    }
    const max = Math.max(...items.map(getValue), 1);
    return html`
        <div class="bars">
            ${items.map((item, index) => {
                const value = Number(getValue(item) || 0);
                return html`
                    <div class="bar" key=${index}>
                        <div class="bar-head">
                            <div class="bar-name" title=${getLabel(item)}>${getLabel(item)}</div>
                            <div class="bar-value">${formatTokenCompact(value)}</div>
                        </div>
                        <div class="track">
                            <div class="fill" style=${`width:${Math.max(value / max * 100, 2)}%;${item.isOther ? 'background:#94a3b8;' : ''}`}></div>
                        </div>
                    </div>`;
            })}
        </div>`;
}

function ModelUsageStatsPage() {
    const [credential, setCredential] = useState('');
    const [data, setData] = useState(/** @type {any} */ (null));
    const [rows, setRows] = useState(/** @type {any[]} */ ([]));
    const [status, setStatus] = useState(/** @type {any} */ ({ text: '尚未加载统计数据。', type: 'info' }));
    const [connected, setConnected] = useState(false);
    const [search, setSearch] = useState('');
    const [sort, setSort] = useState('totalTokens-desc');

    const setStatusMessage = (text, type = 'info') => setStatus({ text, type });

    const loadData = async (credentialValue = credential) => {
        try {
            const value = String(credentialValue || '').trim();
            if (!value) throw new Error('请先输入访问凭证。');
            if (value) localStorage.setItem(STORAGE_KEY, JSON.stringify({ value }));
            setStatusMessage('正在加载统计数据...');
            const payload = await requestWithCredential(API_BASE, value);
            const nextData = payload?.data || payload;
            setData(nextData);
            setRows(flattenModelUsage(nextData));
            setConnected(true);
            setStatusMessage(`已加载 ${formatNumber(flattenModelUsage(nextData).length)} 条模型统计。`, 'success');
        } catch (error) {
            console.error(error);
            setConnected(false);
            setStatusMessage(error.message, 'error');
        }
    };

    useEffect(() => {
        initTheme();
        try {
            const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
            if (saved?.value) {
                setCredential(saved.value);
                void loadData(saved.value);
            }
        } catch {
            // ignore invalid cache
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const summary = data?.summary || {};
    const filteredRows = useMemo(() => {
        const keyword = search.trim().toLowerCase();
        const list = keyword
            ? rows.filter((row) => row.provider.toLowerCase().includes(keyword) || row.model.toLowerCase().includes(keyword))
            : rows.slice();
        const [field, direction] = sort.split('-');
        list.sort((a, b) => {
            if (field === 'provider' || field === 'model') {
                const left = String(a[field] || '');
                const right = String(b[field] || '');
                return direction === 'desc' ? right.localeCompare(left) : left.localeCompare(right);
            }
            const left = Number(a[field] || 0);
            const right = Number(b[field] || 0);
            return direction === 'desc' ? right - left : left - right;
        });
        return list;
    }, [rows, search, sort]);

    const providersRaw = Object.entries(data?.providers || {})
        .map(([name, provider]) => ({
            name,
            data: provider,
            count: Object.keys(provider.models || {}).length,
            totalTokens: Number(provider.summary?.totalTokens || 0)
        }))
        .sort((a, b) => b.totalTokens - a.totalTokens);
    const providerBars = topWithOther(
        Object.fromEntries(providersRaw.map((provider) => [provider.name, provider.totalTokens])),
        3
    ).map((item) => ({ name: item.name, totalTokens: item.count, isOther: item.isOther }));

    const modelBars = topWithOther(
        Object.fromEntries(rows.map((row) => [`${row.provider} / ${row.model}`, Number(row.totalTokens || 0)])),
        3
    ).map((item) => ({ name: item.name, totalTokens: item.count, isOther: item.isOther }));

    const resetData = async (tokensOnly) => {
        const confirmed = await confirmDialog({
            title: tokensOnly ? '重置模型 Token 统计' : '重置全部模型统计',
            message: tokensOnly
                ? '确认重置模型 Token 统计吗？这会清空输入 / 输出 / 缓存 / 总 Token，但保留请求次数与最近使用时间。'
                : '确认重置全部模型统计吗？此操作会清空已落库的累计数据。',
            danger: true
        });
        if (!confirmed) return;
        try {
            setStatusMessage(tokensOnly ? '正在重置 Token 统计...' : '正在重置统计数据...');
            const payload = await requestWithCredential(`${API_BASE}/${tokensOnly ? 'reset-tokens' : 'reset'}`, credential, { method: 'POST' });
            const nextData = payload?.data || payload;
            setData(nextData);
            setRows(flattenModelUsage(nextData));
            setStatusMessage(tokensOnly ? '模型 Token 统计已重置。' : '统计数据已重置。', 'success');
        } catch (error) {
            setStatusMessage(error.message, 'error');
        }
    };

    const clearCredential = () => {
        localStorage.removeItem(STORAGE_KEY);
        setCredential('');
        setConnected(false);
        setStatusMessage('已清空本地保存的凭证。');
    };

    return html`
        <header class="navbar">
            <div class="navbar-inner">
                <div class="brand">
                    <span class="brand-icon"><i class="fas fa-chart-line"></i></span>
                    <div>
                        <div class="brand-title">模型用量统计</div>
                        <div class="brand-sub">统一查看 Provider / Model 的请求次数与 Token 累计</div>
                    </div>
                </div>
                <div class="nav-actions">
                    <a class="nav-btn" href="/"><i class="fas fa-arrow-left"></i><span>返回控制台</span></a>
                    <button class="theme-toggle" type="button" aria-label="切换主题" onClick=${toggleTheme}>
                        <i class="fas fa-moon"></i><i class="fas fa-sun"></i>
                    </button>
                </div>
            </div>
        </header>

        <main class="main">
            <section class="hero">
                <div class="panel hero-main">
                    <span class="eyebrow"><i class="fas fa-chart-pie"></i> 统计面板</span>
                    <h1>模型用量统计面板</h1>
                    <div class="copy">
                        通过 <code>/api/model-usage-stats</code> 查看系统已累计的请求数、输入 Token、输出 Token 和 Provider / Model 维度分布。
                    </div>
                    <div class="meta">
                        <span class="tag"><i class="fas fa-key"></i> 支持后台 Token 与 API Key</span>
                        <span class="tag"><i class="fas fa-database"></i> 基于插件持久化统计</span>
                        <span class="tag"><i class="fas fa-filter"></i> 支持搜索、排序、刷新与重置</span>
                    </div>
                </div>
                <aside class="panel auth">
                    <div class="title">
                        <h2 class="section-title" style="margin:0"><i class="fas fa-shield-halved"></i>访问凭证</h2>
                        <span class=${connected ? 'pill' : 'pill idle'}>${connected ? '已连接' : '未连接'}</span>
                    </div>
                    <div class="sub">与其他管理页面一致，这里不会自动读取服务端敏感配置。输入凭证后可加载统计接口，刷新后会从本地缓存恢复。</div>
                    <div class="group">
                        <label class="label">访问凭证</label>
                        <input class="input" id="credentialValue" type="password" value=${credential}
                            placeholder="输入 Token 或 API Key"
                            onInput=${(event) => setCredential(event.currentTarget.value)}
                            onKeyDown=${(event) => { if (event.key === 'Enter') void loadData(); }} />
                        <div class="help">
                            这里直接填后台登录 Token 或服务 API Key。页面会自动同时尝试
                            <code>Authorization: Bearer</code> 和 <code>x-api-key</code> 两种方式。
                        </div>
                    </div>
                    <div class="row">
                        <button class="btn btn-primary" id="connectBtn" onClick=${() => void loadData()}>
                            <i class="fas fa-plug"></i><span>连接并加载</span>
                        </button>
                        <button class="btn btn-secondary" id="clearBtn" onClick=${clearCredential}>
                            <i class="fas fa-eraser"></i><span>清空凭证</span>
                        </button>
                    </div>
                    <div class=${`status ${status.type} show`}>
                        <i class=${`fas ${status.type === 'error' ? 'fa-triangle-exclamation' : status.type === 'success' ? 'fa-circle-check' : 'fa-circle-info'}`}></i>
                        <span>${status.text}</span>
                    </div>
                </aside>
            </section>

            <section class="stats">
                <article class="card green">
                    <div class="card-label">总请求数</div>
                    <div class="card-value">${formatNumber(summary.requestCount)}</div>
                    <div class="note">
                        QPS: <span style="font-weight:700;color:var(--primary-color)">${(summary.qps || 0).toFixed(2)}</span>
                        (峰值: <span>${(summary.maxQps || 0).toFixed(2)}</span>) |
                        RPM: <span style="font-weight:700;color:var(--primary-color)">${(summary.rpm || 0).toFixed(2)}</span>
                        (峰值: <span>${(summary.maxRpm || 0).toFixed(2)}</span>)
                    </div>
                </article>
                <article class="card blue"><div class="card-label">输入 Token</div><div class="card-value">${formatTokenCompact(summary.promptTokens)}</div><div class="note">输入 token 的累计值</div></article>
                <article class="card cyan"><div class="card-label">缓存 Token</div><div class="card-value">${formatTokenCompact(summary.cachedTokens)}</div><div class="note">缓存命中的累计值</div></article>
                <article class="card indigo"><div class="card-label">输出 Token</div><div class="card-value">${formatTokenCompact(summary.completionTokens)}</div><div class="note">输出 token 的累计值</div></article>
                <article class="card orange">
                    <div class="card-label">总 Token</div>
                    <div class="card-value">${formatTokenCompact(summary.totalTokens)}</div>
                    <div class="note">
                        TPS: <span style="font-weight:700;color:var(--primary-color)">${(summary.tps || 0).toFixed(2)}</span>
                        (峰值: <span>${(summary.maxTps || 0).toFixed(2)}</span>) |
                        <span>${data?.updatedAt ? `更新于 ${new Date(data.updatedAt).toLocaleString('zh-CN')}` : '等待数据'}</span>
                    </div>
                </article>
            </section>

            <section class="split">
                <div class="panel calendar-panel" style="margin-bottom: 0;">
                    <div class="calendar-header">
                        <h2 class="section-title" style="margin:0; font-size: 16px;"><i class="fas fa-calendar-days"></i> Token 使用趋势 (3个月)</h2>
                        <div class="calendar-legend" style="font-size: 10px;">
                            <div class="level level-1"></div><div class="level level-4"></div>
                        </div>
                    </div>
                    <div class="calendar-wrapper" style="justify-content: flex-start; padding: 15px 0 5px;">
                        <${StatsCalendar} usageHistory=${data?.daily || {}} />
                    </div>
                </div>
                <div class="panel">
                    <h2 class="section-title" style="font-size: 16px;"><i class="fas fa-sitemap"></i>Provider 分布</h2>
                    <${Bars} items=${providerBars} getValue=${(item) => item.totalTokens} getLabel=${(item) => item.name} />
                </div>
                <div class="panel">
                    <h2 class="section-title" style="font-size: 16px;"><i class="fas fa-fire"></i>Top Models</h2>
                    <${Bars} items=${modelBars} getValue=${(item) => item.totalTokens} getLabel=${(item) => item.name} />
                </div>
            </section>

            <section>
                <div class="tools">
                    <h2 class="section-title" style="margin:0"><i class="fas fa-layer-group"></i>Provider 视图</h2>
                    <div class="row">
                        <button class="btn btn-secondary" onClick=${() => void loadData()}>
                            <i class="fas fa-rotate-right"></i><span>刷新</span>
                        </button>
                        <button class="btn btn-secondary" onClick=${() => void resetData(true)}>
                            <i class="fas fa-eraser"></i><span>重置 Token</span>
                        </button>
                        <button class="btn btn-danger" onClick=${() => void resetData(false)}>
                            <i class="fas fa-trash-can"></i><span>重置统计</span>
                        </button>
                    </div>
                </div>
                <div class="providers">
                    ${providersRaw.length === 0
                        ? html`<div class="provider"><div class="provider-name">暂无 Provider 统计</div><div class="provider-sub">当前还没有可展示的累计数据。</div></div>`
                        : providersRaw.map((provider) => {
                            const providerSummary = provider.data.summary || {};
                            return html`
                                <article class="provider" key=${provider.name}>
                                    <div class="provider-head">
                                        <div>
                                            <div class="provider-name">${provider.name}</div>
                                            <div class="provider-sub">包含 ${formatNumber(provider.count)} 个模型</div>
                                        </div>
                                        <span class="provider-badge"><i class="fas fa-bolt"></i>${formatNumber(providerSummary.requestCount)} 次调用</span>
                                    </div>
                                    <div class="mini">
                                        ${[
                                            ['总 Token', formatTokenCompact(providerSummary.totalTokens)],
                                            ['输入', formatTokenCompact(providerSummary.promptTokens)],
                                            ['输出', formatTokenCompact(providerSummary.completionTokens)],
                                            ['QPS / RPM', `${(providerSummary.qps || 0).toFixed(2)} / ${(providerSummary.rpm || 0).toFixed(2)}`],
                                            ['TPS', (providerSummary.tps || 0).toFixed(2)],
                                            ['最近使用', formatRelativeTime(providerSummary.lastUsedAt)]
                                        ].map(([label, value]) => html`
                                            <div class="mini-box" key=${label}>
                                                <div class="mini-label">${label}</div>
                                                <div class="mini-value" style=${label === '最近使用' ? 'font-size:14px' : undefined}>${value}</div>
                                            </div>`)}
                                    </div>
                                </article>`;
                        })}
                </div>
            </section>

            <section class="table-card">
                <div class="tools">
                    <h2 class="section-title" style="margin:0"><i class="fas fa-table"></i>模型明细</h2>
                    <div class="tool-row">
                        <input class="search" type="search" placeholder="搜索 provider 或 model"
                            value=${search} onInput=${(event) => setSearch(event.currentTarget.value)} />
                        <select class="select" value=${sort} onChange=${(event) => setSort(event.currentTarget.value)}>
                            <option value="totalTokens-desc">按总 Token 降序</option>
                            <option value="requestCount-desc">按请求数降序</option>
                            <option value="promptTokens-desc">按输入 Token 降序</option>
                            <option value="completionTokens-desc">按输出 Token 降序</option>
                            <option value="provider-asc">按 Provider 升序</option>
                            <option value="model-asc">按 Model 升序</option>
                        </select>
                    </div>
                </div>
                <div class="table-wrap">
                    <table>
                        <thead><tr><th>Provider</th><th>Model</th><th>请求数</th><th>Prompt</th><th>Cached</th><th>Completion</th><th>Total</th><th>最近使用</th></tr></thead>
                        <tbody>
                            ${filteredRows.length === 0
                                ? html`<tr><td colspan="8" style="text-align:center;color:var(--text-tertiary)">没有匹配的数据</td></tr>`
                                : filteredRows.map((row, index) => html`
                                    <tr key=${`${row.provider}-${row.model}-${index}`}>
                                        <td><span class="tag"><i class="fas fa-server"></i>${row.provider}</span></td>
                                        <td>${row.model}</td>
                                        <td class="mono">${formatNumber(row.requestCount)}</td>
                                        <td class="mono">${formatTokenCompact(row.promptTokens)}</td>
                                        <td class="mono">${formatTokenCompact(row.cachedTokens)}</td>
                                        <td class="mono">${formatTokenCompact(row.completionTokens)}</td>
                                        <td class="mono">${formatTokenCompact(row.totalTokens)}</td>
                                        <td>${formatRelativeTime(row.lastUsedAt)}</td>
                                    </tr>`)}
                        </tbody>
                    </table>
                </div>
            </section>

            <p class="footer">如果上游响应没有提供 usage，调用次数仍会统计，但 token 数可能保持为 0。</p>
        </main>`;
}

async function boot() {
    initTheme();
    const page = document.getElementById('page');
    render(html`<${ModelUsageStatsPage} />`, page);
    const toastRoot = document.getElementById('toastContainer');
    if (toastRoot) render(html`<${ToastHost} />`, toastRoot);
    const confirmRoot = document.getElementById('confirm-root');
    if (confirmRoot) render(html`<${ConfirmDialogHost} />`, confirmRoot);
}

void boot();
