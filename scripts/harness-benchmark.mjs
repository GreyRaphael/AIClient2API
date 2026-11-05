import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import crypto from 'node:crypto';

const HARNESS_URL = 'http://127.0.0.1:3080';
const LAUNCH_TOKEN = 'dC7rJapGq1NOPgRueSU3F-N4v5-YEYW1ghb4p3emkcw';
const TARGET_CWD = '/home/gewei/work/AIClient2API';

async function getAuthCookie() {
  const url = `${HARNESS_URL}/?token=${LAUNCH_TOKEN}`;
  const res = await fetch(url, { redirect: 'manual' });
  const raw = res.headers.get('set-cookie');
  if (!raw) throw new Error('Failed to get auth cookie from ' + url);
  return raw.split(';')[0];
}

async function rpc(cookie, endpoint, args) {
  const rpcId = 'bench-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  const res = await fetch(`${HARNESS_URL}/api/${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': cookie,
      'Origin': HARNESS_URL,
      'Referer': `${HARNESS_URL}/`
    },
    body: JSON.stringify({
      type: 'client-request',
      rpcId,
      method: endpoint,
      payload: { args }
    })
  });
  const data = await res.json();
  if (!data.result?.ok) {
    throw new Error(`RPC ${endpoint} failed: ${JSON.stringify(data.result?.error || data)}`);
  }
  return data.result.value;
}

function analyzeSessionZstd(sessionId) {
  const file = `/home/gewei/.dsh/sessions/--home-gewei-work-AIClient2API--/${sessionId}/session.v4.jsonl.zstd`;
  if (!fs.existsSync(file)) return null;

  try {
    const raw = cp.execSync(`zstd -dc "${file}"`, { maxBuffer: 100 * 1024 * 1024 }).toString('utf8');
    const lines = raw.split('\n');
    const steps = [];
    for (const line of lines) {
      if (!line) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.type === 'assistant/message' && ev.data?.usage) {
          const u = ev.data.usage;
          const prompt = (u.inputTokens || 0) + (u.cacheReadTokens || 0);
          const cached = u.cacheReadTokens || 0;
          const uncached = u.inputTokens || 0;
          const output = u.outputTokens || 0;
          const rate = prompt > 0 ? (cached / prompt * 100) : 0;
          steps.push({
            step: ev.data.step,
            prompt,
            cached,
            uncached,
            output,
            rate: rate.toFixed(2)
          });
        }
      } catch {}
    }
    return steps;
  } catch (err) {
    return null;
  }
}

function readProjCache(sessionId) {
  const file = `/home/gewei/.dsh/storages/session_projcache/sessions/${sessionId}.json`;
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

async function runBenchmark(promptText) {
  console.log('=== DeepSeek-Harness Autonomous Benchmark ===');
  const cookie = await getAuthCookie();
  console.log('1. Authenticated to Harness.');

  // Create session
  const created = await rpc(cookie, 'session/create', { request: { cwd: TARGET_CWD } });
  const sessionId = created.sessionId;
  console.log(`2. Created Session: ${sessionId}`);

  // Explicitly select model
  await rpc(cookie, 'session/select-model', {
    request: {
      sessionId,
      provider: 'tencent',
      model: 'trae:DeepSeek-V4.1-Flash-1017',
      reasoningEffort: 'xhigh'
    }
  });
  console.log('2.1 Selected model: tencent / trae:DeepSeek-V4.1-Flash-1017 (xhigh)');

  // Send prompt
  const requestId = crypto.randomUUID();
  console.log(`3. Sending prompt (${promptText.length} chars): "${promptText.slice(0, 80)}..."`);
  await rpc(cookie, 'session/prompt', {
    request: {
      requestId,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: promptText }],
      clientTimeZone: 'Asia/Shanghai'
    }
  });
  console.log('4. Prompt accepted! Monitoring execution...');

  let lastStepCount = 0;
  const startTime = Date.now();
  while (true) {
    await new Promise(r => setTimeout(r, 3000));
    const proj = readProjCache(sessionId);
    const activity = proj?.record?.rows?.workingActivity?.val?.tracker;
    const stats = proj?.record?.rows?.sessionStats?.val;
    const tokenUsage = proj?.record?.rows?.tokenUsage?.val;

    const currentSteps = stats?.steps || 0;
    const phase = activity?.phase || 'unknown';

    if (currentSteps !== lastStepCount) {
      lastStepCount = currentSteps;
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      console.log(`[${elapsed}s] Phase: ${phase}, Steps: ${currentSteps}, Totals: Cached=${tokenUsage?.totals?.cacheReadTokens || 0}, Uncached=${tokenUsage?.totals?.uncachedInputTokens || 0}`);
    }

    if (phase === 'done' || (currentSteps >= 12 && phase !== 'running')) {
      console.log(`\nExecution finished (Phase: ${phase}, Steps: ${currentSteps})!\n`);
      break;
    }

    // Safety timeout: 10 minutes
    if (Date.now() - startTime > 600000) {
      console.log('\nTimed out waiting for session completion.\n');
      break;
    }
  }

  // Print final breakdown
  const steps = analyzeSessionZstd(sessionId);
  if (steps && steps.length > 0) {
    console.log('-------------------------------------------------------------');
    console.log('Step  | Prompt Tokens | Cached Tokens | Uncached | Cache Rate');
    console.log('-------------------------------------------------------------');
    let totalPrompt = 0;
    let totalCached = 0;
    let totalUncached = 0;
    for (const s of steps) {
      totalPrompt += s.prompt;
      totalCached += s.cached;
      totalUncached += s.uncached;
      console.log(`${String(s.step).padEnd(5)} | ${String(s.prompt).padStart(13)} | ${String(s.cached).padStart(13)} | ${String(s.uncached).padStart(8)} | ${s.rate.padStart(9)}%`);
    }
    console.log('-------------------------------------------------------------');
    const overallRate = totalPrompt > 0 ? ((totalCached / totalPrompt) * 100).toFixed(2) : '0.00';
    console.log(`OVERALL: Prompt=${totalPrompt}, Cached=${totalCached}, Uncached=${totalUncached}, Rate=${overallRate}%`);
    console.log('-------------------------------------------------------------');
    return { sessionId, steps, overallRate: Number(overallRate) };
  } else {
    console.log('Could not extract step-by-step details.');
    return { sessionId, steps: [], overallRate: 0 };
  }
}

const prompt = process.argv[2] || "不使用sub-agents, review 当前项目从v8.0.0到最新commit的修改, 如果要e2e测试, 最好换用3200端口测试, 可以后台运行任务.";
runBenchmark(prompt).catch(err => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
