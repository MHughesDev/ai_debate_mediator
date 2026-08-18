# Vendor tiers — what is actually free, and what actually works

**Verified against official vendor documentation on 2026-08-17.** Vendors change
pricing and retire models frequently — 8 of the 14 model ids written into this
repo six months earlier had already been retired by the time they were checked.
Re-verify before relying on anything here, and treat `npm run preflight` as the
source of truth for what your own account can do.

## What this system demands

Two numbers decide whether a tier is usable, and neither is token cost:

| Load | Figure |
|---|---|
| LLM requests during a live debate | **~12 requests/minute** (extraction ticks every 5s whenever there is new transcript), ~760 per hour |
| Search requests | ~1 per checkable claim, ~40 per hour-long debate |

**~12 RPM sustained is the bar.** Any free tier below it cannot run a single
debate, regardless of how generous its monthly token allowance looks.

## LLM providers

| Provider | Genuinely free? | Card? | Verdict for live debates |
|---|---|---|---|
| **Google Gemini** | Yes — free tier via AI Studio | No | **The only free tier that plausibly fits.** Exact RPM/RPD are shown in the AI Studio console rather than the docs; confirm yours before relying on it |
| **Groq** | Yes — 30 RPM, **1,000 requests/day** | Not documented | RPM is fine, but one debate consumes the entire daily quota |
| **OpenRouter** | Yes — `:free` models, 20 RPM, **50/day** (1,000/day after a one-off $10) | No (until $10) | 50/day ≈ 7 minutes of debate. At 1,000/day, ~1 debate. Also: free models generally route to providers that **train on your inputs** — a real problem for recorded speech |
| **Cerebras** | $5 trial credits, 5 RPM | Unverified | 5 RPM is below our 12 RPM floor. Fails outright |
| **Fireworks** | $1 credit, **10 RPM** without a card | Needed above 10 RPM | 10 RPM is just under our floor |
| **Together** | One $0 model, but it does **not** support structured output | Unverified | Unusable for our schema-constrained calls |
| **Anthropic** | No free tier | Yes | Paid. `claude-haiku-4-5` + `claude-opus-5` both confirmed current |
| **OpenAI** | No free tier | Yes | Paid. `gpt-4.1`/`gpt-4.1-mini` still exist in the API but are legacy; prefer `gpt-5.6-luna` / `gpt-5.6-terra` |
| **DeepSeek** | No free tier | — | **`json_object` only — no schema constraint.** Our dialect negotiation copes, but output is unenforced |
| **Self-hosted** (Ollama, vLLM, LM Studio, llama.cpp) | Free, no limits | No | **No rate limit and no per-token cost.** The only option with genuinely unlimited requests |

The honest conclusion: **no hosted free tier reliably sustains a live debate.**
Either budget a few dollars per debate, or self-host — which is why the LLM
layer treats self-hosting as first class (see
[ADR-0007](decisions/0007-universal-llm-provider-layer.md)).

**Consumer subscriptions do not work.** ChatGPT Plus and Claude Pro/Max are
separate products from the APIs and expose no endpoint an application can call.

## Search

