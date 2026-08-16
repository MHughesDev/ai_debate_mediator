# AI Debate Mediator

An AI mediator that joins any video call (Zoom / Meet / Teams) as a bot participant, listens in real time, detects claims and argument structure, fact-checks verifiable claims against live web sources, scores debaters against configurable format rubrics, and displays everything live through the bot's own camera tile — zero installs for participants.

## How it works

```
Meeting audio (per participant, via Recall.ai bot)
  → Streaming STT with speaker labels
  → Claim extraction (fast LLM on transcript deltas) → argument graph
  → Async verification workers (web search + LLM judge) → verdicts + sources
  → Score engine (format rubric weights)
  → WebSocket → bot display page (rendered as the bot's camera) + host dashboard
```

Full product spec, architecture, build plan, and deployment plan: [`docs/SPEC.md`](docs/SPEC.md)

Architecture decisions are recorded as ADRs in [`docs/decisions/`](docs/decisions/).

## Stack

- **Meeting bot & in-call display:** Recall.ai (audio in, Output Media webpage-as-camera out)
- **Transcription:** Deepgram or AssemblyAI streaming (bake-off pending — ADR-0004)
- **AI:** Anthropic API (claim extraction, verification judging, scoring)
- **Search:** Tavily / Exa (bake-off pending)
- **Backend:** Node.js, single Docker container, fully stateless
- **State:** Neon Postgres (persistent) + Upstash Redis (live session state, queues, pub/sub)
- **Hosting:** Render free tier (dev/demo) → Google Cloud Run (production)

## Design contract

Built Cloud Run–first, runs anywhere:

1. One `Dockerfile` at repo root — same image on every host
2. Listen on `$PORT` from env
3. Stateless containers — all state external; any instance can die anytime
4. WebSocket clients auto-reconnect and rehydrate from Redis
5. Env-var-only configuration
6. Graceful shutdown: SIGTERM → flush to Redis → close

## Status

📋 Planning complete — build Phase 0 (skeleton: container + WS hub + display page with mock data) is next. See the build plan in [`docs/SPEC.md`](docs/SPEC.md#5-build-plan).
