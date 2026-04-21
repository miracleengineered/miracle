import { createServer } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { createCorrelator } from "../correlation/correlator.js";
import {
  InMemoryNotebookClient,
  type NotebookClient,
} from "../notebook/client.js";
import { createHttpListener } from "./listener.js";
import type {
  HookEventPayload,
  HttpListener,
  HttpListenerConfig,
} from "./types.js";

const activeListeners = new Set<HttpListener>();
const TEST_LOGGER = {
  warn() {},
  error() {},
};

afterEach(async () => {
  await Promise.all(
    [...activeListeners].map(async (listener) => {
      await listener.stop();
      activeListeners.delete(listener);
    }),
  );
});

describe("HttpListener", () => {
  it("binds to the configured host:port and accepts POST /hook", async () => {
    const port = await getFreePort();
    const notebook = new InMemoryNotebookClient();
    const config: HttpListenerConfig = { host: "127.0.0.1", port };
    const listener = createHttpListener({ ...config, notebook, logger: TEST_LOGGER });
    activeListeners.add(listener);

    await listener.start();

    const response = await fetch(`http://${config.host}:${config.port}/hook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: "session-bind",
        hook_event_name: "SessionStart",
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(notebook.hookEvents).toHaveLength(1);
  });

  it("persists the payload verbatim, session_id populated, job_id null", async () => {
    const port = await getFreePort();
    const notebook = new InMemoryNotebookClient();
    const listener = createHttpListener({
      host: "127.0.0.1",
      port,
      notebook,
      logger: TEST_LOGGER,
    });
    activeListeners.add(listener);

    const payload: HookEventPayload & {
      hook_event_name: string;
      tool_name: string;
    } = {
      session_id: "session-123",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
    };

    const before = Date.now();
    await listener.start();

    const response = await fetch(`http://127.0.0.1:${port}/hook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const after = Date.now();

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(notebook.hookEvents).toEqual([
      {
        jobId: null,
        sessionId: "session-123",
        eventType: "PreToolUse",
        payloadJson: JSON.stringify(payload),
        receivedAt: expect.any(Number),
      },
    ]);
    expect(notebook.hookEvents[0]?.receivedAt).toBeGreaterThanOrEqual(before);
    expect(notebook.hookEvents[0]?.receivedAt).toBeLessThanOrEqual(after);
  });

  it("returns 200 for malformed payloads and stores the raw body", async () => {
    const port = await getFreePort();
    const notebook = new InMemoryNotebookClient();
    const listener = createHttpListener({
      host: "127.0.0.1",
      port,
      notebook,
      logger: TEST_LOGGER,
    });
    activeListeners.add(listener);

    await listener.start();

    const response = await fetch(`http://127.0.0.1:${port}/hook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(notebook.hookEvents).toHaveLength(1);
    expect(notebook.hookEvents[0]).toMatchObject({
      jobId: null,
      sessionId: "",
      eventType: "",
      payloadJson: "{not-json",
    });
  });

  it("returns 500 with a JSON error body when notebook writes fail", async () => {
    const port = await getFreePort();
    const notebook: NotebookClient &
      Required<Pick<NotebookClient, "appendHookEvent">> = {
      createJob() {
        throw new Error("unused");
      },
      updateStatus() {
        throw new Error("unused");
      },
      getChildren() {
        throw new Error("unused");
      },
      writePlanSnapshot() {
        throw new Error("unused");
      },
      appendHookEvent() {
        throw new Error("write failed");
      },
      observeCompletions() {
        throw new Error("unused");
      },
    };
    const listener = createHttpListener({
      host: "127.0.0.1",
      port,
      notebook,
      logger: TEST_LOGGER,
    });
    activeListeners.add(listener);

    await listener.start();

    const response = await fetch(`http://127.0.0.1:${port}/hook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: "session-fail",
        hook_event_name: "Stop",
      }),
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "write failed" });
  });

  it("releases the port on stop so the same port can be reused", async () => {
    const port = await getFreePort();
    const first = createHttpListener({
      host: "127.0.0.1",
      port,
      notebook: new InMemoryNotebookClient(),
      logger: TEST_LOGGER,
    });
    activeListeners.add(first);

    await first.start();
    await first.stop();
    activeListeners.delete(first);

    const secondNotebook = new InMemoryNotebookClient();
    const second = createHttpListener({
      host: "127.0.0.1",
      port,
      notebook: secondNotebook,
      logger: TEST_LOGGER,
    });
    activeListeners.add(second);

    await second.start();

    const response = await fetch(`http://127.0.0.1:${port}/hook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: "session-reuse",
        hook_event_name: "SessionEnd",
      }),
    });

    expect(response.status).toBe(200);
    expect(secondNotebook.hookEvents).toHaveLength(1);
  });

  it("eagerly correlates hook rows when the session mapping already exists", async () => {
    const port = await getFreePort();
    const notebook = new InMemoryNotebookClient();
    const correlator = createCorrelator({ notebook });
    await correlator.registerSession("job-eager", "session-eager");

    const listener = createHttpListener({
      host: "127.0.0.1",
      port,
      notebook,
      correlator,
      logger: TEST_LOGGER,
    });
    activeListeners.add(listener);

    await listener.start();

    const response = await fetch(`http://127.0.0.1:${port}/hook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: "session-eager",
        hook_event_name: "PreToolUse",
      }),
    });

    expect(response.status).toBe(200);
    expect(notebook.hookEvents).toEqual([
      expect.objectContaining({
        jobId: "job-eager",
        sessionId: "session-eager",
        eventType: "PreToolUse",
      }),
    ]);
  });

  it("lazy-backfills hook rows after the session mapping is registered later", async () => {
    const port = await getFreePort();
    const notebook = new InMemoryNotebookClient();
    const correlator = createCorrelator({ notebook });
    const listener = createHttpListener({
      host: "127.0.0.1",
      port,
      notebook,
      correlator,
      logger: TEST_LOGGER,
    });
    activeListeners.add(listener);

    await listener.start();

    const response = await fetch(`http://127.0.0.1:${port}/hook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: "session-lazy",
        hook_event_name: "Stop",
      }),
    });

    expect(response.status).toBe(200);
    expect(notebook.hookEvents[0]).toMatchObject({
      jobId: null,
      sessionId: "session-lazy",
    });

    await correlator.registerSession("job-lazy", "session-lazy");

    expect(notebook.hookEvents[0]).toMatchObject({
      jobId: "job-lazy",
      sessionId: "session-lazy",
    });
  });
});

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