| Vendor | Reality |
|---|---|
| **Exa** | **The best free option.** $20 to start plus **$10 of credits every month, recurring, no card** ≈ 1,400 searches/month — and `publishedDate` is a documented, first-class field on all result types, which recency scoring needs. Since March 2026 text for the first 10 results is included free. Overage ~$0.007/query. **Its terms restrict caching harder than Brave's** — see below |
| **Tavily** | 1,000 credits/month free, no card, but the weakest fit: **`published_date` is not in the documented response schema** (news topic only), and its terms let Tavily **train on your queries and outputs** — which for a debate tool means transcript excerpts |
| **Serper** | 2,500 free queries, no card, then a **$50 minimum that expires in 6 months** (~$8.33/mo effective at our volume). Notably the **only one whose terms explicitly permit caching** "for as long as your use case requires" |
| **Brave Search** | **No free plan** — a subscription is required before a key can be issued, and the card is now a live billing instrument, not just anti-fraud. $5.00 per 1,000 requests against $5 monthly credit ≈ 1,000 requests/month ≈ 25 debates. Capacity **50 requests/second** — rate is not the constraint, spend is. Set a spending cap in the dashboard; it is opt-in. **Its terms permit only "transient storage" of results** — see below |
| **Wikipedia / Wikidata** | Genuinely free, no key. The floor the engine always has. Weak on statistical claims. New global rate limits landed in March/April 2026: **10 req/min for an unidentified IP, 200 req/min with a compliant User-Agent** — ours complies, which buys a 20x allowance for free |
| **Google Programmable Search** | **Closed to new customers.** Existing keys work until **1 January 2027**; new Cloud projects get `403 PERMISSION_DENIED`. Only useful if you already hold a working key (then 100/day free is the best deal available — but plan the migration) |
| **SearXNG** | **Not viable as a primary backend.** With the limiter on, any non-HTML format is capped at **4 requests per hour per IP**, so public instances are unusable; self-hosting on a datacenter IP gets blocked by Google within a handful of searches, and engine suspensions last an hour (rate-limit) to a day (CAPTCHA). Keep as a last-resort tier only |
| **Bing Web Search** | **Retired** August 2025. The Azure successor feeds an agent rather than returning results, at ~$35/1,000 calls. Not viable |
| **DuckDuckGo** | No usable API. The Instant Answer endpoint returns empty results for fact-check-shaped queries and never returns dates |

### Vendor caching terms shape our code

Brave forbids storing or caching results beyond "transient storage required for
operation" without a plan granting storage rights (Enterprise only). Exa is
stricter still, permitting only "temporary files that are automatically cached
by your web browser" — a server-side cache is plainly not that.

Our default 6-hour search cache sits on the wrong side of both, so backends
declare `cacheRestricted` and any answer they contributed to is capped at
`SEARCH_RESTRICTED_CACHE_TTL_SEC` (default 300s) instead. The cap applies to the
whole answer, because after rank fusion one backend's contribution cannot be
separated from another's. 300s still serves a claim repeated within a debate,
which is the operational need, without accumulating a database of their results.

If aggressive caching later matters, Serper is the only vendor whose terms
clearly allow it, and Exa offers enterprise agreements.

### One trap worth naming

Gemini's Grounding with Google Search looks like free search, but its result
URIs are `vertexaisearch.cloud.google.com` redirects rather than publisher URLs
— useless for a fetch-and-extract pipeline — and its terms forbid interspersing
other content with the grounded results, which is exactly what ranking passages
into evidence cards does.

## Speech to text

Both vendors support **real-time streaming with speaker diarization**, which the
architecture depends on for attributing claims to speakers. There is no
capability gap.

| Vendor | Free | Card? | Cost with speaker labels |
|---|---|---|---|
| **AssemblyAI** | $50 one-off credits | **No** | ~$0.27/hr (`universal-streaming-english` $0.15 + labels $0.12) |
| **Deepgram** | $200 credits, no expiry | **No** | ~$0.41/hr (nova-3 $0.288 + diarization $0.12) |

Two things that will bite:
- **AssemblyAI bills WebSocket connection-open time, not audio sent.** Holding
  one socket per speaker for an hour bills for every socket. Close them
  aggressively.
- Deepgram streaming requires `diarize_model=v1` or `latest`; **`v2` is
  rejected on streaming**.

Deepgram's $200 is the larger free runway in absolute hours (~488 vs ~185).

## Meeting bot

**Recall.ai**: $0.50/recording-hour, **first 5 hours free**, no card to start, no
waitlist. Zoom, Google Meet and Teams all supported.

Three constraints that shape our implementation:
1. **Real-time media requires a public `wss://` endpoint. There is no
   HTTPS-webhook alternative.** This is the only reason a deploy is needed
   before a live call; everything else runs from a laptop.
