# Runbook — going live and operating

## 1. Provision the data layer (once, ~10 min)

1. **Neon** (neon.tech): create a free project → copy the connection string → `DATABASE_URL`.
   Schema migrates automatically on boot ([src/db/schema.sql](../src/db/schema.sql)).
2. **Upstash** (upstash.com): create a free Redis database → copy the `rediss://` URL → `REDIS_URL`.
3. Never use Render's free Postgres or Key Value (ADR-0003: 30-day expiry / memory-only).

## 2. Vendor keys

| Key | Where | Notes |
|---|---|---|
| `RECALL_API_KEY` | recall.ai dashboard | Pick region (`RECALL_REGION`, default us-west-2) close to your users; billing per bot-hour |
| `DEEPGRAM_API_KEY` / `ASSEMBLYAI_API_KEY` | deepgram.com / assemblyai.com | Phase 1 bake-off: run one real debate on each (`STT_PROVIDER=deepgram|assemblyai`), compare latency + crosstalk accuracy, keep the winner |
| `ANTHROPIC_API_KEY` | console.anthropic.com | Models overridable: `EXTRACTOR_MODEL` (default claude-haiku-4-5), `JUDGE_MODEL`/`SCORER_MODEL`/`RECEIPTS_MODEL` (default claude-opus-5) |
| `TAVILY_API_KEY` / `EXA_API_KEY` | tavily.com / exa.ai | Phase 2 bake-off, same pattern (`SEARCH_PROVIDER`) |

Provider selection is automatic from key presence; override with `MEETING_PROVIDER` / `STT_PROVIDER` / `SEARCH_PROVIDER` / `LLM_PROVIDER` (`mock` forces offline mode).

## 3. Deploy to Render (dev/demo host)

1. Push this repo to GitHub; in Render: **New → Blueprint** → select the repo ([render.yaml](../render.yaml)) — or create a single Docker web service manually (free plan).
2. Set env vars: `DATABASE_URL`, `REDIS_URL`, all vendor keys, and `PUBLIC_BASE_URL=https://<service>.onrender.com` (Recall needs it for the display page + realtime intake URLs).
3. Copy the service's **Deploy Hook URL** → GitHub repo secret `RENDER_DEPLOY_HOOK` → pushes to `main` now auto-deploy via CI.
4. Optional: deploy `public/launcher/` as a Render **static site** (free, no instance hours); set `window.API_BASE` to the backend URL in a small inline script before `launcher.js`.
5. Free-tier reality (SPEC §6.2): one web service only; 15-min idle spin-down with 30–60 s cold start — the launcher pings `/healthz` before "Send bot", and you can add a free cron ping during events. Mid-call restarts are a ~2 s blip (clients rehydrate from Redis).

## 4. First real call (smoke test)

1. Open the launcher, paste a real Zoom/Meet/Teams link (you as host), preset **Casual**, Send bot.
2. Admit the bot when it knocks. Its camera tile should show the display page within seconds.
3. Say a checkable false claim ("the Great Wall is visible from the Moon"). Expect ❌ FALSE with a source in ~8–20 s.
4. Try `/check that`, `/mode oxford`, `/end` in the meeting chat.
5. Watch `/dashboard/?session=<id>` and `/api/sessions/<id>/costs` during the call.
6. If audio never arrives: check Recall dashboard for the bot's realtime-endpoint delivery status; the intake URL is `wss://<PUBLIC_BASE_URL>/ws/recall?session=<id>`. The realtime message shapes are mapped in one place: [src/providers/meeting/recall.js](../src/providers/meeting/recall.js) (`parseRecallRealtimeMessage`).

## 5. Cloud Run cutover (~30 min, SPEC §6.4)

1. Create a GCP project; enable Cloud Run, Secret Manager, Artifact Registry.
2. Create secrets named `RECALL_API_KEY`, `DEEPGRAM_API_KEY`, `ANTHROPIC_API_KEY`, `TAVILY_API_KEY`, `DATABASE_URL`, `REDIS_URL`.
3. Set repo secrets `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_SERVICE_ACCOUNT`, `GCP_PROJECT_ID` (and optional `GCP_REGION`, default us-west1 — match Recall region).
4. Run the **deploy-cloudrun** job (Actions → CI & Deploy → Run workflow). It deploys with `min-instances=1` (no cold-start bot joins) and concurrency 80.
5. Set `PUBLIC_BASE_URL` env on the Cloud Run service to its URL; point the static launcher's `API_BASE` at it.
6. Run one full test debate; then retire the Render service. The data layer never moves.

## 6. Operations

- **Costs**: `GET /api/sessions/:id/costs` live during a call; final estimate lands in receipts and the `session_costs` table. Rates are env-tunable (`COST_*` in [src/config.js](../src/config.js)). Expected ~$3–7 per 1-hr debate.
- **Dials via env**: extraction cadence (`EXTRACT_INTERVAL_MS`), verification concurrency/timeout, confidence bars (`FALSE_VERDICT_MIN_CONFIDENCE` etc.), dodge timer (`DODGE_TIMEOUT_MS`).
- **Load test**: `node scripts/loadtest.js https://<host> 3` (3 concurrent debates, p95 event latency must stay under the 500 ms display budget).
- **Outside-user debates (Phase 4 milestone)**: run 3 real debates, then review every FALSE/MISLEADING verdict against its sources (`claims` + `verdicts` tables) — tighten `FALSE_VERDICT_MIN_CONFIDENCE` upward if any wrong FALSE appeared.
- **Consent**: the bot is clearly named "AI Debate Mediator"; have the host announce it and get participant consent where required (SPEC §7 platform-ToS risk).
