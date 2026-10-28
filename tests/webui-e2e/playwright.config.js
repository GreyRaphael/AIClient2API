import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.WEBUI_E2E_PORT || 39173);

export default defineConfig({
    testDir: '.',
    testMatch: '**/*.spec.js',
    timeout: 30_000,
    expect: { timeout: 10_000 },
    fullyParallel: false,
    workers: 1,
    reporter: [['list']],
    outputDir: '../../test-results',
    use: {
        baseURL: `http://127.0.0.1:${PORT}`,
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure'
    },
    projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
    webServer: {
        command: 'node tests/webui-e2e/start-server.mjs',
        cwd: '../..',
        url: `http://127.0.0.1:${PORT}/login.html`,
        reuseExistingServer: false,
        timeout: 60_000,
        stdout: 'ignore',
        stderr: 'pipe'
    }
});
