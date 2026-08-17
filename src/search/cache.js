// Two-layer cache. Debates repeat themselves — the same claim gets re-checked
// via /check that, opponents restate each other, and rehearsals replay the same
// motion — so caching turns a ~2s search into a ~1ms one and cuts vendor spend.
//
// Layer 1: in-process LRU (survives nothing, costs nothing).
// Layer 2: the shared store (Redis in prod), so every container instance and
// every later session benefits — required because containers are disposable.
import { createHash } from 'node:crypto';
import { getStore } from '../state/store.js';
import { contentTerms } from './text.js';

const memory = new Map(); // key -> {value, expiresAt}
const MEMORY_MAX = 300;

// Key on the claim's content terms, not its exact wording: "EV sales tripled
// between 2020 and 2023" and "Between 2020 and 2023, EV sales tripled" are the
// same retrieval problem.
export function cacheKey(claimText, { maxResults } = {}) {
  const normalized = [...new Set(contentTerms(claimText))].sort().join(' ');
  const hash = createHash('sha1').update(`${normalized}|${maxResults ?? ''}`).digest('hex').slice(0, 20);
  return `search:v1:${hash}`;
}

export async function readCache(key) {
  const local = memory.get(key);
  if (local && local.expiresAt > Date.now()) return local.value;
  if (local) memory.delete(key);

  try {
    const store = await getStore();
    const raw = await store.get(key);
    if (!raw) return null;
    const value = JSON.parse(raw);
    memory.set(key, { value, expiresAt: Date.now() + 60_000 });
    return value;
  } catch {
    return null; // cache must never be able to break a verification
  }
}

export async function writeCache(key, value, ttlSec) {
  memory.set(key, { value, expiresAt: Date.now() + Math.min(ttlSec, 60) * 1000 });
  if (memory.size > MEMORY_MAX) {
    for (const k of [...memory.keys()].slice(0, memory.size - MEMORY_MAX)) memory.delete(k);
  }
  try {
    const store = await getStore();
    await store.set(key, JSON.stringify(value), ttlSec);
  } catch {
    /* best effort */
  }
}

export function _clearMemoryCache() {
  memory.clear();
}
