-- 002: AI-generated tracks (MiniMax Music 3.0 integration, 2026-09).
-- Generated audio is stored in Postgres (v1; move to bucket storage when the
-- StoragePort TODO in server.ts is implemented) and referenced from the
-- project's timeline state as /api/ai/audio/:id clips.

BEGIN;

CREATE TABLE IF NOT EXISTS generated_tracks (
  id           TEXT PRIMARY KEY,
  project_id   TEXT REFERENCES projects(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL,
  title        TEXT NOT NULL,
  style_prompt TEXT NOT NULL,
  instrumental BOOLEAN NOT NULL DEFAULT TRUE,
  mime         TEXT NOT NULL DEFAULT 'audio/mpeg',
  bytes        BYTEA NOT NULL,
  duration_ms  INTEGER,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_generated_tracks_project ON generated_tracks (project_id);
CREATE INDEX IF NOT EXISTS idx_generated_tracks_user ON generated_tracks (user_id);

COMMIT;
