/**
 * 模型用量统计独立页。
 *
 * 设计目标（相对旧版的简化）：
 *  - **一张表**，通过「按模型 / 按 Provider」切换分组维度，而不是并排三块重复内容；
 *  - 只有两个维度：**当前范围**（日历选中某天）与**历史累计**；
 *  - 删除「Provider 分布」「Top Models」「Provider 视图」三块 —— 它们与主表信息重复。
 *
 * 数据语义：`?date=YYYY-MM-DD` 取单日聚合，省略则为历史累计；
 * 两种范围都同时返回按模型与按 Provider 的聚合行，切维度不需要重新请求。
 */
import { html, useEffect, useMemo, useState } from '../html.js';
import { toggleTheme } from '../lib/theme.js';
import { confirmDialog } from '../store/confirm.js';
import { StatsCalendar } from '../components/StatsCalendar.js';
import { mountPage } from '../lib/page-boot.js';
import { requestWithCredential } from '../lib/credential-api.js';
import { formatNumber, formatTokenCompact } from '../lib/stats.js';

const API_BASE = '/api/model-usage-stats';
const STORAGE_KEY = 'model_usage_stats_auth';

async function requestStats(url, credential, options = {}) {
    if (!credential) throw new Error('请先输入访问凭证。');
    try {
        return await requestWithCredential(url, credential, {
            ...options,
            auth: 'dual',
            onUnauthorized: () => {}
        });
    } catch (error) {
        if (String(error.message).includes('PLUGIN_DISABLED')) {
            throw new Error('插件未启用：请先在插件管理中启用 model-usage-stats。');
        }
        throw error;
    }
}

/** 北京时间当天，与后端 dateKey 口径一致 */
function todayKeyBEIJING() {
    const utc8 = new Date(Date.now() + 8 * 60 * 60 * 1000);
    return utc8.toISOString().split('T')[0];
}

/** 命中率：缓存命中 / 输入 token */
function hitRate(row) {
    const prompt = Number(row?.promptTokens || 0);
    const cached = Number(row?.cachedTokens || 0);
    return prompt > 0 ? (cached / prompt) * 100 : 0;
}

