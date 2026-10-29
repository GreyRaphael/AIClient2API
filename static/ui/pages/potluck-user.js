/** API 大锅饭 - 用户用量页（Phase 5 迁移）。 */
import { html, render, useEffect, useRef, useState } from '../html.js';
import { initTheme, toggleTheme } from '../lib/theme.js';
import { copyToClipboard } from '../lib/clipboard.js';
import { toast } from '../store/toast.js';
import { ToastHost } from '../components/Toast.js';
import { ConfirmDialogHost } from '../components/ConfirmDialog.js';
import { StatsCalendar } from '../components/StatsCalendar.js';
import { DistributionList } from '../components/DistributionList.js';
import {
    aggregateUsage,
    formatNumber,
    formatTokenCompact,
    formatDateTime
} from '../lib/stats.js';

const API_BASE = '/api/potluckuser';
const STORAGE_KEY = 'potluck_user_key';

function PotluckUserPage() {
    const [apiKey, setApiKey] = useState('');
    const [remember, setRemember] = useState(true);
    const [data, setData] = useState(/** @type {any} */ (null));
    const [loading, setLoading] = useState(false);
    const inputRef = useRef(/** @type {HTMLInputElement|null} */ (null));

    const login = async (keyValue = apiKey) => {
        const key = String(keyValue || '').trim();
        if (!key) {
            toast.error('请输入 API Key');
            return;
        }
        if (!key.startsWith('maki_')) {
            toast.error('API Key 格式不正确');
            return;
        }

        setLoading(true);
        try {
            const response = await fetch(`${API_BASE}/usage`, {
                method: 'GET',
                headers: { Authorization: `Bearer ${key}` }
            });
            const payload = await response.json();
            if (!response.ok || !payload.success) {
                throw new Error(payload.error?.message || '登录失败');
            }
            if (remember) localStorage.setItem(STORAGE_KEY, key);
            else localStorage.removeItem(STORAGE_KEY);
            setApiKey(key);
            setData(payload.data);
            toast.success('登录成功');
        } catch (error) {
            toast.error(error.message);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) {
            setApiKey(saved);
            void login(saved);
        } else {
            inputRef.current?.focus();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const logout = () => {
        localStorage.removeItem(STORAGE_KEY);
        setApiKey('');
        setData(null);
        toast.success('已退出登录');
    };

    const copyApiKey = async () => {
        const copied = await copyToClipboard(apiKey);
        toast[copied ? 'success' : 'error'](copied ? '已复制到剪贴板' : '复制失败，请手动复制');
    };

    const usageHistory = data?.usageHistory || {};
    const aggregated = aggregateUsage(usageHistory);
    const showUsageStats = aggregated.totalCalls > 0;

    return html`
        <nav class="navbar">
            <div class="navbar-inner">
                <div class="navbar-brand">
                    <span class="icon">🍲</span>
                    <span>API 大锅饭</span>
                    <span class="badge">用户版</span>
                </div>
                ${data ? html`
                    <div class="navbar-user" style="display:flex;">
                        <span class="welcome">欢迎，<strong>${data.name || '用户'}</strong></span>
                        <button class="theme-toggle" title="切换主题" onClick=${toggleTheme}>
                            <i class="fas fa-sun"></i><i class="fas fa-moon"></i>
                        </button>
                        <button class="btn btn-secondary btn-sm" onClick=${logout}>
                            <i class="fas fa-sign-out-alt"></i> <span class="btn-text">退出</span>
                        </button>
                    </div>` : html`
                    <button class="theme-toggle" style="display:inline-flex;" title="切换主题" onClick=${toggleTheme}>
                        <i class="fas fa-sun"></i><i class="fas fa-moon"></i>
                    </button>`}
            </div>
        </nav>

        ${!data ? html`
            <div class="login-container">
                <div class="login-box">
                    <h2><i class="fas fa-key"></i> 登录</h2>
                    <p class="subtitle">使用您的 API Key 登录查看用量</p>
                    <div class="form-group">
                        <label>API Key</label>
                        <input type="text" id="apiKeyInput" class="form-input" ref=${inputRef} value=${apiKey}
                            placeholder="maki_xxxxxxxx..." autocomplete="off"
                            onInput=${(event) => setApiKey(event.currentTarget.value)}
                            onKeyDown=${(event) => { if (event.key === 'Enter') void login(); }} />
                    </div>
                    <div class="form-group">
                        <label class="form-checkbox">
                            <input type="checkbox" id="rememberKey" checked=${remember}
                                onChange=${(event) => setRemember(event.currentTarget.checked)} />
                            <span>记住我的 Key</span>
                        </label>
                    </div>
                    <button class="btn btn-primary btn-block" id="loginBtn" disabled=${loading} onClick=${() => void login()}>
                        <i class=${`fas ${loading ? 'fa-spinner fa-spin' : 'fa-sign-in-alt'}`}></i>
                        ${loading ? '登录中...' : '登录'}
                    </button>
                </div>
            </div>` : html`
            <div class="main-container" style="display:block;">
                <h3 class="section-title"><i class="fas fa-chart-bar"></i> 个人使用统计</h3>

                <div class="stats-grid">
                    <div class="stat-card orange">
                        <div class="label">最后使用</div>
                        <div class="value">${data.lastUsedAt ? formatDateTime(data.lastUsedAt) : '从未'}</div>
                    </div>
                    <div class="stat-card purple">
                        <div class="label">每日用量</div>
                        <div class="value">
                            <span>${data.usage?.today ?? 0}</span>
                            <span class="dim"> / <span>${data.usage?.limit ?? 0}</span></span>
                        </div>
                        <div style="font-size:12px;color:var(--text-secondary);margin-top:4px">
                            QPS: <span style="font-weight:700;color:var(--primary-color)">${(data.usage?.qps || 0).toFixed(2)}</span>
                            (峰值: <span>${(data.usage?.maxQps || 0).toFixed(2)}</span>) |
                            RPM: <span style="font-weight:700;color:var(--primary-color)">${(data.usage?.rpm || 0).toFixed(2)}</span>
                            (峰值: <span>${(data.usage?.maxRpm || 0).toFixed(2)}</span>)
                        </div>
                    </div>
                    <div class="stat-card green">
                        <div class="label">剩余额度</div>
                        <div class="value">${data.usage?.remaining ?? 0}</div>
                    </div>
                    <div class="stat-card cyan">
                        <div class="label">累计调用</div>
                        <div class="value">${data.total || 0}</div>
                    </div>
                    <div class="stat-card green">
                        <div class="label">今日 Tokens</div>
                        <div class="value">${formatTokenCompact(data.usage?.totalTokens || 0)}</div>
                        <div style="font-size:12px;color:var(--text-secondary);margin-top:4px">
                            TPS: <span style="font-weight:700;color:var(--primary-color)">${(data.usage?.tps || 0).toFixed(2)}</span>
                            (峰值: <span>${(data.usage?.maxTps || 0).toFixed(2)}</span>)
                        </div>
                    </div>
                    <div class="stat-card cyan">
                        <div class="label">今日缓存 Tokens</div>
                        <div class="value">${formatTokenCompact(data.usage?.cachedTokens || 0)}</div>
                    </div>
                    <div class="stat-card purple">
                        <div class="label">累计 Tokens</div>
                        <div class="value">${formatTokenCompact(data.tokens?.total || 0)}</div>
                    </div>
                    <div class="stat-card cyan">
                        <div class="label">累计缓存 Tokens</div>
                        <div class="value">${formatTokenCompact(data.tokens?.cached || 0)}</div>
                    </div>
                </div>

                ${showUsageStats ? html`
                    <div style="margin-bottom: 2.5rem;">
                        <h3 class="section-title"><i class="fas fa-chart-pie"></i> 我的使用趋势与分布 (最近 3 个月)</h3>
                        <div class="stats-grid" style="grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 1.5rem;">
                            <div class="stat-card" style="text-align: left; padding: 20px;">
                                <div class="label" style="margin-bottom: 10px; font-weight: 600; display: flex; justify-content: space-between;">
                                    <span>我的 Token 消耗趋势</span>
                                    <div class="calendar-legend" style="gap: 3px;">
                                        <div class="level level-1" style="width:8px;height:8px"></div>
                                        <div class="level level-4" style="width:8px;height:8px"></div>
                                    </div>
                                </div>
                                <${StatsCalendar} usageHistory=${usageHistory} />
                            </div>
                            <div class="stat-card" style="text-align: left; padding: 20px;">
                                <div class="label" style="margin-bottom: 15px; font-weight: 600; display: flex; justify-content: space-between;">
                                    <span>常用提供商</span>
                                    <span style="color: var(--primary-color);">
                                        ${formatNumber(aggregated.totalCalls)} 次 / ${formatTokenCompact(aggregated.totalTokens)} Tokens
                                    </span>
                                </div>
                                <${DistributionList} data=${aggregated.providers} total=${aggregated.totalCalls} />
                            </div>
                            <div class="stat-card" style="text-align: left; padding: 20px;">
                                <div class="label" style="margin-bottom: 15px; font-weight: 600; display: flex; justify-content: space-between;">
                                    <span>常用模型</span>
                                    <span style="color: var(--primary-color);">${formatNumber(aggregated.totalCalls)} 次</span>
                                </div>
                                <${DistributionList} data=${aggregated.models} total=${aggregated.totalCalls} />
                            </div>
                        </div>
                    </div>` : null}

                <h3 class="section-title"><i class="fas fa-key"></i> API 密钥</h3>
                <div class="apikey-display">
                    <input type="text" readonly value=${apiKey}
                        style="font-family: 'JetBrains Mono', monospace; font-size: 14px; text-align: center; background: var(--bg-secondary);" />
                    <button class="btn btn-primary btn-block" onClick=${() => void copyApiKey()}>
                        <i class="fas fa-copy"></i> <span>复制 Key</span>
                    </button>
                </div>
                <div class="info-box">
                    <p><i class="fas fa-info-circle"></i> API Key 用于访问 API 服务。请妥善保管，不要泄露给他人。</p>
                </div>
            </div>`}
    `;
}

async function boot() {
    initTheme();
    const page = document.getElementById('page');
    render(html`<${PotluckUserPage} />`, page);
    const toastRoot = document.getElementById('toastContainer');
    if (toastRoot) render(html`<${ToastHost} />`, toastRoot);
    const confirmRoot = document.getElementById('confirm-root');
    if (confirmRoot) render(html`<${ConfirmDialogHost} />`, confirmRoot);
}

void boot();
