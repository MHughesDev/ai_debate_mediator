# V1 Implementation Plan — AI Debate Mediator

> Working plan derived from `SPEC.md` (authoritative) covering every phase and task to V1.
> Execution status is tracked by checkboxes; each phase ends in a green test suite and a commit.
>
> **Status: all phases implemented (36 tests green).** Everything below is built and verified
> against mock vendors end-to-end; live-vendor runs need the keys in [`RUNBOOK.md`](RUNBOOK.md).
> What remains owner-gated is listed at the bottom.

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

## Phase 0 — Skeleton ✅

- [x] `package.json` (ESM), deps, npm scripts (`start`, `dev`, `test`)
- [x] `src/config.js` — every env var in one place with defaults; `src/logger.js`
- [x] Store layer: `src/state/store.js` (ioredis when `REDIS_URL` set) + `src/state/memoryStore.js` (kv, hashes, lists, sorted sets, pub/sub, expiry)
- [x] Postgres layer: `src/db/postgres.js` (+ no-op store when `DATABASE_URL` unset), `src/db/schema.sql` (SPEC §4.4 tables), auto-migrate on boot
- [x] Session manager: create/get/end sessions; hot state in Redis; snapshot for rehydration
- [x] Event bus: `publishEvent(sessionId, type, payload)` → seq number + Redis backlog (replay window) + pub/sub → WS broadcast
- [x] WS hub: `/ws?session=<id>&role=display|dashboard|stage`, heartbeat, `since` replay, hello/snapshot on connect
- [x] REST API: `GET /healthz`, `POST /api/sessions`, `GET /api/sessions/:id`, `GET /api/sessions/:id/snapshot`, `POST /api/sessions/:id/end`
- [x] Bot display page (`public/display/`): rotating single-focus states (idle/listening + turn clock, fact-check card, scoreboard flash, fallacy flag, pending indicator), huge fonts, WS client with auto-reconnect + rehydrate (shared `public/shared/ws-client.js`)
- [x] Mock event generator (`POST /api/sessions/:id/mock`): drives fake fact-check/scoreboard/turn events so the display works with no pipeline
- [x] Dockerfile (node:22-alpine, non-root, `$PORT`), `.dockerignore`
- [x] Graceful shutdown: SIGTERM → stop intake → flush to Redis → close WS/HTTP (~10s)
- [x] CI: `.github/workflows/deploy.yml` — test job; `deploy-render` via deploy hook (secret-gated); `deploy-cloudrun` job. `render.yaml` blueprint.
- [x] Tests: memory store, session API, event seq/replay, WS pub/sub, snapshot rehydrate
- **Milestone (dev-verified):** display page shows live fake cards from WS events; ready for a Recall Output Media URL once keys exist.

## Phase 1 — Ears ✅

- [x] `MeetingProvider` interface + factory (`MEETING_PROVIDER=recall|mock`)
- [x] Recall provider: create bot (Output Media → display URL), realtime audio websocket intake at `/ws/recall`, participant events, chat events, leave, send-chat
- [x] Mock provider: scripted debate playback (`scripts/fixtures/debate.json`) — fake participants join, timed utterances flow through the same code path as real audio
- [x] `SttProvider` interface + factory (`STT_PROVIDER=deepgram|assemblyai|mock`); Deepgram + AssemblyAI streaming WS clients (per-participant streams, interim/final transcripts); mock STT passes scripted text through with realistic timing
- [x] Speaker registry: platform participant id → speaker record (name, team from launcher config); persisted to Postgres
- [x] Transcript pipeline: finals → rolling Redis buffer (window + delta cursor for extractor) → `transcript` WS events → batched Postgres writes (utterances)
- [x] Dashboard page (`public/dashboard/`): live labeled transcript + session status + controls
- [x] Tests: provider mapping, speaker mapping, transcript buffering/delta, batched persistence, mock end-to-end (scripted audio → transcript events)
- **Milestone (dev-verified):** scripted call produces live speaker-labeled transcript in the dashboard; identical path awaits real Recall/Deepgram keys.

## Phase 2 — Brain ✅

- [x] Anthropic client wrapper: structured-output helper (json_schema), refusal handling, per-call token accounting hook; mock LLM (heuristic extraction/judging) when `ANTHROPIC_API_KEY` unset
- [x] Claim extractor loop: per-session tick on transcript delta → claims `{text, speaker, type, checkable, links}` → dedupe → argument graph
- [x] Argument graph: nodes=claims, edges=supports/rebuts; Redis hot copy, persisted to Postgres (`claims.graph_links`)
- [x] Verification queue (Redis list) + worker pool (`VERIFY_CONCURRENCY`): checkable factual claims → searches via `SearchProvider` (tavily | exa | mock corpus) → LLM judge → `{verdict, confidence, evidence_summary, sources[]}`
- [x] Credibility gating (SPEC §3.1, non-negotiable): below `verdict_min_confidence` → UNVERIFIED; FALSE requires `false_verdict_min_confidence` (default 0.85, per-preset); TRUE/FALSE/MISLEADING must carry ≥1 source or downgrade to UNVERIFIED; opinions/predictions never verified; timeout → UNVERIFIED
- [x] Display integration: `verification.pending` (🔍 checking N), `factcheck` card events with hold priority, "thoughts visible" transparency lines; persisted verdicts
- [x] Tests: extraction classification/dedupe, graph ops, every credibility rule, timeout path, mock end-to-end (scripted false claim → ❌ card with source)
- **Milestone (dev-verified):** scripted false claim produces a FALSE card with source in the display within budget, via mock vendors; same path awaits Anthropic/Tavily keys.

