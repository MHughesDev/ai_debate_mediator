# Plain ESM Node with no build step; in-memory fallbacks for Redis/Postgres in dev

## Status
Accepted

## Context and Problem Statement
Phase 0 requires choosing the backend implementation stack within the ADR-0001..0004 constraints (Node.js single container). Two open questions: TypeScript vs plain JavaScript, and how to develop/test locally without provisioning Neon/Upstash accounts first.

## Decision Drivers
- Single Dockerfile, fast cold starts on Render free tier / Cloud Run
- Full pipeline must be testable locally and in CI with zero external services or API keys
- Env-var-only config (design contract) — no "dev mode" config files

## Considered Options
- TypeScript with a build step vs modern ESM JavaScript
- Require real Redis/Postgres locally vs in-memory fallback implementations vs embedding redis/postgres binaries

## Decision Outcome
1. **Modern ESM JavaScript, no build step.** The container runs source directly (`node src/index.js`); smaller image, no compile stage, no toolchain drift. Tests use built-in `node:test`.
2. **In-memory fallbacks behind the same interfaces.** `src/state/redis.js` returns an ioredis client when `REDIS_URL` is set, otherwise an in-memory implementation of the used command subset (including pub/sub and expiry). `src/db/postgres.js` likewise no-ops persistence when `DATABASE_URL` is unset. Selection is purely by env var presence — consistent with the env-var-only contract. Production always sets both URLs; the fallback is a dev/test affordance, not a storage option.
3. Every vendor (meeting, STT, search, LLM) has a mock provider selected by env var, so the entire pipeline runs end-to-end offline.

### Consequences
- Good: `npm test` and a full simulated debate work on a fresh clone with no accounts; CI needs no services; the same code paths run in prod with real URLs.
- Bad: no static types (mitigated with JSDoc on interfaces); the memory Redis must faithfully mirror the command subset used (covered by shared tests); risk of accidentally running "prod" without persistence is mitigated by a boot warning when URLs are unset.
