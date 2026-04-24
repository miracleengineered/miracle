import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createNotebookClient } from "../src/notebook/client.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3") as new (p: string) => any;

describe("SqliteNotebookClient.recoverStaleRunning (Fix 3.D)", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nb-stale-"));
    dbPath = join(dir, "queue.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function insertJob(id: string, kind: string, status: string, ageMs: number) {
    const db = new Database(dbPath);
    const now = Date.now();
    db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        parent_id TEXT,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        payload TEXT NOT NULL,
        model TEXT,
        worker_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        result_summary TEXT,
        plan_snapshot TEXT
      );
    `);
    db.prepare(
      `INSERT INTO jobs (id, parent_id, kind, status, payload, created_at, updated_at)
       VALUES (?, NULL, ?, ?, '{}', ?, ?)`,
    ).run(id, kind, status, now - ageMs, now - ageMs);
    db.close();
  }

  it("flips running jobs older than maxAge across all kinds", () => {
    insertJob("j1", "orchestrator", "running", 30 * 60 * 1000);   // 30 min old
    insertJob("j2", "leaf", "running", 15 * 60 * 1000);           // 15 min old
    insertJob("j3", "miracle", "running", 2 * 60 * 1000);         // 2 min old (fresh)
    insertJob("j4", "leaf", "pending", 30 * 60 * 1000);           // not running

    const nb = createNotebookClient({ backend: "sqlite", dbPath });
    const changed = nb.recoverStaleRunning(10 * 60 * 1000);        // 10 min threshold
    expect(changed).toBe(2);  // j1 and j2 flipped; j3 still fresh; j4 not running

    const db = new Database(dbPath);
    const rows = db
      .prepare(`SELECT id, status, result_summary FROM jobs ORDER BY id`)
      .all() as Array<{ id: string; status: string; result_summary: string | null }>;
    db.close();

    expect(rows[0]).toMatchObject({ id: "j1", status: "failed" });
    expect(rows[0]!.result_summary).toMatch(/auto-recovery|stale/i);
    expect(rows[1]).toMatchObject({ id: "j2", status: "failed" });
    expect(rows[2]).toMatchObject({ id: "j3", status: "running" });
    expect(rows[3]).toMatchObject({ id: "j4", status: "pending" });
  });

  it("returns 0 when no stale jobs", () => {
    insertJob("j1", "leaf", "pending", 60 * 60 * 1000);
    const nb = createNotebookClient({ backend: "sqlite", dbPath });
    expect(nb.recoverStaleRunning(10 * 60 * 1000)).toBe(0);
  });
});