function ModelUsageStatsPage() {
    const [credential, setCredential] = useState('');
    const [status, setStatus] = useState(/** @type {any} */ ({ text: '尚未加载统计数据。', type: 'info' }));
    const [connected, setConnected] = useState(false);
    const [loading, setLoading] = useState(false);

    // 范围：null = 历史累计；'YYYY-MM-DD' = 该日
    const [rangeDate, setRangeDate] = useState(/** @type {string|null} */ (null));
    // 分组维度
    const [groupBy, setGroupBy] = useState(/** @type {'model'|'provider'} */ ('model'));
    const [search, setSearch] = useState('');
    const [sort, setSort] = useState('totalTokens-desc');

    // 两个范围的数据分开缓存，切换时无需重新请求
    const [scope, setScope] = useState(/** @type {any} */ ({ day: null, all: null }));
    const [calendar, setCalendar] = useState(/** @type {any[]} */ ([]));

    const setStatusMessage = (text, type = 'info') => setStatus({ text, type });
    const today = useMemo(() => todayKeyBEIJING(), []);

    const loadScope = async (credentialValue, date) => {
        const query = date ? `?date=${encodeURIComponent(date)}` : '';
        const payload = await requestStats(`${API_BASE}${query}`, credentialValue);
        return payload?.data || payload;
    };

    const loadAll = async (credentialValue = credential) => {
        const value = String(credentialValue || '').trim();
        if (!value) throw new Error('请先输入访问凭证。');

        setLoading(true);
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({ value }));
            setStatusMessage('正在加载统计数据...');

            const [day, all] = await Promise.all([
                loadScope(value, today),
                loadScope(value, null)
            ]);

            setScope({ day, all });
            setCalendar(Array.isArray(all?.calendar) ? all.calendar : []);
            setConnected(true);
            setStatusMessage(
                `已加载：今日 ${formatNumber(day?.summary?.requestCount || 0)} 次请求，`
                + `历史累计 ${formatNumber(all?.summary?.requestCount || 0)} 次。`,
                'success'
            );
        } catch (error) {
            console.error(error);
            setConnected(false);
            setStatusMessage(error.message, 'error');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        try {
            const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
            if (saved?.value) {
                setCredential(saved.value);
                void loadAll(saved.value);
            }
        } catch {
            // ignore invalid cache
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    /** 当前范围对应的数据块 */
    const activeScope = rangeDate
        ? (scope.day && scope.day.range?.date === rangeDate ? scope.day : null)
        : scope.all;

    /** 点日历某天：已在两个范围里缓存过的直接用，否则按需拉取 */
    const selectDate = async (dateKey) => {
        if (!dateKey) {
            setRangeDate(null);
            return;
        }
        setRangeDate(dateKey);
        if (scope.day && scope.day.range?.date === dateKey) return;

        if (dateKey === today && scope.day) return;

        setLoading(true);
        try {
            const day = await loadScope(credential, dateKey);
            setScope((prev) => ({ ...prev, day }));
        } catch (error) {
            setStatusMessage(error.message, 'error');
        } finally {
            setLoading(false);
        }
    };

    const summary = activeScope?.summary || {};

    /** 当前维度下的表格行 */
    const tableRows = useMemo(() => {
        const rows = Array.isArray(activeScope?.[groupBy === 'provider' ? 'byProvider' : 'byModel'])
            ? activeScope[groupBy === 'provider' ? 'byProvider' : 'byModel']
            : [];
        return rows.map((row) => ({ ...row, cacheHitRate: hitRate(row) }));
    }, [activeScope, groupBy]);

    const filteredRows = useMemo(() => {
        const keyword = search.trim().toLowerCase();
        const list = keyword
            ? tableRows.filter((row) => {
                if (groupBy === 'provider') return String(row.provider || '').toLowerCase().includes(keyword);
                return String(row.provider || '').toLowerCase().includes(keyword)
                    || String(row.model || '').toLowerCase().includes(keyword);
            })
            : tableRows.slice();

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
    }, [tableRows, search, sort, groupBy]);

    const resetData = async (tokensOnly) => {
        const confirmed = await confirmDialog({
            title: tokensOnly ? '重置 Token 统计' : '重置全部统计',
            message: tokensOnly
                ? '确认重置 Token 统计吗？会清空输入 / 输出 / 缓存 / 总 Token，保留请求次数与最近使用时间。'
                : '确认重置全部统计吗？此操作会清空所有已落库的累计数据，不可恢复。',
            danger: true
        });
        if (!confirmed) return;
        try {
            setStatusMessage(tokensOnly ? '正在重置 Token 统计...' : '正在重置统计数据...');
            await requestStats(`${API_BASE}/${tokensOnly ? 'reset-tokens' : 'reset'}`, credential, { method: 'POST' });
            await loadAll();
        } catch (error) {
            setStatusMessage(error.message, 'error');
        }
    };

    const clearCredential = () => {
        localStorage.removeItem(STORAGE_KEY);
        setCredential('');
        setConnected(false);
        setScope({ day: null, all: null });
        setCalendar([]);
        setStatusMessage('已清空本地保存的凭证。');
    };

    /** 表格列定义：两个维度共用前 4 列，Provider 视图去掉 model 列并加「模型数」 */
    const isProviderView = groupBy === 'provider';

    const renderTable = () => {
        if (filteredRows.length === 0) {
            return html`<tr><td colspan=${isProviderView ? 7 : 8} class="empty-cell">没有匹配的数据</td></tr>`;
        }
        return filteredRows.map((row) => html`
            <tr key=${isProviderView ? row.provider : `${row.provider}:${row.model}`}>
                <td class="col-provider"><span class="provider-chip">${row.provider}</span></td>
                ${isProviderView ? null : html`<td class="col-model mono">${row.model}</td>`}
                ${isProviderView ? html`<td class="num">${formatNumber(row.modelCount || 0)}</td>` : null}
                <td class="num">${formatNumber(row.requestCount)}</td>
                <td class="num">${formatTokenCompact(row.promptTokens)}</td>
                <td class="num">${formatTokenCompact(row.cachedTokens)}</td>
                <td class="num">${formatTokenCompact(row.completionTokens)}</td>
                <td class="num strong">${formatTokenCompact(row.totalTokens)}</td>
                <td class="num">
                    <span class=${`rate-pill ${row.cacheHitRate >= 80 ? 'rate-high' : row.cacheHitRate >= 50 ? 'rate-mid' : 'rate-low'}`}>
                        ${row.cacheHitRate.toFixed(0)}%
                    </span>
                </td>
            </tr>
        `);
    };

    return html`
        <header class="navbar">
            <div class="navbar-inner">
                <div class="brand">
                    <span class="brand-icon"><i class="fas fa-chart-line"></i></span>
                    <div>
                        <div class="brand-title">模型用量统计</div>
                        <div class="brand-sub">按天查看，或切到历史累计</div>
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
                    <h1>模型用量统计</h1>
                    <div class="copy">
                        点击日历上的任意日期查看当天明细；点「历史累计」查看全部时间的汇总。
                        表格可在「按模型」与「按 Provider」之间切换。
                    </div>
                    <div class="meta">
                        <span class="tag"><i class="fas fa-database"></i> SQLite 持久化</span>
                        <span class="tag"><i class="fas fa-filter"></i> 支持搜索与排序</span>
                    </div>
                </div>
                <aside class="panel auth">
                    <div class="title">
                        <h2 class="section-title" style="margin:0"><i class="fas fa-shield-halved"></i>访问凭证</h2>
                        <span class=${connected ? 'pill' : 'pill idle'}>${connected ? '已连接' : '未连接'}</span>
                    </div>
                    <div class="sub">填入后台登录 Token 或服务 API Key，两种认证方式都会尝试。</div>
                    <div class="group">
                        <label class="label">访问凭证</label>
                        <input class="input" id="credentialValue" type="password" value=${credential}
                            placeholder="输入 Token 或 API Key"
                            onInput=${(event) => setCredential(event.currentTarget.value)}
                            onKeyDown=${(event) => { if (event.key === 'Enter') void loadAll(); }} />
                    </div>
                    <div class="row">
                        <button class="btn btn-primary" id="connectBtn" disabled=${loading} onClick=${() => void loadAll()}>
                            <i class="fas ${loading ? 'fa-spinner fa-spin' : 'fa-plug'}"></i>
                            <span>${loading ? '加载中' : '连接并加载'}</span>
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
                    <div class="card-label">请求数</div>
                    <div class="card-value">${formatNumber(summary.requestCount)}</div>
                    <div class="note">${rangeDate ? `当日 ${rangeDate}` : '历史累计'}</div>
                </article>
                <article class="card blue">
                    <div class="card-label">输入 Token</div>
                    <div class="card-value">${formatTokenCompact(summary.promptTokens)}</div>
                    <div class="note">含缓存命中部分</div>
                </article>
                <article class="card cyan">
                    <div class="card-label">缓存 Token</div>
                    <div class="card-value">${formatTokenCompact(summary.cachedTokens)}</div>
                    <div class="note">命中率 ${hitRate(summary).toFixed(1)}%</div>
                </article>
                <article class="card indigo">
                    <div class="card-label">输出 Token</div>
                    <div class="card-value">${formatTokenCompact(summary.completionTokens)}</div>
                    <div class="note">模型生成部分</div>
                </article>
                <article class="card orange">
                    <div class="card-label">总 Token</div>
                    <div class="card-value">${formatTokenCompact(summary.totalTokens)}</div>
                    <div class="note">${activeScope?.updatedAt ? `更新于 ${new Date(activeScope.updatedAt).toLocaleTimeString('zh-CN')}` : '等待数据'}</div>
                </article>
            </section>

            <section class="panel calendar-panel">
                <div class="calendar-header">
                    <h2 class="section-title" style="margin:0; font-size: 16px;">
                        <i class="fas fa-calendar-days"></i> 选择日期
                    </h2>
                    <button class=${`btn btn-sm ${rangeDate ? 'btn-secondary' : 'btn-primary'}`}
                        onClick=${() => setRangeDate(null)}>
                        <i class="fas fa-history"></i><span>历史累计</span>
                    </button>
                </div>
                <div class="calendar-wrapper" style="justify-content: flex-start; padding: 15px 0 5px;">
                    <${StatsCalendar}
                        usageHistory=${Object.fromEntries(calendar.map((day) => [day.date, day]))}
                        selectedDate=${rangeDate}
                        onSelect=${(dateKey) => void selectDate(dateKey)} />
                </div>
                <div class="calendar-footer-note" style="font-size:11px;color:var(--text-tertiary);margin-top:6px;">
                    点击日期查看当天数据；点「历史累计」查看全部时间汇总。
                </div>
            </section>

            <section class="panel">
                <div class="table-toolbar">
                    <div class="table-title">
                        <h2 class="section-title" style="margin:0; font-size: 16px;">
                            <i class="fas fa-table"></i>
                            ${rangeDate ? `${rangeDate} 明细` : '历史累计'}
                        </h2>
                        <span class="table-sub">${formatNumber(filteredRows.length)} 行</span>
                    </div>
                    <div class="table-controls">
                        <div class="segmented" role="tablist">
                            <button class=${`seg-btn ${isProviderView ? '' : 'active'}`}
                                role="tab" aria-selected=${!isProviderView}
                                onClick=${() => setGroupBy('model')}>
                                <i class="fas fa-cube"></i><span>按模型</span>
                            </button>
                            <button class=${`seg-btn ${isProviderView ? 'active' : ''}`}
                                role="tab" aria-selected=${isProviderView}
                                onClick=${() => setGroupBy('provider')}>
                                <i class="fas fa-sitemap"></i><span>按 Provider</span>
                            </button>
                        </div>
                        <input class="input table-search" type="search" placeholder="搜索 provider / model"
                            value=${search} onInput=${(e) => setSearch(e.currentTarget.value)} />
                        <select class="input table-sort" value=${sort} onChange=${(e) => setSort(e.currentTarget.value)}>
                            <option value="totalTokens-desc">总 Token ↓</option>
                            <option value="totalTokens-asc">总 Token ↑</option>
                            <option value="requestCount-desc">请求数 ↓</option>
                            <option value="promptTokens-desc">输入 Token ↓</option>
                            <option value="cachedTokens-desc">缓存 Token ↓</option>
                            <option value="cacheHitRate-desc">命中率 ↓</option>
                        </select>
                        <button class="btn btn-secondary btn-sm" onClick=${() => void loadAll()} disabled=${loading}>
                            <i class="fas fa-rotate-right"></i><span>刷新</span>
                        </button>
                    </div>
                </div>

                <div class="table-wrap">
                    <table class="usage-table">
                        <thead>
                            <tr>
                                <th class="col-provider">Provider</th>
                                ${isProviderView ? html`<th class="num">模型数</th>` : html`<th class="col-model">Model</th>`}
                                <th class="num">请求数</th>
                                <th class="num">输入</th>
                                <th class="num">缓存</th>
                                <th class="num">输出</th>
                                <th class="num">总 Token</th>
                                <th class="num">命中率</th>
                            </tr>
                        </thead>
                        <tbody>${renderTable()}</tbody>
                    </table>
                </div>
            </section>

            <section class="panel danger-zone">
                <div class="row" style="justify-content: space-between; align-items: center;">
                    <div>
                        <div style="font-weight:600;margin-bottom:2px">重置数据</div>
                        <div style="font-size:12px;color:var(--text-tertiary)">
                            「重置 Token」保留请求数；「重置统计」清空全部数据。
                        </div>
                    </div>
                    <div class="row">
                        <button class="btn btn-secondary" onClick=${() => void resetData(true)}>
                            <i class="fas fa-eraser"></i><span>重置 Token</span>
                        </button>
                        <button class="btn btn-danger" onClick=${() => void resetData(false)}>
                            <i class="fas fa-trash-can"></i><span>重置统计</span>
                        </button>
                    </div>
                </div>
            </section>
        </main>
    `;
}

mountPage(ModelUsageStatsPage);
