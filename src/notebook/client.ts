// Notebook client module.
//
// Two implementations live here:
//
//   InMemoryNotebookClient — permanent test double. Used by unit tests
//     and (until C3 lands a functional SqliteNotebookClient) by the
//     production orchestrator default.
//
//   SqliteNotebookClient — Phase 3 / C3 production impl. This file
//     contains only a skeleton; the sub-branch implements each method.
//
// createNotebookClient(config) dispatches on backend. See INTERFACES.md
// → "Phase 3 contracts" for the authoritative contract.

import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { createRequire } from "node:module";

import { newJobId } from "../util/jobId.js";
import type { JobRow, JobStatus, NotebookConfig } from "../types/phase3.js";

type SqliteDatabase = import("better-sqlite3").Database;

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3") as {
  new (filename?: string, options?: { readonly?: boolean }): SqliteDatabase;
};

const MIGRATION_SQL = readFileSync(
  new URL("./migrations/001_phase3_init.sql", import.meta.url),
  "utf8",
);
const TERMINAL_STATUSES = new Set<JobStatus>(["completed", "failed", "cancelled"]);
const OBSERVE_POLL_INTERVAL_MS = 10;

export type {
  JobStatus,
  NotebookBackend,
  NotebookConfig,
} from "../types/phase3.js";

export interface CreateJobInput {
  id?: string;
  parentId?: string | null;
  payload: unknown;
}

export interface Job {
  id: string;
  parentId: string | null;
  status: JobStatus;
  payload: unknown;
  planSnapshot: unknown | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  result: unknown | null;
}

export interface NotebookClient {
  createJob(input: CreateJobInput): Job;
  updateStatus(jobId: string, status: JobStatus, result?: unknown): Job;
  getChildren(parentId: string): Job[];
  writePlanSnapshot(jobId: string, snapshot: unknown): Job;
  appendHookEvent?(input: {
    sessionId: string;
    eventType: string;
    payloadJson: string;
    receivedAt: number;
  }): void;
  backfillHookEvents?(sessionId: string, jobId: string): number | Promise<number>;
  observeCompletions(parentId: string): AsyncIterable<Job>;
  /**
   * Startup recovery — reset jobs with status='running' older than maxAgeMs
   * to status='failed' with a result_summary explaining the recovery.
   * Kind-agnostic so any job kind (orchestrator, leaf, miracle, etc.) is swept.
   * Returns the number of rows updated.
   *
   * Optional on the interface so existing test mocks keep compiling;
   * production callers guard with `notebook.recoverStaleRunning?.(…)`.
   */
  recoverStaleRunning?(maxAgeMs: number): number;
}

class InMemoryNotebookClient implements NotebookClient {
  private jobs = new Map<string, Job>();
  readonly hookEvents: Array<{
    jobId: string | null;
    sessionId: string;
    eventType: string;
    payloadJson: string;
    receivedAt: number;
  }> = [];
  // Per-parent buffer of completions waiting to be observed.
  private buffers = new Map<string, Job[]>();
  // Per-parent single pending resolver (set when an iterator is currently awaiting).
  private waiters = new Map<string, (job: Job) => void>();

  createJob(input: CreateJobInput): Job {
    const now = Date.now();
    const job: Job = {
      id: input.id ?? newJobId(),
      parentId: input.parentId ?? null,
      status: "pending",
      payload: input.payload,
      planSnapshot: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      result: null,
    };
    this.jobs.set(job.id, job);
    return job;
  }

