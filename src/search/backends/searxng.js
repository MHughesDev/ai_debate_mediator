// SearXNG — self-hosted metasearch. Set SEARXNG_URL to your instance and you
// get aggregated Google/Bing/DDG coverage with no per-query API cost and no
// third-party key. The most cost-effective backend at debate volume, at the
// price of running one container yourself.
export function createSearxngBackend(config) {
  return {
    name: 'searxng',
    enabled: !!config.searxngUrl,

    async search(query, { limit = 8, signal } = {}) {
      const base = config.searxngUrl.replace(/\/$/, '');
      const url = `${base}/search?q=${encodeURIComponent(query)}&format=json&language=en&safesearch=0`;
      const res = await fetch(url, {
        signal,
        headers: {
          accept: 'application/json',
          'user-agent': config.searchUserAgent,
          ...(config.searxngToken ? { Authorization: `Bearer ${config.searxngToken}` } : {}),
        },
      });
      if (!res.ok) throw new Error(`searxng HTTP ${res.status}`);
      const data = await res.json();
      return (data?.results || []).slice(0, limit).map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.content || '',
        publishedAt: r.publishedDate || null,
      }));
    },
  };
}
