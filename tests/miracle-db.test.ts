import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSliceDb, _resetSliceDbForTests } from "../src/miracle/db";

const TEST_DB = join(tmpdir(), `miracle-slice-test-${process.pid}.db`);

function cleanupTestDb(): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(TEST_DB + suffix);
    } catch {
      /* ignore */
    }
  }
}

describe("miracle slice DB", () => {
  beforeEach(() => {
    _resetSliceDbForTests();
    cleanupTestDb();
  });

  afterAll(() => {
    _resetSliceDbForTests();
    cleanupTestDb();
  });

  it("runs migration and creates all four miracle_* tables", () => {
    const db = getSliceDb({ MIRACLE_SLICE_DB_PATH: TEST_DB });

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'miracle_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>;

    expect(tables.map((t) => t.name)).toEqual([
      "miracle_approvals",
      "miracle_plans",
      "miracle_runs",
      "miracle_sessions",
    ]);
  });

  it("is idempotent: calling getSliceDb twice returns the same handle and migration doesn't re-error", () => {
    const a = getSliceDb({ MIRACLE_SLICE_DB_PATH: TEST_DB });
    const b = getSliceDb({ MIRACLE_SLICE_DB_PATH: TEST_DB });
    expect(a).toBe(b);
  });

  it("enforces miracle_approvals.hmac_nonce UNIQUE constraint", () => {
    const db = getSliceDb({ MIRACLE_SLICE_DB_PATH: TEST_DB });

    // First insert a plan (FK requirement).
    db.prepare(
      "INSERT INTO miracle_plans (id, chat_id, status, intent, budget_usd_cap, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("plan-1", -1001, "pending_approval", "test", 2.0, Date.now());

    const now = Date.now();
    const insert = db.prepare(
      "INSERT INTO miracle_approvals (id, plan_id, hmac_nonce, status, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    );

    insert.run("a1", "plan-1", "nonce-xyz", "pending", now + 72 * 3600_000, now);

    expect(() =>
      insert.run("a2", "plan-1", "nonce-xyz", "pending", now + 72 * 3600_000, now),
    ).toThrow(/UNIQUE/);
  });

  it("miracle_sessions round-trips session_key + entries_json + mtime", () => {
    const db = getSliceDb({ MIRACLE_SLICE_DB_PATH: TEST_DB });
    const now = Date.now();

    db.prepare(
      "INSERT INTO miracle_sessions (session_key, entries_json, mtime) VALUES (?, ?, ?)",
    ).run("project-a:session-1", JSON.stringify([{ role: "user" }]), now);

    const row = db
      .prepare(
        "SELECT session_key, entries_json, mtime FROM miracle_sessions WHERE session_key = ?",
      )
      .get("project-a:session-1") as {
      session_key: string;
      entries_json: string;
      mtime: number;
    };

    expect(row.session_key).toBe("project-a:session-1");
    expect(JSON.parse(row.entries_json)).toEqual([{ role: "user" }]);
    expect(row.mtime).toBe(now);
  });
});
