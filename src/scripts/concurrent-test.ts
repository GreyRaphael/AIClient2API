/**
 * 并发测试脚本
 * 用于测试 API 服务器在高并发场景下的性能和稳定性
 * 
 * 使用方法:
 *   node src/scripts/concurrent-test.js [选项]
 * 
 * 选项:
 *   --url <url>           API 服务器地址 (默认: http://localhost:3000)
 *   --api-key <key>       API 密钥 (默认: 123456)
 *   --concurrency <n>     并发数 (默认: 10)
 *   --requests <n>        总请求数 (默认: 100)
 *   --endpoint <path>     测试端点 (默认: /v1/chat/completions)
 *   --model <model>       模型名称 (默认: gpt-5.5)
 *   --stream              使用流式响应 (默认: false)
 *   --timeout <ms>        请求超时时间 (默认: 60000)
 *   --verbose             显示详细日志
 */

import http from 'http';
import https from 'https';

// 解析命令行参数
function parseArgs() {
    const args = process.argv.slice(2);
    const config = {
        url: 'http://localhost:3000',
        apiKey: '123456',
        concurrency: 10,
        totalRequests: 100,
        rpm: 0,
        endpoint: '/v1/chat/completions',
        model: 'gpt-5.5',
        stream: false,
        timeout: 60000,
        verbose: false
    };

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--url':
                config.url = args[++i];
                break;
            case '--api-key':
                config.apiKey = args[++i];
                break;
            case '--concurrency':
                config.concurrency = parseInt(args[++i], 10);
                break;
            case '--requests':
                config.totalRequests = parseInt(args[++i], 10);
                break;
            case '--rpm':
                config.rpm = parseInt(args[++i], 10);
                break;
            case '--endpoint':
                config.endpoint = args[++i];
                break;
            case '--model':
                config.model = args[++i];
                break;
            case '--stream':
                config.stream = true;
                break;
            case '--timeout':
                config.timeout = parseInt(args[++i], 10);
                break;
            case '--verbose':
                config.verbose = true;
                break;
            case '--help':
                console.log(`
并发测试脚本 - 测试 API 服务器性能

使用方法:
  node src/scripts/concurrent-test.js [选项]

选项:
  --url <url>           API 服务器地址 (默认: http://localhost:3000)
  --api-key <key>       API 密钥 (默认: 123456)
  --concurrency <n>     并发数 (默认: 10)
  --requests <n>        总请求数 (默认: 100)
  --endpoint <path>     测试端点 (默认: /v1/chat/completions)
  --model <model>       模型名称 (默认: gpt-5.5)
  --stream              使用流式响应 (默认: false)
  --timeout <ms>        请求超时时间 (默认: 60000)
  --verbose             显示详细日志
  --help                显示帮助信息
                `);
                process.exit(0);
        }
    }

    return config;
}

// 统计数据
class Statistics {
    completed: number;
    failed: number;
    responseTimes: number[];
    errors: Record<string, number>;
    startTime: number | null;
    endTime: number | null;

    constructor() {
        this.completed = 0;
        this.failed = 0;
        this.responseTimes = [];
        this.errors = {};
        this.startTime = null;
        this.endTime = null;
    }

    recordSuccess(responseTime) {
        this.completed++;
        this.responseTimes.push(responseTime);
    }

    recordFailure(error) {
        this.failed++;
        const errorKey = error.message || String(error);
        this.errors[errorKey] = (this.errors[errorKey] || 0) + 1;
    }

    start() {
        this.startTime = Date.now();
    }

    end() {
        this.endTime = Date.now();
    }

    getReport() {
        const totalTime = this.endTime - this.startTime;
        const sortedTimes = [...this.responseTimes].sort((a, b) => a - b);
        
        const percentile = (p) => {
            if (sortedTimes.length === 0) return 0;
            const index = Math.ceil((p / 100) * sortedTimes.length) - 1;
            return sortedTimes[Math.max(0, index)];
        };

        const avg = sortedTimes.length > 0 
            ? sortedTimes.reduce((a, b) => a + b, 0) / sortedTimes.length 
            : 0;

        return {
            totalRequests: this.completed + this.failed,
            completed: this.completed,
            failed: this.failed,
            successRate: ((this.completed / (this.completed + this.failed)) * 100).toFixed(2) + '%',
            totalTime: totalTime,
            requestsPerSecond: ((this.completed + this.failed) / (totalTime / 1000)).toFixed(2),
            responseTime: {
                min: sortedTimes.length > 0 ? sortedTimes[0] : 0,
                max: sortedTimes.length > 0 ? sortedTimes[sortedTimes.length - 1] : 0,
                avg: avg.toFixed(2),
                p50: percentile(50),
                p90: percentile(90),
                p95: percentile(95),
                p99: percentile(99)
            },
            errors: this.errors
        };
    }
}

