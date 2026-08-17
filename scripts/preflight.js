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

async function check(name, key, fn) {
  if (!key) {
    record(name, 'SKIP', 'no key set — this vendor runs as a mock');
    return;
  }
  const started = t();
  try {
    const detail = await fn();
    record(name, 'OK', detail, t() - started);
  } catch (err) {
    record(name, 'FAIL', err.message.slice(0, 160), t() - started);
  }
}

async function main() {
  console.log('\nPreflight — validating configured vendors\n');

  await check('Anthropic', config.anthropicApiKey, async () => {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': config.anthropicApiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: config.extractorModel,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
    const data = await res.json();
    return `${config.extractorModel} responded`;
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
