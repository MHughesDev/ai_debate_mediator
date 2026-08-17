// Search engine orchestration.
//
// Pipeline (mirrors how modern LLM-grounding retrieval stacks are built):
//   claim -> query planning -> federated retrieval -> reciprocal rank fusion
//         -> parallel page fetch (deadline-bounded) -> readability extraction
//         -> BM25 passage ranking with claim-aware boosts -> top passages
//
// Two hard rules, both from the credibility rules in SPEC §3.1:
//   1. Never stall a verdict. Every stage is deadline-bounded and degrades to
//      whatever evidence it already has; an empty result is an honest
//      UNVERIFIED, which is a correct outcome, not a failure.
//   2. Never fabricate. Passages are verbatim source text with their URL, so
//      the judge cites what it actually read.
import { planQueries } from './queryPlanner.js';
import { buildBackends, createBreaker } from './backends/index.js';
import { rrfFuse, capPerDomain } from './fusion.js';
import { fetchPages } from './fetcher.js';
import { extractArticle } from './extract.js';
import { rankPassages } from './rank.js';
import { cacheKey, readCache, writeCache } from './cache.js';
import { domainOf, domainAuthority } from './text.js';
import { logger } from '../logger.js';

export function createSearchEngine({ config, backends: injectedBackends, fetchImpl } = {}) {
  const backends = injectedBackends || buildBackends(config);
  const breaker = createBreaker({ cooldownMs: config.searchBreakerCooldownMs });

  async function retrieve(plan, deadlineAt) {
    const jobs = [];
    for (const backend of backends) {
      if (!breaker.allow(backend.name)) continue;
      // Quota-capped backends (Brave's free tier is ~1 query/sec) get only
      // their highest-value queries. The planner orders queries core-first, so
      // slicing keeps the query that matters and sheds the speculative ones;
      // keyless backends still run the whole plan.
      const queries = backend.maxQueries ? plan.queries.slice(0, backend.maxQueries) : plan.queries;
      for (const { q } of queries) {
        jobs.push(
          (async () => {
            const remaining = deadlineAt - Date.now();
            if (remaining <= 30) return null;
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), Math.min(remaining, config.searchBackendTimeoutMs));
            try {
              const results = await backend.search(q, { limit: 8, signal: controller.signal, deadlineAt });
              breaker.success(backend.name);
              return { backend: `${backend.name}:${q}`, results };
            } catch (err) {
              // A quota skip is not a failure. The backend is healthy; we
              // simply had no rate-limit budget for it before this claim's
              // deadline. Counting it would trip the breaker and disable a
              // working backend for the whole cooldown window.
              if (err.skip) {
                logger.debug('search backend skipped', { backend: backend.name, reason: err.message });
                return null;
              }
              breaker.failure(backend.name);
              logger.debug('search backend failed', { backend: backend.name, error: err.message });
              return null;
            } finally {
              clearTimeout(timer);
            }
          })(),
        );
      }
    }
    const settled = await Promise.all(jobs);
    return settled.filter(Boolean);
  }

  /**
   * @param {string} claimText
   * @returns {Promise<Array<{title,url,snippet,publishedAt,domain,score}>>}
   */
  async function search(claimText, { maxResults = 6, useCache = true } = {}) {
    const started = Date.now();
    const key = cacheKey(claimText, { maxResults });
    if (useCache) {
      const hit = await readCache(key);
      if (hit) {
        logger.debug('search cache hit', { ms: Date.now() - started });
        return hit;
      }
    }

    const plan = planQueries(claimText, { maxQueries: config.searchesPerClaim });
    const deadlineAt = started + config.searchDeadlineMs;

    // 1. Federated retrieval.
    const lists = await retrieve(plan, started + config.searchRetrieveMs);
    if (lists.length === 0) {
      logger.warn('no search backend returned results', { backends: backends.map((b) => b.name) });
      return [];
    }

    // 2. Fuse into one ranked candidate set. The domain cap here is deliberately
    //    looser than the final one: a site can legitimately hold several
    //    relevant pages, and pruning them before we have read anything would
    //    throw away evidence. Strict diversity is enforced on the final
    //    passages instead (rankPassages).
    const fused = capPerDomain(rrfFuse(lists), Math.max(config.searchMaxPerDomain * 2, 4));
    const candidates = fused.slice(0, config.searchMaxCandidates);
    if (candidates.length === 0) return [];

    // 3. Fetch the top candidates for full text — snippets alone are often too
    //    thin to settle a numeric claim.
    const fetchBudget = Math.max(300, deadlineAt - Date.now());
    const toFetch = candidates.slice(0, config.searchMaxFetch);
    const pages = await fetchPages(toFetch.map((c) => c.url), {
      deadlineMs: Math.min(fetchBudget, config.searchFetchDeadlineMs),
      maxBytes: config.searchMaxPageBytes,
      userAgent: config.searchUserAgent,
      fetchImpl,
    });

    // 4. Extract main content and rank passages against the claim.
    const byUrl = new Map(candidates.map((c) => [c.url, c]));
    const docs = [];
    for (const page of pages) {
      const article = extractArticle(page.html, page.url);
      // Keep short pages: an official one-paragraph fact page is often the most
      // decisive source there is. Only discard extraction failures.
      if (!article.text || article.text.split(/\s+/).length < 20) continue;
      const meta = byUrl.get(page.url) || {};
      const domain = domainOf(page.url);
      docs.push({
        url: meta.url || page.url,
        title: article.title || meta.title || page.url,
        domain,
        text: article.text,
        publishedAt: article.publishedAt || meta.publishedAt || null,
        // The backend's own date (a Wikipedia revision timestamp, Brave's page
        // age) is evidence of currency too, so it counts as an update signal
        // rather than being overridden by the page's creation date.
        updatedAt: article.updatedAt || meta.publishedAt || null,
        authority: meta.authority ?? domainAuthority(domain),
      });
    }

    // 5. SERP snippets compete alongside full text. A backend picked its
    //    snippet *because* it matched the query, so it is often the single most
    //    on-point sentence on the page — and it is the only evidence available
    //    for pages we could not fetch in time.
    for (const candidate of candidates) {
      if ((candidate.snippet || '').split(/\s+/).length < 6) continue;
      docs.push({
        url: candidate.url,
        title: candidate.title,
        domain: candidate.domain,
        text: candidate.snippet,
        publishedAt: candidate.publishedAt,
        authority: candidate.authority,
      });
    }

    const passages = rankPassages(docs, {
      claim: claimText,
      plan,
      maxPassages: maxResults,
      maxPerDomain: config.searchMaxPerDomain,
    });

    const results = passages.slice(0, maxResults).map((p) => ({
      title: p.title,
      url: p.url,
      snippet: p.text,
      publishedAt: p.publishedAt,
      updatedAt: p.updatedAt || null,
      domain: p.domain,
      score: +p.score.toFixed(4),
    }));

    logger.debug('search complete', {
      ms: Date.now() - started,
      candidates: candidates.length,
      fetched: pages.length,
      docs: docs.length,
      results: results.length,
    });

    if (useCache && results.length) await writeCache(key, results, config.searchCacheTtlSec);
    return results;
  }

  return {
    search,
    plan: planQueries,
    backendNames: backends.map((b) => b.name),
    breakerState: () => breaker.snapshot(),
  };
}
