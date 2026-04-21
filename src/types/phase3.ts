// Phase 3 shared types — imported by C3 (notebook), C5 (http-listener),
// and C6 (routing). See INTERFACES.md → "Phase 3 contracts" for the
// authoritative contract text.

// ── Notebook ────────────────────────────────────────────────────────────
//
// JobStatus is the union of states a job can be in. "cancelled" is new
// in Phase 3; existing four states ("pending" | "running" | "completed"
// | "failed") predate this file and are preserved unchanged so Phase 2
// orchestrator code (which pattern-matches on "completed"/"failed")
// keeps compiling.

export type JobStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * Row shape for the `jobs` table. Column names match the SQLite schema
 * verbatim (snake_case) — this is the raw row, not an ORM object.
 *
 * `payload` and `plan_snapshot` are serialized JSON blobs (not query
 * targets); TypeScript consumers deserialize to the corresponding
 * `Job.payload` / `Job.planSnapshot` fields at read time.
 */
export interface JobRow {
  id: string;
  parent_id: string | null;
  kind: string;
  status: JobStatus;
  /** JSON-encoded Job.payload; required on every row. */
  payload: string;
  model: string | null;
  worker_id: string | null;
  created_at: number;
  updated_at: number;
  /** Unix ms; set when status transitions to completed, failed, or cancelled. */
  completed_at: number | null;
  /** JSON-encoded result summary; null until the job reaches a terminal state. */
  result_summary: string | null;
  /** JSON-encoded Job.planSnapshot; null when no plan has been written. */
  plan_snapshot: string | null;
}

/**
 * Row shape for the `hook_events` table. Append-only trail of CC HTTP
 * hook posts. job_id is always NULL in Phase 3 — hook-to-job correlation
 * is Phase 4+ work (see INTERFACES.md).
 */
export interface HookEventRow {
  event_id: number;
  job_id: string | null;
  session_id: string;
  event_type: string;
  /** Verbatim CC payload JSON; not normalized. */
  payload_json: string;
  received_at: number;
}

export type NotebookBackend = "memory" | "sqlite";

export type NotebookConfig =
  | { backend: "memory" }
  | { backend: "sqlite"; dbPath: string };

// ── HTTP listener (C5) ──────────────────────────────────────────────────
//
// CC HTTP hook payload reference:
//   https://code.claude.com/docs/en/hooks
// Phase 3 stores the payload verbatim; only session_id is guaranteed to
// be present. Other fields vary by hook event type.

export interface HookEventPayload {
  session_id: string;
  [key: string]: unknown;
}

export interface HttpListenerConfig {
  host: string;
  port: number;
}

// ── Routing (C6) ────────────────────────────────────────────────────────

export type ModelName = "opus" | "sonnet" | "haiku";

export interface ModelRoute {
  default: ModelName;
}

export type RoutingTable = Record<string, ModelRoute>;
