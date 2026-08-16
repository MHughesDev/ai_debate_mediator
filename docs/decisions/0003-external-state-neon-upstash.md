# Keep all state in external free-tier services (Neon Postgres + Upstash Redis)

## Status
Accepted

## Context and Problem Statement
Render free tier has an ephemeral filesystem; deploys and restarts wipe local data. Render's free Postgres expires after 30 days (then deleted) and free Key Value is memory-only.

## Decision Drivers
- Data must survive every deploy, restart, and host migration
- $0 budget
- Portability across Render → Cloud Run

## Considered Options
- Render managed Postgres/Key Value
- Neon (Postgres) + Upstash (Redis)
- Supabase (Postgres) + Upstash

## Decision Outcome
Chosen option: **Neon + Upstash**, because both have genuinely persistent free tiers and are host-agnostic — the data layer never moves during the Cloud Run migration.

### Consequences
- Good: stateless app containers by construction; free; portable
- Bad: three vendors instead of one; small network latency to external stores (acceptable — hot state batched in Redis)
