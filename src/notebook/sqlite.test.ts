// C3 skeleton tests — SKIPPED in this commit. The C3 sub-branch un-skips
// these and wires assertions against a real sqlite-backed client.
//
// These imports pin the public surface area C3 must implement; if the
// factory signature or NotebookClient interface drifts, this file stops
// compiling and the drift is caught before C3 merges.

import { describe, it, expect } from "vitest";
import {
  SqliteNotebookClient,
  createNotebookClient,
  type NotebookClient,
} from "./client.js";

describe.skip("SqliteNotebookClient (Phase 3 / C3 — pending)", () => {
  it("factory returns a SqliteNotebookClient when backend === 'sqlite'", () => {
    const client: NotebookClient = createNotebookClient({
      backend: "sqlite",
      dbPath: "/tmp/c3-test.db",
    });
    expect(client).toBeInstanceOf(SqliteNotebookClient);
  });

  it("createJob persists a row to the jobs table and returns the hydrated Job", () => {
    expect(true).toBe(true);
  });

  it("updateStatus transitions are persisted and observeCompletions yields terminal children", () => {
    expect(true).toBe(true);
  });

  it("runs the 001_phase3_init migration on first boot if tables are absent", () => {
    expect(true).toBe(true);
  });
});
