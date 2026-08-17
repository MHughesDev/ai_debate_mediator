import { config } from '../../config.js';

export function createExaProvider() {
  return {
    kind: 'exa',
    async search(query, { maxResults = 5 } = {}) {
      const res = await fetch('https://api.exa.ai/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': config.exaApiKey },
        body: JSON.stringify({ query, numResults: maxResults, contents: { text: { maxCharacters: 500 } } }),
      });
      if (!res.ok) throw new Error(`exa search failed: ${res.status}`);
      const data = await res.json();
      return (data.results || []).map((r) => ({
        title: r.title || r.url,
        url: r.url,
        snippet: r.text || '',
      }));
    },
  };
}