// 创建测试请求体
function createRequestBody(config, requestId) {
    // OpenAI Chat Completions 格式
    if (config.endpoint.includes('/chat/completions')) {
        return JSON.stringify({
            model: config.model,
            messages: [
                {
                    role: 'user',
                    content: `这是并发测试请求 #${requestId}。请简短回复"收到"。`
                }
            ],
            stream: config.stream,
            max_tokens: 50
        });
    }
    
    // OpenAI Responses 格式
    if (config.endpoint.includes('/responses')) {
        return JSON.stringify({
            model: config.model,
            input: `这是并发测试请求 #${requestId}。请简短回复"收到"。`,
            stream: config.stream
        });
    }
    
    // Claude Messages 格式
    if (config.endpoint.includes('/messages')) {
        return JSON.stringify({
            model: config.model,
            messages: [
                {
                    role: 'user',
                    content: `这是并发测试请求 #${requestId}。请简短回复"收到"。`
                }
            ],
            stream: config.stream,
            max_tokens: 50
        });
    }

    // 默认格式
    return JSON.stringify({
        model: config.model,
        messages: [
            {
                role: 'user',
                content: `这是并发测试请求 #${requestId}。请简短回复"收到"。`
            }
        ],
        stream: config.stream,
        max_tokens: 50
    });
}

// 发送单个请求
function sendRequest(config, requestId): Promise<any> {
    return new Promise((resolve, reject) => {
        const startTime = Date.now();
        const url = new URL(config.endpoint, config.url);
        const isHttps = url.protocol === 'https:';
        const client = isHttps ? https : http;

        const requestBody = createRequestBody(config, requestId);

        const options = {
            hostname: url.hostname,
            port: url.port || (isHttps ? 443 : 80),
            path: url.pathname + url.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(requestBody),
                'Authorization': `Bearer ${config.apiKey}`
            },
            timeout: config.timeout
        };

        const req = client.request(options, (res) => {
            let data = '';

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                const responseTime = Date.now() - startTime;
                
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve({
                        success: true,
                        requestId,
                        statusCode: res.statusCode,
                        responseTime,
                        dataLength: data.length
                    });
                } else {
                    reject({
                        success: false,
                        requestId,
                        statusCode: res.statusCode,
                        responseTime,
                        error: `HTTP ${res.statusCode}: ${data.substring(0, 200)}`
                    });
                }
            });
        });

        req.on('error', (error) => {
            const responseTime = Date.now() - startTime;
            reject({
                success: false,
                requestId,
                responseTime,
                error: error.code === 'ECONNREFUSED' 
                    ? `连接被拒绝 (${url.hostname}:${url.port || (isHttps ? 443 : 80)})` 
                    : (error.message || error.code || 'Unknown error')
            });
        });

        req.on('timeout', () => {
            req.destroy();
            const responseTime = Date.now() - startTime;
            reject({
                success: false,
                requestId,
                responseTime,
                error: '请求超时'
            });
        });

        req.write(requestBody);
        req.end();
    });
}

// 并发控制器
class ConcurrencyController {
    concurrency: number;
    running: number;
    queue: any[];

    constructor(concurrency) {
        this.concurrency = concurrency;
        this.running = 0;
        this.queue = [];
    }

    async run(task: any): Promise<any> {
        return new Promise((resolve, reject) => {
            this.queue.push({ task, resolve, reject });
            this.processQueue();
        });
    }

    async processQueue() {
        while (this.running < this.concurrency && this.queue.length > 0) {
            const { task, resolve, reject } = this.queue.shift();
            this.running++;

            task()
                .then(resolve)
                .catch(reject)
                .finally(() => {
                    this.running--;
                    this.processQueue();
                });
        }
    }
}

// 进度条显示
function showProgress(current, total, stats) {
    const percentage = ((current / total) * 100).toFixed(1);
    const barLength = 30;
    const filled = Math.round((current / total) * barLength);
    const bar = '█'.repeat(filled) + '░'.repeat(barLength - filled);
    
    process.stdout.write(`\r[${bar}] ${percentage}% (${current}/${total}) | 成功: ${stats.completed} | 失败: ${stats.failed}`);
}

