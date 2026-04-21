// Tier-3 full-chain end-to-end test (Phase 4 / C8).
//
// Exercises the real chain:
//   spawn `claude -p "Say hi."` subprocess
//     → CC SessionStart/Stop hooks POST to 127.0.0.1:<ephemeral>/hook
//     → ExpressHttpListener appends hook_events row (job_id NULL)
//     → listener calls correlator.recordHook (eager backfill if mapping exists)
//     → orchestrator reads worker stdout via captureWorkerSessionId
//     → correlator.registerSession backfills any earlier rows
//     → orchestrator.retireJob on child terminal state (final sweep)
//     → assertion: hook_events rows for the session exist with non-NULL job_id
//      pointing at the child job
//
// Gated behind E2E=1 so `npm test` stays at the unit-test baseline. With
// E2E=1, this adds one real subprocess run and one real API call to
// Anthropic per invocation (small cost, a few cents).
//
// Port: ephemeral (getFreePort), not 8787. Justification in
// plans/c8: decouples the test from Gate-1 state in ~/miracle-workspace
// and avoids collision with any production listener.
//
// DB: ~/.miracle/tier-3-test.db, deleted on beforeEach for determinism.
// Never touches ~/.miracle/queue.db (production).

import { spawn, type ChildProcess } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createNotebookClient } from "../../src/notebook/client.js";
import {
  createTier3Runtime,
  type Tier3Notebook,
  type Tier3Runtime,
} from "../../src/tier3/runtime.js";
import type { HookEventRow } from "../../src/types/phase3.js";

type SqliteDatabase = import("better-sqlite3").Database;

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3") as {
  new (filename?: string, options?: { readonly?: boolean }): SqliteDatabase;
};

const TEST_DB_PATH = join(homedir(), ".miracle", "tier-3-test.db");

// Skip the whole suite unless E2E=1; keeps default `npm test` at the
// unit-test baseline without having to import the test file conditionally.
const suite = process.env.E2E === "1" ? describe : describe.skip;

suite("tier-3 full chain (claude subprocess → hooks → correlator → notebook)", () => {
  let tmpRoot = "";
  let runtime: Tier3Runtime | null = null;
  let subprocess: ChildProcess | null = null;

  beforeEach(() => {
    // Fresh test DB per run so assertions are deterministic. Delete both
    // the DB and any journal/WAL sidecar that may linger from a prior run.
    for (const sidecar of ["", "-journal", "-wal", "-shm"]) {
      try {
        unlinkSync(`${TEST_DB_PATH}${sidecar}`);
      } catch {
        // Absent is the expected case; ignore.
      }
    }
    tmpRoot = mkdtempSync(join(tmpdir(), "c8-e2e-"));
  });

  afterEach(async () => {
    if (subprocess && subprocess.exitCode === null) {
      subprocess.kill("SIGKILL");
    }
    if (runtime) {
      await runtime.stop();
    }
    subprocess = null;
    runtime = null;
    if (tmpRoot) {
      rmSync(tmpRoot, { recursive: true, force: true });
      tmpRoot = "";
    }
  });

  it(
    "worker hooks get correlated to job_id end-to-end",
    async () => {
      const port = await getFreePort();
      const notebook = createNotebookClient({
        backend: "sqlite",
        dbPath: TEST_DB_PATH,
      }) as Tier3Notebook;

      const settingsPath = join(tmpRoot, "e2e-settings.json");
      writeFileSync(settingsPath, JSON.stringify(buildHookSettings(port)));

      runtime = createTier3Runtime({ notebook, port });
      await runtime.listener.start();

      let capturedChildJobId: string | null = null;

      const result = await runtime.runJob("Say hi.", {
        startWorker: (job) => {
          capturedChildJobId = job.id;
          subprocess = spawn(
            "claude",
            [
              "-p",
              "Say hi.",
              "--settings",
              settingsPath,
              "--output-format",
              "stream-json",
              "--verbose",
              "--permission-mode",
              "bypassPermissions",
            ],
            {
              stdio: ["ignore", "pipe", "pipe"],
              cwd: tmpRoot,
            },
          );

          subprocess.on("exit", (code) => {
            if (code === 0) {
              notebook.updateStatus(job.id, "completed", { exit: 0 });
            } else {
              notebook.updateStatus(job.id, "failed", { exit: code });
            }
          });

          return { stdout: subprocess.stdout };
        },
      });

      expect(result.status).toBe("completed");
      expect(capturedChildJobId).not.toBeNull();

      // CC hooks may still be in flight when the subprocess exits; poll
      // the DB up to 5 s for rows to land before asserting.
      const rows = await waitForHookEvents(TEST_DB_PATH, 5_000);
      expect(rows.length).toBeGreaterThan(0);

      const correlatedRows = rows.filter(
        (r) => r.job_id === capturedChildJobId,
      );
      expect(correlatedRows.length).toBeGreaterThan(0);

      // Sanity: every correlated row references the same session_id.
      const sessions = new Set(correlatedRows.map((r) => r.session_id));
      expect(sessions.size).toBe(1);
    },
    60_000,
  );
});

function buildHookSettings(port: number): {
  hooks: Record<string, Array<{ hooks: Array<{ type: string; url: string }> }>>;
} {
  // CC 2.x hook schema nests event names with a matcher/hooks structure.
  // Register against multiple lifecycle events so at least one fires for
  // a trivial `claude -p "Say hi."` run. URL points at the test listener.
  const url = `http://127.0.0.1:${port}/hook`;
  const entry = { hooks: [{ type: "http", url }] };
  return {
    hooks: {
      SessionStart: [entry],
      UserPromptSubmit: [entry],
      Stop: [entry],
      SessionEnd: [entry],
    },
  };
}

async function waitForHookEvents(
  dbPath: string,
  timeoutMs: number,
): Promise<HookEventRow[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = readHookEventsIfExists(dbPath);
    if (rows.length > 0) {
      return rows;
    }
    await sleep(100);
  }
  return readHookEventsIfExists(dbPath);
}

function readHookEventsIfExists(dbPath: string): HookEventRow[] {
  let db: SqliteDatabase;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    return [];
  }
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

async function getFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Expected TCP address"));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
