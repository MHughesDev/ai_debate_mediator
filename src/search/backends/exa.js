// Exa — neural/semantic search with a genuinely free recurring tier ($10 of
// credits every month, no card), and it returns publishedDate, which is the
// property recency scoring needs and most cheap backends do not provide.
//
// That combination makes it the strongest zero-cost general-web backend, so it
// federates alongside Brave rather than replacing it: two independent indexes
// agreeing is itself a quality signal (see fusion.js).
const ENDPOINT = 'https://api.exa.ai/search';

export function createExaBackend(config, { fetchImpl = fetch } = {}) {
  return {
    name: 'exa',
    enabled: !!config.exaApiKey,
    // Exa's terms are stricter than Brave's: they permit only "temporary files
    // that are automatically cached by your web browser". A server-side cache
    // is not covered, so answers it contributed to take the short TTL too.
    cacheRestricted: true,

    async search(query, { limit = 8, signal } = {}) {
      const res = await fetchImpl(ENDPOINT, {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': config.exaApiKey,
          'user-agent': config.searchUserAgent,
        },
        body: JSON.stringify({
          query,
          numResults: limit,
          type: 'auto', // let Exa pick neural vs keyword per query
          contents: { text: { maxCharacters: 800 } },
        }),
      });

      if (res.status === 401 || res.status === 403) {
        throw new Error(`exa auth rejected (HTTP ${res.status}) — check EXA_API_KEY`);
      }
      if (!res.ok) throw new Error(`exa HTTP ${res.status}`);

      const data = await res.json();
      return (data.results || []).map((r) => ({
        title: r.title || r.url,
        url: r.url,
        snippet: (r.text || r.summary || '').replace(/\s+/g, ' ').trim(),
        // The field Brave was chosen for, and which our previous Exa adapter
        // silently discarded.
        publishedAt: normalizeDate(r.publishedDate),
      }));
    },
  };
}

function normalizeDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  const year = parsed.getUTCFullYear();
  if (year < 1990 || year > 2100) return null;
  return parsed.toISOString();
}
