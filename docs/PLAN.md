# V1 Implementation Plan — AI Debate Mediator

> Working plan derived from `SPEC.md` (authoritative) covering every phase and task to V1.
> Execution status is tracked by checkboxes; each phase ends in a green test suite and a commit.

## Ground rules (from SPEC §4.3 + ADRs)

- Single Dockerfile at repo root; listen on `$PORT`; env-var-only config; stateless containers.
- All state external: Redis (hot state, queues, pub/sub) + Postgres (durable). When `REDIS_URL` / `DATABASE_URL` are unset (local dev/tests), in-memory fallbacks with identical interfaces are used — the app code never knows the difference (recorded as ADR-0005).
- Every external vendor sits behind an interface with a real implementation *and* a mock:
  `MeetingProvider` (recall | mock), `SttProvider` (deepgram | assemblyai | mock), `SearchProvider` (tavily | exa | mock), `LlmProvider` (anthropic | mock).
  The mock chain lets the entire pipeline run end-to-end locally with zero API keys — that is how each milestone is verified in development; live-vendor smoke tests happen when keys are added.
- Credibility rules (SPEC §3.1) are enforced in code and covered by tests.
- WS clients auto-reconnect and rehydrate; events carry per-session sequence numbers with a Redis backlog for replay.

## Stack decisions

- Node 22+ (container: `node:22-alpine`), modern ESM JavaScript, no build step (ADR-0005).
- Express + `ws`; vanilla JS display/dashboard/stage pages served by the backend; static launcher.
- `ioredis` (Upstash), `pg` (Neon), `@anthropic-ai/sdk`.
- Models (env-overridable): `EXTRACTOR_MODEL=claude-haiku-4-5` (fast loop, per SPEC "Haiku-class"), `JUDGE_MODEL` / `SCORER_MODEL` / `RECEIPTS_MODEL=claude-opus-5`. Structured JSON via `output_config.format` (json_schema); `stop_reason: "refusal"` handled → claim treated as UNVERIFIED.
- Tests: `node:test` (no test-framework dependency). CI: GitHub Actions.

---

## Phase 0 — Skeleton

- [ ] `package.json` (ESM), deps, npm scripts (`start`, `dev`, `test`)
- [ ] `src/config.js` — every env var in one place with defaults; `src/logger.js`
- [ ] Redis layer: `src/state/redis.js` (ioredis when `REDIS_URL` set) + `src/state/memoryRedis.js` (subset: kv, hashes, lists, sorted sets, pub/sub, expiry)
- [ ] Postgres layer: `src/db/postgres.js` (+ no-op store when `DATABASE_URL` unset), `src/db/schema.sql` (SPEC §4.4 tables), auto-migrate on boot
- [ ] Session manager: create/get/end sessions; hot state in Redis; snapshot for rehydration
- [ ] Event bus: `publish(sessionId, event)` → seq number + Redis backlog (replay window) + pub/sub → WS broadcast
- [ ] WS hub: `/ws?session=<id>&role=display|dashboard|stage`, heartbeat, `since` replay, hello/snapshot on connect
- [ ] REST API: `GET /healthz`, `POST /api/sessions`, `GET /api/sessions/:id`, `GET /api/sessions/:id/snapshot`, `POST /api/sessions/:id/end`
- [ ] Bot display page (`public/display/`): rotating single-focus states (idle/listening + turn clock, fact-check card, scoreboard flash, fallacy flag, pending indicator), huge fonts, WS client with auto-reconnect + rehydrate (shared `public/shared/ws-client.js`)
- [ ] Mock event generator (`MOCK_EVENTS=true` or `POST /api/sessions/:id/mock`): drives fake fact-check/scoreboard/turn events so the display works with no pipeline
- [ ] Dockerfile (node:22-alpine, non-root, `$PORT`), `.dockerignore`
- [ ] Graceful shutdown: SIGTERM → stop intake → flush to Redis → close WS/HTTP (~10s)
- [ ] CI: `.github/workflows/deploy.yml` — test job; `deploy-render` via deploy hook (secret-gated); `deploy-cloudrun` job stubbed. `render.yaml` blueprint.
- [ ] Tests: config, memory Redis, session API, event seq/replay, WS pub/sub, snapshot rehydrate
- **Milestone (dev-verified):** display page shows live fake cards from WS events; ready for a Recall Output Media URL once keys exist.

## Phase 1 — Ears

- [ ] `MeetingProvider` interface + factory (`MEETING_PROVIDER=recall|mock`)
- [ ] Recall provider: create bot (Output Media → display URL), real-time audio websocket intake, participant events, chat events, leave; webhook endpoint for status changes
- [ ] Mock provider: scripted debate playback (`scripts/fixtures/debate.json`) — fake participants join, timed utterances flow through the same code path as real audio
- [ ] `SttProvider` interface + factory (`STT_PROVIDER=deepgram|assemblyai|mock`); Deepgram + AssemblyAI streaming WS clients (per-participant streams, interim/final transcripts); mock STT passes scripted text through with realistic timing
- [ ] Speaker registry: platform participant id → speaker record (name, team from launcher config); persisted to Postgres
- [ ] Transcript pipeline: finals → rolling Redis buffer (window + delta cursor for extractor) → `transcript` WS events → batched Postgres writes (utterances)
- [ ] Dashboard page (`public/dashboard/`): live labeled transcript + session status + controls scaffold
- [ ] Tests: provider factories, speaker mapping, transcript buffering/delta, batched persistence, mock end-to-end (scripted audio → transcript events)
- **Milestone (dev-verified):** scripted call produces live speaker-labeled transcript in the dashboard; identical path awaits real Recall/Deepgram keys.

