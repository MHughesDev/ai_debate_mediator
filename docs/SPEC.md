# AI Debate Mediator — Product Spec, Build Plan & Deployment Plan

**Version:** 0.1 (V1 planning)
**Status:** Draft for review
**Last updated:** August 2026

---

## 1. Vision

An AI debate mediator that joins any video call as a bot participant, listens to the conversation in real time, detects claims and argument structure, fact-checks verifiable claims against live web sources within seconds, scores debaters against configurable rubrics, and displays everything live through the bot's own camera tile — with zero installs for participants.

**V1 target:** live video calls (Zoom / Google Meet / Microsoft Teams).
**Later:** staged auditorium debates (same pipeline, mic feed input, screen-share/projector output), streaming events, everyday meeting fact-checking.

---

## 2. V1 Scope

### In scope
- Bot joins Zoom / Meet / Teams via meeting-bot API (Recall.ai)
- Streaming transcription with platform-provided speaker identity
- Real-time claim detection (factual / opinion / prediction) and argument graph (supports / rebuts links)
- Async web verification of factual claims with verdict + confidence + sources
- Rubric-based per-speaker scoring
- Debate format presets + configurable dials
- Live visual output via bot camera tile (Output Media) and a host dashboard
- One-page launcher website (paste meeting link → pick preset → send bot)
- In-call chat commands for live control
- Post-debate "receipts" summary

### Out of scope for V1
- Non-English debates
- Custom in-room hardware
- Native overlays inside Zoom/Meet/Teams UI (the bot tile IS the overlay)
- Accounts, billing, marketing site
- Community preset library (architecture supports it; not built)
- The bot speaking aloud (visual-only mediator in V1)

### V1 limits
- Max ~6 tracked speakers per session
- One debate format active per session
- English only

---

## 3. Functional Spec

### 3.1 Pipeline (core loop)

```
Meeting audio (per participant, via Recall.ai)
  → Streaming STT (Deepgram/AssemblyAI, ~300ms) with speaker labels
  → Rolling transcript buffer (Redis)
  → Claim Extractor (fast LLM every ~5s on transcript delta)
      output: {claim_text, speaker, type, links: supports/rebuts}
      → Argument Graph (session state)
  → Verification queue (checkable factual claims only)
      → Verification Worker: 1–3 fast web searches (Tavily/Exa)
        + LLM judge → {verdict, confidence, sources[]}
  → Score Engine (consumes graph + verdicts, applies rubric weights)
  → Render Service → WebSocket push → bot display page + host dashboard
```

**Latency budgets (targets):**
| Stage | Target |
|---|---|
| Utterance → transcript | < 1s |
| Transcript → claim detected | 3–7s |
| Claim → verification verdict | 8–20s |
| State change → display update | < 500ms |

**Credibility rules (non-negotiable):**
- Verdicts below confidence threshold display as ⏳ UNVERIFIED — never a guess
- Every TRUE/FALSE/MISLEADING verdict displays its sources
- FALSE verdicts require the highest confidence threshold (a wrong FALSE on screen is the worst failure mode)

### 3.2 Claim taxonomy
- **Verifiable factual** → queued for verification
- **Opinion / value claim** → tracked in graph, scored for support quality, never "fact-checked"
- **Prediction** → tracked, labeled, not verified
- **Question** → tracked for dodge detection (unanswered-question timer)

### 3.3 Verdicts
`TRUE | FALSE | MISLEADING | UNVERIFIABLE | UNVERIFIED (pending/low confidence)`
Each with: confidence score, 1-line evidence summary, source list (name + URL).

