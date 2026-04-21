import { createServer } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { InMemoryNotebookClient } from "../notebook/client.js";
import type { Job } from "../notebook/client.js";
import type { StartWorker } from "../orchestrator/types.js";
import { createTier3Runtime, type Tier3Runtime } from "./runtime.js";

const activeRuntimes = new Set<Tier3Runtime>();

afterEach(async () => {
  await Promise.all(
    [...activeRuntimes].map(async (runtime) => {
      await runtime.stop();
      activeRuntimes.delete(runtime);
    }),
  );
});

describe("createTier3Runtime", () => {
  it("exposes listener and correlator on the returned runtime", async () => {
    const runtime = await startRuntime();

    expect(runtime.listener).toBeDefined();
    expect(typeof runtime.listener.start).toBe("function");
    expect(typeof runtime.listener.stop).toBe("function");
    expect(runtime.correlator).toBeDefined();
    expect(typeof runtime.correlator.registerSession).toBe("function");
  });

  it("shares one correlator between the listener and runJob's orchestrator", async () => {
    const notebook = new InMemoryNotebookClient();
    const port = await getFreePort();
    const runtime = createTier3Runtime({ notebook, port });
    activeRuntimes.add(runtime);
    await runtime.listener.start();

    // Register a session on the runtime's correlator; a hook POST should
    // then get eagerly backfilled by the listener using the same instance.
    await runtime.correlator.registerSession("job-shared", "session-shared");

    const response = await fetch(`http://127.0.0.1:${port}/hook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: "session-shared",
        hook_event_name: "SessionStart",
      }),
    });

    expect(response.status).toBe(200);
    expect(notebook.hookEvents).toEqual([
      expect.objectContaining({
        jobId: "job-shared",
        sessionId: "session-shared",
      }),
    ]);
  });

  it("runJob forwards startWorker to the orchestrator and calls it per child job", async () => {
    const notebook = new InMemoryNotebookClient();
    const port = await getFreePort();
    const startedJobs: Job[] = [];
    const startWorker: StartWorker = (job) => {
      startedJobs.push(job);
      // Fulfill the child job's terminal state so the orchestrator's
      // observeCompletions resolves without a real subprocess.
      queueMicrotask(() => notebook.updateStatus(job.id, "completed", { ok: true }));
      return { stdout: null };
    };
    const runtime = createTier3Runtime({ notebook, port, startWorker });
    activeRuntimes.add(runtime);

    const result = await runtime.runJob("draft a note and summarize it");

    expect(startedJobs.length).toBeGreaterThan(0);
    expect(startedJobs.every((job) => job.parentId !== null)).toBe(true);
    expect(result.status).toBe("completed");
  });

  it("runJob's per-call startWorker overrides the config default", async () => {
    const notebook = new InMemoryNotebookClient();
    const port = await getFreePort();
    let defaultCalls = 0;
    let overrideCalls = 0;
    const runtime = createTier3Runtime({
      notebook,
      port,
      startWorker: (job) => {
        defaultCalls += 1;
        queueMicrotask(() => notebook.updateStatus(job.id, "completed"));
      },
    });
    activeRuntimes.add(runtime);

    await runtime.runJob("two step task", {
      startWorker: (job) => {
        overrideCalls += 1;
        queueMicrotask(() => notebook.updateStatus(job.id, "completed"));
      },
    });

    expect(defaultCalls).toBe(0);
    expect(overrideCalls).toBeGreaterThan(0);
  });

  it("stop is idempotent", async () => {
    const runtime = await startRuntime();
    await runtime.stop();
    await expect(runtime.stop()).resolves.toBeUndefined();
    activeRuntimes.delete(runtime);
  });

  it("defaults host to 127.0.0.1 when unspecified", async () => {
    const notebook = new InMemoryNotebookClient();
    const port = await getFreePort();
    const runtime = createTier3Runtime({ notebook, port });
    activeRuntimes.add(runtime);

    await runtime.listener.start();

    const response = await fetch(`http://127.0.0.1:${port}/hook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: "session-default-host",
        hook_event_name: "SessionStart",
      }),
    });

    expect(response.status).toBe(200);
  });
});

async function startRuntime(): Promise<Tier3Runtime> {
  const notebook = new InMemoryNotebookClient();
  const port = await getFreePort();
  const runtime = createTier3Runtime({ notebook, port });
  activeRuntimes.add(runtime);
  await runtime.listener.start();
  return runtime;
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

