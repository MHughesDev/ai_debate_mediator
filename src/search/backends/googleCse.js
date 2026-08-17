// Google Programmable Search (CSE) — 100 free queries/day. Narrow quota, but
// Google's index is the best coverage available via a sanctioned API, so it is
// worth having in the federation for hard claims.
const ENDPOINT = 'https://www.googleapis.com/customsearch/v1';

export function createGoogleCseBackend(config) {
  return {
    name: 'google',
    enabled: !!(config.googleCseKey && config.googleCseCx),

    async search(query, { limit = 6, signal } = {}) {
      const url =
        `${ENDPOINT}?key=${encodeURIComponent(config.googleCseKey)}` +
        `&cx=${encodeURIComponent(config.googleCseCx)}` +
        `&q=${encodeURIComponent(query)}&num=${Math.min(limit, 10)}`;
      const res = await fetch(url, { signal, headers: { 'user-agent': config.searchUserAgent } });
      if (res.status === 429) throw new Error('google cse quota exhausted');
      if (!res.ok) throw new Error(`google cse HTTP ${res.status}`);
      const data = await res.json();
      return (data?.items || []).map((item) => ({
        title: item.title,
        url: item.link,
        snippet: item.snippet || '',
        publishedAt:
          item.pagemap?.metatags?.[0]?.['article:published_time'] ||
          item.pagemap?.metatags?.[0]?.date ||
          null,
      }));
    },
  };
}
