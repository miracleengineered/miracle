-- Miracle v1 slice — schema.
--
-- Scope: approval-gated async delegation via /plan. Four tables,
-- all namespaced with `miracle_` to make cleanup trivial if the
-- slice rolls back.
--
-- DB file: ~/.miracle/slice.db (separate from the Tier 3 queue DB
-- at ~/.miracle/queue.db — the slice is independent infrastructure,
-- and dropping this file is the nuclear rollback).
--
-- Loaded by src/miracle/db.ts at first connection; idempotent via
-- IF NOT EXISTS on every object.

CREATE TABLE IF NOT EXISTS miracle_plans (
  id                TEXT PRIMARY KEY,
  thread_id         TEXT,
  chat_id           INTEGER NOT NULL,
  topic_id          INTEGER,
  status            TEXT NOT NULL,
  intent            TEXT NOT NULL,
  title             TEXT,
  plan_json         TEXT,
  tool_set          TEXT,
  budget_usd_cap    REAL NOT NULL,
  budget_usd_spent  REAL NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  approved_at       INTEGER,
  completed_at      INTEGER
);

CREATE INDEX IF NOT EXISTS idx_miracle_plans_status ON miracle_plans(status);
CREATE INDEX IF NOT EXISTS idx_miracle_plans_chat ON miracle_plans(chat_id);

CREATE TABLE IF NOT EXISTS miracle_approvals (
  id          TEXT PRIMARY KEY,
  plan_id     TEXT NOT NULL,
  hmac_nonce  TEXT NOT NULL UNIQUE,
  status      TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (plan_id) REFERENCES miracle_plans(id)
);

CREATE INDEX IF NOT EXISTS idx_miracle_approvals_plan ON miracle_approvals(plan_id);
CREATE INDEX IF NOT EXISTS idx_miracle_approvals_expires ON miracle_approvals(expires_at);

-- Gate 3 log table — one row per Executor run (post-approval).
-- Appended to ~/miracle-workspace/gate-3-log.md in parallel via the
-- Executor so the markdown log stays readable by hand.
CREATE TABLE IF NOT EXISTS miracle_runs (
  plan_id               TEXT NOT NULL,
  executor_session_id   TEXT,
  started_at            INTEGER NOT NULL,
  ended_at              INTEGER,
  outcome               TEXT,
  usd_spent             REAL NOT NULL DEFAULT 0,
  turn_count            INTEGER NOT NULL DEFAULT 0,
  user_verdict          TEXT,
  notes                 TEXT,
  PRIMARY KEY (plan_id, started_at),
  FOREIGN KEY (plan_id) REFERENCES miracle_plans(id)
);

CREATE INDEX IF NOT EXISTS idx_miracle_runs_plan ON miracle_runs(plan_id);
CREATE INDEX IF NOT EXISTS idx_miracle_runs_outcome ON miracle_runs(outcome);

-- SessionStore backing — one row per (projectKey, sessionId, subkey).
-- The Agent SDK SessionStore interface stores opaque entry arrays
-- per key; this table is the durable backing for our adapter.
CREATE TABLE IF NOT EXISTS miracle_sessions (
  session_key   TEXT PRIMARY KEY,
  entries_json  TEXT NOT NULL,
  mtime         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_miracle_sessions_mtime ON miracle_sessions(mtime);
