/**
 * 令牌管理 (API Keys) 控制台主模块
 *
 * 统一整合至主控制台：
 * 1. 全局用量指标卡片与 QPS/RPM/TPS 实时监控
 * 2. 年度 Token 用量热力图日历与 Provider/Model 分布
 * 3. 密钥管理列表：搜索、排序、限额修改、名称修改、状态切换、重置、重新生成、删除
 * 4. 商业化套餐管理：设置套餐、续期套餐、解除套餐、每日 Token 上限控制
 */

import { html, useEffect, useMemo, useState } from '../../html.js';
import { api } from '../../lib/api.js';
import { copyToClipboard } from '../../lib/clipboard.js';
import { confirmDialog } from '../../store/confirm.js';
import { toast, toastError } from '../../store/toast.js';
import { Modal } from '../../components/Modal.js';
import { StatsCalendar } from '../../components/StatsCalendar.js';
import { DistributionList } from '../../components/DistributionList.js';
import {
    aggregateUsage,
    formatNumber,
    formatTokenCompact,
    formatRelativeTime,
    keyProviderBadges
} from '../../lib/stats.js';
import type {
    ApiKeyRecord,
    BillingCycle,
    GlobalApiKeyStats,
    KeyPlan,
    TokenPack
} from '../../../../src/services/api-keys/types.ts';

interface KeyListData {
    keys: ApiKeyRecord[];
    stats: GlobalApiKeyStats;
}

