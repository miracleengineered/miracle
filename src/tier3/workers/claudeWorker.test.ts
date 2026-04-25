import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { PassThrough, Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import type { Correlator } from "../../correlation/correlator.js";
import {
  createNotebookClient,
  type Job,
  type JobStatus,
  type NotebookClient,
} from "../../notebook/client.js";
import type { ChildJobPayload } from "../../orchestrator/types.js";
import { createClaudeWorker } from "./claudeWorker.js";

interface FakeChildOptions {
  stdoutChunks: string[];
  stderrChunks?: string[];
  exitCode?: number | null;
  signalCode?: string | null;
}

function makeFakeChild(opts: FakeChildOptions): ChildProcess {
  const stdin = new PassThrough();
  const stdout = Readable.from(opts.stdoutChunks);
  const stderr = Readable.from(opts.stderrChunks ?? []);
  const emitter = new EventEmitter();
  const child = Object.assign(emitter, {
    stdin,
    stdout,
    stderr,
    exitCode: null as number | null,
    signalCode: opts.signalCode ?? null,
  });
  // When stdout drains, set exitCode so the worker sees it after its
  // for-await loop exits.
  stdout.on("end", () => {
    child.exitCode = opts.exitCode ?? 0;
  });
  return child as unknown as ChildProcess;
}

function makeRecordingCorrelator(): Correlator & {
  registerCalls: Array<{ jobId: string; sessionId: string }>;
} {
  const registerCalls: Array<{ jobId: string; sessionId: string }> = [];
  return {
    registerCalls,
    async registerSession(jobId, sessionId) {
      registerCalls.push({ jobId, sessionId });
    },
    async recordHook() {
      return null;
    },
    resolveJobId() {
      return null;
    },
    resolveSessionId() {
      return null;
    },
    async retireJob() {
      // no-op
    },
  };
}

function makeRecordingClient(): {
  client: NotebookClient;
  updateCalls: Array<{ jobId: string; status: JobStatus; result: unknown }>;
  createdJobs: Job[];
} {
  const base = createNotebookClient();
  const updateCalls: Array<{ jobId: string; status: JobStatus; result: unknown }> = [];
  const createdJobs: Job[] = [];
  const client: NotebookClient = {
    createJob(input) {
      const job = base.createJob(input);
      createdJobs.push(job);
      return job;
    },
    updateStatus(jobId, status, result) {
      updateCalls.push({ jobId, status, result });
      return base.updateStatus(jobId, status, result);
    },
    getChildren(parentId) {
      return base.getChildren(parentId);
    },
    writePlanSnapshot(jobId, snapshot) {
      return base.writePlanSnapshot(jobId, snapshot);
    },
    observeCompletions(parentId) {
      return base.observeCompletions(parentId);
    },
  };
  return { client, updateCalls, createdJobs };
}

function createChildJob(client: NotebookClient, ask: string, model = "sonnet"): Job {
  const parent = client.createJob({
    payload: { kind: "orchestrator", ask: "parent", model: "opus" },
  });
  const childPayload: ChildJobPayload = {
    kind: "orchestrator-subtask",
    ask,
    index: 0,
    parentAsk: "parent",
    model: model as ChildJobPayload["model"],
  };
  return client.createJob({ parentId: parent.id, payload: childPayload });
}

async function waitForTerminal(updateCalls: Array<{ status: JobStatus }>): Promise<void> {
  // driveSubprocess runs async and depends on I/O loop turns (stream 'end',
  // readline flush); a microtask flush isn't enough. vi.waitFor polls until
  // the updateStatus call lands.
  await vi.waitFor(() => {
    expect(updateCalls.some((c) => c.status === "completed" || c.status === "failed")).toBe(true);
  });
}

describe("createClaudeWorker", () => {
  it("captures session_id, waits for result event, and writes completed status", async () => {
    const { client, updateCalls } = makeRecordingClient();
    const correlator = makeRecordingCorrelator();
    const job = createChildJob(client, "Summarize the project.");

    const fakeChild = makeFakeChild({
      stdoutChunks: [
        `{"type":"system","subtype":"init","session_id":"sess-abc"}\n`,
        `{"type":"assistant","session_id":"sess-abc","message":{"content":[{"type":"text","text":"Hello"}]}}\n`,
        `{"type":"result","subtype":"success","session_id":"sess-abc","result":"final answer"}\n`,
      ],
      exitCode: 0,
    });

    const spawn = vi.fn((_cmd: string, _args: readonly string[], _opts: SpawnOptions) => fakeChild);

    const worker = createClaudeWorker({
      client,
      correlator,
      claudeCliPath: "/bin/claude",
      workingDir: "/tmp/workdir",
      spawn,
    });

    const handle = await worker(job);
    expect(handle).toEqual({ stdout: null });
    expect(spawn).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawn.mock.calls[0]!;
    expect(cmd).toBe("/bin/claude");
    expect(args).toContain("-p");
    expect(args).toContain("--output-format");
    expect(args).toContain("stream-json");
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).toEqual(expect.arrayContaining(["--model", "sonnet"]));

    await vi.waitFor(() => {
      expect(updateCalls.some((c) => c.status === "completed")).toBe(true);
    });

    expect(correlator.registerCalls).toEqual([{ jobId: job.id, sessionId: "sess-abc" }]);

    const completed = updateCalls.find((c) => c.status === "completed");
    expect(completed?.jobId).toBe(job.id);
    expect(completed?.result).toBe("final answer");
  });

  it("marks job failed when result event reports is_error=true", async () => {
    const { client, updateCalls } = makeRecordingClient();
    const correlator = makeRecordingCorrelator();
    const job = createChildJob(client, "Something broken");

    const fakeChild = makeFakeChild({
      stdoutChunks: [
        `{"type":"result","subtype":"error","session_id":"sess-err","is_error":true,"error":"rate limited"}\n`,
      ],
      exitCode: 0,
    });

    const worker = createClaudeWorker({
      client,
      correlator,
      claudeCliPath: "/bin/claude",
      workingDir: "/tmp/workdir",
      spawn: () => fakeChild,
    });

    await worker(job);
    await waitForTerminal(updateCalls);

    const failed = updateCalls.find((c) => c.status === "failed");
    expect(failed?.jobId).toBe(job.id);
    expect(failed?.result).toMatchObject({ error: "rate limited" });
  });

  it("marks job failed when CLI exits non-zero with no result event", async () => {
    const { client, updateCalls } = makeRecordingClient();
    const correlator = makeRecordingCorrelator();
    const job = createChildJob(client, "Broken run");

    const fakeChild = makeFakeChild({
      stdoutChunks: [],
      stderrChunks: ["boom\n"],
      exitCode: 1,
    });

    const worker = createClaudeWorker({
      client,
      correlator,
      claudeCliPath: "/bin/claude",
      workingDir: "/tmp/workdir",
      spawn: () => fakeChild,
    });

    await worker(job);
    await waitForTerminal(updateCalls);

    const failed = updateCalls.find((c) => c.status === "failed");
    expect(failed?.jobId).toBe(job.id);
    expect(failed?.result).toMatchObject({
      error: expect.stringContaining("exited with code 1"),
      stderr: "boom",
    });
  });

  it("marks job failed when CLI closes with zero exit but no result event", async () => {
    const { client, updateCalls } = makeRecordingClient();
    const correlator = makeRecordingCorrelator();
    const job = createChildJob(client, "Silent run");

    const fakeChild = makeFakeChild({
      stdoutChunks: [`{"type":"assistant","session_id":"sess-silent","message":{"content":[]}}\n`],
      exitCode: 0,
    });

    const worker = createClaudeWorker({
      client,
      correlator,
      claudeCliPath: "/bin/claude",
      workingDir: "/tmp/workdir",
      spawn: () => fakeChild,
    });

    await worker(job);
    await waitForTerminal(updateCalls);

    const failed = updateCalls.find((c) => c.status === "failed");
    expect(failed?.jobId).toBe(job.id);
    expect(failed?.result).toMatchObject({
      error: expect.stringContaining("without emitting a result event"),
    });
  });

  it("refuses to spawn when child payload has no non-empty ask", async () => {
    const { client, updateCalls } = makeRecordingClient();
    const correlator = makeRecordingCorrelator();
    // Create a parent + child directly so we can inject a blank ask.
    const parent = client.createJob({
      payload: { kind: "orchestrator", ask: "parent", model: "opus" },
    });
    const job = client.createJob({
      parentId: parent.id,
      payload: {
        kind: "orchestrator-subtask",
        ask: "   ",
        index: 0,
        parentAsk: "parent",
        model: "sonnet",
      },
    });

    const spawn = vi.fn(() => makeFakeChild({ stdoutChunks: [], exitCode: 0 }));
    const worker = createClaudeWorker({
      client,
      correlator,
      claudeCliPath: "/bin/claude",
      workingDir: "/tmp/workdir",
      spawn,
    });

    await worker(job);
    await waitForTerminal(updateCalls);

    expect(spawn).not.toHaveBeenCalled();
    const failed = updateCalls.find((c) => c.status === "failed");
    expect(failed?.jobId).toBe(job.id);
    expect(failed?.result).toMatchObject({
      error: expect.stringContaining("missing non-empty `ask`"),
    });
  });

  it("tolerates malformed NDJSON lines and still completes on a later valid result event", async () => {
    const { client, updateCalls } = makeRecordingClient();
    const correlator = makeRecordingCorrelator();
    const job = createChildJob(client, "Parse noise");

    const fakeChild = makeFakeChild({
      stdoutChunks: [
        `not json at all\n`,
        `{malformed\n`,
        `{"type":"result","session_id":"sess-noise","result":"ok"}\n`,
      ],
      exitCode: 0,
    });

    const worker = createClaudeWorker({
      client,
      correlator,
      claudeCliPath: "/bin/claude",
      workingDir: "/tmp/workdir",
      spawn: () => fakeChild,
    });

    await worker(job);
    await waitForTerminal(updateCalls);

    const completed = updateCalls.find((c) => c.status === "completed");
    expect(completed?.result).toBe("ok");
    expect(correlator.registerCalls).toEqual([{ jobId: job.id, sessionId: "sess-noise" }]);
  });

  it("passes --resume <id> when conversationSessionId is set on the payload", async () => {
    const { client, updateCalls } = makeRecordingClient();
    const correlator = makeRecordingCorrelator();
    const parent = client.createJob({
      payload: { kind: "orchestrator", ask: "parent", model: "opus" },
    });
    const job = client.createJob({
      parentId: parent.id,
      payload: {
        kind: "orchestrator-subtask",
        ask: "Continue the thread",
        index: 0,
        parentAsk: "parent",
        model: "sonnet",
        conversationSessionId: "fixture-session-xyz",
      },
    });

    const fakeChild = makeFakeChild({
      stdoutChunks: [`{"type":"result","session_id":"fixture-session-xyz","result":"ok"}\n`],
      exitCode: 0,
    });

    const spawn = vi.fn((_cmd: string, _args: readonly string[], _opts: SpawnOptions) => fakeChild);

    const worker = createClaudeWorker({
      client,
      correlator,
      claudeCliPath: "/bin/claude",
      workingDir: "/tmp/workdir",
      spawn,
    });

    await worker(job);
    await waitForTerminal(updateCalls);

    expect(spawn).toHaveBeenCalledTimes(1);
    const [, args] = spawn.mock.calls[0]!;
    const resumeIdx = args.indexOf("--resume");
    expect(resumeIdx).toBeGreaterThanOrEqual(0);
    expect(args[resumeIdx + 1]).toBe("fixture-session-xyz");

    const { client: client2, updateCalls: updateCalls2 } = makeRecordingClient();
    const correlator2 = makeRecordingCorrelator();
    const job2 = createChildJob(client2, "No resume here");
    const fakeChild2 = makeFakeChild({
      stdoutChunks: [`{"type":"result","session_id":"sess-noresume","result":"ok"}\n`],
      exitCode: 0,
    });
    const spawn2 = vi.fn(
      (_cmd: string, _args: readonly string[], _opts: SpawnOptions) => fakeChild2,
    );
    const worker2 = createClaudeWorker({
      client: client2,
      correlator: correlator2,
      claudeCliPath: "/bin/claude",
      workingDir: "/tmp/workdir",
      spawn: spawn2,
    });
    await worker2(job2);
    await waitForTerminal(updateCalls2);
    const [, args2] = spawn2.mock.calls[0]!;
    expect(args2).not.toContain("--resume");
  });
});
