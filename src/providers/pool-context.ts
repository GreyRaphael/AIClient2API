/**
 * ProviderPoolManager 的运行时引用。
 *
 * 这是一个刻意保持“零依赖”的模块：provider core 需要读取池管理器来上报
 * 健康状态，但 service-manager 又需要构造 adapter/provider core。如果
 * provider core 直接 import service-manager，就会形成
 * service-manager -> adapter -> provider core -> service-manager 的运行时环。
 *
 * provider-pool-manager 只作为 type import 引入，类型擦除后不会产生运行时边。
 */

import type { ProviderPoolManager } from './provider-pool-manager.ts';

let providerPoolManager: ProviderPoolManager | null = null;

export function setProviderPoolManager(manager: ProviderPoolManager | null): void {
    providerPoolManager = manager;
}

export function getProviderPoolManager(): ProviderPoolManager | null {
    return providerPoolManager;
}
