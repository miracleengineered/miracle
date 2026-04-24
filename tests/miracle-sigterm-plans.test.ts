import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  getSliceDb,
  _resetSliceDbForTests,
  markRunningPlansAsShutdown,
} from "../src/miracle/db";

describe("markRunningPlansAsShutdown (Fix 3.K SIGTERM)", () => {
  let tmp: string;
  let dbPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "miracle-sigterm-"));
    dbPath = join(tmp, "slice.db");
    process.env.MIRACLE_SLICE_DB_PATH = dbPath;
    _resetSliceDbForTests();
  });

  afterEach(() => {
    _resetSliceDbForTests();
    delete process.env.MIRACLE_SLICE_DB_PATH;
    rmSync(tmp, { recursive: true, force: true });
  });

  function insertPlan(id: string, status: string) {
    const db = getSliceDb();
    db.prepare(
      `INSERT INTO miracle_plans
         (id, chat_id, status, intent, budget_usd_cap, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, 123, status, "test intent", 1.0, Date.now());
  }

  it("flips running plans to failed_shutdown", () => {
    insertPlan("p1", "running");
    insertPlan("p2", "running");
    insertPlan("p3", "pending_approval");
    insertPlan("p4", "succeeded");

    const changed = markRunningPlansAsShutdown();
    expect(changed).toBe(2);

    const db = getSliceDb();
    const rows = db
      .prepare("SELECT id, status FROM miracle_plans ORDER BY id")
      .all() as { id: string; status: string }[];
    expect(rows).toEqual([
      { id: "p1", status: "failed_shutdown" },
      { id: "p2", status: "failed_shutdown" },
      { id: "p3", status: "pending_approval" },
      { id: "p4", status: "succeeded" },
    ]);
  });

  it("returns 0 when no running plans exist", () => {
    insertPlan("p1", "succeeded");
    const changed = markRunningPlansAsShutdown();
    expect(changed).toBe(0);
  });
});
