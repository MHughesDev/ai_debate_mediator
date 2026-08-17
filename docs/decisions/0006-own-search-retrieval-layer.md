# Build our own search/retrieval layer instead of buying Tavily or Exa

## Status
Accepted (supersedes the "search vendor bake-off" open decision in SPEC §8)

## Context and Problem Statement
Verification needs web evidence for every checkable factual claim, inside a
verdict budget of 8–20 seconds, at roughly 40 claims per debate. The original
plan was a Tavily-vs-Exa bake-off. The owner asked instead for our own service,
built to the standard of the best retrieval products on the market.

The question worth answering first is what those products actually are. Tavily,
Perplexity and similar LLM-grounding services are not crawlers — they are
**retrieval and ranking layers over existing indexes**: they plan queries, fan
out to backends, fuse results, fetch and clean pages, then rank passages for the
model. Almost all of their quality lives in that layer, and that layer is
entirely buildable. A web-scale crawler is not, and is not what makes them good.

## Decision Drivers
- Verdict latency budget (search must finish in low single-digit seconds)
- Per-debate cost — a commercial search API is a recurring per-claim charge
- Control over ranking, because a wrong FALSE on screen is the worst failure
  mode (SPEC §3.1) and evidence selection drives that directly
- No vendor lock-in on the component most central to credibility
- Must work with zero API keys so the pipeline is always runnable

## Considered Options
1. Tavily or Exa (buy the whole layer)
2. Our own retrieval layer over federated backends
3. Our own crawler and index

## Decision Outcome
Chosen: **option 2**, implemented in `src/search/`:

```
claim → query planning → federated retrieval → reciprocal rank fusion
      → parallel page fetch (deadline-bounded) → readability extraction
      → BM25 passage ranking with claim-aware boosts → top passages
```

- **Query planning** turns a rambling debate claim into tight queries, always
  including a contradiction-seeking query so we look for counter-evidence
  rather than confirmation.
- **Federated backends**: Wikipedia/Wikidata (no key), Brave, Google CSE and
  self-hosted SearXNG. Agreement across independent retrievers is a quality
  signal used in fusion.
- **Reciprocal Rank Fusion** merges lists whose scores are not comparable.
- **Fetch + readability extraction** gets real article text, not just snippets,
  under a hard deadline with byte caps.
- **Passage ranking** pools all passages into one BM25 corpus (so scores are
  comparable across sources), then applies claim-aware boosts: numbers, years,
  entities, phrases, comparative and verification language, domain authority
  tiers, and recency that only bites for time-sensitive claims. A topical
  coverage gate drops passages that mention none of the claim's entities,
  numbers or core terms.
- **Caching** on normalized claim terms, in-process and in Redis.

Option 3 was rejected outright: a web-scale crawler is a multi-year
infrastructure programme and buys nothing this product needs.

### Consequences
- Good: no per-claim vendor cost; runs with zero keys; ranking is ours to tune
  against real debate claims; passages (not pages) reach the judge, which is
  both cheaper in tokens and better evidence; every stage degrades to partial
  results instead of stalling a verdict.
- Bad: retrieval quality is bounded by the backends we federate. Measured on
  Wikipedia alone, results are usable but imprecise for statistical claims —
  adding one real web backend (Brave's free tier, or a self-hosted SearXNG) is
  the single highest-leverage quality change, and costs nothing.
- Bad: we own the maintenance. Page extraction and backend APIs drift, so
  `scripts/searchBench.js` exists to re-measure quality and latency on demand.
- Tavily and Exa remain implemented behind the same `SearchProvider` interface,
  so switching back is one env var if we ever want to.

### Measured at time of writing (Wikipedia backend only, no keys)
p50 ≈ 700 ms, worst ≈ 1.1 s against a 4.5 s deadline; cache hits ≈ 0 ms.
