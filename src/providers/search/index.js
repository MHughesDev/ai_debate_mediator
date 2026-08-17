// SearchProvider interface:
//   search(query, { maxResults }) -> [{ title, url, snippet, publishedAt?, domain? }]
//   plansQueries?: boolean — provider does its own query planning, so callers
//                            should hand it the raw claim exactly once.
//
// 'own' is our in-house retrieval layer (ADR-0006) and the default; Tavily and
// Exa remain available as drop-in commercial alternatives.
import { config } from '../../config.js';
import { createOwnSearchProvider } from './own.js';
import { createTavilyProvider } from './tavily.js';
import { createExaProvider } from './exa.js';
import { createMockSearchProvider } from './mock.js';

// Memoized: the provider owns process-wide state that must not be rebuilt per
// session — the circuit breaker (a dead backend is dead for every session) and
// the Brave quota meter (an account-level limit).
let cached = null;

export function getSearchProvider() {
  if (cached) return cached;
  cached = buildSearchProvider();
  return cached;
}

export function _resetSearchProviderForTests() {
  cached = null;
}

function buildSearchProvider() {
  switch (config.searchProvider) {
    case 'own':
      return createOwnSearchProvider();
    case 'tavily':
      return createTavilyProvider();
    case 'exa':
      return createExaProvider();
    case 'mock':
      return createMockSearchProvider();
    default:
      throw new Error(`unknown SEARCH_PROVIDER: ${config.searchProvider}`);
  }
}
