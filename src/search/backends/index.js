// Federated backends. Each returns a normalized ranked list:
//   [{ title, url, snippet, publishedAt? }]
//
// We federate rather than depend on one index: coverage improves, agreement
// across independent retrievers is a quality signal (see fusion.js), and one
// backend going down degrades results instead of breaking verification.
//
// Wikipedia/Wikidata need no key, so the engine is useful out of the box.
import { createWikipediaBackend } from './wikipedia.js';
import { createBraveBackend } from './brave.js';
import { createExaBackend } from './exa.js';
import { createGoogleCseBackend } from './googleCse.js';
import { createSearxngBackend } from './searxng.js';

export function buildBackends(config) {
  const all = [
    createWikipediaBackend(config),
    createBraveBackend(config),
    createExaBackend(config),
    createGoogleCseBackend(config),
    createSearxngBackend(config),
  ];
  const enabled = all.filter((b) => b.enabled);
  // Explicit override: SEARCH_BACKENDS=brave,wikipedia
  if (config.searchBackends?.length) {
    const wanted = new Set(config.searchBackends.map((s) => s.trim().toLowerCase()).filter(Boolean));
    return enabled.filter((b) => wanted.has(b.name));
  }
  return enabled;
}

// Simple per-backend circuit breaker: after repeated failures stop calling a
// backend for a cool-off window so one dead vendor cannot eat the deadline on
// every single claim.
export function createBreaker({ failureThreshold = 3, softFailureThreshold = 8, cooldownMs = 60000 } = {}) {
  const state = new Map(); // name -> {failures, softFailures, openUntil}
  return {
    allow(name) {
      const s = state.get(name);
      return !s || !s.openUntil || Date.now() >= s.openUntil;
    },
    success(name) {
      state.set(name, { failures: 0, softFailures: 0, openUntil: 0 });
    },
    /**
     * @param {string} name
     * @param {{soft?: boolean}} opts soft = a timeout/abort, which usually means
     *   WE were busy (extraction and verification share this box), not that the
     *   vendor is down. Tripping the breaker on those disables a healthy backend
     *   for the whole cooldown and degrades every claim behind it, so soft
     *   failures need far more evidence before opening the circuit.
     */
    failure(name, { soft = false } = {}) {
      const s = state.get(name) || { failures: 0, softFailures: 0, openUntil: 0 };
      if (soft) s.softFailures = (s.softFailures || 0) + 1;
      else s.failures += 1;
      if (s.failures >= failureThreshold || (s.softFailures || 0) >= softFailureThreshold) {
        s.openUntil = Date.now() + cooldownMs;
        s.failures = 0;
        s.softFailures = 0;
      }
      state.set(name, s);
    },
    snapshot: () => Object.fromEntries([...state.entries()].map(([k, v]) => [k, { ...v }])),
  };
}
