import { config } from '../../config.js';

export function createTavilyProvider() {
  return {
    kind: 'tavily',
    async search(query, { maxResults = 5 } = {}) {
      const res = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          api_key: config.tavilyApiKey,
          query,
          max_results: maxResults,
          search_depth: 'basic',
        }),
      });
      if (!res.ok) throw new Error(`tavily search failed: ${res.status}`);
      const data = await res.json();
      return (data.results || []).map((r) => ({
        title: r.title,
        url: r.url,
        snippet: (r.content || '').slice(0, 500),
      }));
    },
  };
}
