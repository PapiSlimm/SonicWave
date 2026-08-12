-- SonicWave production schema (PostgreSQL).
-- Replaces the ephemeral, unindexed SQLite in db.ts. Run with node-pg-migrate,
-- Prisma migrate, or `psql < migrations/001_init.sql`.

BEGIN;

CREATE TABLE IF NOT EXISTS projects (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  bpm          INTEGER NOT NULL DEFAULT 120,      -- integer, not REAL
  is_public    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- The original had no index on user_id → full scan on every project list.
CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects (user_id);

CREATE TABLE IF NOT EXISTS project_states (
  project_id   TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  state        JSONB NOT NULL,
  version      INTEGER NOT NULL DEFAULT 0,        -- optimistic concurrency token
  ydoc         BYTEA,                             -- persisted CRDT state
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS project_events (
  id           BIGSERIAL PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL,
  event_type   TEXT NOT NULL,
  payload      JSONB,
  version      INTEGER NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_events_project ON project_events (project_id, version);

-- Accepted collaborators (authorizes socket room joins + shared editing).
CREATE TABLE IF NOT EXISTS project_collaborators (
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'editor',
  added_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);

-- Persisted entitlements so authz never needs a live Stripe call.
CREATE TABLE IF NOT EXISTS entitlements (
  user_id            TEXT PRIMARY KEY,
  plan               TEXT NOT NULL DEFAULT 'FREE',
  stripe_customer_id TEXT,
  subscription_id    TEXT,
  current_period_end BIGINT,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_entitlements_customer ON entitlements (stripe_customer_id);

-- Webhook idempotency: a duplicate Stripe delivery is a no-op by PK conflict.
CREATE TABLE IF NOT EXISTS processed_webhooks (
  event_id     TEXT PRIMARY KEY,
  event_type   TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Render jobs (durable record beyond BullMQ's queue retention).
CREATE TABLE IF NOT EXISTS render_jobs (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'queued',
  output_key   TEXT,
  bytes        BIGINT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_render_jobs_project ON render_jobs (project_id);

COMMIT;