## Phase 2 — Brain

- [ ] Anthropic client wrapper: structured-output helper (json_schema), retries, refusal handling, per-call token accounting hook; mock LLM (heuristic extraction/judging) when `ANTHROPIC_API_KEY` unset
- [ ] Claim extractor loop: per-session ~5s tick on transcript delta → claims `{text, speaker, type: factual|opinion|prediction|question, checkable, links}` → dedupe → argument graph
- [ ] Argument graph: nodes=claims, edges=supports/rebuts; Redis hot copy, persisted to Postgres (`claims.graph_links`)
- [ ] Verification queue (Redis list) + worker pool (`VERIFY_CONCURRENCY`): checkable factual claims → 1–3 searches via `SearchProvider` (tavily | exa | mock corpus) → LLM judge → `{verdict, confidence, evidence_summary, sources[]}`
- [ ] Credibility gating (SPEC §3.1, non-negotiable): below `verdict_min_confidence` → UNVERIFIED; FALSE requires `false_verdict_min_confidence` (default 0.85, per-preset); TRUE/FALSE/MISLEADING must carry ≥1 source or downgrade to UNVERIFIED; opinions/predictions never verified; timeout → UNVERIFIED
- [ ] Display integration: `verification.pending` (🔍 checking N), `factcheck` card events with hold priority; persisted verdicts (Neon)
- [ ] Tests: extraction schema/dedupe, graph ops, queue lifecycle, judge gating rules (each credibility rule), timeout path, mock end-to-end (scripted false claim → ❌ card with source)
- **Milestone (dev-verified):** scripted false claim produces a FALSE card with source in the display within budget, via mock vendors; same path awaits Anthropic/Tavily keys.

## Phase 3 — Referee

- [ ] Preset system: `src/presets/*.json` (oxford, lincoln_douglas, panel, casual, roast) per SPEC §3.5 schema; loader + validation + dial-override merge; `/api/presets`
- [ ] Score engine: per-speaker sub-scores (accuracy from verdicts, evidence quality, logic ±, responsiveness) weighted by rubric; periodic snapshots to Neon; visibility modes live|end|off; scoreboard WS events
- [ ] Turn clock: structure from preset, server tick → `turnclock` events, enforcement states ("Rebuttal: 60s remaining", overtime flags), pause/resume
- [ ] Launcher (`public/launcher/` + served copy): meeting link → preset picker → dial overrides → speakers/teams/motion → wake ping (`/healthz`) → `POST /api/sessions` + send bot; works as static deploy (configurable API base)
- [ ] Chat commands via meeting provider chat events: `/mode <preset>`, `/pause scoring`, `/resume`, `/check that`, `/end` (host kill switch)
- [ ] Tests: preset validation/merge, every sub-score + rubric weighting, visibility modes, turn clock transitions, each chat command, mock Oxford debate scored end-to-end
- **Milestone (dev-verified):** scripted Oxford-format debate runs end-to-end with live scoring, turn clock, and chat control.

## Phase 4 — Polish & Trust

- [ ] Fallacy detection: extractor-adjacent LLM pass, high-confidence only (`fallacy_min_confidence`), rare flag display state; scored into logic
- [ ] Dodge detection: question tracking + unanswered-question timer → responsiveness penalty + optional flag (per preset)
- [ ] Receipts: end-of-session generator (final scores, most/least accurate, biggest unsupported claim, unanswered questions) → Neon + `GET /api/sessions/:id/receipts` + display state + dashboard view
- [ ] Stage mode (`public/stage/`): scoreboard rail w/ sub-scores, center argument map (SVG; nodes=claims colored by verdict, edges=rebuttals), fact-check feed w/ sources, bottom ticker, optional audience QR
- [ ] Reconnect hardening: seq-gap detection → replay request → snapshot fallback; server heartbeat/liveness; display "reconnecting" affordance ≤2s blip
- [ ] Failure-mode UX: STT drop banner, verification timeout → UNVERIFIED, provider-down states; extractor/worker error isolation (one bad tick never kills the session)
- [ ] Tests: fallacy gating, dodge timers, receipts content, replay/gap recovery, failure injection
- **Milestone (dev-verified):** full scripted debate incl. fallacy/dodge/receipts; kill-and-restart mid-debate recovers within one heartbeat. (Real outside-user debates require live keys — runbook provided.)

## Phase 5 — Prod cutover

- [ ] Cost meter: per-session counters (bot minutes, STT seconds, LLM in/out tokens per model, search calls) → cost estimate via env-priced rates; Redis live + Neon persist; `GET /api/sessions/:id/costs`; shown in receipts
- [ ] `deploy-cloudrun` GitHub Actions job made real (`gcloud run deploy`, secret-gated, manual dispatch), per SPEC §6.3/§6.4
- [ ] Load test: `scripts/loadtest.js` — 3 concurrent mock sessions, latency/WS assertions
- [ ] Full simulated E2E: `scripts/simulate.js` runs a complete debate against a running server and asserts transcript→claims→verdicts→scores→receipts
- [ ] Docs: README update (run/dev/deploy), `docs/RUNBOOK.md` (go-live checklist: keys, Render, Recall bot URL, Cloud Run migration day)
- [ ] Final: full test suite green, commit, push to GitHub
- **Milestone:** repo is deploy-ready; adding the 7 secrets + hosting accounts takes it live per the runbook.

## Out of scope for this build (needs owner/live accounts)

Creating Neon/Upstash/Render/GCP accounts, purchasing Recall/Deepgram/Tavily keys, joining real Zoom/Meet/Teams calls, and the outside-user debate sessions (Phase 4 milestone) — the runbook covers each.
