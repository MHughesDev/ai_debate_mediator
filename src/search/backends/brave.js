// Brave Search API — independent index (not a Google/Bing reseller), proper
// API with a free tier, and returns publication dates, which our recency
// scoring uses. Primary general-web backend when a key is present.
//
// Brave has no free plan: a subscription is required to issue a key at all, and
// the Search plan bills per request against $5 of monthly credit. Rate is not
// the constraint (50 req/sec); SPEND is. So this backend is metered (see
// rateLimiter.js) and gets a small per-claim query allowance: it receives the
// single most important query while keyless backends take the rest. That keeps
// a debate inside the monthly credit rather than running up a bill.
import { createRateLimiter, QuotaSkip } from '../rateLimiter.js';

const ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';

// One limiter per process, not per engine. Brave's rate limit is an
// account-level quota, but engines are built per session — so a limiter owned
// by one engine would let two concurrent debates each believe they had the
// whole budget, and both would collect 429s. Injectable for tests.
let sharedLimiter = null;
function getSharedLimiter(qps) {
  if (!sharedLimiter) sharedLimiter = createRateLimiter({ minIntervalMs: Math.ceil(1000 / qps) });
  return sharedLimiter;
}

export function _resetBraveLimiterForTests() {
  sharedLimiter = null;
}

export function createBraveBackend(config, { fetchImpl = fetch, limiter } = {}) {
  const qps = Math.max(config.braveQps || 1, 0.1);
  const rateLimiter = limiter || getSharedLimiter(qps);

  return {
    name: 'brave',
    enabled: !!config.braveApiKey,
    // Brave's terms permit only "transient storage required for operation" of
    // the application — storing or caching results otherwise needs a plan that
    // explicitly grants storage rights. So results this backend contributes to
    // are cached for minutes, not hours (see engine.js).
    cacheRestricted: true,
    // Quota-capped: only the highest-value query goes here.
    maxQueries: Math.max(1, config.braveMaxQueries || 1),
    limiter: rateLimiter,

    async search(query, { limit = 8, signal, deadlineAt = Infinity } = {}) {
      const gotSlot = await rateLimiter.acquire({ deadlineAt, signal });
      if (!gotSlot) throw new QuotaSkip('brave: no rate-limit slot before deadline');

      const url =
        `${ENDPOINT}?q=${encodeURIComponent(query)}&count=${limit}` +
        '&result_filter=web&text_decorations=false&safesearch=off&spellcheck=1';
      const res = await fetchImpl(url, {
        signal,
        headers: {
          'X-Subscription-Token': config.braveApiKey,
          Accept: 'application/json',
          'Accept-Encoding': 'gzip',
          'user-agent': config.searchUserAgent,
        },
      });

      if (res.status === 429) {
        // Respect the vendor's own backoff hint when it gives one.
        const retryAfterSec = Number(res.headers?.get?.('retry-after')) || 2;
        rateLimiter.penalize(retryAfterSec * 1000);
        throw new Error(`brave rate limited (retry after ${retryAfterSec}s)`);
      }
      if (res.status === 401 || res.status === 403) {
        throw new Error(`brave auth rejected (HTTP ${res.status}) — check BRAVE_API_KEY`);
      }
      if (!res.ok) throw new Error(`brave HTTP ${res.status}`);

      const data = await res.json();
      return (data?.web?.results || []).map((r) => ({
        title: r.title,
        url: r.url,
        snippet: stripTags(r.description || ''),
        publishedAt: normalizeAge(r.page_age || r.age),
      }));
    },
  };
}

function stripTags(text) {
  return text.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

// Brave returns either an ISO timestamp or a relative string ("3 days ago").
function normalizeAge(age) {
  if (!age) return null;
  const iso = new Date(age);
  if (!Number.isNaN(iso.getTime())) return iso.toISOString();
  const m = /^(\d+)\s+(minute|hour|day|week|month|year)s?\s+ago$/i.exec(String(age).trim());
  if (!m) return null;
  const n = Number(m[1]);
  const ms = {
    minute: 60e3, hour: 3600e3, day: 864e5, week: 6048e5, month: 2592e6, year: 31536e6,
  }[m[2].toLowerCase()];
  return new Date(Date.now() - n * ms).toISOString();
}
