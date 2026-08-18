// Preflight: validate every configured vendor with a real, minimal API call
// before trusting them in a live debate. Run after editing .env:
//
//   npm run preflight
//
// Each check reports OK / FAIL / SKIPPED (no key -> that vendor runs as a mock).
// Exit code is non-zero only if a key IS set but does not work — a fully
// mock-configured setup passes, because that is a valid way to run the app.
import { config } from '../src/config.js';

const results = [];
const t = () => Date.now();

function record(name, status, detail, ms) {
  results.push({ name, status, detail, ms });
  const icon = status === 'OK' ? '✔' : status === 'SKIP' ? '·' : '✖';
  const timing = ms !== undefined ? ` (${ms}ms)` : '';
  console.log(`${icon} ${name.padEnd(24)} ${status.padEnd(5)} ${detail}${timing}`);
}

// Every check is time-boxed. A vendor that hangs must report as a hang rather
// than stalling the whole run — a self-hosted model loading a cold 7B file can
// take a minute, and without this the first slow check hides every later one.
const CHECK_TIMEOUT_MS = int(process.env.PREFLIGHT_TIMEOUT_MS, 60000);

async function check(name, key, fn) {
  if (!key) {
    record(name, 'SKIP', 'no key set — this vendor runs as a mock');
    return;
  }
  const started = t();
  let timer;
  try {
    const detail = await Promise.race([
      fn(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`no response within ${Math.round(CHECK_TIMEOUT_MS / 1000)}s`)),
          CHECK_TIMEOUT_MS,
        );
      }),
    ]);
    record(name, 'OK', detail, t() - started);
  } catch (err) {
    record(name, 'FAIL', err.message.slice(0, 160), t() - started);
  } finally {
    clearTimeout(timer);
  }
}

function int(v, d) {
  return v !== undefined && v !== '' ? parseInt(v, 10) : d;
}

