// Per-session cost counters (SPEC §6.5: per-session API costs dominate, so
// instrument from the moment the pipeline exists). Live counters in Redis;
// estimate + persistence surface in Phase 5.
import { getStore } from '../state/store.js';
import { config } from '../config.js';

const costsKey = (id) => `sess:${id}:costs`;

async function setField(sessionId, field, value) {
  const store = await getStore();
  await store.hset(costsKey(sessionId), field, String(value));
  await store.expire(costsKey(sessionId), config.sessionTtlSec);
}

async function incrField(sessionId, field, amount) {
  if (!amount) return;
  const store = await getStore();
  const current = parseFloat((await store.hget(costsKey(sessionId), field)) || '0');
  await store.hset(costsKey(sessionId), field, String(current + amount));
  await store.expire(costsKey(sessionId), config.sessionTtlSec);
}

export async function recordLlmUsage(sessionId, model, inputTokens, outputTokens, { free = false } = {}) {
  await incrField(sessionId, `llm_in:${model}`, inputTokens || 0);
  await incrField(sessionId, `llm_out:${model}`, outputTokens || 0);
  await incrField(sessionId, 'llm_calls', 1);
  // Recorded alongside the counters rather than held in memory, so the estimate
  // is still right when it is recomputed from the database after a restart.
  if (free) await setField(sessionId, `llm_free:${model}`, 1);
}

export async function recordSearch(sessionId, calls = 1) {
  await incrField(sessionId, 'search_calls', calls);
}

export async function recordBotSeconds(sessionId, seconds) {
  await incrField(sessionId, 'bot_seconds', seconds);
}

export async function recordSttSeconds(sessionId, seconds) {
  await incrField(sessionId, 'stt_seconds', seconds);
}

export async function getCounters(sessionId) {
  const store = await getStore();
  const raw = await store.hgetall(costsKey(sessionId));
  const counters = {};
  for (const [k, v] of Object.entries(raw)) counters[k] = parseFloat(v);
  return counters;
}

// Persist final counters + estimate to Neon (called at session end).
export async function persistCosts(sessionId) {
  const counters = await getCounters(sessionId);
  const estimate = estimateCost(counters);
  const { getDb } = await import('../db/postgres.js');
  const db = await getDb();
  await db.query(
    'INSERT INTO session_costs (session_id, counters, estimate_usd, updated_at) VALUES ($1,$2,$3,now()) ' +
      'ON CONFLICT (session_id) DO UPDATE SET counters = $2, estimate_usd = $3, updated_at = now()',
    [sessionId, JSON.stringify(counters), estimate],
  );
  return { counters, estimate };
}

// Estimate in USD from counters using env-priced rates.
export function estimateCost(counters) {
  const r = config.costRates;
  let usd = 0;
  usd += ((counters.bot_seconds || 0) / 3600) * r.botHour;
  usd += ((counters.stt_seconds || 0) / 3600) * r.sttHour;
  usd += (counters.search_calls || 0) * r.searchCall;
  for (const [k, v] of Object.entries(counters)) {
    const model = k.startsWith('llm_in:') ? k.slice(7) : k.startsWith('llm_out:') ? k.slice(8) : null;
    if (!model) continue;
    // A model you host yourself costs nothing per token. Without this a local
    // run reports a bill it will never receive, since an unpriced model id
    // otherwise falls back to the most expensive rate we know.
    if (counters[`llm_free:${model}`]) continue;
    const table = k.startsWith('llm_in:') ? r.llmIn : r.llmOut;
    // An unknown HOSTED model still falls back to the dearest known rate: an
    // overestimate is the safe direction for a bill.
    usd += (v / 1e6) * (table[model] ?? table['claude-opus-5']);
  }
  return Math.round(usd * 10000) / 10000;
}
