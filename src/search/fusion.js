// Reciprocal Rank Fusion — the standard way to merge ranked lists from
// heterogeneous retrievers whose scores are not comparable (a Brave relevance
// score means nothing next to a Wikipedia hit). Rank-based, parameter-light,
// and consistently competitive with learned fusion in IR literature.
import { canonicalUrl, dedupeKey, domainOf, domainAuthority } from './text.js';

const RRF_K = 60; // standard damping; larger => flatter contribution by rank

/**
 * @param {Array<{backend: string, results: Array<{title,url,snippet,publishedAt?}>}>} lists
 */
export function rrfFuse(lists, { k = RRF_K, authorityWeight = 0.25 } = {}) {
  const merged = new Map(); // dedupe key -> entry (entry keeps a fetchable url)

  for (const { backend, results } of lists) {
    (results || []).forEach((result, index) => {
      if (!result?.url) return;
      const url = canonicalUrl(result.url);
      const key = dedupeKey(url);
      const contribution = 1 / (k + index + 1);
      const existing = merged.get(key);
      if (existing) {
        existing.score += contribution;
        existing.backends.add(backend);
        // Prefer the richest metadata seen across backends.
        if (!existing.snippet || (result.snippet && result.snippet.length > existing.snippet.length)) {
          existing.snippet = result.snippet;
        }
        existing.publishedAt = existing.publishedAt || result.publishedAt || null;
        existing.title = existing.title || result.title;
      } else {
        merged.set(key, {
          url,
          title: result.title || url,
          snippet: result.snippet || '',
          publishedAt: result.publishedAt || null,
          domain: domainOf(url),
          backends: new Set([backend]),
          score: contribution,
        });
      }
    });
  }

  const fused = [...merged.values()].map((entry) => {
    const authority = domainAuthority(entry.domain);
    // Agreement across independent backends is a strong quality signal.
    const agreement = 1 + 0.15 * (entry.backends.size - 1);
    return {
      ...entry,
      backends: [...entry.backends],
      authority,
      fusedScore: entry.score * agreement * (1 - authorityWeight + authorityWeight * authority),
    };
  });

  return fused.sort((a, b) => b.fusedScore - a.fusedScore);
}

// Keep the result set diverse: one dominant site should not own the evidence.
export function capPerDomain(results, maxPerDomain = 2) {
  const counts = new Map();
  const out = [];
  for (const r of results) {
    const n = counts.get(r.domain) || 0;
    if (n >= maxPerDomain) continue;
    counts.set(r.domain, n + 1);
    out.push(r);
  }
  return out;
}