## Phase 3 — Referee ✅

- [x] Preset system: `src/presets/*.json` (oxford, lincoln_douglas, panel, casual, roast) per SPEC §3.5 schema; loader + validation + dial-override deep-merge; `/api/presets`
- [x] Score engine: per-speaker sub-scores (accuracy from verdicts, evidence quality, logic ±, responsiveness) weighted by rubric; periodic snapshots to Neon; visibility modes live|end|off; scoreboard WS events
- [x] Turn clock: structure from preset, server tick → `turnclock` events, overtime flags, auto-advance under enforce, pause/resume
- [x] Launcher (`public/launcher/`): meeting link → preset picker → dial overrides → speakers/teams/motion → wake ping (`/healthz`) → create session + send bot; works as a static deploy (`API_BASE`)
- [x] Chat commands: `/mode <preset>` (live switch), `/pause scoring`, `/resume`, `/check that`, `/turn`, `/end`; same registry backs the dashboard `/command` route
- [x] Tests: preset validation/merge, every sub-score + rubric weighting, visibility modes, turn clock transitions, chat commands, mock Oxford debate scored end-to-end
- **Milestone (dev-verified):** scripted Oxford-format debate runs end-to-end with live scoring, turn clock, and chat control.

## Phase 4 — Polish & Trust ✅

- [x] Fallacy detection: extractor-side pass, high-confidence only (`fallacy_min_confidence`), rare flag display state; always scored into logic even when flags are hidden by preset
- [x] Dodge detection: question tracking + unanswered-question timer with content-word answer matching → responsiveness penalty + optional flag
- [x] Receipts: end-of-session generator (final scores, most/least accurate, biggest unsupported claim, unanswered questions, verdict counts, cost estimate) → Neon + `GET /api/sessions/:id/receipts` + terminal display state
- [x] Stage mode (`public/stage/`): scoreboard rail w/ sub-scores, center SVG argument map (nodes=claims colored by verdict, edges=rebuts/supports), fact-check feed w/ sources, bottom ticker
- [x] Reconnect hardening: seq-gap detection → replay request → snapshot fallback; server heartbeat; display "reconnecting" affordance
- [x] Failure-mode UX: STT drop alert + stream rebuild, verification timeout → UNVERIFIED, broken LLM/search never kill transcripts; extractor/worker error isolation
- [x] Tests: fallacy/dodge gating, receipts content, replay/gap recovery, failure injection (broken LLM, broken search, judge failure)
- **Milestone (dev-verified):** full scripted debate incl. fallacy/dodge/receipts; browser-verified stage + display surfaces live.

## Phase 5 — Prod cutover ✅

- [x] Cost meter: per-session counters (bot seconds, STT seconds, LLM in/out tokens per model, search calls) → env-priced estimate; Redis live + Neon persist; `GET /api/sessions/:id/costs`; estimate shown in receipts
- [x] `deploy-cloudrun` GitHub Actions job (gcloud run deploy, secret-gated, manual dispatch, min-instances=1)
- [x] Load test: `scripts/loadtest.js` — N concurrent mock sessions, completion + p95 latency assertions
- [x] Full simulated E2E: `scripts/simulate.js` asserts transcript → claims → verdicts → scores → receipts → costs against a running server
- [x] Docs: README (run/dev/deploy), `docs/RUNBOOK.md` (keys, Render, first real call, Cloud Run migration day, operations)
- **Milestone:** repo is deploy-ready; adding the secrets + hosting accounts takes it live per the runbook.

---

## Verification record (mock vendors, this build)

- `npm test` — 36 tests green (store/events/API/WS + Phase 1–5 suites, incl. every credibility rule).
- `node scripts/simulate.js` against a running server: 16 labeled utterances → 13 claims → 9 fact-check cards (2 FALSE, all sourced) → 4 scoreboards → turn clock → fallacy flag → receipts → cost estimate. Exit 0.
- `node scripts/loadtest.js <host> 3` — concurrent debates complete within the 500 ms p95 event-latency budget.
- Browser-verified: display page state machine, stage argument map + feed + scoreboard mid-debate, receipts as the terminal display state.

## Still owner-gated (needs keys/accounts, not code)

| Phase | Gated item |
|---|---|
| 1 | Real Recall bot join; Deepgram vs AssemblyAI bake-off on real debate audio (settles ADR-0004) |
| 2 | Tavily vs Exa bake-off; live extraction/judging quality tuning |
| 4 | 3 real debates with outside users + verdict error review |
| 5 | Cloud Run project/secrets and the cutover run; public demo link |
| — | Product name (SPEC §8 open decision) |
