-- Phase 3 / C3 initial schema.
--
-- This file is SCAFFOLDING ONLY. It is not executed by this commit.
-- The C3 sub-branch wires migration-on-first-boot inside
-- SqliteNotebookClient. See INTERFACES.md → "Phase 3 contracts" for
-- the authoritative schema description.

CREATE TABLE IF NOT EXISTS jobs (
  id             TEXT PRIMARY KEY,
  parent_id      TEXT,
  kind           TEXT NOT NULL,
  status         TEXT NOT NULL,
  payload        TEXT NOT NULL,
  model          TEXT,
  worker_id      TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  completed_at   INTEGER,
  result_summary TEXT,
  plan_snapshot  TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_parent ON jobs(parent_id);

CREATE TABLE IF NOT EXISTS hook_events (
  event_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id       TEXT,
  session_id   TEXT NOT NULL,
  event_type   TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  received_at  INTEGER NOT NULL
);

-- job_id is always NULL in Phase 3; hook-to-job correlation is C4's
-- Phase 4 work. The column + index exist now so correlation becomes
-- a backfill UPDATE rather than a schema migration.
CREATE INDEX IF NOT EXISTS idx_hook_events_session
  ON hook_events(session_id, received_at);
CREATE INDEX IF NOT EXISTS idx_hook_events_job
  ON hook_events(job_id, received_at);
