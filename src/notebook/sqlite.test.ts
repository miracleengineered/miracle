// C3 skeleton tests — SKIPPED in this commit. The C3 sub-branch un-skips
// these and wires assertions against a real sqlite-backed client.
//
// These imports pin the public surface area C3 must implement; if the
// factory signature or NotebookClient interface drifts, this file stops
// compiling and the drift is caught before C3 merges.

import { rmSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

import { afterEach, describe, expect, it } from "vitest";
import { SqliteNotebookClient, createNotebookClient, type NotebookClient } from "./client.js";
import type { HookEventRow, JobRow } from "../types/phase3.js";

type SqliteDatabase = import("better-sqlite3").Database;

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3") as {
  new (filename?: string, options?: { readonly?: boolean }): SqliteDatabase;
};

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("SqliteNotebookClient", () => {
  it("factory returns a SqliteNotebookClient when backend === 'sqlite'", () => {
    const { dbPath } = makeTempDbPath();
    const client: NotebookClient = createNotebookClient({
      backend: "sqlite",
      dbPath,
    });

    expect(client).toBeInstanceOf(SqliteNotebookClient);
  });

  it("runs the 001_phase3_init migration on first boot and creates the parent directory", () => {
    const { dbPath } = makeTempDbPath();
    const parentDir = dirname(dbPath);

    expect(existsSync(parentDir)).toBe(false);

    createNotebookClient({ backend: "sqlite", dbPath });

    expect(existsSync(parentDir)).toBe(true);
    expect(listTables(dbPath)).toEqual(
      expect.arrayContaining(["hook_events", "jobs", "sqlite_sequence"]),
    );
  });

  it("createJob persists rows to disk, survives reconstruction, and round-trips nested JSON", () => {
    const { dbPath } = makeTempDbPath();
    const client = createNotebookClient({ backend: "sqlite", dbPath });
    const parent = client.createJob({
      id: "00000000-0000-0000-0000-000000000001",
      payload: { kind: "root", ask: "parent" },
    });
    const payload = {
      kind: "orchestrator-subtask",
      ask: "collect facts",
      nested: {
        tags: ["alpha", "beta"],
        attempts: [{ n: 1 }, { n: 2 }],
      },
    };

    const child = client.createJob({
      id: "00000000-0000-0000-0000-000000000002",
      parentId: parent.id,
      payload,
    });

    expect(child).toEqual({
      id: "00000000-0000-0000-0000-000000000002",
      parentId: parent.id,
      status: "pending",
      payload,
      planSnapshot: null,
      createdAt: expect.any(Number),
      updatedAt: expect.any(Number),
      completedAt: null,
      result: null,
    });

    const row = readJobRow(dbPath, child.id);
    expect(row).toMatchObject({
      id: child.id,
      parent_id: parent.id,
      kind: "orchestrator-subtask",
      status: "pending",
      payload: JSON.stringify(payload),
      completed_at: null,
      result_summary: null,
      plan_snapshot: null,
    });

    const reopened = createNotebookClient({ backend: "sqlite", dbPath });
    expect(reopened.getChildren(parent.id)).toEqual([child]);
  });

  it("createJob persists payload.kind into the kind column", () => {
    const { dbPath } = makeTempDbPath();
    const client = createNotebookClient({ backend: "sqlite", dbPath });

    const job = client.createJob({
      id: "00000000-0000-0000-0000-000000000004",
      payload: { kind: "something", ask: "persist kind" },
    });

    expect(readJobRow(dbPath, job.id)?.kind).toBe("something");
  });

  it("createJob throws when payload.kind is missing, empty, or not a string", () => {
    const { dbPath } = makeTempDbPath();
    const client = createNotebookClient({ backend: "sqlite", dbPath });

    expect(() => client.createJob({ payload: {} })).toThrow(
      "createJob requires payload.kind (string); got: undefined",
    );
    expect(() => client.createJob({ payload: { kind: "" } })).toThrow(
      "createJob requires payload.kind (string); got: ",
    );
    expect(() => client.createJob({ payload: { kind: 42 } })).toThrow(
      "createJob requires payload.kind (string); got: 42",
    );
  });

  it("updateStatus persists updated_at, completed_at, and result_summary for terminal states", async () => {
    const { dbPath } = makeTempDbPath();
    const client = createNotebookClient({ backend: "sqlite", dbPath });
    const parent = client.createJob({ payload: { kind: "root" } });
    const child = client.createJob({
      id: "00000000-0000-0000-0000-000000000003",
      parentId: parent.id,
      payload: { kind: "leaf", step: 1 },
    });

    await sleep(5);
    const running = client.updateStatus(child.id, "running");
    expect(running.status).toBe("running");
    expect(running.updatedAt).toBeGreaterThan(child.updatedAt);
    expect(running.completedAt).toBeNull();

    await sleep(5);
    const cancelled = client.updateStatus(child.id, "cancelled", {
      reason: "operator stop",
    });
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.updatedAt).toBeGreaterThan(running.updatedAt);
    expect(cancelled.completedAt).toBe(cancelled.updatedAt);
    expect(cancelled.result).toEqual({ reason: "operator stop" });

    const row = readJobRow(dbPath, child.id);
    expect(row?.status).toBe("cancelled");
    expect(row?.updated_at).toBe(cancelled.updatedAt);
    expect(row?.completed_at).toBe(cancelled.completedAt);
    expect(row?.result_summary).toBe(JSON.stringify({ reason: "operator stop" }));

    const reopened = createNotebookClient({ backend: "sqlite", dbPath });
    expect(reopened.getChildren(parent.id)).toEqual([cancelled]);
  });

  it("getChildren returns the correct rows in creation order across reopen", async () => {
    const { dbPath } = makeTempDbPath();
    const client = createNotebookClient({ backend: "sqlite", dbPath });
    const parent = client.createJob({
      id: "00000000-0000-0000-0000-000000000010",
      payload: { kind: "root" },
    });

    const ids = [
      "00000000-0000-0000-0000-000000000011",
      "00000000-0000-0000-0000-000000000012",
      "00000000-0000-0000-0000-000000000013",
    ];

    for (const id of ids) {
      client.createJob({
        id,
        parentId: parent.id,
        payload: { kind: "child", id },
      });
      await sleep(2);
    }

    const reopened = createNotebookClient({ backend: "sqlite", dbPath });
    expect(reopened.getChildren(parent.id).map((job) => job.id)).toEqual(ids);
  });

  it("writePlanSnapshot persists plan snapshots and rehydrates them on read", async () => {
    const { dbPath } = makeTempDbPath();
    const client = createNotebookClient({ backend: "sqlite", dbPath });
    const parent = client.createJob({ payload: { kind: "root" } });
    const child = client.createJob({
      id: "00000000-0000-0000-0000-000000000020",
      parentId: parent.id,
      payload: { kind: "leaf", ask: "draft plan" },
    });
    const snapshot = {
      strategy: "rule-based-v1",
      subtasks: [{ index: 0, ask: "draft plan" }],
    };

    await sleep(5);
    const updated = client.writePlanSnapshot(child.id, snapshot);

    expect(updated.updatedAt).toBeGreaterThan(child.updatedAt);
    expect(updated.planSnapshot).toEqual(snapshot);
    expect(readJobRow(dbPath, child.id)?.plan_snapshot).toBe(JSON.stringify(snapshot));

    const reopened = createNotebookClient({ backend: "sqlite", dbPath });
    expect(reopened.getChildren(parent.id)[0]?.planSnapshot).toEqual(snapshot);
  });

  it("observeCompletions yields terminal children in completion order", async () => {
    const { dbPath } = makeTempDbPath();
    const client = createNotebookClient({ backend: "sqlite", dbPath });
    const parent = client.createJob({ payload: { kind: "root", ask: "watch" } });
    const first = client.createJob({
      id: "00000000-0000-0000-0000-000000000030",
      parentId: parent.id,
      payload: { kind: "leaf", name: "first" },
    });
    const second = client.createJob({
      id: "00000000-0000-0000-0000-000000000031",
      parentId: parent.id,
      payload: { kind: "leaf", name: "second" },
    });

    client.updateStatus(first.id, "completed", { ok: "first" });

    const seen: string[] = [];
    const observer = (async () => {
      for await (const job of client.observeCompletions(parent.id)) {
        seen.push(job.id);
        if (seen.length === 2) {
          break;
        }
      }
    })();

    await sleep(20);
    client.updateStatus(second.id, "failed", { error: "second" });
    await observer;

    expect(seen).toEqual([first.id, second.id]);
  });

  it("reopens an existing db file and picks up previously written rows", () => {
    const { dbPath } = makeTempDbPath();
    const writer = createNotebookClient({ backend: "sqlite", dbPath });
    const parent = writer.createJob({
      id: "00000000-0000-0000-0000-000000000040",
      payload: { kind: "root", ask: "persist me" },
    });
    const child = writer.createJob({
      id: "00000000-0000-0000-0000-000000000041",
      parentId: parent.id,
      payload: { kind: "leaf", ask: "return later" },
    });

    const reader = createNotebookClient({ backend: "sqlite", dbPath });
    expect(reader.getChildren(parent.id)).toEqual([child]);
  });

  describe("appendHookEvent", () => {
    it("inserts a hook_events row with job_id NULL and round-trips all fields", () => {
      const { dbPath } = makeTempDbPath();
      const client = createNotebookClient({ backend: "sqlite", dbPath });

      client.appendHookEvent?.({
        sessionId: "session-abc",
        eventType: "SessionStart",
        payloadJson: JSON.stringify({ session_id: "session-abc", hook_event_name: "SessionStart" }),
        receivedAt: 1_700_000_000_000,
      });

      const rows = readHookEvents(dbPath);
      expect(rows).toEqual([
        {
          event_id: expect.any(Number),
          job_id: null,
          session_id: "session-abc",
          event_type: "SessionStart",
          payload_json: JSON.stringify({
            session_id: "session-abc",
            hook_event_name: "SessionStart",
          }),
          received_at: 1_700_000_000_000,
        },
      ]);
    });

    it("accumulates multiple inserts in received_at order", () => {
      const { dbPath } = makeTempDbPath();
      const client = createNotebookClient({ backend: "sqlite", dbPath });

      for (let i = 0; i < 3; i += 1) {
        client.appendHookEvent?.({
          sessionId: "session-multi",
          eventType: "PreToolUse",
          payloadJson: `{"step":${i}}`,
          receivedAt: 1_700_000_000_000 + i,
        });
      }

      const rows = readHookEvents(dbPath);
      expect(rows.map((r) => r.received_at)).toEqual([
        1_700_000_000_000, 1_700_000_000_001, 1_700_000_000_002,
      ]);
      expect(rows.every((r) => r.job_id === null)).toBe(true);
    });

    it("accepts an empty sessionId (listener defaults for malformed payloads)", () => {
      const { dbPath } = makeTempDbPath();
      const client = createNotebookClient({ backend: "sqlite", dbPath });

      client.appendHookEvent?.({
        sessionId: "",
        eventType: "",
        payloadJson: "",
        receivedAt: 0,
      });

      const rows = readHookEvents(dbPath);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.session_id).toBe("");
      expect(rows[0]?.event_type).toBe("");
      expect(rows[0]?.payload_json).toBe("");
      expect(rows[0]?.job_id).toBeNull();
    });

    it("persists rows across a reopen", () => {
      const { dbPath } = makeTempDbPath();
      const writer = createNotebookClient({ backend: "sqlite", dbPath });

      writer.appendHookEvent?.({
        sessionId: "session-reopen",
        eventType: "Stop",
        payloadJson: `{"k":"v"}`,
        receivedAt: 1_700_000_000_000,
      });

      const rowsOnWriter = readHookEvents(dbPath);
      expect(rowsOnWriter).toHaveLength(1);

      createNotebookClient({ backend: "sqlite", dbPath });
      const rowsAfterReopen = readHookEvents(dbPath);
      expect(rowsAfterReopen).toHaveLength(1);
      expect(rowsAfterReopen[0]?.session_id).toBe("session-reopen");
    });
  });

  describe("backfillHookEvents", () => {
    it("sets job_id on all rows matching a session and returns the update count", () => {
      const { dbPath } = makeTempDbPath();
      const client = createNotebookClient({ backend: "sqlite", dbPath });

      for (let i = 0; i < 3; i += 1) {
        client.appendHookEvent?.({
          sessionId: "session-match",
          eventType: "PreToolUse",
          payloadJson: `{"step":${i}}`,
          receivedAt: 1_700_000_000_000 + i,
        });
      }
      client.appendHookEvent?.({
        sessionId: "session-other",
        eventType: "PreToolUse",
        payloadJson: `{"other":true}`,
        receivedAt: 1_700_000_000_100,
      });

      const updated = client.backfillHookEvents?.("session-match", "job-aaa");
      expect(updated).toBe(3);

      const rows = readHookEvents(dbPath);
      const matched = rows.filter((r) => r.session_id === "session-match");
      const other = rows.filter((r) => r.session_id === "session-other");
      expect(matched.every((r) => r.job_id === "job-aaa")).toBe(true);
      expect(other.every((r) => r.job_id === null)).toBe(true);
    });

    it("returns 0 when no rows match the session", () => {
      const { dbPath } = makeTempDbPath();
      const client = createNotebookClient({ backend: "sqlite", dbPath });

      client.appendHookEvent?.({
        sessionId: "session-present",
        eventType: "SessionStart",
        payloadJson: "{}",
        receivedAt: 1_700_000_000_000,
      });

      const updated = client.backfillHookEvents?.("session-absent", "job-bbb");
      expect(updated).toBe(0);

      const rows = readHookEvents(dbPath);
      expect(rows[0]?.job_id).toBeNull();
    });

    it("leaves already-backfilled rows untouched (WHERE job_id IS NULL filter)", () => {
      const { dbPath } = makeTempDbPath();
      const client = createNotebookClient({ backend: "sqlite", dbPath });

      client.appendHookEvent?.({
        sessionId: "session-dup",
        eventType: "SessionStart",
        payloadJson: "{}",
        receivedAt: 1_700_000_000_000,
      });

      const first = client.backfillHookEvents?.("session-dup", "job-original");
      expect(first).toBe(1);

      const second = client.backfillHookEvents?.("session-dup", "job-should-not-overwrite");
      expect(second).toBe(0);

      const rows = readHookEvents(dbPath);
      expect(rows[0]?.job_id).toBe("job-original");
    });

    it("is idempotent when called multiple times with the same arguments", () => {
      const { dbPath } = makeTempDbPath();
      const client = createNotebookClient({ backend: "sqlite", dbPath });

      client.appendHookEvent?.({
        sessionId: "session-idem",
        eventType: "SessionStart",
        payloadJson: "{}",
        receivedAt: 1_700_000_000_000,
      });

      expect(client.backfillHookEvents?.("session-idem", "job-x")).toBe(1);
      expect(client.backfillHookEvents?.("session-idem", "job-x")).toBe(0);
      expect(readHookEvents(dbPath)[0]?.job_id).toBe("job-x");
    });
  });
});

function makeTempDbPath(): { root: string; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), "c3-sqlite-"));
  tempRoots.push(root);
  return {
    root,
    dbPath: join(root, "fresh", ".miracle", "queue.db"),
  };
}

function listTables(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true });

  try {
    return db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name ASC",
      )
      .all()
      .map((row) => row.name);
  } finally {
    db.close();
  }
}

function readJobRow(dbPath: string, jobId: string): JobRow | undefined {
  const db = new Database(dbPath, { readonly: true });

  try {
    return db
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
  } finally {
    db.close();
  }
}

function readHookEvents(dbPath: string): HookEventRow[] {
  const db = new Database(dbPath, { readonly: true });

  try {
    return db
      .prepare<[], HookEventRow>(
        `SELECT event_id, job_id, session_id, event_type, payload_json, received_at
         FROM hook_events
         ORDER BY event_id ASC`,
      )
      .all();
  } finally {
    db.close();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
