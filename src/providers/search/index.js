// SearchProvider interface (Tavily/Exa bake-off pending, SPEC §8):
//   search(query, { maxResults }) -> [{ title, url, snippet }]
import { config } from '../../config.js';
import { createTavilyProvider } from './tavily.js';
import { createExaProvider } from './exa.js';
import { createMockSearchProvider } from './mock.js';

export function getSearchProvider() {
  switch (config.searchProvider) {
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
