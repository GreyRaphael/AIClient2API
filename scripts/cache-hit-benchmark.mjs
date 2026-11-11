#!/usr/bin/env node
/**
 * 缓存命中率基准测试 —— 网关驱动版。
 *
 * 取代已删除的 scripts/harness-benchmark.mjs。旧脚本的三个问题：
 *   1. 硬编码了一个真实的 DeepSeek-Harness 启动 token（凭据泄露）；
 *   2. 硬编码 /home/gewei 绝对路径；
 *   3. 解析私有的 session.v4.jsonl.zstd 格式（该格式会随 harness 版本变化）。
 *
 * 新设计只依赖网关**公开** API，不 import 任何 harness 内部模块：
 *
 *   驱动：直接 POST /v1/chat/completions，第 N 轮把前面 N-1 轮的问答累积进 messages
 *         （即 docs/CACHE_HIT_RATE.md 里的「10 轮增长历史」实验设计）。
 *   测量：每轮后 GET /api/model-usage-stats，取本次**增量** cachedTokens/promptTokens。
 *         该接口是网关核心功能（非插件），始终可用，但仍需管理凭据；
 *         若拿不到凭据而无法访问，自动降级为读取响应体里的 usage
 *         （OpenAI 协议自带 prompt_tokens_details.cached_tokens）。
 *   输出：逐轮表格（轮次 | prompt | cached | uncached | 命中率）+ 总计。
 *   退出码：总命中率低于 --min-rate 时返回 1，可进 CI 当回归。
 *
 * 用法：
 *   node scripts/cache-hit-benchmark.mjs
 *   node scripts/cache-hit-benchmark.mjs --rounds 10 --model gpt-5.5 --min-rate 90
 *   node scripts/cache-hit-benchmark.mjs --base-url http://127.0.0.1:3000 --api-key 123456
 *
 * 环境变量：
 *   GATEWAY_BASE_URL   等同 --base-url（默认 http://127.0.0.1:3000）
 *   GATEWAY_API_KEY    等同 --api-key
 *   ADMIN_PASSWORD     用于登录管理端换取 token（默认 admin123）
 */

import process from 'node:process';

const DEFAULTS = {
    baseUrl: process.env.GATEWAY_BASE_URL || 'http://127.0.0.1:3000',
    apiKey: process.env.GATEWAY_API_KEY || '',
    adminPassword: process.env.ADMIN_PASSWORD || 'admin123',
    rounds: 10,
    model: '',
    minRate: 90,
    maxTokens: 220,
    timeoutMs: 180000,
    verbose: false
};

function parseArgs(argv) {
    const options = { ...DEFAULTS };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const next = () => {
            const value = argv[++i];
            if (value === undefined) {
                throw new Error(`Missing value for ${arg}`);
            }
            return value;
        };
        switch (arg) {
            case '--base-url': options.baseUrl = next(); break;
            case '--api-key': options.apiKey = next(); break;
            case '--admin-password': options.adminPassword = next(); break;
            case '--model': options.model = next(); break;
            case '--rounds': options.rounds = Number.parseInt(next(), 10); break;
            case '--min-rate': options.minRate = Number.parseFloat(next()); break;
            case '--max-tokens': options.maxTokens = Number.parseInt(next(), 10); break;
            case '--timeout-ms': options.timeoutMs = Number.parseInt(next(), 10); break;
            case '--verbose': options.verbose = true; break;
            case '--help':
            case '-h':
                printHelp();
                process.exit(0);
                break;
            default:
                throw new Error(`Unknown option: ${arg}`);
        }
    }
    options.baseUrl = options.baseUrl.replace(/\/+$/, '');
    if (!Number.isFinite(options.rounds) || options.rounds < 2) {
        throw new Error('--rounds must be an integer >= 2 (the first round primes the cache)');
    }
    return options;
}

