// 主应用入口文件 - 模块化版本
//
// Phase 1 起，页面装配（Header/Sidebar/路由/SSE）由 static/ui/ 接管；
// 本文件只负责尚未迁移的模块初始化，并在最后派发 legacyAppReady 供外壳触发按需数据加载。

// 导入所有模块
import {
    providerStats,
    REFRESH_INTERVALS
} from './constants.js';

import {
    showToast,
    getProviderStats
} from './utils.js';

import { t, initI18n } from './i18n.js';

import {
    initFileUpload,
    fileUploadHandler
} from './file-upload.js';

import {
    initEventListeners,
    setDataLoaders,
    setReloadConfig
} from './event-handlers.js';

import {
    setProviderLoaders,
    setConfigLoaders
} from './event-stream.js';

import {
    loadSystemInfo,
    updateTimeDisplay,
    loadProviders,
    openProviderManager,
    showAuthModal,
    executeGenerateAuthUrl,
    handleGenerateAuthUrl,
    showAddProviderGroupModal,
    showTraeAuthSelector
} from './provider-manager.js';

import {
    saveConfiguration,
    generateApiKey
} from './config-manager.js';

import {
    showProviderManagerModal,
    refreshProviderConfig
} from './modal.js';

import {
    initAccessManager,
    loadAccessInfo
} from './access-manager.js';

import {
    initUploadConfigManager,
    loadConfigList,
    viewConfig,
    deleteConfig,
    closeConfigModal,
    copyConfigContent,
    reloadConfig
} from './upload-config-manager.js';

import {
    initUsageManager,
    refreshUsage
} from './usage-manager.js';

import {
    initImageZoom
} from './image-zoom.js';

import {
    CustomModelsManager
} from './custom-models-manager.js';

import {
    initPlaygroundManager,
    loadPlaygroundData
} from './playground-manager.js';

let isAppInitialized = false;

/**
 * 加载初始数据
 */
async function loadInitialData() {
    await Promise.all([
        loadSystemInfo(),
        loadProviders()
    ]);
}

/**
 * 初始化应用
 */
async function initApp() {
    if (isAppInitialized) {
        return;
    }
    isAppInitialized = true;

    // 旧模板仍使用 data-i18n：首次初始化时翻译现有 DOM，并继续监听动态插入的节点
    initI18n();

    // 设置数据加载器
    setDataLoaders(loadInitialData, saveConfiguration);
    
    // 设置reloadConfig函数
    setReloadConfig(reloadConfig);
    
    // 设置提供商加载器
    setProviderLoaders(loadProviders, refreshProviderConfig);
    
    // 设置配置加载器
    setConfigLoaders(loadConfigList);

    // 导出全局函数供其他模块使用
    window.loadPlaygroundData = loadPlaygroundData;
    window.loadProviders = loadProviders;
    window.openProviderManager = openProviderManager;
    window.showProviderManagerModal = showProviderManagerModal;
    window.refreshProviderConfig = refreshProviderConfig;
    window.fileUploadHandler = fileUploadHandler;
    window.showAuthModal = showAuthModal;
    window.executeGenerateAuthUrl = executeGenerateAuthUrl;
    window.handleGenerateAuthUrl = handleGenerateAuthUrl;
    window.showTraeAuthSelector = showTraeAuthSelector;
    window.showAddProviderGroupModal = showAddProviderGroupModal;

    // 配置管理相关全局函数
    window.viewConfig = viewConfig;
    window.deleteConfig = deleteConfig;
    window.loadConfigList = loadConfigList;
    window.closeConfigModal = closeConfigModal;
    window.copyConfigContent = copyConfigContent;
    window.reloadConfig = reloadConfig;
    window.generateApiKey = generateApiKey;
    window.loadAccessInfo = loadAccessInfo;

    // 用量管理相关全局函数
    window.refreshUsage = refreshUsage;

    // 插件管理相关全局函数

    // 初始化自定义模型管理
    window.customModelsManager = new CustomModelsManager();

    // 初始化各个模块（SSE 连接由 ui/store/events.js 统一管理）
    initEventListeners();
    initFileUpload(); // 初始化文件上传功能
    initAccessManager(); // 初始化快速接入页面
    initUploadConfigManager(); // 初始化配置管理功能
    initUsageManager(); // 初始化用量管理功能
    initImageZoom(); // 初始化图片放大功能
    initPlaygroundManager(); // 初始化 Playground

    // 加载初始数据（外壳在 legacyAppReady 后触发当前页面的数据加载）
    await loadInitialData();

    // 显示欢迎消息
    showToast(t('common.success'), t('common.welcome'), 'success');
    
    // 每5秒更新服务器时间和运行时间显示
    setInterval(() => {
        updateTimeDisplay();
    }, 5000);
    
    // 定期刷新系统信息
    setInterval(() => {
        loadProviders();

        if (providerStats.activeProviders > 0) {
            const stats = getProviderStats(providerStats);
            console.log('=== 提供商统计报告 ===');
            console.log(`活跃提供商: ${stats.activeProviders}`);
            console.log(`健康提供商: ${stats.healthyProviders} (${stats.healthRatio})`);
            console.log(`总账户数: ${stats.totalAccounts}`);
            console.log(`总请求数: ${stats.totalRequests}`);
            console.log(`总错误数: ${stats.totalErrors}`);
            console.log(`成功率: ${stats.successRate}`);
            console.log(`平均每提供商请求数: ${stats.avgUsagePerProvider}`);
            console.log('========================');
        }
    }, REFRESH_INTERVALS.SYSTEM_INFO);

    // 通知外壳：旧模块初始化完成，可以触发当前页面的数据加载
    window.dispatchEvent(new CustomEvent('legacyAppReady'));
}

// 等待组件加载完成后初始化应用（ui/sections.js 在 11 个旧片段全部插入后派发）
window.addEventListener('componentsLoaded', initApp);

// 导出调试函数
window.getProviderStats = () => getProviderStats(providerStats);

console.log('AIClient2API 管理控制台已加载 - 模块化版本');
