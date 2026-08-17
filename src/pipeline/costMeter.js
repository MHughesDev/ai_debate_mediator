// Per-session cost counters (SPEC §6.5: per-session API costs dominate, so
// instrument from the moment the pipeline exists). Live counters in Redis;
// estimate + persistence surface in Phase 5.
import { getStore } from '../state/store.js';
import { config } from '../config.js';

const costsKey = (id) => `sess:${id}:costs`;

async function incrField(sessionId, field, amount) {
  if (!amount) return;
  const store = await getStore();
  const current = parseFloat((await store.hget(costsKey(sessionId), field)) || '0');
  await store.hset(costsKey(sessionId), field, String(current + amount));
  await store.expire(costsKey(sessionId), config.sessionTtlSec);
}

export async function recordLlmUsage(sessionId, model, inputTokens, outputTokens) {
  await incrField(sessionId, `llm_in:${model}`, inputTokens || 0);
  await incrField(sessionId, `llm_out:${model}`, outputTokens || 0);
  await incrField(sessionId, 'llm_calls', 1);
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

// Estimate in USD from counters using env-priced rates.
export function estimateCost(counters) {
  const r = config.costRates;
  let usd = 0;
  usd += ((counters.bot_seconds || 0) / 3600) * r.botHour;
  usd += ((counters.stt_seconds || 0) / 3600) * r.sttHour;
  usd += (counters.search_calls || 0) * r.searchCall;
  for (const [k, v] of Object.entries(counters)) {
    if (k.startsWith('llm_in:')) usd += (v / 1e6) * (r.llmIn[k.slice(7)] ?? r.llmIn['claude-opus-5']);
    if (k.startsWith('llm_out:')) usd += (v / 1e6) * (r.llmOut[k.slice(8)] ?? r.llmOut['claude-opus-5']);
  }
  return Math.round(usd * 10000) / 10000;
}
