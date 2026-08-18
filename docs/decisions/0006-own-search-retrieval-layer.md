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

## Amendment (2026-08-17): Brave is the general-web backend

ADR-0006 chose to build the retrieval layer but left which general-web index to
federate open. Chosen: **Brave Search API**, on the free tier.

Why Brave over the alternatives considered:
- It is an **independent index**, not a Google/Bing reseller, so it federates
  with Wikipedia as a genuinely different retriever. Fusion rewards agreement
  between independent backends, which is worth nothing if they share a source.
- It returns **publication dates**, which our recency scoring needs. Google CSE
  does not reliably, and undated results are dead weight on time-sensitive
  claims.
- Free tier (~2,000 queries/month) comfortably covers real use: metered as
  below, a one-hour debate spends roughly 40 queries.
- No infrastructure to run, unlike SearXNG, which remains supported for
  deployments that would rather self-host than hold a third-party key.

### Consequence: quota metering, and why a skip is not a failure
The free tier allows ~1 query/second. Claims are verified concurrently and each
plans several queries, so naive parallelism earns 429s rather than evidence.
Three rules follow, and each one is load-bearing:

1. **Slots are reserved synchronously** (`src/search/rateLimiter.js`), before
   any `await`, so concurrent callers can never be handed the same instant.
2. **Waiting is deadline-aware.** If a caller's slot would land after its
   verdict deadline, it is told to skip immediately instead of blocking and
   then timing out. Losing one backend on one claim is acceptable; delaying a
   verdict is not.
3. **A quota skip is not a backend failure.** It must not count toward the
   circuit breaker — otherwise running low on quota would look like a broken
   vendor and take a healthy Brave offline for the whole cooldown window.

The limiter is **per process, not per engine**. Engines are built per debate
session, but the quota belongs to the account, so a per-engine limiter would let
two concurrent debates each believe they had the full budget. `getSearchProvider()`
is memoized for the same reason, which also shares circuit-breaker state across
sessions.

Only the highest-value query per claim spends quota (`BRAVE_MAX_QUERIES`, default
1). The query planner orders queries core-first, so the metered backend gets the
query that matters and the keyless backends absorb the speculative ones. Both
`BRAVE_QPS` and `BRAVE_MAX_QUERIES` are raised on a paid tier.

## Amendment 2 (2026-08-17): Exa is the primary backend; Brave becomes optional

The first amendment chose Brave for two reasons: a free tier, and publication
dates. Verifying vendor terms in August 2026 found that **both halves of that
reasoning had expired**.

- Brave's free plan was discontinued on 2026-02-12. There is now no plan that
  issues an API key without a subscription and a payment card, and the card is a
  live billing instrument rather than an anti-fraud hold. The Search plan bills
  $5.00/1,000 requests against $5 of monthly credit — roughly 1,000 requests, or
  ~25 hour-long debates.
- **Exa provides what Brave was chosen for, free.** $20 of credits on signup plus
  $10 every month, recurring, with no payment method required (~1,400 searches),
  and `publishedDate` is a documented first-class field on all result types.
  Since March 2026 the text of the first 10 results is included at no extra cost.

Chosen: **Exa is the primary general-web backend. Brave remains supported and
federates when a key is present, but is no longer recommended by default.**

The decision this amendment does not change is the one that mattered: because
ADR-0006 built a federated layer rather than buying a vendor's, swapping the
primary index was a new backend file plus a registry line, and the ranking,
fusion, extraction and caching work all carried over untouched. That is the
lock-in argument paying for itself within six months.

### A term that shapes the code
Brave permits only "transient storage required for operation" of the
application; Exa is stricter, allowing only "temporary files that are
automatically cached by your web browser". Our 6-hour result cache satisfies
neither. Backends therefore declare `cacheRestricted`, and any answer such a
backend contributed to is capped at `SEARCH_RESTRICTED_CACHE_TTL_SEC` (300s).
The cap applies to the whole answer because after rank fusion one backend's
contribution cannot be separated from another's, and the conservative reading is
the only defensible one.

### Also rejected, having been recommended earlier in error
- **Google Programmable Search** — closed to new customers; shuts down
  2027-01-01.
- **SearXNG as a primary backend** — its limiter caps non-HTML formats at 4
  requests per hour per IP, and self-hosting on a datacenter IP is blocked by
  Google within a handful of searches. Retained only as a last-resort tier.
- **Tavily** — returns no publication dates outside `topic=news`, and its terms
  permit training on submitted queries, which for this tool means debate
  transcript excerpts.
