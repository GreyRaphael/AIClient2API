import readline from 'readline';
import { handleZedOAuth, handleZedOAuthCallback } from '../auth/zed-oauth.js';
import { CONFIG, initializeConfig } from '../core/config-manager.js';
import logger from '../utils/logger.js';

async function main() {
    await initializeConfig();
    const args = process.argv.slice(2);
    let email = 'user@example.com';

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--email' && args[i + 1]) {
            email = args[i + 1];
            i++;
        }
    }

    console.log('\n======================================================================');
    console.log('                 Zed 订阅转 API - 账号授权登录');
    console.log('======================================================================');
    console.log(`目标账号: ${email}`);
    console.log('正在初始化本地 RSA 密钥与授权回调监听...');

    try {
        const { authUrl, authInfo, waitForCallback } = await handleZedOAuth(CONFIG, {
            email,
            openBrowser: true
        });

        console.log('\n请在浏览器中打开以下授权 URL (已尝试自动打开)：\n');
        console.log(`\x1b[36m${authUrl}\x1b[0m\n`);
        console.log('----------------------------------------------------------------------');
        console.log('说明：');
        console.log('1. 如果你在本地图形界面运行，浏览器已尝试自动打开，请登录并授权。');
        console.log('2. 如果你在远程服务器 / SSH 无头环境下，请复制上方 URL 到本地浏览器打开。');
        console.log('3. 授权后，如果浏览器能够访问 127.0.0.1:' + authInfo.port + '，将自动完成授权。');
        console.log('4. 如果不能直接访问本地端口，可在下方粘贴授权后浏览器地址栏中的完整 URL：');
        console.log('----------------------------------------------------------------------\n');

        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        let finished = false;

        const cleanupAndExit = (code = 0) => {
            if (finished) return;
            finished = true;
            rl.close();
            process.exit(code);
        };

        // 监听自动回调
        waitForCallback()
            .then(result => {
                if (finished) return;
                console.log('\n\x1b[32m[SUCCESS] Zed 授权成功！\x1b[0m');
                console.log(`User ID: ${result.userId}`);
                console.log(`凭据文件已写入: ${result.credPath}`);
                console.log(`节点已自动挂载至 provider_pools.json (Zed - ${email})\n`);
                cleanupAndExit(0);
            })
            .catch(err => {
                if (finished) return;
                console.error(`\n\x1b[31m[ERROR] 回调等待出错: ${err.message}\x1b[0m\n`);
                cleanupAndExit(1);
            });

        // 监听终端手动输入 (粘贴回调 URL)
        rl.question('等待自动回调，或在此粘贴回调 URL > ', async (answer) => {
            if (finished) return;
            const input = answer.trim();
            if (input) {
                try {
                    console.log('\n正在解析手动输入的回调 URL...');
                    const result = await handleZedOAuthCallback(input, authInfo.sessionId, CONFIG);
                    console.log('\n\x1b[32m[SUCCESS] Zed 授权成功！\x1b[0m');
                    console.log(`User ID: ${result.userId}`);
                    console.log(`凭据文件已写入: ${result.credPath}`);
                    console.log(`节点已自动挂载至 provider_pools.json (Zed - ${email})\n`);
                    cleanupAndExit(0);
                } catch (err) {
                    console.error(`\n\x1b[31m[ERROR] 手动回调解析失败: ${err.message}\x1b[0m\n`);
                    cleanupAndExit(1);
                }
            }
        });

    } catch (err) {
        console.error(`\n\x1b[31m[ERROR] 初始化登录失败: ${err.message}\x1b[0m\n`);
        process.exit(1);
    }
}

main();