  updateStatus(jobId: string, status: JobStatus, result?: unknown): Job {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);
    const now = Date.now();
    const isTerminal = isTerminalStatus(status);
    const next: Job = {
      ...job,
      status,
      updatedAt: now,
      completedAt: isTerminal ? now : job.completedAt,
      result: result ?? job.result,
    };
    this.jobs.set(jobId, next);
    if (isTerminal && next.parentId) {
      const waiter = this.waiters.get(next.parentId);
      if (waiter) {
        this.waiters.delete(next.parentId);
        waiter(next);
      } else {
        const buf = this.buffers.get(next.parentId) ?? [];
        buf.push(next);
        this.buffers.set(next.parentId, buf);
      }
    }
    return next;
  }

  getChildren(parentId: string): Job[] {
    return [...this.jobs.values()].filter((j) => j.parentId === parentId);
  }

  writePlanSnapshot(jobId: string, snapshot: unknown): Job {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);
    const next: Job = { ...job, planSnapshot: snapshot, updatedAt: Date.now() };
    this.jobs.set(jobId, next);
    return next;
  }

  appendHookEvent(input: {
    sessionId: string;
    eventType: string;
    payloadJson: string;
    receivedAt: number;
  }): void {
    this.hookEvents.push({
      jobId: null,
      ...input,
    });
  }

  backfillHookEvents(sessionId: string, jobId: string): number {
    let updated = 0;
    for (const event of this.hookEvents) {
      if (event.sessionId === sessionId && event.jobId === null) {
        event.jobId = jobId;
        updated += 1;
      }
    }
    return updated;
  }

  async *observeCompletions(parentId: string): AsyncIterable<Job> {
    const seen = new Set<string>();
    for (const j of this.getChildren(parentId)) {
      if (isTerminalStatus(j.status) && !seen.has(j.id)) {
        seen.add(j.id);
        yield j;
      }
    }
    while (this.getChildren(parentId).some((j) => !seen.has(j.id))) {
      const buf = this.buffers.get(parentId) ?? [];
      let next: Job | undefined;
      while (buf.length > 0) {
        const candidate = buf.shift();
        if (candidate && !seen.has(candidate.id)) {
          next = candidate;
          break;
        }
      }
      if (buf.length === 0) this.buffers.delete(parentId);
      else this.buffers.set(parentId, buf);

      if (!next) {
        next = await new Promise<Job>((resolve) => {
          this.waiters.set(parentId, resolve);
        });
      }
      if (!seen.has(next.id)) {
        seen.add(next.id);
        yield next;
      }
    }
  }

  recoverStaleRunning(maxAgeMs: number): number {
    const now = Date.now();
    let changed = 0;
    for (const [id, job] of this.jobs) {
      if (job.status !== "running") continue;
      if (now - job.createdAt < maxAgeMs) continue;
      this.jobs.set(id, {
        ...job,
        status: "failed",
        updatedAt: now,
        completedAt: now,
        result: { reason: "auto-recovery: stale running on startup" },
      });
      changed++;
    }
    return changed;
  }
}

/**
 * Phase 3 / C3 production impl. Hook event persistence (appendHookEvent,
 * backfillHookEvents) added in Phase 4 / C8; declared non-optional on the
 * class so callers that need both methods get structural assignability
 * without a cast.
 */
class SqliteNotebookClient implements NotebookClient {
  readonly dbPath: string;
  private readonly db: SqliteDatabase;

  constructor(config: { dbPath: string }) {
    this.dbPath = config.dbPath;
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(MIGRATION_SQL);
  }

  createJob(input: CreateJobInput): Job {
    const now = Date.now();
    const job: Job = {
      id: input.id ?? newJobId(),
      parentId: input.parentId ?? null,
      status: "pending",
      payload: input.payload,
      planSnapshot: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      result: null,
    };

    this.db
      .prepare(
        `INSERT INTO jobs (
          id,
          parent_id,
          kind,
          status,
          payload,
          model,
          worker_id,
          created_at,
          updated_at,
          completed_at,
          result_summary,
          plan_snapshot
        ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL, NULL, NULL)`,
      )
      .run(
        job.id,
        job.parentId,
        extractKind(job.payload),
        job.status,
        serializeJson(job.payload),
        job.createdAt,
        job.updatedAt,
      );

    return job;
  }

  updateStatus(jobId: string, status: JobStatus, result?: unknown): Job {
    const job = this.readJob(jobId);
    const now = Date.now();
    const isTerminal = isTerminalStatus(status);
    const next: Job = {
      ...job,
      status,
      updatedAt: now,
      completedAt: isTerminal ? now : job.completedAt,
      result: isTerminal ? (result ?? job.result) : job.result,
    };

    this.db
      .prepare(
        `UPDATE jobs
         SET status = ?, updated_at = ?, completed_at = ?, result_summary = ?
         WHERE id = ?`,
      )
      .run(
        next.status,
        next.updatedAt,
        next.completedAt,
        isTerminal ? serializeNullableJson(next.result) : serializeNullableJson(job.result),
        jobId,
      );

    return next;
  }

  getChildren(parentId: string): Job[] {
    const rows = this.db
      .prepare<[string], JobRow>(
        `SELECT
          id,
          parent_id,
          kind,
          status,
          payload,
          model,
          worker_id,
          created_at,
          updated_at,
          completed_at,
          result_summary,
          plan_snapshot
         FROM jobs
         WHERE parent_id = ?
         ORDER BY created_at ASC, id ASC`,
      )
      .all(parentId);

    return rows.map(hydrateJob);
  }

  writePlanSnapshot(jobId: string, snapshot: unknown): Job {
    const job = this.readJob(jobId);
    const next: Job = {
      ...job,
      planSnapshot: snapshot,
      updatedAt: Date.now(),
    };

    this.db
      .prepare(`UPDATE jobs SET plan_snapshot = ?, updated_at = ? WHERE id = ?`)
      .run(serializeNullableJson(snapshot), next.updatedAt, jobId);

    return next;
  }