async function main() {
  console.log('\nPreflight — validating configured vendors\n');

  // Whichever backend LLM_PROVIDER selected — one check for all of them.
  // This exercises the real path: auth, the resolved model id, and structured
  // output, which is where self-hosted servers usually differ.
  await check('LLM', config.llmProvider !== 'mock' ? config.llmProvider : '', async () => {
    const { getLlmProvider } = await import('../src/providers/llm/index.js');
    const llm = getLlmProvider();
    const info = llm.describe();
    const out = await llm.extractClaims({
      motion: 'This house believes preflight checks are worth writing',
      speakers: ['Preflight'],
      chunkText: 'Preflight: global electric vehicle sales tripled between 2020 and 2023.',
      priorClaims: [],
    });
    if (!out || !Array.isArray(out.claims)) throw new Error('structured output did not come back as an object');
    // Zero claims would mean the transport worked but the model ignored the
    // schema — worth flagging, since every downstream task depends on it.
    const shape = out.claims.length ? `${out.claims.length} claim(s) extracted` : 'responded but extracted nothing';
    return `${info.label} [${info.dialect}] ${info.models.extractor} -> ${shape}`;
  });

  // Model ids drift as vendors rename and retire them, and on a self-hosted
  // server the only valid id is whatever happens to be loaded. Ask the endpoint
  // rather than trusting a default.
  await check('LLM: models', config.llmProvider !== 'mock' ? config.llmProvider : '', async () => {
    const { getLlmProvider } = await import('../src/providers/llm/index.js');
    const llm = getLlmProvider();
    const info = llm.describe();
    const available = await llm.listModels().catch(() => null);
    if (!available || !available.length) return 'endpoint does not list models — ids unverified';
    const wanted = [...new Set(Object.values(info.models))];
    const missing = wanted.filter((m) => !available.includes(m));
    if (missing.length) {
      const sample = available.slice(0, 6).join(', ');
      throw new Error(
        `not served: ${missing.join(', ')} — available include: ${sample}${available.length > 6 ? ', ...' : ''}`,
      );
    }
    return `${wanted.join(', ')} confirmed against ${available.length} served`;
  });

  await check('Tavily search', config.tavilyApiKey, async () => {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_key: config.tavilyApiKey, query: 'IEA global EV sales 2023', max_results: 2 }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
    const data = await res.json();
    return `${(data.results || []).length} results`;
  });

  await check('Exa search', config.exaApiKey, async () => {
    const res = await fetch('https://api.exa.ai/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': config.exaApiKey },
      body: JSON.stringify({ query: 'IEA global EV sales 2023', numResults: 2 }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
    const data = await res.json();
    return `${(data.results || []).length} results`;
  });

  // Our own search layer (ADR-0006): check each backend it will actually use.
  await check('Search: Brave', config.braveApiKey, async () => {
    const { createBraveBackend } = await import('../src/search/backends/brave.js');
    const backend = createBraveBackend(config);
    const results = await backend.search('IEA global EV sales 2023', { limit: 3 });
    if (!results.length) throw new Error('key accepted but returned 0 results — check plan/quota');
    // Report the metering too: a valid key that is about to blow its monthly
    // quota is not actually a passing check, and this is the number to reason
    // about before a live debate.
    const dated = results.filter((r) => r.publishedAt).length;
    const perHour = config.braveMaxQueries * 40;
    return (
      `${results.length} results (${dated} dated) — ` +
      `${config.braveMaxQueries} query/claim at ${config.braveQps}/sec, ~${perHour} queries per hour-long debate`
    );
  });

  await check('Search: Exa', config.exaApiKey, async () => {
    const { createExaBackend } = await import('../src/search/backends/exa.js');
    const results = await createExaBackend(config).search('IEA global EV sales 2023', { limit: 3 });
    const dated = results.filter((r) => r.publishedAt).length;
    return `${results.length} results (${dated} dated)`;
  });

  await check('Search: Google CSE', config.googleCseKey && config.googleCseCx, async () => {
    const { createGoogleCseBackend } = await import('../src/search/backends/googleCse.js');
    const results = await createGoogleCseBackend(config).search('IEA global EV sales 2023', { limit: 3 });
    return `${results.length} results`;
  });

  await check('Search: SearXNG', config.searxngUrl, async () => {
    const { createSearxngBackend } = await import('../src/search/backends/searxng.js');
    const results = await createSearxngBackend(config).search('IEA global EV sales 2023', { limit: 3 });
    return `${results.length} results from ${config.searxngUrl}`;
  });

  // Wikipedia needs no key, so it is always exercised — it is the floor that
  // guarantees the fact-checker can always search something.
  await check('Search: Wikipedia', config.searchWikipediaEnabled ? 'builtin' : '', async () => {
    const { createWikipediaBackend } = await import('../src/search/backends/wikipedia.js');
    const results = await createWikipediaBackend(config).search('Great Wall of China visible from space', { limit: 3 });
    if (!results.length) throw new Error('no results (network blocked?)');
    return `${results.length} results (no key required)`;
  });

  // End-to-end retrieval: the number that actually matters for verdict latency.
  await check('Search: end-to-end', config.searchProvider === 'own' ? 'own' : '', async () => {
    const { createOwnSearchProvider } = await import('../src/providers/search/own.js');
    const provider = createOwnSearchProvider({ config });
    const started = t();
    const results = await provider.search('The Great Wall of China is visible from the Moon.', { maxResults: 3 });
    const ms = t() - started;
    if (!results.length) throw new Error('no evidence returned — every verdict would be UNVERIFIED');
    const over = ms > config.searchDeadlineMs ? ` OVER BUDGET (${config.searchDeadlineMs}ms)` : '';
    return `${results.length} passages via [${provider.backends.join(', ')}] in ${ms}ms${over}`;
  });

  await check('Recall.ai', config.recallApiKey, async () => {
    const res = await fetch(`https://${config.recallRegion}.recall.ai/api/v1/bot/?limit=1`, {
      headers: { Authorization: `Token ${config.recallApiKey}` },
    });
    if (res.status === 401 || res.status === 403) throw new Error(`auth rejected (HTTP ${res.status}) — check key and RECALL_REGION`);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
    return `authenticated in region ${config.recallRegion}`;
  });

  await check('Deepgram', config.deepgramApiKey, async () => {
    const res = await fetch('https://api.deepgram.com/v1/projects', {
      headers: { Authorization: `Token ${config.deepgramApiKey}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
    const data = await res.json();
    return `${(data.projects || []).length} project(s) visible`;
  });

  await check('AssemblyAI', config.assemblyaiApiKey, async () => {
    const res = await fetch('https://api.assemblyai.com/v2/transcript?limit=1', {
      headers: { Authorization: config.assemblyaiApiKey },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
    return 'authenticated';
  });

  await check('Neon Postgres', config.databaseUrl, async () => {
    const { getDb, closeDb } = await import('../src/db/postgres.js');
    const db = await getDb();
    if (db.kind !== 'pg') throw new Error('DATABASE_URL set but pg client did not initialize');
    await db.migrate();
    const { rows } = await db.query(
      "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name IN ('sessions','claims','verdicts','scores','receipts','speakers','utterances','session_costs')",
    );
    await closeDb();
    return `connected; ${rows[0].n}/8 tables present`;
  });

  await check('Upstash Redis', config.redisUrl, async () => {
    const { getStore, closeStore } = await import('../src/state/store.js');
    const store = await getStore();
    if (store.kind !== 'redis') throw new Error('REDIS_URL set but redis client did not initialize');
    const probe = `preflight:${Date.now()}`;
    await store.set(probe, 'ok', 30);
    const value = await store.get(probe);
    await store.del(probe);
    await closeStore();
    if (value !== 'ok') throw new Error('round-trip failed');
    return 'set/get round-trip ok';
  });

  // Config sanity that does not need a network call.
  console.log('');
  if (config.recallApiKey && !config.publicBaseUrl) {
    record('PUBLIC_BASE_URL', 'FAIL', 'required when RECALL_API_KEY is set (bot display + audio callback URLs)');
  } else if (config.publicBaseUrl) {
    const https = config.publicBaseUrl.startsWith('https://');
    record('PUBLIC_BASE_URL', https ? 'OK' : 'FAIL', https ? config.publicBaseUrl : `must be https:// for Recall (got ${config.publicBaseUrl})`);
  } else {
    record('PUBLIC_BASE_URL', 'SKIP', 'not needed without Recall');
  }

  console.log('\nActive providers:');
  console.log(`  meeting=${config.meetingProvider}  stt=${config.sttProvider}  llm=${config.llmProvider}  search=${config.searchProvider}`);
  console.log(`  store=${config.redisUrl ? 'redis' : 'memory'}  db=${config.databaseUrl ? 'postgres' : 'none'}`);

  const failures = results.filter((r) => r.status === 'FAIL');
  const mocks = [config.meetingProvider, config.sttProvider, config.llmProvider, config.searchProvider].filter((p) => p === 'mock').length;
  console.log('');
  if (failures.length > 0) {
    console.error(`✖ ${failures.length} check(s) failed: ${failures.map((f) => f.name).join(', ')}`);
    process.exit(1);
  }
  if (mocks > 0) console.log(`✔ all configured vendors reachable (${mocks} still on mocks — fine for local runs)`);
  else console.log('✔ all vendors reachable — ready for a live call');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
