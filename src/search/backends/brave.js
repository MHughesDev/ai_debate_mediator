// Brave Search API — independent index (not a Google/Bing reseller), proper
// API with a free tier, and returns publication dates, which our recency
// scoring uses. Primary general-web backend when a key is present.
const ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';

export function createBraveBackend(config) {
  return {
    name: 'brave',
    enabled: !!config.braveApiKey,

    async search(query, { limit = 8, signal } = {}) {
      const url = `${ENDPOINT}?q=${encodeURIComponent(query)}&count=${limit}&result_filter=web&text_decorations=false&safesearch=off`;
      const res = await fetch(url, {
        signal,
        headers: {
          'X-Subscription-Token': config.braveApiKey,
          Accept: 'application/json',
          'Accept-Encoding': 'gzip',
          'user-agent': config.searchUserAgent,
        },
      });
      if (res.status === 429) throw new Error('brave rate limited');
      if (!res.ok) throw new Error(`brave HTTP ${res.status}`);
      const data = await res.json();
      return (data?.web?.results || []).map((r) => ({
        title: r.title,
        url: r.url,
        snippet: (r.description || '').replace(/<[^>]+>/g, ''),
        publishedAt: r.page_age || r.age || null,
      }));
    },
  };
}