function printHelp() {
    console.log(`Usage: node scripts/cache-hit-benchmark.mjs [options]

  --base-url <url>          Gateway base URL (default ${DEFAULTS.baseUrl})
  --api-key <key>           Business API key for /v1/chat/completions
  --admin-password <pass>   Admin password for /api/login (default: ADMIN_PASSWORD or admin123)
  --model <name>            Model to test (default: first model from /v1/models)
  --rounds <n>              Number of growth rounds (default ${DEFAULTS.rounds})
  --min-rate <pct>          Fail (exit 1) if overall cache-hit rate is below this (default ${DEFAULTS.minRate})
  --max-tokens <n>          Max tokens per answer (default ${DEFAULTS.maxTokens})
  --timeout-ms <n>          Per-request timeout (default ${DEFAULTS.timeoutMs})
  --verbose                 Print full request/response diagnostics
`);
}

/** 单次带超时的 fetch（使用 Node 26 原生 AbortSignal.timeout），返回 { status, headers, body(text) }。 */
async function rawRequest(url, { method = 'GET', headers = {}, body, timeoutMs }) {
    const signal = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined;
    const response = await fetch(url, { method, headers, body, signal });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text };
}

function authHeaders(apiKey) {
    return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

/** 通用启发式：从任意响应体里找出 usage 对象。 */
function pickUsage(payload) {
    if (!payload || typeof payload !== 'object') return null;
    return payload.usage || payload.data?.usage || payload.response?.usage || payload.message?.usage || null;
}

/**
 * 归一化 usage —— 必须与 utils/usage-normalizer.ts 的语义一致：
 * promptTokens 是**含缓存**的 inclusive 语义，否则 cached/prompt 会算出 >100%。
 */
function normalizeUsage(usage) {
    if (!usage || typeof usage !== 'object') return null;
    const num = (v) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : 0;
    };
    // Anthropic 形状：input_tokens 是 exclusive，需加回 cache 读写
    const hasAnthropicCache = usage.cache_read_input_tokens !== undefined
        || usage.cache_creation_input_tokens !== undefined;
    if (hasAnthropicCache) {
        const cached = num(usage.cache_read_input_tokens);
        const created = num(usage.cache_creation_input_tokens);
        const fresh = num(usage.input_tokens);
        return {
            promptTokens: fresh + cached + created,
            completionTokens: num(usage.output_tokens),
            cachedTokens: cached
        };
    }
    const prompt = num(usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokenCount);
    const completion = num(usage.completion_tokens ?? usage.output_tokens ?? usage.candidatesTokenCount);
    const cached = num(
        usage.prompt_tokens_details?.cached_tokens
        ?? usage.input_tokens_details?.cached_tokens
        ?? usage.cached_tokens
        ?? usage.cache_read_input_tokens
        ?? usage.cachedContentTokenCount
    );
    if (prompt === 0 && completion === 0) return null;
    return { promptTokens: prompt, completionTokens: completion, cachedTokens: cached };
}

async function resolveModel(options) {
    if (options.model) return options.model;
    try {
        const { status, text } = await rawRequest(`${options.baseUrl}/v1/models`, {
            headers: authHeaders(options.apiKey),
            timeoutMs: 15000
        });
        if (status === 200) {
            const payload = JSON.parse(text);
            const first = payload?.data?.[0]?.id;
            if (first) return first;
        }
    } catch { /* 落到下面的报错 */ }
    throw new Error('Cannot determine a model: /v1/models returned nothing usable. Pass --model explicitly.');
}

