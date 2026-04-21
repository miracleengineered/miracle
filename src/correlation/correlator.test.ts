import { describe, expect, it, vi } from "vitest";

import { InMemoryNotebookClient } from "../notebook/client.js";
import { createCorrelator } from "./correlator.js";

describe("LiveCorrelator", () => {
  it("registers a session and resolves the mapped job id synchronously", async () => {
    const notebook = new InMemoryNotebookClient();
    const correlator = createCorrelator({ notebook });

    await correlator.registerSession("job-1", "session-1");

    expect(correlator.resolveJobId("session-1")).toBe("job-1");
  });

  it("backfills earlier hook rows when the session is registered after the hook arrives", async () => {
    const notebook = new InMemoryNotebookClient();
    const correlator = createCorrelator({ notebook });

    notebook.appendHookEvent({
      sessionId: "session-late",
      eventType: "PreToolUse",
      payloadJson: '{"hook_event_name":"PreToolUse"}',
      receivedAt: 1,
    });

    await correlator.recordHook("session-late");
    await correlator.registerSession("job-late", "session-late");

    expect(notebook.hookEvents).toEqual([
      expect.objectContaining({
        jobId: "job-late",
        sessionId: "session-late",
      }),
    ]);
  });

  it("eagerly backfills when a hook arrives after the session is already known", async () => {
    const notebook = new InMemoryNotebookClient();
    const correlator = createCorrelator({ notebook });

    await correlator.registerSession("job-eager", "session-eager");
    notebook.appendHookEvent({
      sessionId: "session-eager",
      eventType: "Stop",
      payloadJson: '{"hook_event_name":"Stop"}',
      receivedAt: 2,
    });

    const resolvedJobId = await correlator.recordHook("session-eager");

    expect(resolvedJobId).toBe("job-eager");
    expect(notebook.hookEvents[0]).toMatchObject({
      jobId: "job-eager",
      sessionId: "session-eager",
    });
  });

  it("publishes the live mapping before async backfill finishes so concurrent resolves can succeed", async () => {
    const notebook = {
      backfillHookEvents: vi.fn(async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
        return 0;
      }),
    };
    const correlator = createCorrelator({ notebook });

    const registerPromise = correlator.registerSession("job-race", "session-race");

    expect(correlator.resolveJobId("session-race")).toBe("job-race");
    await registerPromise;
  });

  it("does a final sweep on retire and stops correlating new hooks afterward", async () => {
    const notebook = new InMemoryNotebookClient();
    const correlator = createCorrelator({ notebook });

    await correlator.registerSession("job-retire", "session-retire");
    notebook.appendHookEvent({
      sessionId: "session-retire",
      eventType: "SessionEnd",
      payloadJson: '{"hook_event_name":"SessionEnd"}',
      receivedAt: 3,
    });

    await correlator.retireJob("job-retire");

    expect(notebook.hookEvents[0]).toMatchObject({
      jobId: "job-retire",
      sessionId: "session-retire",
    });
    expect(correlator.resolveJobId("session-retire")).toBeNull();

    notebook.appendHookEvent({
      sessionId: "session-retire",
      eventType: "PostToolUse",
      payloadJson: '{"hook_event_name":"PostToolUse"}',
      receivedAt: 4,
    });
    await correlator.recordHook("session-retire");

    expect(notebook.hookEvents[1]).toMatchObject({
      jobId: null,
      sessionId: "session-retire",
    });
  });
});