  appendHookEvent(input: {
    sessionId: string;
    eventType: string;
    payloadJson: string;
    receivedAt: number;
  }): void {
    // Single-statement INSERT = implicit SQLite transaction. job_id stays
    // NULL at insert; the correlator's eager path (recordHook) or lazy
    // paths (registerSession / retireJob) backfill it later. Wrapping the
    // INSERT and a later UPDATE in one tx would require a cross-layer
    // begin/commit seam; the three-path backfill makes that unnecessary.
    this.db
      .prepare(
        `INSERT INTO hook_events (
          job_id,
          session_id,
          event_type,
          payload_json,
          received_at
        ) VALUES (NULL, ?, ?, ?, ?)`,
      )
      .run(input.sessionId, input.eventType, input.payloadJson, input.receivedAt);
  }

  backfillHookEvents(sessionId: string, jobId: string): number {
    // Single-statement UPDATE = implicit transaction. Only touches rows
    // whose job_id is still NULL — already-backfilled rows are untouched,
    // which makes this idempotent across the correlator's three call
    // paths (recordHook, registerSession, retireJob).
    const result = this.db
      .prepare(
        `UPDATE hook_events
         SET job_id = ?
         WHERE session_id = ? AND job_id IS NULL`,
      )
      .run(jobId, sessionId);

    return Number(result.changes);
  }

  async *observeCompletions(parentId: string): AsyncIterable<Job> {
    const seen = new Set<string>();

    while (this.getChildren(parentId).some((job) => !seen.has(job.id))) {
      let next = this.getTerminalChildren(parentId).find((job) => !seen.has(job.id));
      while (!next) {
        await sleep(OBSERVE_POLL_INTERVAL_MS);
        if (!this.getChildren(parentId).some((job) => !seen.has(job.id))) {
          return;
        }
        next = this.getTerminalChildren(parentId).find((job) => !seen.has(job.id));
      }

      seen.add(next.id);
      yield next;
    }
  }

  private readJob(jobId: string): Job {
    const row = this.db
      .prepare<[string], JobRow>(
        `SELECT
          id,
          parent_id,
          kind,
          status,
          payload,
          model,
          worker_id,
          created_at,
          updated_at,
          completed_at,
          result_summary,
          plan_snapshot
         FROM jobs
         WHERE id = ?`,
      )
      .get(jobId);

    if (!row) {
      throw new Error(`Job not found: ${jobId}`);
    }

    return hydrateJob(row);
  }

  private getTerminalChildren(parentId: string): Job[] {
    const rows = this.db
      .prepare<[string], JobRow>(
        `SELECT
          id,
          parent_id,
          kind,
          status,
          payload,
          model,
          worker_id,
          created_at,
          updated_at,
          completed_at,
          result_summary,
          plan_snapshot
         FROM jobs
         WHERE parent_id = ?
           AND status IN ('completed', 'failed', 'cancelled')
         ORDER BY completed_at ASC, updated_at ASC, created_at ASC, id ASC`,
      )
      .all(parentId);

    return rows.map(hydrateJob);
  }

  recoverStaleRunning(maxAgeMs: number): number {
    const now = Date.now();
    const result = this.db
      .prepare(
        `UPDATE jobs
           SET status = 'failed',
               updated_at = ?,
               completed_at = ?,
               result_summary = ?
           WHERE status = 'running'
             AND created_at < ?`,
      )
      .run(
        now,
        now,
        JSON.stringify({ reason: "auto-recovery: stale running on startup" }),
        now - maxAgeMs,
      );
    return Number(result.changes ?? 0);
  }
}

/**
 * Factory. Dispatches on backend. Defaults to in-memory so tests can
 * call `createNotebookClient()` with no args; production callers that
 * want the sqlite impl must pass `{ backend: "sqlite", dbPath }`
 * explicitly.
 */
export function createNotebookClient(
  config: NotebookConfig = { backend: "memory" },
): NotebookClient {
  if (config.backend === "sqlite") {
    return new SqliteNotebookClient({ dbPath: config.dbPath });
  }
  return new InMemoryNotebookClient();
}

export { InMemoryNotebookClient, SqliteNotebookClient };

function hydrateJob(row: JobRow): Job {
  return {
    id: row.id,
    parentId: row.parent_id,
    status: row.status,
    payload: deserializeJson(row.payload),
    planSnapshot: deserializeNullableJson(row.plan_snapshot),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    result: deserializeNullableJson(row.result_summary),
  };
}

function serializeJson(value: unknown): string {
  return JSON.stringify(value) ?? "null";
}

function serializeNullableJson(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return serializeJson(value);
}

function deserializeJson(value: string): unknown {
  return JSON.parse(value);
}

function deserializeNullableJson(value: string | null): unknown | null {
  if (value === null) {
    return null;
  }
  return deserializeJson(value);
}

function extractKind(payload: unknown): string {
  const kind =
    payload && typeof payload === "object" && "kind" in payload ? payload.kind : undefined;

  if (typeof kind === "string" && kind.length > 0) {
    return kind;
  }

  throw new Error(`createJob requires payload.kind (string); got: ${String(kind)}`);
}

function isTerminalStatus(status: JobStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
