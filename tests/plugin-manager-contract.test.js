import { PluginManager } from '../src/core/plugin-manager.ts';

function makePlugin(overrides = {}) {
    return {
        name: 'receiver-contract',
        version: '1.0.0',
        _enabled: true,
        ...overrides
    };
}

describe('PluginManager method receiver compatibility', () => {
    test('preserves the plugin receiver during initAll and destroyAll', async () => {
        const manager = new PluginManager();
        const receivers = [];
        const plugin = makePlugin({
            _enabled: false,
            init() {
                receivers.push(this);
            },
            destroy() {
                receivers.push(this);
            }
        });
        manager.plugins.set(plugin.name, plugin);
        manager.loadConfig = jest.fn(async () => {
            manager.pluginsConfig = { plugins: { [plugin.name]: { enabled: true } } };
        });

        await manager.initAll({});
        await manager.destroyAll();

        expect(receivers).toHaveLength(2);
        expect(receivers[0]).toBe(plugin);
        expect(receivers[1]).toBe(plugin);
    });

    test('preserves the plugin receiver when toggling a plugin', async () => {
        const manager = new PluginManager();
        const receivers = [];
        const plugin = makePlugin({
            _enabled: false,
            init() {
                receivers.push(this);
            },
            destroy() {
                receivers.push(this);
            }
        });
        manager.plugins.set(plugin.name, plugin);
        manager.pluginsConfig = { plugins: {} };
        manager.config = {};
        manager.saveConfig = jest.fn().mockResolvedValue(undefined);

        await manager.setPluginEnabled(plugin.name, true);
        await manager.setPluginEnabled(plugin.name, false);

        expect(receivers).toHaveLength(2);
        expect(receivers[0]).toBe(plugin);
        expect(receivers[1]).toBe(plugin);
    });

    test('preserves the plugin receiver during authentication', async () => {
        const manager = new PluginManager();
        let receiver;
        const plugin = makePlugin({
            type: 'auth',
            authenticate() {
                receiver = this;
                return { authorized: true };
            }
        });
        manager.plugins.set(plugin.name, plugin);

        const result = await manager.executeAuth({}, {}, new URL('http://localhost/'), {});

        expect(result).toEqual({ handled: false, authorized: true });
        expect(receiver).toBe(plugin);
    });

    test('preserves the plugin receiver during middleware execution', async () => {
        const manager = new PluginManager();
        let receiver;
        const plugin = makePlugin({
            type: 'middleware',
            middleware() {
                receiver = this;
                return { handled: true };
            }
        });
        manager.plugins.set(plugin.name, plugin);

        const result = await manager.executeMiddleware({}, {}, new URL('http://localhost/'), {});

        expect(result).toEqual({ handled: true });
        expect(receiver).toBe(plugin);
    });

    test('preserves the hooks object receiver during hook execution', async () => {
        const manager = new PluginManager();
        let receiver;
        const hooks = {
            onBeforeRequest() {
                receiver = this;
            }
        };
        const plugin = makePlugin({ hooks });
        manager.plugins.set(plugin.name, plugin);

        await manager.executeHook('onBeforeRequest', {}, {});

        expect(receiver).toBe(hooks);
    });
});
