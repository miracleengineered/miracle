import { describe, it, expect } from "vitest";
import { createNotebookClient } from "./client.js";

describe("InMemoryNotebookClient", () => {
  it("createJob assigns id, defaults status to pending, and stores parent linkage", () => {
    const nb = createNotebookClient();
    const parent = nb.createJob({ payload: { kind: "root" } });
    const child = nb.createJob({ parentId: parent.id, payload: { kind: "leaf" } });

    expect(parent.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(parent.parentId).toBeNull();
    expect(parent.status).toBe("pending");
    expect(child.parentId).toBe(parent.id);
    expect(nb.getChildren(parent.id)).toHaveLength(1);
  });

  it("updateStatus advances job state and stamps completedAt only on terminal states", () => {
    const nb = createNotebookClient();
    const job = nb.createJob({ payload: { task: "x" } });

    const running = nb.updateStatus(job.id, "running");
    expect(running.status).toBe("running");
    expect(running.completedAt).toBeNull();

    const done = nb.updateStatus(job.id, "completed", { ok: true });
    expect(done.status).toBe("completed");
    expect(done.completedAt).not.toBeNull();
    expect(done.result).toEqual({ ok: true });
  });

  it("observeCompletions yields children in the order they finish", async () => {
    const nb = createNotebookClient();
    const parent = nb.createJob({ payload: null });
    const a = nb.createJob({ parentId: parent.id, payload: { n: "a" } });
    const b = nb.createJob({ parentId: parent.id, payload: { n: "b" } });

    const completions: string[] = [];
    const observer = (async () => {
      for await (const job of nb.observeCompletions(parent.id)) {
        completions.push(job.id);
        if (completions.length === 2) break;
      }
    })();

    await Promise.resolve();
    nb.updateStatus(b.id, "completed", { result: "b-done" });
    await Promise.resolve();
    nb.updateStatus(a.id, "failed", { error: "a-failed" });
    await observer;

    expect(completions).toEqual([b.id, a.id]);
  });
});
