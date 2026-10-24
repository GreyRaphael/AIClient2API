import { existsSync, readFileSync } from 'fs';

function getProviderPoolsFilePath(currentConfig: any) {
    return currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
}

function getDefaultProviders(currentConfig: any) {
    if (Array.isArray(currentConfig.DEFAULT_MODEL_PROVIDERS) && currentConfig.DEFAULT_MODEL_PROVIDERS.length > 0) {
        return currentConfig.DEFAULT_MODEL_PROVIDERS.filter(Boolean);
    }

    if (typeof currentConfig.MODEL_PROVIDER === 'string' && currentConfig.MODEL_PROVIDER.trim()) {
        return currentConfig.MODEL_PROVIDER
            .split(',')
            .map((item: any) => item.trim())
            .filter(Boolean);
    }

    return [];
}

function collectProviderStatus(currentConfig: any, providerPoolManager: any) {
    const providerStatus = {};

    if (providerPoolManager?.providerStatus) {
        for (const [type, providers] of Object.entries(providerPoolManager.providerStatus as Record<string, any>)) {
            (providerStatus as any)[type] = providers.map((provider: any) => ({
                ...provider.config,
                activeRequests: provider.state?.activeCount || 0,
                waitingRequests: provider.state?.waitingCount || 0
            }));
        }
    }

    const filePath = getProviderPoolsFilePath(currentConfig);
    if (existsSync(filePath)) {
        try {
            const poolsData = JSON.parse(readFileSync(filePath, 'utf-8'));
            for (const [type, providers] of Object.entries(poolsData)) {
                if (!(providerStatus as any)[type] || (providerStatus as any)[type].length === 0) {
                    (providerStatus as any)[type] = Array.isArray(providers) ? providers : [];
                }
            }
        } catch (error: any) {
            console.warn('[Access API] Failed to read provider pools file:', error.message);
        }
    }

    return providerStatus;
}

function buildProviderSummaries(providerStatus: any, defaultProviders: any, registeredProviders: any = []) {
    const supportedProviders = [...new Set([
        ...registeredProviders,
        ...Object.keys(providerStatus)
    ])];

    const providerSummaries = supportedProviders.map((id: any) => {
        const providers = Array.isArray(providerStatus[id]) ? providerStatus[id] : [];
        const totalNodes = providers.length;
        const healthyNodes = providers.filter((provider: any) => provider.isHealthy).length;
        const disabledNodes = providers.filter((provider: any) => provider.isDisabled).length;
        const usableNodes = providers.filter((provider: any) => provider.isHealthy && !provider.isDisabled).length;

        return {
            id,
            totalNodes,
            healthyNodes,
            usableNodes,
            enabledNodes: totalNodes - disabledNodes,
            disabledNodes,
            isDefault: defaultProviders.includes(id)
        };
    });

    providerSummaries.sort((left: any, right: any) => {
        if (left.isDefault !== right.isDefault) {
            return left.isDefault ? -1 : 1;
        }
        if (left.totalNodes !== right.totalNodes) {
            return right.totalNodes - left.totalNodes;
        }
        return left.id.localeCompare(right.id);
    });

    return {
        supportedProviders,
        providerSummaries
    };
}

export function buildAccessInfoPayload(currentConfig: any, providerPoolManager: any, registeredProviders: any = []) {
    const defaultProviders = getDefaultProviders(currentConfig);
    const providerStatus = collectProviderStatus(currentConfig, providerPoolManager);
    const { supportedProviders, providerSummaries } = buildProviderSummaries(providerStatus, defaultProviders, registeredProviders);

    return {
        apiKey: currentConfig.REQUIRED_API_KEY || '',
        hasApiKey: Boolean(currentConfig.REQUIRED_API_KEY),
        defaultProviders,
        providerPoolsFilePath: getProviderPoolsFilePath(currentConfig),
        supportedProviders,
        providers: providerSummaries
    };
}

export async function handleGetAccessInfo(req: any, res: any, currentConfig: any, providerPoolManager: any) {
    const { getRegisteredProviders } = await import('../providers/adapter.ts');
    const payload = buildAccessInfoPayload(currentConfig, providerPoolManager, getRegisteredProviders());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
    return true;
}
