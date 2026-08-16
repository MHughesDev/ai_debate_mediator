-- Core durable tables (SPEC §4.4), Neon Postgres. Idempotent.
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  meeting_url TEXT NOT NULL,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'created',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS speakers (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  platform_participant_id TEXT,
  display_name TEXT NOT NULL,
  team TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS speakers_session_idx ON speakers(session_id);

CREATE TABLE IF NOT EXISTS utterances (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  speaker_id TEXT,
  text TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS utterances_session_idx ON utterances(session_id, ts);

CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  speaker_id TEXT,
  text TEXT NOT NULL,
  type TEXT NOT NULL,
  checkable BOOLEAN NOT NULL DEFAULT false,
  graph_links JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS claims_session_idx ON claims(session_id);

CREATE TABLE IF NOT EXISTS verdicts (
  id BIGSERIAL PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  verdict TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0,
  evidence_summary TEXT,
  sources JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS verdicts_claim_idx ON verdicts(claim_id);

CREATE TABLE IF NOT EXISTS scores (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  speaker_id TEXT NOT NULL,
  sub_scores JSONB NOT NULL DEFAULT '{}'::jsonb,
  total REAL NOT NULL DEFAULT 0,
  ts TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS scores_session_idx ON scores(session_id, ts);

CREATE TABLE IF NOT EXISTS receipts (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  summary JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS session_costs (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  counters JSONB NOT NULL DEFAULT '{}'::jsonb,
  estimate_usd REAL NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