export default function ApiKeysSection() {
    const [data, setData] = useState<KeyListData | null>(null);
    const [loading, setLoading] = useState(false);
    const [search, setSearch] = useState('');
    const [sort, setSort] = useState('created-desc');

    // 生成新 Key 模态框
    const [createOpen, setCreateOpen] = useState(false);
    const [createName, setCreateName] = useState('');
    const [createLimit, setCreateLimit] = useState('500');
    const [createPackId, setCreatePackId] = useState('');
    const [createCycleId, setCreateCycleId] = useState('month');
    const [createDailyCap, setCreateDailyCap] = useState('');

    // 新生成 Key 显示模态框
    const [createdKey, setCreatedKey] = useState<ApiKeyRecord | null>(null);

    // 修改名称 / 限额模态框
    const [editLimit, setEditLimit] = useState<{ key: ApiKeyRecord; value: string } | null>(null);
    const [editName, setEditName] = useState<{ key: ApiKeyRecord; value: string } | null>(null);

    // 批量限额模态框
    const [applyLimitOpen, setApplyLimitOpen] = useState(false);
    const [applyLimitValue, setApplyLimitValue] = useState('500');

    // 套餐配置模态框
    const [planModalKey, setPlanModalKey] = useState<ApiKeyRecord | null>(null);
    const [planPackId, setPlanPackId] = useState('pack_100m');
    const [planCycleId, setPlanCycleId] = useState('month');
    const [planDailyCap, setPlanDailyCap] = useState('');

    // 在售套餐定义
    const [availablePacks, setAvailablePacks] = useState<TokenPack[]>([]);
    const [availableCycles, setAvailableCycles] = useState<BillingCycle[]>([]);

    const loadData = async (): Promise<void> => {
        setLoading(true);
        try {
            const res = await api.get('/keys') as { success: boolean; data: KeyListData };
            if (res && res.data) {
                setData(res.data);
            }
        } catch (err) {
            toastError((err as Error).message || '加载令牌列表失败');
        } finally {
            setLoading(false);
        }
    };

    const loadPlansDef = async (): Promise<void> => {
        try {
            const res = await api.get('/keys/plans') as { success: boolean; data: { packs: TokenPack[]; cycles: BillingCycle[] } };
            if (res && res.data) {
                setAvailablePacks(res.data.packs || []);
                setAvailableCycles(res.data.cycles || []);
            }
        } catch { /* 忽略 */ }
    };

    useEffect(() => {
        void loadData();
        void loadPlansDef();
    }, []);

    const stats = data?.stats;
    const allKeys = data?.keys || [];
    const usageHistory = stats?.usageHistory || {};
    const aggregated = useMemo(() => aggregateUsage(usageHistory), [usageHistory]);

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
            let left: string | number = '';
            let right: string | number = '';
            if (field === 'name') {
                left = String(a.name || '').toLowerCase();
                right = String(b.name || '').toLowerCase();
            } else if (field === 'usage') {
                left = a.todayUsage;
                right = b.todayUsage;
            } else if (field === 'total') {
                left = a.totalUsage;
                right = b.totalUsage;
            } else if (field === 'lastUsed') {
                left = a.lastUsedAt || '';
                right = b.lastUsedAt || '';
            } else if (field === 'qps') {
                left = a.qps || 0;
                right = b.qps || 0;
            } else if (field === 'rpm') {
                left = a.rpm || 0;
                right = b.rpm || 0;
            } else {
                left = a.createdAt || '';
                right = b.createdAt || '';
            }
            if (left < right) return order === 'asc' ? -1 : 1;
            if (left > right) return order === 'asc' ? 1 : -1;
            return 0;
        });
    }, [allKeys, search, sort]);

    const copyText = async (text: string, message: string = '已复制到剪贴板'): Promise<void> => {
        const copied = await copyToClipboard(text);
        if (copied) toast.success(message);
        else toast.error('复制失败，请手动复制');
    };

    const handleCreateKey = async (): Promise<void> => {
        const limit = Number.parseInt(createLimit, 10);
        const payload: Record<string, unknown> = {
            name: createName.trim(),
            dailyLimit: Number.isFinite(limit) && limit >= 0 ? limit : 500
        };

        if (createPackId) {
            payload.packId = createPackId;
            payload.cycleId = createCycleId;
            if (createDailyCap) {
                payload.dailyTokenCap = Number(createDailyCap);
            }
        }

        try {
            const res = await api.post('/keys', payload) as { success: boolean; data: ApiKeyRecord };
            if (res && res.data) {
                setCreatedKey(res.data);
                setCreateOpen(false);
                setCreateName('');
                setCreateLimit('500');
                setCreatePackId('');
                setCreateDailyCap('');
                toast.success('API Key 创建成功');
                await loadData();
            }
        } catch (err) {
            toastError((err as Error).message || '创建失败');
        }
    };

    const handleUpdateName = async (): Promise<void> => {
        if (!editName) return;
        const name = editName.value.trim();
        if (!name) {
            toast.error('名称不能为空');
            return;
        }
        try {
            await api.put(`/keys/${encodeURIComponent(editName.key.id)}/name`, { name });
            toast.success('名称已更新');
            setEditName(null);
            await loadData();
        } catch (err) {
            toastError((err as Error).message || '更新名称失败');
        }
    };

    const handleUpdateLimit = async (): Promise<void> => {
        if (!editLimit) return;
        const limit = Number.parseInt(editLimit.value, 10);
        if (!Number.isFinite(limit) || limit < 0) {
            toast.error('请输入有效的限额数字');
            return;
        }
        try {
            await api.put(`/keys/${encodeURIComponent(editLimit.key.id)}/limit`, { dailyLimit: limit });
            toast.success('每日限额已更新');
            setEditLimit(null);
            await loadData();
        } catch (err) {
            toastError((err as Error).message || '更新限额失败');
        }
    };

    const handleApplyLimitToAll = async (): Promise<void> => {
        const limit = Number.parseInt(applyLimitValue, 10);
        if (!Number.isFinite(limit) || limit < 0) {
            toast.error('请输入有效的限额数字');
            return;
        }
        try {
            await api.post('/keys/apply-limit', { dailyLimit: limit });
            toast.success(`已将每日限额 ${limit} 应用到全部 Key`);
            setApplyLimitOpen(false);
            await loadData();
        } catch (err) {
            toastError((err as Error).message || '批量更新限额失败');
        }
    };

    const handleToggleKey = async (key: ApiKeyRecord): Promise<void> => {
        try {
            const res = await api.post(`/keys/${encodeURIComponent(key.id)}/toggle`) as { success: boolean; enabled: boolean };
            toast.success(res.enabled ? '已启用该 Key' : '已禁用该 Key');
            await loadData();
        } catch (err) {
            toastError((err as Error).message || '操作失败');
        }
    };

    const handleResetUsage = async (key: ApiKeyRecord): Promise<void> => {
        const confirmed = await confirmDialog({
            title: '重置今日调用量',
            message: `确定要重置「${key.name}」的今日调用次数吗？`,
            danger: true
        });
        if (!confirmed) return;
        try {
            await api.post(`/keys/${encodeURIComponent(key.id)}/reset`);
            toast.success('今日调用次数已重置');
            await loadData();
        } catch (err) {
            toastError((err as Error).message || '重置失败');
        }
    };

    const handleResetTokenStats = async (key: ApiKeyRecord): Promise<void> => {
        const confirmed = await confirmDialog({
            title: '重置 Token 统计',
            message: `确定要重置「${key.name}」的 Token 统计吗？这会清空该 Key 的今日/累计 Token 与日历统计，但保留调用次数。`,
            danger: true
        });
        if (!confirmed) return;
        try {
            await api.post(`/keys/${encodeURIComponent(key.id)}/reset-tokens`);
            toast.success('Token 统计已重置');
            await loadData();
        } catch (err) {
            toastError((err as Error).message || '重置失败');
        }
    };

    const handleResetAllTokens = async (): Promise<void> => {
        const confirmed = await confirmDialog({
            title: '重置全部 Key 的 Token 统计',
            message: '确定要重置所有 Key 的 Token 统计吗？此操作不可逆。',
            danger: true
        });
        if (!confirmed) return;
        try {
            await api.post('/keys/stats/reset-tokens');
            toast.success('全部 Key 的 Token 统计已重置');
            await loadData();
        } catch (err) {
            toastError((err as Error).message || '重置失败');
        }
    };

    const handleRegenerateKey = async (key: ApiKeyRecord): Promise<void> => {
        const confirmed = await confirmDialog({
            title: '重新生成 Key',
            message: `确定要为「${key.name}」重新生成密钥吗？旧密钥将立即作废！`,
            danger: true
        });
        if (!confirmed) return;
        try {
            const res = await api.post(`/keys/${encodeURIComponent(key.id)}/regenerate`) as { success: boolean; data: ApiKeyRecord };
            if (res && res.data) {
                setCreatedKey(res.data);
                toast.success('密钥已重新生成');
                await loadData();
            }
        } catch (err) {
            toastError((err as Error).message || '重新生成失败');
        }
    };

    const handleDeleteKey = async (key: ApiKeyRecord): Promise<void> => {
        const confirmed = await confirmDialog({
            title: '删除 API Key',
            message: `确定要永久删除「${key.name}」(${key.id}) 吗？此操作无法撤销！`,
            danger: true
        });
        if (!confirmed) return;
        try {
            await api.delete(`/keys/${encodeURIComponent(key.id)}`);
            toast.success('Key 已删除');
            await loadData();
        } catch (err) {
            toastError((err as Error).message || '删除失败');
        }
    };

    const openPlanModal = (key: ApiKeyRecord): void => {
        setPlanModalKey(key);
        if (key.plan) {
            setPlanPackId(key.plan.packId);
            setPlanCycleId(key.plan.cycleId);
            setPlanDailyCap(key.plan.dailyTokenCap ? String(key.plan.dailyTokenCap) : '');
        } else {
            setPlanPackId('pack_100m');
            setPlanCycleId('month');
            setPlanDailyCap('');
        }
    };

    const handleSavePlan = async (): Promise<void> => {
        if (!planModalKey) return;
        try {
            await api.post('/keys/plan', {
                keyId: planModalKey.id,
                packId: planPackId,
                cycleId: planCycleId,
                dailyTokenCap: planDailyCap ? Number(planDailyCap) : null
            });
            toast.success('套餐设置成功');
            setPlanModalKey(null);
            await loadData();
        } catch (err) {
            toastError((err as Error).message || '设置套餐失败');
        }
    };

    const handleRenewPlan = async (): Promise<void> => {
        if (!planModalKey) return;
        try {
            await api.post('/keys/plan/renew', {
                keyId: planModalKey.id,
                cycleId: planCycleId
            });
            toast.success('套餐续期成功');
            setPlanModalKey(null);
            await loadData();
        } catch (err) {
            toastError((err as Error).message || '续期失败');
        }
    };

    const handleClearPlan = async (): Promise<void> => {
        if (!planModalKey) return;
        const confirmed = await confirmDialog({
            title: '移除商业化套餐',
            message: `确定要为「${planModalKey.name}」解除付费套餐限制吗？该 Key 将恢复为仅受每日调用次数限制。`,
            danger: true
        });
        if (!confirmed) return;
        try {
            await api.delete(`/keys/plan?keyId=${encodeURIComponent(planModalKey.id)}`);
            toast.success('套餐已成功移除');
            setPlanModalKey(null);
            await loadData();
        } catch (err) {
            toastError((err as Error).message || '移除套餐失败');
        }
    };

    const renderPlanBadge = (plan: KeyPlan | null | undefined) => {
        if (!plan) return null;
        const remaining = Math.max(0, plan.tokenQuota - plan.tokenUsed - plan.tokenReserved);
        const percent = plan.tokenQuota > 0 ? Math.min(100, Math.round((plan.tokenUsed / plan.tokenQuota) * 100)) : 0;
        const untilStr = plan.validUntil ? plan.validUntil.split('T')[0] : '永久';
        const isExpiredNow = plan.validUntil ? new Date().getTime() >= new Date(plan.validUntil).getTime() : false;

        return html`
            <div class="key-plan-banner ${isExpiredNow ? 'expired' : ''}">
                <div class="plan-head">
                    <span class="plan-tag"><i class="fas fa-crown"></i> ${plan.packLabel} · ${plan.cycleId === 'week' ? '周付' : '月付'}</span>
                    <span class="plan-expiry">${isExpiredNow ? '已过期' : `有效至 ${untilStr}`}</span>
                </div>
                <div class="plan-details">
                    <span>剩余额度 <b>${formatTokenCompact(remaining)}</b> / ${formatTokenCompact(plan.tokenQuota)} (${percent}% 已用)</span>
                    ${plan.dailyTokenCap ? html`<span>日上限 <b>${formatTokenCompact(plan.dailyTokenCap)}</b></span>` : null}
                </div>
                <div class="progress-bar plan-progress">
                    <div class=${`fill ${isExpiredNow ? 'danger' : percent >= 90 ? 'danger' : percent >= 70 ? 'warning' : ''}`} style=${`width: ${percent}%`}></div>
                </div>
            </div>`;
    };

    const renderKeyCard = (key: ApiKeyRecord) => {
        const hasLimit = key.dailyLimit > 0;
        const usagePercent = hasLimit ? (key.todayUsage / key.dailyLimit) * 100 : 0;
        const progressClass = usagePercent >= 90 ? 'danger' : usagePercent >= 70 ? 'warning' : '';
        const badges = keyProviderBadges(key.usageHistory || {});

        return html`
            <article class=${`key-card ${key.enabled ? '' : 'disabled'}`} key=${key.id}>
                <div class="key-card-head">
                    <div class="key-identity">
                        <div class="key-name-row">
                            <span class="name-text">${key.name}</span>
                            <span class=${`status-pill ${key.enabled ? 'active' : 'inactive'}`}>
                                <span class=${`status-dot ${key.enabled ? 'active' : 'inactive'}`}></span>
                                ${key.enabled ? '启用中' : '已禁用'}
                            </span>
                            <button type="button" class="btn-icon" title="修改名称" onClick=${() => setEditName({ key, value: key.name })}>
                                <i class="fas fa-edit"></i>
                            </button>
                        </div>
                        <div class="key-id-row">
                            <code class="key-code">${key.maskedKey || key.id}</code>
                            <button type="button" class="btn-icon" title="复制完整 Key" onClick=${() => void copyText(key.id)}>
                                <i class="fas fa-copy"></i>
                            </button>
                            <span class="key-last-active">
                                <i class="fas fa-clock"></i>
                                最近活跃 ${formatRelativeTime(key.lastUsedAt)}
                            </span>
                        </div>
                    </div>
                    ${badges.length > 0 ? html`
                        <div class="key-dist-mini">
                            ${badges.map((b) => html`
                                <span class="dist-badge" key=${b.name}>${b.name} <b>${formatNumber(b.count)}</b></span>
                            `)}
                        </div>` : null}
                </div>

                ${renderPlanBadge(key.plan)}

                <div class="key-stats-grid">
                    <div class="key-stat-cell">
                        <div class="stat-label">今日请求 / 每日限额</div>
                        <div class=${`stat-val ${progressClass}`}>
                            ${hasLimit ? `${formatNumber(key.todayUsage)} / ${formatNumber(key.dailyLimit)} 次` : `${formatNumber(key.todayUsage)} 次 · 无限制`}
                        </div>
                        <div class="progress-bar">
                            <div class=${`fill ${progressClass}`} style=${`width: ${Math.min(100, usagePercent)}%`}></div>
                        </div>
                    </div>

                    <div class="key-stat-cell">
                        <div class="stat-label">今日 Tokens</div>
                        <div class="stat-val">${formatTokenCompact(key.todayTotalTokens || 0)}</div>
                        <div class="stat-sub">
                            ${key.todayCachedTokens ? `含缓存 ${formatTokenCompact(key.todayCachedTokens)}` : '无缓存命中'}
                        </div>
                    </div>

                    <div class="key-stat-cell">
                        <div class="stat-label">历史累计</div>
                        <div class="stat-val">${formatNumber(key.totalUsage)} 次</div>
                        <div class="stat-sub">${formatTokenCompact(key.totalTokens || 0)} Tokens</div>
                    </div>

                    <div class="key-stat-cell">
                        <div class="stat-label">实时速率 (60s)</div>
                        <div class="stat-val">${(key.qps || 0).toFixed(2)} QPS · ${(key.rpm || 0).toFixed(0)} RPM</div>
                        <div class="stat-sub">${(key.tps || 0).toFixed(1)} TPS (峰值 ${(key.maxTps || 0).toFixed(1)})</div>
                    </div>
                </div>

                <div class="key-actions">
                    <div class="key-actions-group">
                        <button type="button" class="btn btn-secondary btn-sm" title="管理商业化套餐" onClick=${() => openPlanModal(key)}>
                            <i class="fas fa-crown"></i> <span>套餐</span>
                        </button>
                        <button type="button" class="btn btn-secondary btn-sm" title="修改每日限额" onClick=${() => setEditLimit({ key, value: String(key.dailyLimit) })}>
                            <i class="fas fa-sliders-h"></i> <span>限额</span>
                        </button>
                        <button type="button" class="btn btn-secondary btn-sm" title="重置今日调用量" onClick=${() => void handleResetUsage(key)}>
                            <i class="fas fa-redo"></i> <span>重置</span>
                        </button>
                        <button type="button" class="btn btn-secondary btn-sm" title="重置 Token 统计" onClick=${() => void handleResetTokenStats(key)}>
                            <i class="fas fa-eraser"></i> <span>Token</span>
                        </button>
                    </div>
                    <div class="key-actions-group">
                        <button type="button" class="btn btn-secondary btn-sm" title=${key.enabled ? '禁用该 Key' : '启用该 Key'} onClick=${() => void handleToggleKey(key)}>
                            <i class=${`fas ${key.enabled ? 'fa-toggle-on' : 'fa-toggle-off'}`}></i>
                            <span>${key.enabled ? '禁用' : '启用'}</span>
                        </button>
                        <button type="button" class="btn btn-secondary btn-sm" title="重新生成密钥" onClick=${() => void handleRegenerateKey(key)}>
                            <i class="fas fa-sync-alt"></i> <span>换密</span>
                        </button>
                        <button type="button" class="btn btn-danger btn-sm" title="永久删除" onClick=${() => void handleDeleteKey(key)}>
                            <i class="fas fa-trash"></i> <span>删除</span>
                        </button>
                    </div>
                </div>
            </article>`;
    };

    const totalKeys = stats?.totalKeys || 0;
    const enabledKeys = stats?.enabledKeys || 0;
    const disabledKeys = Math.max(0, totalKeys - enabledKeys);

    return html`
        <section id="api-keys" class="section active api-keys-section" aria-labelledby="api-keys-title">
            <div class="section-header">
                <div class="header-title-block">
                    <h2 id="api-keys-title"><i class="fas fa-key"></i> 令牌管理 (API Keys)</h2>
                    <p class="section-desc">管理网关客户端访问令牌、每日限额与 Token 商业化套餐配置</p>
                </div>
                <div class="header-actions">
                    <button id="refreshKeysBtn" type="button" class="btn btn-secondary btn-sm" disabled=${loading} onClick=${() => void loadData()}>
                        <i class=${`fas ${loading ? 'fa-spinner fa-spin' : 'fa-sync-alt'}`}></i> <span>刷新</span>
                    </button>
                    <a href="/potluck-user.html" target="_blank" rel="noopener noreferrer" class="btn btn-secondary btn-sm" title="打开用户端自助查询额度页面">
                        <i class="fas fa-external-link-alt"></i> <span>用户自助查询</span>
                    </a>
                    <button type="button" class="btn btn-secondary btn-sm" onClick=${() => setApplyLimitOpen(true)}>
                        <i class="fas fa-sliders-h"></i> <span>批量限额</span>
                    </button>
                    <button type="button" class="btn btn-secondary btn-sm" onClick=${() => void handleResetAllTokens()}>
                        <i class="fas fa-eraser"></i> <span>重置全部 Token</span>
                    </button>
                    <button id="createKeyBtn" type="button" class="btn btn-primary btn-sm" onClick=${() => setCreateOpen(true)}>
                        <i class="fas fa-plus"></i> <span>生成新 Key</span>
                    </button>
                </div>
            </div>

            <div class="api-keys-stats-grid">
                <div class="kpi-card tone-indigo">
                    <div class="kpi-head">
                        <span class="kpi-label">启用 / 总 Key</span>
                        <span class="kpi-icon"><i class="fas fa-key"></i></span>
                    </div>
                    <div class="kpi-value">${enabledKeys} <span class="kpi-sep">/ ${totalKeys}</span></div>
                    <div class="kpi-sub">正常启用 ${enabledKeys} · 已禁用 ${disabledKeys}</div>
                </div>
                <div class="kpi-card tone-emerald">
                    <div class="kpi-head">
                        <span class="kpi-label">今日总调用</span>
                        <span class="kpi-icon"><i class="fas fa-bolt"></i></span>
                    </div>
                    <div class="kpi-value">${formatNumber(stats?.todayTotalUsage || 0)}</div>
                    <div class="kpi-sub">历史累计 ${formatNumber(stats?.totalUsage || 0)} 次</div>
                </div>
                <div class="kpi-card tone-info">
                    <div class="kpi-head">
                        <span class="kpi-label">今日总 Tokens</span>
                        <span class="kpi-icon"><i class="fas fa-microchip"></i></span>
                    </div>
                    <div class="kpi-value">${formatTokenCompact(stats?.todayTotalTokens || 0)}</div>
                    <div class="kpi-sub">今日缓存命中 ${formatTokenCompact(stats?.todayCachedTokens || 0)}</div>
                </div>
                <div class="kpi-card tone-warning">
                    <div class="kpi-head">
                        <span class="kpi-label">累计消耗 Tokens</span>
                        <span class="kpi-icon"><i class="fas fa-database"></i></span>
                    </div>
                    <div class="kpi-value">${formatTokenCompact(stats?.totalTokens || 0)}</div>
                    <div class="kpi-sub">累计缓存命中 ${formatTokenCompact(stats?.totalCachedTokens || 0)}</div>
                </div>
            </div>

            <div class="rates-banner">
                <span class="rates-title">
                    <span class="live-dot"></span>
                    60s 实时吞吐
                </span>
                <div class="rates-metrics">
                    <span class="rate-chip">QPS <strong>${(stats?.qps || 0).toFixed(2)}</strong> <span class="rate-peak">峰值 ${(stats?.maxQps || 0).toFixed(2)}</span></span>
                    <span class="rate-chip">RPM <strong>${(stats?.rpm || 0).toFixed(0)}</strong> <span class="rate-peak">峰值 ${(stats?.maxRpm || 0).toFixed(0)}</span></span>
                    <span class="rate-chip">TPS <strong>${(stats?.tps || 0).toFixed(1)}</strong> <span class="rate-peak">峰值 ${(stats?.maxTps || 0).toFixed(1)}</span></span>
                </div>
            </div>

            ${aggregated.totalCalls > 0 ? html`
                <div class="analytics-row">
                    <div class="analytics-card analytics-card-wide">
                        <div class="card-head">
                            <span class="card-title"><i class="fas fa-calendar-alt"></i> Token 用量日历 (按年度)</span>
                            <span class="card-subtitle">${formatTokenCompact(aggregated.totalTokens)} Tokens</span>
                        </div>
                        <${StatsCalendar} usageHistory=${usageHistory} />
                    </div>

                    <div class="analytics-card">
                        <div class="card-head">
                            <span class="card-title"><i class="fas fa-network-wired"></i> 提供商调用占比</span>
                            <span class="card-subtitle">${formatNumber(aggregated.totalCalls)} 次 / ${formatTokenCompact(aggregated.totalTokens)} Tokens</span>
                        </div>
                        <${DistributionList} data=${aggregated.providers} total=${aggregated.totalCalls} />
                    </div>

                    <div class="analytics-card">
                        <div class="card-head">
                            <span class="card-title"><i class="fas fa-cubes"></i> 模型调用活跃度</span>
                            <span class="card-subtitle">${formatNumber(aggregated.totalCalls)} 次</span>
                        </div>
                        <${DistributionList} data=${aggregated.models} total=${aggregated.totalCalls} />
                    </div>
                </div>` : null}

            <div class="keys-container">
                <div class="keys-toolbar">
                    <div class="toolbar-search">
                        <i class="fas fa-search search-icon"></i>
                        <input type="text" class="form-control search-input" placeholder="按名称或 Key ID 搜索..."
                            value=${search} onInput=${(e: Event) => setSearch((e.target as HTMLInputElement).value)} />
                    </div>
                    <div class="toolbar-meta">
                        ${allKeys.length > 0 ? html`
                            <span class="keys-count-badge">
                                ${filteredKeys.length === allKeys.length
                                    ? `共 ${allKeys.length} 个密钥`
                                    : `匹配 ${filteredKeys.length} / ${allKeys.length}`}
                            </span>` : null}
                        <div class="toolbar-sort">
                            <label>排序</label>
                            <select class="form-control sort-select" value=${sort} onChange=${(e: Event) => setSort((e.target as HTMLSelectElement).value)}>
                                <option value="created-desc">创建时间 ↓</option>
                                <option value="name-asc">名称 A-Z</option>
                                <option value="name-desc">名称 Z-A</option>
                                <option value="usage-desc">今日用量 ↓</option>
                                <option value="usage-asc">今日用量 ↑</option>
                                <option value="total-desc">累计调用 ↓</option>
                                <option value="lastUsed-desc">最近活跃 ↓</option>
                                <option value="qps-desc">QPS 速率 ↓</option>
                                <option value="rpm-desc">RPM 频率 ↓</option>
                            </select>
                        </div>
                    </div>
                </div>

                <div class="keys-list">
                    ${allKeys.length === 0 ? html`
                        <div class="empty-state">
                            <div class="icon"><i class="fas fa-key"></i></div>
                            <p>尚未创建任何网关 API Key</p>
                            <button type="button" class="btn btn-primary" onClick=${() => setCreateOpen(true)}>
                                <i class="fas fa-plus"></i> 生成第一个 API Key
                            </button>
                        </div>`
                        : filteredKeys.length === 0
                            ? html`<div class="empty-state"><p>未找到匹配 "${search}" 的 Key</p></div>`
                            : filteredKeys.map(renderKeyCard)}
                </div>
            </div>
        </section>

        <!-- 模态框：生成新 Key -->
        <${Modal} open=${createOpen} className="api-keys-modal" title="生成新 API Key" onClose=${() => setCreateOpen(false)} width="520px"
            footer=${html`
                <button type="button" class="btn btn-secondary" onClick=${() => setCreateOpen(false)}>取消</button>
                <button type="button" class="btn btn-primary" onClick=${() => void handleCreateKey()}>
                    <i class="fas fa-check"></i> 生成 Key
                </button>`}>
            <div class="modal-form">
                <div class="form-group">
                    <label>Key 名称 (可选)</label>
                    <input type="text" class="form-control" placeholder="例如：开发环境、用户 A"
                        value=${createName} onInput=${(e: Event) => setCreateName((e.target as HTMLInputElement).value)} />
                </div>
                <div class="form-group">
                    <label>每日调用限额 (次/天)</label>
                    <input type="number" class="form-control" min="0" placeholder="500"
                        value=${createLimit} onInput=${(e: Event) => setCreateLimit((e.target as HTMLInputElement).value)} />
                    <div class="form-text">0 表示无限制，默认 500</div>
                </div>
                <div class="form-divider">商业化套餐绑定 (可选)</div>
                <div class="form-group">
                    <label>绑定 Token 套餐包</label>
                    <select class="form-control" value=${createPackId} onChange=${(e: Event) => setCreatePackId((e.target as HTMLSelectElement).value)}>
                        <option value="">不绑定商业套餐（仅限额控制）</option>
                        ${availablePacks.map((p) => html`<option key=${p.id} value=${p.id}>${p.label} (${formatTokenCompact(p.tokenQuota)} Tokens)</option>`)}
                    </select>
                </div>
                ${createPackId ? html`
                    <div class="form-group">
                        <label>计费周期</label>
                        <select class="form-control" value=${createCycleId} onChange=${(e: Event) => setCreateCycleId((e.target as HTMLSelectElement).value)}>
                            ${availableCycles.map((c) => html`<option key=${c.id} value=${c.id}>${c.label}</option>`)}
                        </select>
                    </div>
                    <div class="form-group">
                        <label>每日 Token 速率保护上限 (Tokens/天，可选)</label>
                        <input type="number" class="form-control" placeholder="留空不限制"
                            value=${createDailyCap} onInput=${(e: Event) => setCreateDailyCap((e.target as HTMLInputElement).value)} />
                    </div>` : null}
            </div>
        <//>

        <!-- 模态框：Key 已生成 -->
        <${Modal} open=${Boolean(createdKey)} className="api-keys-modal" title="API Key 已生成" onClose=${() => setCreatedKey(null)} width="540px"
            footer=${html`
                <button type="button" class="btn btn-secondary" onClick=${() => void copyText(createdKey?.id || '')}>
                    <i class="fas fa-copy"></i> 复制 Key
                </button>
                <button type="button" class="btn btn-primary" onClick=${() => setCreatedKey(null)}>确定</button>`}>
            <div class="created-key-modal">
                <p class="warn-text"><i class="fas fa-exclamation-triangle"></i> 请妥善保存此 Key，关闭窗口后将无法再次查看完整密钥：</p>
                <div class="key-box">
                    <code>${createdKey?.id}</code>
                </div>
            </div>
        <//>

        <!-- 模态框：修改名称 -->
        <${Modal} open=${Boolean(editName)} className="api-keys-modal" title="修改 Key 名称" onClose=${() => setEditName(null)} width="440px"
            footer=${html`
                <button type="button" class="btn btn-secondary" onClick=${() => setEditName(null)}>取消</button>
                <button type="button" class="btn btn-primary" onClick=${() => void handleUpdateName()}>
                    <i class="fas fa-save"></i> 保存
                </button>`}>
            <div class="modal-form">
                <div class="form-group">
                    <label>新名称</label>
                    <input type="text" class="form-control" value=${editName?.value || ''}
                        onInput=${(e: Event) => setEditName(editName ? { ...editName, value: (e.target as HTMLInputElement).value } : null)} />
                </div>
            </div>
        <//>

        <!-- 模态框：修改限额 -->
        <${Modal} open=${Boolean(editLimit)} className="api-keys-modal" title="修改每日限额" onClose=${() => setEditLimit(null)} width="440px"
            footer=${html`
                <button type="button" class="btn btn-secondary" onClick=${() => setEditLimit(null)}>取消</button>
                <button type="button" class="btn btn-primary" onClick=${() => void handleUpdateLimit()}>
                    <i class="fas fa-save"></i> 保存
                </button>`}>
            <div class="modal-form">
                <div class="form-group">
                    <label>每日调用限额 (次/天)</label>
                    <input type="number" class="form-control" min="0" value=${editLimit?.value || ''}
                        onInput=${(e: Event) => setEditLimit(editLimit ? { ...editLimit, value: (e.target as HTMLInputElement).value } : null)} />
                    <div class="form-text">0 表示无限制</div>
                </div>
            </div>
        <//>

        <!-- 模态框：商业化套餐管理 -->
        <${Modal} open=${Boolean(planModalKey)} className="api-keys-modal" title=${`商业化套餐管理 - ${planModalKey?.name || ''}`} onClose=${() => setPlanModalKey(null)} width="520px"
            footer=${html`
                ${planModalKey?.plan ? html`
                    <button type="button" class="btn btn-danger" onClick=${() => void handleClearPlan()}>
                        <i class="fas fa-times"></i> 解除套餐
                    </button>
                    <button type="button" class="btn btn-secondary" onClick=${() => void handleRenewPlan()}>
                        <i class="fas fa-redo"></i> 周期续期
                    </button>` : null}
                <button type="button" class="btn btn-primary" onClick=${() => void handleSavePlan()}>
                    <i class="fas fa-check"></i> ${planModalKey?.plan ? '更新套餐' : '开通套餐'}
                </button>`}>
            <div class="modal-form">
                ${planModalKey?.plan ? html`
                    <div class="current-plan-card">
                        <div class="current-head"><i class="fas fa-crown"></i> 当前已开通套餐</div>
                        <div class="current-body">
                            <div>规格：<b>${planModalKey.plan.packLabel}</b> (${planModalKey.plan.cycleId === 'week' ? '周付' : '月付'})</div>
                            <div>额度：已用 ${formatTokenCompact(planModalKey.plan.tokenUsed)} / 总量 ${formatTokenCompact(planModalKey.plan.tokenQuota)} Tokens</div>
                            <div>余量：<b>${formatTokenCompact(Math.max(0, planModalKey.plan.tokenQuota - planModalKey.plan.tokenUsed - planModalKey.plan.tokenReserved))}</b> Tokens</div>
                            <div>有效期：${planModalKey.plan.validUntil ? planModalKey.plan.validUntil.replace('T', ' ').slice(0, 19) : '永久'}</div>
                        </div>
                    </div>` : null}
                <div class="form-group">
                    <label>选择 Token 套餐规格</label>
                    <select class="form-control" value=${planPackId} onChange=${(e: Event) => setPlanPackId((e.target as HTMLSelectElement).value)}>
                        ${availablePacks.map((p) => html`<option key=${p.id} value=${p.id}>${p.label} (${formatTokenCompact(p.tokenQuota)} Tokens)</option>`)}
                    </select>
                </div>
                <div class="form-group">
                    <label>计费周期</label>
                    <select class="form-control" value=${planCycleId} onChange=${(e: Event) => setPlanCycleId((e.target as HTMLSelectElement).value)}>
                        ${availableCycles.map((c) => html`<option key=${c.id} value=${c.id}>${c.label}</option>`)}
                    </select>
                </div>
                <div class="form-group">
                    <label>每日 Token 保护上限 (Tokens/天，留空不限制)</label>
                    <input type="number" class="form-control" placeholder="留空不限制"
                        value=${planDailyCap} onInput=${(e: Event) => setPlanDailyCap((e.target as HTMLInputElement).value)} />
                    <div class="form-text">防刷速率保护，达到日上限后当日停止计费生成请求</div>
                </div>
            </div>
        <//>

        <!-- 模态框：批量设置限额 -->
        <${Modal} open=${applyLimitOpen} className="api-keys-modal" title="批量应用每日调用限额" onClose=${() => setApplyLimitOpen(false)} width="460px"
            footer=${html`
                <button type="button" class="btn btn-secondary" onClick=${() => setApplyLimitOpen(false)}>取消</button>
                <button type="button" class="btn btn-danger" onClick=${() => void handleApplyLimitToAll()}>
                    <i class="fas fa-check"></i> 立即覆盖应用
                </button>`}>
            <div class="modal-form">
                <div class="form-group">
                    <label>新的每日调用限额 (次/天)</label>
                    <input type="number" class="form-control" min="0" value=${applyLimitValue}
                        onInput=${(e: Event) => setApplyLimitValue((e.target as HTMLInputElement).value)} />
                </div>
                <div class="danger-notice">
                    <p><b><i class="fas fa-exclamation-triangle"></i> 注意：</b>此操作将统一覆盖所有现有 Key 的每日限额，不可逆撤销。</p>
                </div>
            </div>
        <//>
    `;
}
