// Wikipedia + Wikidata: no API key, generous rate limits, and unusually strong
// coverage of exactly the encyclopedic facts debaters assert (populations,
// dates, records, "visible from space"). Also our zero-config default, so the
// fact-checker is never silently unable to search.
const API = 'https://en.wikipedia.org/w/api.php';
const REST = 'https://en.wikipedia.org/api/rest_v1/page/summary';

export function createWikipediaBackend(config) {
  return {
    name: 'wikipedia',
    enabled: config.searchWikipediaEnabled !== false,

    async search(query, { limit = 5, signal } = {}) {
      // srsearch with snippets gives us ranked hits AND the matching text in
      // one round trip — no extra fetch needed to judge relevance.
      const url =
        `${API}?action=query&format=json&origin=*&list=search` +
        `&srsearch=${encodeURIComponent(query)}&srlimit=${limit}&srprop=snippet|timestamp`;
      const res = await fetch(url, {
        signal,
        headers: { 'user-agent': config.searchUserAgent, accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`wikipedia HTTP ${res.status}`);
      const data = await res.json();
      return (data?.query?.search || []).map((hit) => ({
        title: hit.title,
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(hit.title.replace(/ /g, '_'))}`,
        snippet: stripHighlight(hit.snippet || ''),
        publishedAt: hit.timestamp || null,
      }));
    },

    // Used opportunistically for a crisp definition of the head entity.
    async summary(title, { signal } = {}) {
      const res = await fetch(`${REST}/${encodeURIComponent(title.replace(/ /g, '_'))}`, {
        signal,
        headers: { 'user-agent': config.searchUserAgent, accept: 'application/json' },
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data?.extract || null;
    },
  };
}

function stripHighlight(html) {
  return html
    .replace(/<\/?span[^>]*>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
