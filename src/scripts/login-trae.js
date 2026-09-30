import readline from 'readline';
import { handleTraePATLogin, TRAE_AUTH_CONFIG } from '../auth/trae-auth.js';
import { initializeConfig } from '../core/config-manager.js';
import logger from '../utils/logger.js';

async function main() {
    await initializeConfig();
    const args = process.argv.slice(2);

    let token = process.env.TRAECLI_PERSONAL_ACCESS_TOKEN || '';
    let host = process.env.TRAECLI_HOST || process.env.TRAE_HOST || TRAE_AUTH_CONFIG.defaultHost;
    let customName = '';

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--token' && args[i + 1]) {
            token = args[i + 1];
            i++;
        } else if (args[i] === '--host' && args[i + 1]) {
            host = args[i + 1];
            i++;
        } else if (args[i] === '--name' && args[i + 1]) {
            customName = args[i + 1];
            i++;
        } else if (args[i] === '--help' || args[i] === '-h') {
            console.log(`
使用方法:
  node src/scripts/login-trae.js [选项]
  npm run login:trae -- [选项]

选项:
  --token <token>   指定 Trae 个人访问令牌 (trae-lt-...)，支持从环境变量 TRAECLI_PERSONAL_ACCESS_TOKEN 读取
  --host <url>      指定 Trae API 域名 (默认: ${TRAE_AUTH_CONFIG.defaultHost})
  --name <name>     自定义节点名称 (可选)
  -h, --help        显示帮助信息
`);
            process.exit(0);
        }
    }

    console.log('\n======================================================================');
    console.log('              Trae (企业版 / SOLO) 订阅转 API - 凭据录入');
    console.log('======================================================================');
    console.log(`目标端点 (Host): ${host}`);

    if (token) {
        console.log(`已检测到凭据令牌: ${token.substring(0, 15)}... (长度: ${token.length})`);
        try {
            console.log('正在向 Trae 端点执行 ExchangeToken 握手与身份验证...');
            const res = await handleTraePATLogin({ token, host, customName });
            console.log('\n\x1b[32m[SUCCESS] Trae 凭据验证与录入成功！\x1b[0m');
            console.log(`  用户标识: ${res.nickname} (UID: ${res.userId || 'N/A'})`);
            if (res.enterpriseId) {
                console.log(`  所属企业: ${res.enterpriseId}`);
            }
            console.log(`  令牌有效期至: ${new Date(res.expiresAt).toLocaleString()}`);
            console.log(`  凭据配置文件: ${res.credPath}`);
            console.log('\n凭据已自动注入 configs/provider_pools.json，启动 AIClient2API 即可直接调用 Trae 模型！');
            process.exit(0);
        } catch (err) {
            console.error('\n\x1b[31m[ERROR] 凭证换取失败:\x1b[0m', err.message);
            process.exit(1);
        }
    }

    // 交互式输入
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    console.log('\n未指定 --token 且环境变量 TRAECLI_PERSONAL_ACCESS_TOKEN 为空。');
    console.log('请获取你的 CLI 登录令牌 (通常在 Trae 企业版控制台 > 个人信息 > 访问令牌 中生成，以 trae-lt- 开头)。');
    rl.question('\n请输入你的 Trae 个人访问令牌 (Personal Access Token): ', async (inputToken) => {
        rl.close();
        if (!inputToken || !inputToken.trim()) {
            console.log('未输入令牌，退出。');
            process.exit(1);
        }

        try {
            console.log('\n正在向 Trae 端点执行 ExchangeToken 握手与身份验证...');
            const res = await handleTraePATLogin({ token: inputToken.trim(), host, customName });
            console.log('\n\x1b[32m[SUCCESS] Trae 凭据验证与录入成功！\x1b[0m');
            console.log(`  用户标识: ${res.nickname} (UID: ${res.userId || 'N/A'})`);
            if (res.enterpriseId) {
                console.log(`  所属企业: ${res.enterpriseId}`);
            }
            console.log(`  令牌有效期至: ${new Date(res.expiresAt).toLocaleString()}`);
            console.log(`  凭据配置文件: ${res.credPath}`);
            console.log('\n凭据已自动注入 configs/provider_pools.json，启动 AIClient2API 即可直接调用 Trae 模型！');
            process.exit(0);
        } catch (err) {
            console.error('\n\x1b[31m[ERROR] 凭证换取失败:\x1b[0m', err.message);
            process.exit(1);
        }
    });
}

main().catch(err => {
    logger.error('Unexpected error in login-trae:', err);
    process.exit(1);
});
