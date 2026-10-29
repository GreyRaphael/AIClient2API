/** API 大锅饭 - 管理端 Key 管理页（Phase 5 迁移）。 */
import { html, render, useEffect, useMemo, useState } from '../html.js';
import { initTheme, toggleTheme } from '../lib/theme.js';
import { getToken } from '../lib/auth.js';
import { copyToClipboard } from '../lib/clipboard.js';
import { confirmDialog } from '../store/confirm.js';
import { toast } from '../store/toast.js';
import { ToastHost } from '../components/Toast.js';
import { Modal } from '../components/Modal.js';
import { StatsCalendar } from '../components/StatsCalendar.js';
import { DistributionList } from '../components/DistributionList.js';
import {
    aggregateUsage,
    formatNumber,
    formatTokenCompact,
    formatRelativeTime,
    keyProviderBadges
} from '../lib/stats.js';

const API_BASE = '/api/potluck';

async function apiRequest(url, options = {}) {
    const token = getToken();
    const headers = { 'Content-Type': 'application/json', ...options.headers };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(url, { ...options, headers });
    if (response.status === 401) {
        window.location.href = '/login.html';
        return null;
    }
    return response.json();
}

function PotluckAdminPage() {
    const [data, setData] = useState(/** @type {any} */ (null));
    const [search, setSearch] = useState('');
    const [sort, setSort] = useState('name-asc');
    const [createOpen, setCreateOpen] = useState(false);
    const [createName, setCreateName] = useState('');
    const [createLimit, setCreateLimit] = useState('');
    const [createdKey, setCreatedKey] = useState('');
    const [editLimit, setEditLimit] = useState(/** @type {any} */ (null));
    const [editName, setEditName] = useState(/** @type {any} */ (null));
    const [applyLimitOpen, setApplyLimitOpen] = useState(false);
    const [applyLimitValue, setApplyLimitValue] = useState('500');

    const loadData = async () => {
        const result = await apiRequest(`${API_BASE}/keys`);
        if (!result) return;
        if (!result.success) {
            toast.error('加载失败');
            return;
        }
        setData(result.data);
    };

    useEffect(() => {
        initTheme();
        if (!getToken()) {
            window.location.href = '/login.html';
            return;
        }
        void loadData();
    }, []);

    const stats = data?.stats || {};
    const allKeys = data?.keys || [];
    const usageHistory = stats.usageHistory || {};
    const aggregated = aggregateUsage(usageHistory);

    const filteredKeys = useMemo(() => {
        const term = search.toLowerCase().trim();
        let list = allKeys;
        if (term) {
            list = allKeys.filter((key) => (
                String(key.name || '').toLowerCase().includes(term)
                || String(key.id || '').toLowerCase().includes(term)
            ));
        }
        const [field, order] = sort.split('-');
        return [...list].sort((a, b) => {
            let left;
            let right;
            if (field === 'name') { left = String(a.name || '').toLowerCase(); right = String(b.name || '').toLowerCase(); }
            else if (field === 'usage') { left = a.todayUsage; right = b.todayUsage; }
            else if (field === 'total') { left = a.totalUsage; right = b.totalUsage; }
            else if (field === 'lastUsed') { left = a.lastUsedAt || ''; right = b.lastUsedAt || ''; }
            else if (field === 'qps') { left = a.qps || 0; right = b.qps || 0; }
            else if (field === 'rpm') { left = a.rpm || 0; right = b.rpm || 0; }
            else { left = a.createdAt || ''; right = b.createdAt || ''; }
            if (left < right) return order === 'asc' ? -1 : 1;
            if (left > right) return order === 'asc' ? 1 : -1;
            return 0;
        });
    }, [allKeys, search, sort]);

    const createKey = async () => {
        const dailyLimit = Number.parseInt(createLimit, 10) || 500;
        const result = await apiRequest(`${API_BASE}/keys`, {
            method: 'POST',
            body: JSON.stringify({ name: createName, dailyLimit })
        });
        if (!result?.success) {
            toast.error(result?.error?.message || '创建失败');
            return;
        }
        setCreatedKey(result.data.id);
        setCreateOpen(false);
        setCreateName('');
        setCreateLimit('');
        await loadData();
    };

    const copyKey = async (text, message = '已复制到剪贴板') => {
        const copied = await copyToClipboard(text);
        toast[copied ? 'success' : 'error'](copied ? message : '复制失败，请手动复制');
    };

    const resetUsage = async (key) => {
        const confirmed = await confirmDialog({
            title: '重置今日用量',
            message: '确定要重置该 Key 的今日调用次数吗？',
            danger: true
        });
        if (!confirmed) return;
        const result = await apiRequest(`${API_BASE}/keys/${encodeURIComponent(key.id)}/reset`, { method: 'POST' });
        if (result?.success) { toast.success('已重置'); await loadData(); }
        else toast.error(result?.error?.message || '操作失败');
    };

    const resetTokenStats = async (key) => {
        const confirmed = await confirmDialog({
            title: '重置 Token 统计',
            message: '确定要重置该 Key 的 Token 统计吗？这会清空该 Key 的今日/累计 Token 与历史 Token 统计，但保留调用次数。',
            danger: true
        });
        if (!confirmed) return;
        const result = await apiRequest(`${API_BASE}/keys/${encodeURIComponent(key.id)}/reset-tokens`, { method: 'POST' });
        if (result?.success) { toast.success('Token 统计已重置'); await loadData(); }
        else toast.error(result?.error?.message || '操作失败');
    };

    const resetAllTokenStats = async () => {
        const confirmed = await confirmDialog({
            title: '重置全部 Token',
            message: '确定要重置全部 Key 的 Token 统计吗？这会清空所有 Key 的今日/累计 Token 与历史 Token 统计，但保留调用次数。',
            danger: true
        });
        if (!confirmed) return;
        const result = await apiRequest(`${API_BASE}/stats/reset-tokens`, { method: 'POST' });
        if (result?.success) { toast.success('全部 Token 统计已重置'); await loadData(); }
        else toast.error(result?.error?.message || '操作失败');
    };

    const updateLimit = async () => {
        const dailyLimit = Number.parseInt(editLimit?.value, 10);
        if (!dailyLimit || dailyLimit < 1) {
            toast.error('请输入有效的限额');
            return;
        }
        const result = await apiRequest(`${API_BASE}/keys/${encodeURIComponent(editLimit.key.id)}/limit`, {
            method: 'PUT',
            body: JSON.stringify({ dailyLimit })
        });
        if (result?.success) {
            toast.success('限额已更新');
            setEditLimit(null);
            await loadData();
        } else {
            toast.error(result?.error?.message || '操作失败');
        }
    };

    const updateName = async () => {
        const name = String(editName?.value || '').trim();
        if (!name) {
            toast.error('请输入有效的名称');
            return;
        }
        const result = await apiRequest(`${API_BASE}/keys/${encodeURIComponent(editName.key.id)}/name`, {
            method: 'PUT',
            body: JSON.stringify({ name })
        });
        if (result?.success) {
            toast.success('名称已更新');
            setEditName(null);
            await loadData();
        } else {
            toast.error(result?.error?.message || '操作失败');
        }
    };

    const toggleKey = async (key) => {
        const result = await apiRequest(`${API_BASE}/keys/${encodeURIComponent(key.id)}/toggle`, { method: 'POST' });
        if (result?.success) { toast.success(result.message || '状态已切换'); await loadData(); }
        else toast.error(result?.error?.message || '操作失败');
    };

    const deleteKey = async (key) => {
        const confirmed = await confirmDialog({
            title: '删除 Key',
            message: '确定要删除该 Key 吗？此操作不可恢复。',
            danger: true
        });
        if (!confirmed) return;
        const result = await apiRequest(`${API_BASE}/keys/${encodeURIComponent(key.id)}`, { method: 'DELETE' });
        if (result?.success) { toast.success('已删除'); await loadData(); }
        else toast.error(result?.error?.message || '删除失败');
    };

    const applyLimitToAll = async () => {
        const dailyLimit = Number.parseInt(applyLimitValue, 10);
        if (!dailyLimit || dailyLimit < 1) {
            toast.error('请输入有效的限额');
            return;
        }
        const result = await apiRequest(`${API_BASE}/keys/apply-limit`, {
            method: 'POST',
            body: JSON.stringify({ dailyLimit })
        });
        if (result?.success) {
            toast.success(result.message || '已应用');
            setApplyLimitOpen(false);
            await loadData();
        } else {
            toast.error(result?.error?.message || '操作失败');
        }
    };

    const renderKey = (key) => {
        const usagePercent = key.dailyLimit > 0 ? (key.todayUsage / key.dailyLimit * 100) : 0;
        const progressClass = usagePercent >= 90 ? 'danger' : usagePercent >= 70 ? 'warning' : '';
        const badges = keyProviderBadges(key.usageHistory || {});

        return html`
            <div class=${`key-card ${key.enabled ? '' : 'disabled'}`} key=${key.id}>
                <div class="key-info">
                    <div class="key-name">
                        ${key.name}
                        <button class="btn-copy" style="margin-left:4px;padding:2px 6px;" title="修改名称"
                            onClick=${() => setEditName({ key, value: key.name })}>
                            <i class="fas fa-edit"></i>
                        </button>
                    </div>
                    <div class="key-id">
                        ${key.maskedKey}
                        <button class="btn-copy" title="复制完整 Key" onClick=${() => void copyKey(key.id)}>
                            <i class="fas fa-copy"></i>
                        </button>
                    </div>
                    ${badges.length > 0 ? html`
                        <div class="key-dist-mini">
                            ${badges.map((badge) => html`
                                <span class="dist-badge" key=${badge.name}>${badge.name}: <b>${formatNumber(badge.count)}</b></span>`)}
                        </div>` : null}
                </div>
                <div class="key-stats">
                    <div class="key-stat">
                        <div class="label">今日/限额</div>
                        <div class=${`value ${progressClass}`}>${key.todayUsage}/${key.dailyLimit}</div>
                        <div class="value muted">
                            ${formatTokenCompact(key.todayTotalTokens || 0)} Tokens
                            ${key.todayCachedTokens ? `(含 ${formatTokenCompact(key.todayCachedTokens)} 缓存)` : ''}
                        </div>
                        <div class="progress-bar"><div class=${`fill ${progressClass}`} style=${`width:${usagePercent}%`}></div></div>
                    </div>
                    <div class="key-stat">
                        <div class="label">累计数据</div>
                        <div class="value">${key.totalUsage} 次请求</div>
                        <div class="value muted">
                            ${formatTokenCompact(key.totalTokens || 0)} Tokens
                            ${key.totalCachedTokens ? `(含 ${formatTokenCompact(key.totalCachedTokens)} 缓存)` : ''}
                        </div>
                    </div>
                    <div class="key-stat">
                        <div class="label">请求频率</div>
                        <div class="value">${(key.qps || 0).toFixed(2)} QPS / ${(key.rpm || 0).toFixed(0)} RPM</div>
                        <div class="value muted">峰值: ${(key.maxQps || 0).toFixed(2)} QPS / ${(key.maxRpm || 0).toFixed(0)} RPM</div>
                    </div>
                    <div class="key-stat">
                        <div class="label">Token 速率</div>
                        <div class="value">${(key.tps || 0).toFixed(1)} TPS</div>
                        <div class="value muted">峰值: ${(key.maxTps || 0).toFixed(1)} TPS</div>
                    </div>
                    <div class="key-stat">
                        <div class="label">最后调用</div>
                        <div class="value muted">${formatRelativeTime(key.lastUsedAt)}</div>
                    </div>
                    <div class="key-stat">
                        <div class="label">状态</div>
                        <div class="value" style=${`color:${key.enabled ? 'var(--success-color)' : 'var(--danger-color)'}`}>
                            ${key.enabled ? '启用' : '禁用'}
                        </div>
                    </div>
                </div>
                <div class="key-actions">
                    <button class="btn btn-secondary btn-sm" onClick=${() => void resetUsage(key)}>
                        <i class="fas fa-redo"></i> <span class="btn-text">重置</span>
                    </button>
                    <button class="btn btn-secondary btn-sm" onClick=${() => void resetTokenStats(key)}>
                        <i class="fas fa-eraser"></i> <span class="btn-text">Token</span>
                    </button>
                    <button class="btn btn-secondary btn-sm" onClick=${() => setEditLimit({ key, value: key.dailyLimit })}>
                        <i class="fas fa-sliders-h"></i> <span class="btn-text">限额</span>
                    </button>
                    <button class="btn btn-secondary btn-sm" onClick=${() => void toggleKey(key)}>
                        <i class=${`fas ${key.enabled ? 'fa-toggle-on' : 'fa-toggle-off'}`}></i>
                        <span class="btn-text">${key.enabled ? '禁用' : '启用'}</span>
                    </button>
                    <button class="btn btn-danger btn-sm" onClick=${() => void deleteKey(key)}>
                        <i class="fas fa-trash"></i> <span class="btn-text">删除</span>
                    </button>
                </div>
            </div>`;
    };

    return html`
        <nav class="navbar">
            <div class="navbar-inner">
                <div class="navbar-brand">
                    <span class="icon">🍲</span><span>API 大锅饭</span><span class="badge">管理端</span>
                </div>
                <div class="navbar-actions" style="display:flex;align-items:center;gap:12px;">
                    <button class="theme-toggle" title="切换主题" onClick=${toggleTheme}>
                        <i class="fas fa-sun"></i><i class="fas fa-moon"></i>
                    </button>
                    <button class="btn btn-primary" onClick=${() => setCreateOpen(true)}>
                        <i class="fas fa-plus"></i> <span class="btn-text">生成新 Key</span>
                    </button>
                </div>
            </div>
        </nav>

        <div class="main-container">
            <div class="stats-grid">
                ${[
                    ['purple', '总 Key 数', stats.totalKeys || 0],
                    ['green', '已启用', stats.enabledKeys || 0],
                    ['pink', '今日总调用', stats.todayTotalUsage || 0],
                    ['cyan', '累计调用', stats.totalUsage || 0],
                    ['green', '今日总 Tokens', formatTokenCompact(stats.todayTotalTokens)],
                    ['cyan', '今日缓存 Tokens', formatTokenCompact(stats.todayCachedTokens)],
                    ['pink', '累计 Tokens', formatTokenCompact(stats.totalTokens)],
                    ['cyan', '累计缓存 Tokens', formatTokenCompact(stats.totalCachedTokens)]
                ].map(([color, label, value]) => html`
                    <div class=${`stat-card ${color}`} key=${label}>
                        <div class="label">${label}</div>
                        <div class="value">${value}</div>
                    </div>`)}
            </div>
            <div style="font-size:12px;color:var(--text-secondary);margin-top:-1rem;margin-bottom:1.5rem;">
                QPS: <strong>${(stats.qps || 0).toFixed(2)}</strong> (峰值: ${(stats.maxQps || 0).toFixed(2)}) |
                RPM: <strong>${(stats.rpm || 0).toFixed(2)}</strong> (峰值: ${(stats.maxRpm || 0).toFixed(2)}) |
                TPS: <strong>${(stats.tps || 0).toFixed(2)}</strong> (峰值: ${(stats.maxTps || 0).toFixed(2)})
            </div>

            ${aggregated.totalCalls > 0 ? html`
                <div style="margin-bottom: 2.5rem;">
                    <div class="section-title"><i class="fas fa-chart-pie"></i> 节点与 Token 使用统计 (最近 3 个月)</div>
                    <div class="stats-grid" style="grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 1.5rem;">
                        <div class="stat-card" style="text-align: left; padding: 20px;">
                            <div class="label" style="margin-bottom:10px;font-weight:600;display:flex;justify-content:space-between;">
                                <span>Token 用量日历</span>
                                <div class="calendar-legend" style="gap:3px;">
                                    <div class="level level-1" style="width:8px;height:8px"></div>
                                    <div class="level level-4" style="width:8px;height:8px"></div>
                                </div>
                            </div>
                            <${StatsCalendar} usageHistory=${usageHistory} />
                        </div>
                        <div class="stat-card" style="text-align: left; padding: 20px;">
                            <div class="label" style="margin-bottom:15px;font-weight:600;display:flex;justify-content:space-between;">
                                <span>提供商占比 (Providers)</span>
                                <span style="color:var(--primary-color);">
                                    ${formatNumber(aggregated.totalCalls)} 次 / ${formatTokenCompact(aggregated.totalTokens)} Tokens
                                </span>
                            </div>
                            <${DistributionList} data=${aggregated.providers} total=${aggregated.totalCalls} />
                        </div>
                        <div class="stat-card" style="text-align: left; padding: 20px;">
                            <div class="label" style="margin-bottom:15px;font-weight:600;display:flex;justify-content:space-between;">
                                <span>模型活跃度 (Models)</span>
                                <span style="color:var(--primary-color);">${formatNumber(aggregated.totalCalls)} 次</span>
                            </div>
                            <${DistributionList} data=${aggregated.models} total=${aggregated.totalCalls} />
                        </div>
                    </div>
                </div>` : null}

            <div class="keys-section">
                <div class="keys-header">
                    <h2 class="section-title" style="margin-bottom:0;"><i class="fas fa-key"></i> Key 列表</h2>
                    <div class="toolbar">
                        <div class="search-wrapper">
                            <input type="text" class="search-box" placeholder="搜索名称或 Key..."
                                value=${search} onInput=${(event) => setSearch(event.currentTarget.value)} />
                            <select class="sort-select" value=${sort} onChange=${(event) => setSort(event.currentTarget.value)}>
                                <option value="name-asc">名称 A-Z</option>
                                <option value="name-desc">名称 Z-A</option>
                                <option value="usage-desc">今日用量 ↓</option>
                                <option value="usage-asc">今日用量 ↑</option>
                                <option value="total-desc">累计用量 ↓</option>
                                <option value="lastUsed-desc">最近使用 ↓</option>
                                <option value="qps-desc">QPS 速率 ↓</option>
                                <option value="rpm-desc">RPM 频率 ↓</option>
                                <option value="created-desc">创建时间 ↓</option>
                            </select>
                        </div>
                        <div class="btn-limit-wrapper">
                            <button class="btn btn-secondary btn-sm" onClick=${() => void resetAllTokenStats()}>
                                <i class="fas fa-eraser"></i> <span class="btn-limit-text">重置全部 Token</span>
                            </button>
                            <button class="btn btn-secondary btn-sm" onClick=${() => setApplyLimitOpen(true)}>
                                <i class="fas fa-cog"></i> <span class="btn-limit-text">批量应用限额</span>
                            </button>
                        </div>
                    </div>
                </div>
                <div class="keys-list">
                    ${allKeys.length === 0 ? html`
                        <div class="empty-state">
                            <div class="icon"><i class="fas fa-inbox"></i></div>
                            <p>还没有任何 API Key</p>
                            <button class="btn btn-primary btn-lg" onClick=${() => setCreateOpen(true)}>
                                <i class="fas fa-plus"></i> 生成第一个 Key
                            </button>
                        </div>`
                        : filteredKeys.length === 0
                            ? html`<div class="no-results">没有匹配的结果</div>`
                            : filteredKeys.map(renderKey)}
                </div>
            </div>
        </div>

        <${Modal} open=${createOpen} title="生成新 API Key" onClose=${() => setCreateOpen(false)} width="480px"
            footer=${html`
                <button class="btn btn-secondary" onClick=${() => setCreateOpen(false)}>取消</button>
                <button class="btn btn-primary" onClick=${() => void createKey()}>
                    <i class="fas fa-check"></i> 生成 Key
                </button>`}>
            <div class="form-group">
                <label>Key 名称 (可选)</label>
                <input type="text" class="form-control" value=${createName} placeholder="例如：测试用户 1"
                    onInput=${(event) => setCreateName(event.currentTarget.value)} />
            </div>
            <div class="form-group">
                <label>每日调用限额</label>
                <input type="number" class="form-control" value=${createLimit} placeholder="500" min="1"
                    onInput=${(event) => setCreateLimit(event.currentTarget.value)} />
            </div>
        <//>

        <${Modal} open=${!!createdKey} title="Key 已生成" onClose=${() => setCreatedKey('')} width="520px"
            footer=${html`
                <button class="btn btn-secondary" onClick=${() => void copyKey(createdKey)}>
                    <i class="fas fa-copy"></i> 复制 Key
                </button>`}>
            <p style="color:var(--text-secondary);margin-bottom:10px;">请妥善保存此 Key，关闭后将无法再次查看完整内容：</p>
            <div class="key-display" style="word-break:break-all;padding:12px;background:var(--bg-tertiary);border-radius:8px;font-family:monospace;">
                ${createdKey}
            </div>
        <//>

        <${Modal} open=${!!editLimit} title="修改每日限额" onClose=${() => setEditLimit(null)} width="420px"
            footer=${html`
                <button class="btn btn-secondary" onClick=${() => setEditLimit(null)}>取消</button>
                <button class="btn btn-primary" onClick=${() => void updateLimit()}><i class="fas fa-save"></i> 保存</button>`}>
            <div class="form-group">
                <label>新的每日限额</label>
                <input type="number" class="form-control" min="1" value=${editLimit?.value || ''}
                    onInput=${(event) => setEditLimit((current) => ({ ...current, value: event.currentTarget.value }))} />
            </div>
        <//>

        <${Modal} open=${!!editName} title="修改 Key 名称" onClose=${() => setEditName(null)} width="420px"
            footer=${html`
                <button class="btn btn-secondary" onClick=${() => setEditName(null)}>取消</button>
                <button class="btn btn-primary" onClick=${() => void updateName()}><i class="fas fa-save"></i> 保存</button>`}>
            <div class="form-group">
                <label>新的名称</label>
                <input type="text" class="form-control" value=${editName?.value || ''}
                    onInput=${(event) => setEditName((current) => ({ ...current, value: event.currentTarget.value }))} />
            </div>
        <//>

        <${Modal} open=${applyLimitOpen} title="批量应用每日限额" onClose=${() => setApplyLimitOpen(false)} width="460px"
            footer=${html`
                <button class="btn btn-secondary" onClick=${() => setApplyLimitOpen(false)}>取消</button>
                <button class="btn btn-primary" onClick=${() => void applyLimitToAll()}>
                    <i class="fas fa-check"></i> 应用限额
                </button>`}>
            <div class="form-group">
                <label>每日调用限额</label>
                <input type="number" class="form-control" min="1" value=${applyLimitValue}
                    onInput=${(event) => setApplyLimitValue(event.currentTarget.value)} />
            </div>
            <div style="background: var(--danger-bg); border: 1px solid var(--danger-border); border-radius: var(--radius-lg); padding: 12px; margin-top: 12px;">
                <p style="color: var(--danger-text); font-size: 13px; margin: 0;">
                    <i class="fas fa-exclamation-triangle"></i> 风险提示：
                </p>
                <ul style="color: var(--danger-text); font-size: 12px; margin: 8px 0 0 16px; padding: 0;">
                    <li>所有 Key 的每日限额将被覆盖</li>
                    <li>已单独设置限额的 Key 也会被修改</li>
                    <li>此操作不可撤销</li>
                </ul>
            </div>
        <//>`;
}

async function boot() {
    initTheme();
    const page = document.getElementById('page');
    render(html`<${PotluckAdminPage} />`, page);
    const toastRoot = document.getElementById('toastContainer');
    if (toastRoot) render(html`<${ToastHost} />`, toastRoot);
}

void boot();