/** 尝试登录管理端，拿一个可用于 /api/model-usage-stats 的 token。失败返回 null。 */
async function tryAdminLogin(options) {
    try {
        const { status, text } = await rawRequest(`${options.baseUrl}/api/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: options.adminPassword }),
            timeoutMs: 15000
        });
        if (status !== 200) return null;
        const payload = JSON.parse(text);
        return payload?.token || payload?.data?.token || null;
    } catch {
        return null;
    }
}

/**
 * 读取统计累计值。优先 /api/model-usage-stats（管理端），
 * 失败则返回 null，调用方降级到响应体 usage。
 */
async function readStatsCumulative(options, adminToken) {
    const headers = adminToken
        ? { Authorization: `Bearer ${adminToken}` }
        : authHeaders(options.apiKey);
    try {
        const { status, text } = await rawRequest(`${options.baseUrl}/api/model-usage-stats`, {
            headers,
            timeoutMs: 15000
        });
        if (status !== 200) return null;
        const payload = JSON.parse(text);
        const summary = payload?.data?.summary;
        if (!summary) return null;
        const num = (v) => {
            const n = Number(v);
            return Number.isFinite(n) ? n : 0;
        };
        return {
            promptTokens: num(summary.promptTokens),
            cachedTokens: num(summary.cachedTokens)
        };
    } catch {
        return null;
    }
}

/**
 * 构造一段「足够长且稳定」的前缀。
 *
 * **为什么需要它**：主流上游都有 KV cache 的最小可缓存长度门槛
 * （Anthropic Sonnet/Opus 1024 tokens、Haiku 2048，OpenAI 1024）。
 * 早先版本只发几十到几百 token，全部低于门槛，命中率恒为 0%——
 * 那是脚本的问题，不是网关的问题，会让回归门禁变成永远绿的空壳。
 *
 * 这里用确定性生成的代码样本把前缀撑到 ~6000 字符（约 1500+ tokens），
 * 跨轮完全一致，从而真正触发前缀缓存。
 */
function buildStablePrefix() {
    const lines = ['Review the following module and reply with one short observation.'];
    for (let i = 1; i <= 90; i++) {
        lines.push(
            `export function handler${i}(request, context) {`
            + ` const payload = normalizePayload(request.body, ${i});`
            + ` if (!payload) return reject(context, 'E_${i}');`
            + ` return dispatch(payload, context.tenant, { retry: ${i % 3 === 0}, tag: 'op-${i}' });`
            + ' }'
        );
    }
    return lines.join('\n');
}

/** 第 N 轮的增长历史：模拟真实多步 agent 会话，前缀稳定以便命中 KV cache。 */
function buildMessages(history, round) {
    const system = 'You are a meticulous senior engineer doing an incremental code review. '
        + 'Answer concisely and consistently: the same style every turn keeps the prompt prefix stable.';
    // 稳定前缀：每轮完全相同，位于 messages 最前，保证可被上游缓存
    const stablePrefix = buildStablePrefix();
    if (history.length === 0) {
        return [
            { role: 'system', content: system },
            { role: 'user', content: stablePrefix + '\n\nReply with one short sentence.' }
        ];
    }
    return [
        { role: 'system', content: system },
        { role: 'user', content: stablePrefix },
        ...history,
        { role: 'user', content: `Round ${round}: continue the review with one more short observation.` }
    ];
}

async function callChat(options, messages) {
    const started = Date.now();
    const { status, text } = await rawRequest(`${options.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...authHeaders(options.apiKey)
        },
        body: JSON.stringify({
            model: options.model,
            messages,
            max_tokens: options.maxTokens,
            stream: false
        }),
        timeoutMs: options.timeoutMs
    });
    const elapsedMs = Date.now() - started;
    let payload = null;
    try { payload = JSON.parse(text); } catch { /* 非 JSON 响应 */ }
    if (status !== 200) {
        const detail = payload?.error?.message || text.slice(0, 300);
        throw new Error(`HTTP ${status} from /v1/chat/completions: ${detail}`);
    }
    const answer = payload?.choices?.[0]?.message?.content || '';
    return { payload, answer, elapsedMs };
}

function formatRow(round, prompt, cached, uncached, rate) {
    return `${String(round).padEnd(5)} | ${String(prompt).padStart(13)} | ${String(cached).padStart(13)} `
        + `| ${String(uncached).padStart(8)} | ${rate.toFixed(2).padStart(9)}%`;
}

async function run() {
    const options = parseArgs(process.argv.slice(2));
    options.model = await resolveModel(options);

    console.log('=== Gateway Cache-Hit Benchmark ===');
    console.log(`  gateway : ${options.baseUrl}`);
    console.log(`  model   : ${options.model}`);
    console.log(`  rounds  : ${options.rounds}`);
    console.log('');

    const adminToken = await tryAdminLogin(options);
    const useStatsApi = (await readStatsCumulative(options, adminToken)) !== null;
    console.log(`  measurement: ${useStatsApi
        ? '/api/model-usage-stats (cumulative delta)'
        : 'response usage (per-request, stats API unavailable)'}`);
    if (!useStatsApi) {
        console.log('  hint: pass --admin-password (or ADMIN_PASSWORD) to read the built-in '
            + '/api/model-usage-stats endpoint, to measure cumulative deltas instead of per-request usage.');
    }
    console.log('');

    const history = [];
    const rows = [];
    let prevCumulative = useStatsApi ? await readStatsCumulative(options, adminToken) : null;

    for (let round = 1; round <= options.rounds; round++) {
        const messages = buildMessages(history, round);
        const { payload, answer, elapsedMs } = await callChat(options, messages);

        let promptTokens = 0;
        let cachedTokens = 0;

        if (useStatsApi) {
            const cumulative = await readStatsCumulative(options, adminToken);
            if (cumulative && prevCumulative) {
                promptTokens = cumulative.promptTokens - prevCumulative.promptTokens;
                cachedTokens = cumulative.cachedTokens - prevCumulative.cachedTokens;
            }
            prevCumulative = cumulative || prevCumulative;
        }

        // 统计接口不可用、或该轮增量为 0（例如请求未计入统计）时，降级到响应体 usage
        if (promptTokens <= 0) {
            const normalized = normalizeUsage(pickUsage(payload));
            if (normalized) {
                promptTokens = normalized.promptTokens;
                cachedTokens = normalized.cachedTokens;
            }
        }

        const uncached = Math.max(promptTokens - cachedTokens, 0);
        const rate = promptTokens > 0 ? (cachedTokens / promptTokens) * 100 : 0;
        rows.push({ round, prompt: promptTokens, cached: cachedTokens, uncached, rate });

        if (options.verbose) {
            console.log(`  [round ${round}] ${elapsedMs}ms, answer: ${answer.slice(0, 60)}...`);
        }

        history.push({ role: 'user', content: messages[messages.length - 1].content });
        history.push({ role: 'assistant', content: answer });
    }

    console.log('-------------------------------------------------------------');
    console.log('Step  | Prompt Tokens | Cached Tokens | Uncached | Cache Rate');
    console.log('-------------------------------------------------------------');
    let totalPrompt = 0;
    let totalCached = 0;
    let totalUncached = 0;
    for (const row of rows) {
        console.log(formatRow(row.round, row.prompt, row.cached, row.uncached, row.rate));
        totalPrompt += row.prompt;
        totalCached += row.cached;
        totalUncached += row.uncached;
    }
    console.log('-------------------------------------------------------------');

    const overallRate = totalPrompt > 0 ? (totalCached / totalPrompt) * 100 : 0;
    console.log(`OVERALL: Prompt=${totalPrompt}, Cached=${totalCached}, `
        + `Uncached=${totalUncached}, Rate=${overallRate.toFixed(2)}%`);
    console.log('-------------------------------------------------------------');

    if (rows.length > 0 && rows[0].prompt > 0 && rows[0].cached === rows[0].prompt) {
        console.log('warning: round 1 reported a 100% hit rate - the upstream may not be');
        console.log('         reporting real cache metrics, so later rounds are not comparable.');
    }

    if (overallRate < options.minRate) {
        console.error(`\nFAIL: overall cache-hit rate ${overallRate.toFixed(2)}% < required ${options.minRate}%`);
        process.exit(1);
    }
    console.log(`\nOK: overall cache-hit rate ${overallRate.toFixed(2)}% >= ${options.minRate}%`);
}

run().catch((error) => {
    console.error(`\nBenchmark failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
});
