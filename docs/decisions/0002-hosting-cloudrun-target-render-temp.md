# Target Google Cloud Run for production, use Render free tier temporarily

## Status
Accepted

## Context and Problem Statement
Hosting must be $0 during development, but the 2026 free-tier landscape is thin (Fly.io/Heroku free tiers gone, Railway trial-credit only, Koyeb closed to new users). Render free tier works but has hard limits (spin-down, 750 hrs/mo, ephemeral FS).

## Decision Drivers
- $0 during dev/demo
- Production-grade path without re-architecture
- WebSocket support, container-based deploys

## Considered Options
- Render (free → paid)
- Google Cloud Run
- Oracle Always Free VPS + Coolify

## Decision Outcome
Chosen option: **Cloud Run as end state, Render free as temporary host**, because building to Cloud Run's constraints (containers, $PORT, statelessness, 60-min WS cap, SIGTERM handling) yields a codebase that runs on both — migration is ~30 minutes.

### Consequences
- Good: free now, managed autoscaling later; strict statelessness makes Render's restarts harmless too
- Bad: WS reconnect/rehydrate logic required from day one; min-instances=1 (~$5–10/mo) needed at Cloud Run launch to avoid cold-start bot joins
