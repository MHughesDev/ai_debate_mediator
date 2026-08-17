// SearchProvider adapter for our own engine (ADR-0006).
//
// plansQueries=true tells the verifier this provider does its own query
// planning, so it issues ONE call per claim instead of hand-rolling query
// variants — the engine's planner is better at that than a string concat, and
// it halves backend traffic.
import { createSearchEngine } from '../../search/engine.js';
import { config as defaultConfig } from '../../config.js';

export function createOwnSearchProvider({ config = defaultConfig, backends, fetchImpl } = {}) {
  const engine = createSearchEngine({ config, backends, fetchImpl });
  return {
    kind: 'own',
    plansQueries: true,
    backends: engine.backendNames,
    async search(query, { maxResults = 6 } = {}) {
      return engine.search(query, { maxResults });
    },
    engine,
  };
}
