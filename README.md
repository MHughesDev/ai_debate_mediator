# AI Debate Mediator

An AI mediator that joins any video call (Zoom / Meet / Teams) as a bot participant, listens in real time, detects claims and argument structure, fact-checks verifiable claims against live web sources, scores debaters against configurable format rubrics, and displays everything live through the bot's own camera tile — zero installs for participants.

## How it works

```
Meeting audio (per participant, via Recall.ai bot)
  → Streaming STT with speaker labels (Deepgram / AssemblyAI)
  → Claim extraction (fast LLM on transcript deltas) → argument graph
  → Async verification workers (web search + LLM judge) → gated verdicts + sources
  → Score engine (format rubric weights) + turn clock + fallacy/dodge detection
  → WebSocket → bot display page (rendered as the bot's camera) + dashboard + stage mode
  → Post-debate receipts
```

Full product spec: [`docs/SPEC.md`](docs/SPEC.md) · build plan: [`docs/PLAN.md`](docs/PLAN.md) · ADRs: [`docs/decisions/`](docs/decisions/)

## Product surfaces

| URL | Surface |
|---|---|
| `/launcher/` | One-pager: meeting link → preset → dials → speakers → **Send bot** |
| `/display/?session=<id>` | Bot camera tile (what Recall renders into the call) |
| `/dashboard/?session=<id>` | Host dashboard: live transcript, fact-checks, controls |
| `/stage/?session=<id>` | Auditorium layout: scoreboard rail, argument map, feed, ticker |

In-call chat commands: `/mode <preset>` · `/pause scoring` · `/resume` · `/check that` · `/end`

## Run it locally (zero keys needed)

Every vendor sits behind an interface with a mock (ADR-0005), so the **entire pipeline runs offline**: a scripted debate plays through mock meeting/STT/LLM/search providers and produces real transcripts, claims, verdicts, scores, and receipts.

```bash
npm install
npm start           # http://localhost:8080 — open /launcher/, paste any URL, Send bot
npm test            # 30+ tests, no network
node scripts/simulate.js    # full E2E assertion run against a running server
node scripts/loadtest.js "" 3   # 3 concurrent debates + latency percentiles
```

`MOCK_SPEED_FACTOR=10 npm start` makes the scripted debate run 10× faster.

## Going live

Copy `.env.example` to `.env`, fill in whatever keys you have, and validate them:

```bash
npm run preflight
```

Preflight makes one real API call per configured vendor and reports OK / FAIL / SKIPPED per line, so a wrong key or region is caught in seconds instead of mid-debate. Vendors with no key are skipped and keep running as mocks — a fully mocked setup passes.

Adding env vars switches the same code paths from mocks to real vendors (selection is automatic when a key is present):

| Env var | Enables |
|---|---|
| `RECALL_API_KEY` (+ `PUBLIC_BASE_URL`) | Real meeting bot via Recall.ai (ADR-0001) |
| `ASSEMBLYAI_API_KEY` | Streaming STT (ADR-0004; `DEEPGRAM_API_KEY` stays swappable) |
| `ANTHROPIC_API_KEY` | Claim extraction (Haiku), judging/scoring/receipts (Opus) |
| `BRAVE_API_KEY` *or* `SEARXNG_URL` | Full web coverage for search (optional — see below) |
| `DATABASE_URL` | Neon Postgres persistence (ADR-0003) |
| `REDIS_URL` | Upstash Redis hot state / queues / pub-sub (ADR-0003) |

Step-by-step deployment (Render now, Cloud Run cutover later): [`docs/RUNBOOK.md`](docs/RUNBOOK.md).

## Search: our own retrieval layer

Fact-check evidence comes from a search service we own ([ADR-0006](docs/decisions/0006-own-search-retrieval-layer.md)), not a paid API:

```
claim → query planning → federated backends → reciprocal rank fusion
      → parallel fetch (deadline-bounded) → readability extraction
      → BM25 passage ranking with claim-aware boosts → top passages
```

It runs with **no API keys** (Wikipedia/Wikidata) and gets substantially better with one real web backend — [Brave Search](https://brave.com/search/api/) (free tier) or a self-hosted [SearXNG](https://docs.searxng.org/). Ranking favors primary sources, weighs recency only for time-sensitive claims, drops passages that mention none of the claim's entities or numbers, and always issues a contradiction-seeking query so we hunt counter-evidence rather than confirmation.

Measure quality and latency yourself, on any claim:

```bash
node scripts/searchBench.js "The Great Wall of China is visible from the Moon."
```

## Design contract

Built Cloud Run–first, runs anywhere (ADR-0002):

1. One `Dockerfile` at repo root — same image on every host
2. Listen on `$PORT` from env
3. Stateless containers — all state external; any instance can die anytime
4. WebSocket clients auto-reconnect and rehydrate from Redis (snapshot + seq replay)
5. Env-var-only configuration ([src/config.js](src/config.js) is the complete list)
6. Graceful shutdown: SIGTERM → flush to Redis/Postgres → close (~10s)

**Credibility rules** (non-negotiable, enforced in [`gateVerdict`](src/pipeline/verifier.js)): below-threshold verdicts display as ⏳ UNVERIFIED — never a guess; every TRUE/FALSE/MISLEADING verdict shows sources; FALSE requires the highest confidence bar (default 0.85); opinions and predictions are tracked and scored but never "fact-checked".

## Status

✅ V1 feature-complete in code (Phases 0–5 of the build plan): container + WS skeleton, meeting/STT provider layer, claim extraction + verification, presets + scoring + turn clock + launcher + chat commands, fallacy/dodge detection + receipts + stage mode + hardening, cost instrumentation + load test + CI/CD.

🔌 Going live requires vendor accounts/keys per the [runbook](docs/RUNBOOK.md) (Recall bot join, live STT, Neon/Upstash, Render/Cloud Run).