### 3.4 Scoring
Per-speaker sub-scores, weighted by active format rubric:
- **Accuracy** (from verification verdicts)
- **Evidence quality** (claims backed by sources/data vs. bare assertion)
- **Logic** (fallacy detections subtract; valid inference chains add)
- **Responsiveness** (addresses opponent's points; dodge detection subtracts)

Scoring visibility modes: live | revealed at end | off.

### 3.5 Debate format presets

| Preset | Structure | Scoring | Fact-check | Mediator |
|---|---|---|---|---|
| Oxford | Teams, motion, opening/rebuttal/closing, turn clocks | Formal, live | Major claims | Enforces turns |
| Lincoln-Douglas | 1v1, strict alternating clocks | Logic/responsiveness weighted | Major claims | Strict |
| Panel | Multi-speaker, loose turns | OFF | On | Silent flagger |
| Casual / Meeting | No structure | OFF | On + dodge detection | Silent |
| Debate Night / Roast | Loose rounds | Live leaderboard | Aggressive | Witty personality |

Every preset = a JSON config object:
```json
{
  "format_id": "oxford",
  "turns": { "structure": [...], "seconds_per_turn": 180, "enforce": true },
  "rubric": { "accuracy": 0.3, "evidence": 0.3, "logic": 0.2, "responsiveness": 0.2 },
  "scoring_visibility": "live",
  "factcheck": { "mode": "major_claims", "false_verdict_min_confidence": 0.85 },
  "mediator": { "strictness": "enforce", "fallacy_flags": true, "dodge_detection": true },
  "personality": "neutral",
  "display": { "rotation": ["factcheck", "scoreboard", "turnclock"], "receipts": true }
}
```
Custom presets, sharing, and a future community library fall out of this for free.

### 3.6 Settings surfaces
- **Pre-call (launcher page):** meeting link, preset picker, dial overrides, speaker/team names, motion text → "Send bot"
- **In-call (meeting chat commands):** `/mode <preset>`, `/pause scoring`, `/resume`, `/check that`, `/end` (host kill switch)

### 3.7 Visual output

**Bot camera tile (gallery view — one thing at a time, huge fonts, rotating states):**
1. Idle/listening: brand + pulse + current speaker + turn clock
2. Fact-check card (hero): "claim" → verdict badge → 1-line evidence → source. Holds ~15s
3. Scoreboard flash: names + bars (between turns, not constant)
4. Fallacy/mediator flag (rare, high-confidence only)
5. Turn management: "Rebuttal: 60s remaining"
6. "🔍 checking N claims…" pending indicator (buys latency forgiveness)

**Screen-share / stage mode (auditorium, dense layout):**
- Left: live scoreboard with sub-scores
- Center: argument map (claims as nodes, rebuttals as edges, color = verification status) — the visual signature
- Right: fact-check feed with sources
- Bottom ticker: speaker, turn clock, pending-claims count
- Optional QR code → audience dashboard on phones

**Post-debate:** receipts card — final scores, most/least accurate speaker, biggest unsupported claim, unanswered questions.

**Tone decision:** AI "thoughts" visible (e.g., "searching… comparing 3 sources") — transparency earns trust in verdicts.

---

## 4. Architecture

### 4.1 Components

| Component | Responsibility | Tech |
|---|---|---|
| Launcher (static site) | Config → spawn bot | Static HTML/JS or Next.js static export |
| Backend service (single container) | REST API, WebSocket hub, claim extractor, verification workers, score engine, session orchestration | Node.js (Express/Fastify + ws), Docker |
| Bot display page | Rendered by Recall.ai as bot camera; WS client; auto-reconnect + rehydrate | Served by backend (React or vanilla) |
| Host dashboard | Display page + live controls | Same components, different layout |
| Session state / queue / pub-sub | Live state, event bus, transcript buffer | Upstash Redis (free, external) |
| Persistent store | Sessions, configs, transcripts, claims, verdicts, receipts | Neon Postgres (free, external) |

### 4.2 External services

| Service | Role | Notes |
|---|---|---|
| Recall.ai | Bot join, per-participant audio, speaker identity, Output Media (webpage → bot camera/screenshare), meeting chat read | Confirmed: Output Media renders any webpage as the bot's video, ultra-low latency; meeting audio pipes into the page's mic input |
| Deepgram or AssemblyAI | Streaming STT | ~300ms latency; diarization backup if platform identity unavailable |
| Anthropic API | Claim extraction (Haiku-class, every ~5s), verification judging, fallacy detection, receipts | Structured JSON outputs |
| Tavily / Exa | Fast web search for verification | 1–3 searches per claim |

### 4.3 Design contract (Cloud Run–first, runs anywhere)
1. **Dockerfile at repo root** — same image on Render and Cloud Run
2. **Listen on `$PORT`** from env
3. **Fully stateless containers** — all state in Redis/Postgres; any instance can die anytime
4. **WS resilience** — clients auto-reconnect and rehydrate from Redis (Cloud Run caps WS at 60 min; Render restarts on deploy)
5. **Env-var-only config** — no config files, no platform code paths
6. **Graceful shutdown** — SIGTERM → flush in-flight events to Redis → close (~10s window)

### 4.4 Data model (core tables, Neon)
- `sessions` (id, meeting_url, config JSON, status, timestamps)
- `speakers` (session_id, platform_participant_id, display_name, team)
- `utterances` (session_id, speaker_id, text, ts) — batched writes
- `claims` (session_id, speaker_id, text, type, graph_links JSON)
- `verdicts` (claim_id, verdict, confidence, evidence_summary, sources JSON)
- `scores` (session_id, speaker_id, sub_scores JSON, ts) — periodic snapshots
- `receipts` (session_id, summary JSON)

Live/hot state (Redis): rolling transcript window, argument graph, current scores, turn clock, verification queue, pub/sub channels per session.

---

## 5. Build Plan

### Phase 0 — Skeleton (Week 1)
- Repo + Dockerfile + CI (GitHub Actions: deploy-render on push, deploy-cloudrun job stubbed)
- Backend: health endpoint, WS hub, Redis pub/sub, session create API
- Bot display page rendering **fake** rotating cards from WS events
- **Milestone: bot joins a real call and shows live fake data in its tile**

### Phase 1 — Ears (Week 2)
- Recall.ai integration: spawn bot from launcher, receive per-participant audio
- Streaming STT wired in; live transcript in Redis + dashboard
- Speaker identity mapping
- **Milestone: live speaker-labeled transcript visible in dashboard during a call**

### Phase 2 — Brain (Weeks 3–4)
- Claim extractor loop (delta-based, structured output)
- Argument graph in Redis; persisted to Neon
- Verification workers: search + judge + confidence gating
- Fact-check cards live in bot tile with sources
- **Milestone: say a false claim in a call → ❌ FALSE card with source within ~20s**

### Phase 3 — Referee (Weeks 5–6)
- Score engine + rubric weights; scoreboard states
- Preset system (JSON configs) + launcher preset picker + dial overrides
- Turn clock + basic turn enforcement display
- In-call chat commands
- **Milestone: full Oxford-format mock debate scored end-to-end**

### Phase 4 — Polish & Trust (Weeks 7–8)
- Fallacy + dodge detection (high-confidence only)
- Receipts summary
- Screen-share/stage layout + argument map visualization
- Reconnect/rehydrate hardening; failure-mode UX (STT drop, verification timeout)
- **Milestone: run 3 real debates with outside users; verdict error review**

### Phase 5 — Prod cutover (Week 9+)
- Cloud Run deploy (see §6), load test 3 concurrent sessions
- Cost instrumentation per session (Recall + STT + LLM + search)
- Public demo link

**Deliberately deferred:** accounts/billing, multi-language, bot voice, community presets, native platform overlays, in-room hardware kit.

---

## 6. Deployment Plan

### 6.1 Environments

| Env | Host | Purpose |
|---|---|---|
| Dev/demo (now) | Render free tier | Iteration + demos, $0 |
| Prod (end state) | Google Cloud Run | Launch + scale |
| Data (all envs) | Neon Postgres + Upstash Redis | Portable across hosts; survives all deploys/restarts |

### 6.2 Render (temporary) — free-tier survival rules
- **One** web service only (750 free hrs/mo ≈ one always-on service); launcher on Render static hosting (free, no instance hours)
- No local disk, no in-memory-only state (ephemeral FS; resets on every deploy/restart) → everything in Neon/Upstash
- Do **not** use Render free Postgres (30-day expiry → deletion) or Render free Key Value (in-memory, lost on restart)
- Cold-start handling: launcher visit wakes backend before "Send bot"; optional free cron ping every 10 min during active periods
- Display page auto-reconnects → mid-call restart = ~2s scoreboard blip, not a dead demo

### 6.3 Cloud Run (end state)
- Deploy same Docker image via GitHub Actions (`gcloud run deploy`)
- **min-instances = 1** at launch (~$5–10/mo) so bots never join a cold server; alternatively min 0 + ping-then-send flow
- Concurrency: start at 80/instance; session affinity not required (state in Redis)
- WS 60-min cap handled by client reconnect (already built per design contract)
- Secrets in Secret Manager; env parity with Render via same env-var names
- Region: us-east1 or us-west1, matched to Recall.ai region for audio-loop latency

### 6.4 Migration day checklist (Render → Cloud Run)
1. Create GCP project, enable Cloud Run + Secret Manager
2. Add secrets (Recall, STT, Anthropic, Tavily, Neon URL, Upstash URL)
3. Run `deploy-cloudrun` GitHub Action
4. Point launcher's API base URL at Cloud Run URL
5. Update Recall bot display-page URL to Cloud Run domain
6. Run one full test debate; then retire Render service
*(Estimated effort: ~30 minutes — data layer never moves.)*

### 6.5 Cost model (per 1-hour debate, rough)
| Item | Est. |
|---|---|
| Recall.ai bot-hour | ~$0.7–1.0 |
| Streaming STT (6 speakers, 1 hr) | ~$1.5–3 |
| LLM calls (extraction every 5s + ~40 verifications + scoring) | ~$0.5–2 |
| Search API (~40 claims × 2 searches) | ~$0.5–1 |
| Hosting | ~$0 (amortized) |
| **Total per debate** | **~$3–7** |

Hosting is the cheapest line; per-session API costs dominate → instrument early (Phase 5).

---

## 7. Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Wrong FALSE verdict on screen | Trust-destroying | High confidence threshold for FALSE; always show sources; UNVERIFIED default; "thoughts visible" transparency |
| Verification too slow to feel live | Product feels laggy | Async cards + pending indicator; fast search APIs; cap searches per claim |
| Speaker misattribution | Wrong person blamed for claim | Prefer platform identity over diarization; show claim quote with verdict |
| Free-tier restarts mid-call | Dead demo | Stateless + reconnect/rehydrate (built in Phase 0/4) |
| Recall.ai vendor lock-in | Platform risk | Isolate behind a `MeetingProvider` interface; Meeting BaaS as fallback |
| Per-session cost creep | Unit economics | Cost instrumentation per session; claim-check mode dials (major-claims-only default) |
| Platform ToS (bots in meetings) | Access risk | Bot clearly named/labeled; host explicitly admits it; recording consent notice |

---

## 8. Open Decisions
- [ ] Personality default: neutral referee vs. light personality (leaning neutral for V1, roast mode as preset)
- [ ] STT vendor bake-off: Deepgram vs. AssemblyAI (latency + diarization quality test in Phase 1)
- [ ] Search vendor bake-off: Tavily vs. Exa vs. Perplexity Sonar (Phase 2)
- [ ] Argument map: build in Phase 4 vs. defer to V1.1 if timeline slips
- [ ] Name the product 🙂