2. **Per-participant audio requires 4-core bots** — `variant: {zoom,
   google_meet, microsoft_teams: 'web_4_core'}` on bot creation. Without it the
   separate streams we rely on are not reliably delivered.
3. Recall offers **"Perfect Diarization"** (transcribing each participant's
   separate stream) which returns **real participant names** instead of
   statistical `A`/`B`/`C` labels, at ~1.8x transcription credits. For a system
   that attributes every claim to a person, name-level ground truth is
   materially better than diarization. Worth evaluating against our own STT.

Open-source alternatives exist — **Attendee** (self-hostable, per-participant
audio, Zoom/Meet/Teams) and **Vexa** (Apache-2.0) — trading vendor cost for
running a headless browser fleet and absorbing every Zoom/Meet UI change.

## Data stores

| Vendor | Free tier | Card? | The cliff |
|---|---|---|---|
| **Neon Postgres** | 0.5 GB storage, 100 CU-hours/project/month, permanent | **No** | Both limits are **hard stops, not throttles**: exceeding storage blocks writes, exceeding compute suspends the project until the next billing period. Scale-to-zero after 5 min idle cannot be disabled, so the first query of a debate pays a cold start |
| **Upstash Redis** | **500K commands/month** (~16K/day), 256 MB, 1 database | **No** | Archived after 30 days of inactivity — the endpoint disappears and must be restored. Concurrent-connection ceiling is undocumented; prefer the REST client |

Note Upstash's cap is **per month, not per day** — an older Upstash doc still
says 10K/day, which is stale.

## Sources

Brave [pricing](https://api-dashboard.search.brave.com/documentation/pricing) ·
[terms](https://api-dashboard.search.brave.com/documentation/resources/terms-of-service) ·
Exa [pricing](https://exa.ai/pricing) ·
Tavily [pricing](https://www.tavily.com/pricing) ·
Google CSE [overview](https://developers.google.com/custom-search/v1/overview) ·
Bing [retirement](https://learn.microsoft.com/en-us/lifecycle/announcements/bing-search-api-retirement) ·
Wikimedia [rate limits](https://www.mediawiki.org/wiki/Wikimedia_APIs/Rate_limits) ·
Anthropic [models](https://platform.claude.com/docs/en/about-claude/models/overview) ·
[structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs) ·
OpenAI [pricing](https://developers.openai.com/api/docs/pricing) ·
Gemini [rate limits](https://ai.google.dev/gemini-api/docs/rate-limits) ·
[structured output](https://ai.google.dev/gemini-api/docs/structured-output) ·
Groq [rate limits](https://console.groq.com/docs/rate-limits) ·
[structured outputs](https://console.groq.com/docs/structured-outputs) ·
Cerebras [rate limits](https://inference-docs.cerebras.ai/support/rate-limits) ·
[deprecations](https://inference-docs.cerebras.ai/support/deprecation) ·
Together [serverless models](https://docs.together.ai/docs/serverless-models) ·
Fireworks [rate limits](https://docs.fireworks.ai/guides/quotas_usage/rate-limits) ·
OpenRouter [limits](https://openrouter.ai/docs/api-reference/limits) ·
[privacy](https://openrouter.ai/docs/guides/privacy/provider-logging) ·
AssemblyAI [pricing](https://www.assemblyai.com/pricing) ·
[streaming diarization](https://www.assemblyai.com/docs/faq/can-i-use-speaker-diarization-with-live-audio-transcription) ·
Deepgram [pricing](https://deepgram.com/pricing) ·
[diarization](https://developers.deepgram.com/docs/diarization) ·
Recall [pricing](https://www.recall.ai/pricing) ·
[per-participant audio](https://docs.recall.ai/docs/how-to-get-separate-audio-per-participant-realtime) ·
[websocket endpoints](https://docs.recall.ai/docs/real-time-websocket-endpoints.md) ·
Neon [plans](https://neon.com/docs/introduction/plans) ·
Upstash [pricing](https://upstash.com/pricing/redis)