// 主函数
async function main() {
    const config = parseArgs();

    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║              API 并发测试脚本                              ║');
    console.log('╠════════════════════════════════════════════════════════════╣');
    console.log(`║ 目标地址: ${config.url.padEnd(47)}║`);
    console.log(`║ 测试端点: ${config.endpoint.padEnd(47)}║`);
    console.log(`║ 并发数量: ${String(config.concurrency).padEnd(47)}║`);
    console.log(`║ 总请求数: ${String(config.totalRequests).padEnd(47)}║`);
    console.log(`║ 模型名称: ${config.model.padEnd(47)}║`);
    console.log(`║ 流式响应: ${String(config.stream).padEnd(47)}║`);
    console.log(`║ 超时时间: ${(config.timeout + 'ms').padEnd(47)}║`);
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log('');

    const stats = new Statistics();
    const controller = new ConcurrencyController(config.concurrency);

    console.log('开始测试...\n');
    stats.start();

    const tasks = [];
    for (let i = 1; i <= config.totalRequests; i++) {
        const requestId = i;

        // 如果设置了 RPM，计算延迟时间
        if (config.rpm > 0) {
            const delay = (60000 / config.rpm) * (i - 1);
            tasks.push(
                new Promise(resolve => setTimeout(resolve, delay))
                    .then(() => controller.run(() => sendRequest(config, requestId)))
                    .then((result) => {
                        stats.recordSuccess(result.responseTime);
                        if (config.verbose) {
                            console.log(`\n[成功] 请求 #${result.requestId} - ${result.responseTime}ms - ${result.dataLength} bytes`);
                        }
                    })
                    .catch((result) => {
                        stats.recordFailure(new Error(result.error));
                        if (config.verbose) {
                            console.log(`\n[失败] 请求 #${result.requestId} - ${result.error}`);
                        }
                    })
                    .finally(() => {
                        showProgress(stats.completed + stats.failed, config.totalRequests, stats);
                    })
            );
        } else {
            tasks.push(
                controller.run(() => sendRequest(config, requestId))
                    .then((result) => {
                        stats.recordSuccess(result.responseTime);
                        if (config.verbose) {
                            console.log(`\n[成功] 请求 #${result.requestId} - ${result.responseTime}ms - ${result.dataLength} bytes`);
                        }
                    })
                    .catch((result) => {
                        stats.recordFailure(new Error(result.error));
                        if (config.verbose) {
                            console.log(`\n[失败] 请求 #${result.requestId} - ${result.error}`);
                        }
                    })
                    .finally(() => {
                        showProgress(stats.completed + stats.failed, config.totalRequests, stats);
                    })
            );
        }
    }

    await Promise.all(tasks);
    stats.end();

    console.log('\n\n');
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║                      测试结果报告                          ║');
    console.log('╚════════════════════════════════════════════════════════════╝');

    const report = stats.getReport();

    console.log('\n📊 总体统计:');
    console.log(`   总请求数:     ${report.totalRequests}`);
    console.log(`   成功请求:     ${report.completed}`);
    console.log(`   失败请求:     ${report.failed}`);
    console.log(`   成功率:       ${report.successRate}`);
    console.log(`   总耗时:       ${report.totalTime}ms`);
    console.log(`   吞吐量:       ${report.requestsPerSecond} req/s`);

    console.log('\n⏱️  响应时间统计 (ms):');
    console.log(`   最小值:       ${report.responseTime.min}`);
    console.log(`   最大值:       ${report.responseTime.max}`);
    console.log(`   平均值:       ${report.responseTime.avg}`);
    console.log(`   P50:          ${report.responseTime.p50}`);
    console.log(`   P90:          ${report.responseTime.p90}`);
    console.log(`   P95:          ${report.responseTime.p95}`);
    console.log(`   P99:          ${report.responseTime.p99}`);

    if (Object.keys(report.errors).length > 0) {
        console.log('\n❌ 错误统计:');
        for (const [error, count] of Object.entries(report.errors)) {
            console.log(`   ${error}: ${count}次`);
        }
    }

    console.log('\n════════════════════════════════════════════════════════════════');

    // 返回退出码
    process.exit(report.failed > 0 ? 1 : 0);
}

// 运行主函数
main().catch((error) => {
    console.error('测试脚本执行失败:', error);
    process.exit(1);
});
