import readline from 'readline';
import { styleText, parseArgs } from 'node:util';
import { handleTraePATLogin, TRAE_AUTH_CONFIG } from '../auth/trae-auth.ts';
import { initializeConfig } from '../core/config-manager.ts';
import logger from '../utils/logger.ts';
import { getErrorMessage } from '../utils/error.ts';
async function performLoginAndDisplay({ token, host, customName }: { token: string; host: string; customName: string }) {
    try {
        console.log('正在向 Trae 端点执行 ExchangeToken 握手与身份验证...');
        const res = await handleTraePATLogin({ token, host, customName });
        console.log(`\n${styleText('green', '[SUCCESS] Trae 凭据验证与录入成功！')}`);
        console.log(`  用户标识: ${res.nickname} (UID: ${res.userId || 'N/A'})`);
        if (res.enterpriseId) {
            console.log(`  所属企业: ${res.enterpriseId}`);
        }
        console.log(`  令牌有效期至: ${new Date(res.expiresAt).toLocaleString()}`);
        console.log(`  凭据配置文件: ${res.credPath}`);
        console.log('\n凭据已自动注入 configs/provider_pools.json，启动 AIClient2API 即可直接调用 Trae 模型！');
        process.exit(0);
    } catch (err) {
        console.error(`\n${styleText('red', '[ERROR] 凭证换取失败:')}`, getErrorMessage(err));
        process.exit(1);
    }
}

async function main() {
    await initializeConfig();
    const { values } = parseArgs({
        args: process.argv.slice(2),
        options: {
            token: { type: 'string' },
            host: { type: 'string' },
            name: { type: 'string' },
            help: { type: 'boolean', short: 'h' }
        },
        strict: false
    });

    if (values.help) {
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

    const token = (values.token as string | undefined) || process.env.TRAECLI_PERSONAL_ACCESS_TOKEN || '';
    const host = (values.host as string | undefined) || process.env.TRAECLI_HOST || process.env.TRAE_HOST || TRAE_AUTH_CONFIG.defaultHost;
    const customName = (values.name as string | undefined) || '';

    console.log('\n======================================================================');
    console.log('              Trae (企业版 / SOLO) 订阅转 API - 凭据录入');
    console.log('======================================================================');
    console.log(`目标端点 (Host): ${host}`);

    if (token) {
        console.log(`已检测到凭据令牌: ${token.substring(0, 15)}... (长度: ${token.length})`);
        await performLoginAndDisplay({ token, host, customName });
        return;
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

        await performLoginAndDisplay({ token: inputToken.trim(), host, customName });
    });
}

main().catch(err => {
    logger.error('Unexpected error in login-trae:', err);
    process.exit(1);
});
