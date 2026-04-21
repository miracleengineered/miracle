import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";
import {
  createNotebookClient,
  type CreateJobInput,
  type Job,
  type JobStatus,
  type NotebookClient,
} from "../notebook/client.js";
import type { Correlator } from "../correlation/correlator.js";
import {
  captureWorkerSessionIdFromLines,
  runOrchestrator,
} from "./index.js";
import type { ChildJobPayload, ParentJobPayload } from "./types.js";

describe("runOrchestrator", () => {
  it("writes the plan snapshot before fan-out, waits for child completions, and synthesizes in plan order", async () => {
    const baseClient = createNotebookClient();
    const events: string[] = [];
    const parentJobs: Job[] = [];

    const client: NotebookClient = {
      createJob(input: CreateJobInput) {
        const job = baseClient.createJob(input);
        events.push(input.parentId ? `create-child:${job.id}` : `create-parent:${job.id}`);
        if (!input.parentId) {
          parentJobs.push(job);
        }
        return job;
      },
      updateStatus(jobId: string, status: JobStatus, result?: unknown) {
        events.push(`update:${jobId}:${status}`);
        return baseClient.updateStatus(jobId, status, result);
      },
      getChildren(parentId: string) {
        return baseClient.getChildren(parentId);
      },
      writePlanSnapshot(jobId: string, snapshot: unknown) {
        events.push(`snapshot:${jobId}`);
        return baseClient.writePlanSnapshot(jobId, snapshot);
      },
      observeCompletions(parentId: string) {
        events.push(`observe:${parentId}`);
        return baseClient.observeCompletions(parentId);
      },
    };

    const runPromise = runOrchestrator("Gather facts and draft summary", { client });

    await Promise.resolve();

    const parent = parentJobs[0];
    expect(parent).toBeDefined();

    const childJobs = baseClient.getChildren(parent!.id);
    expect(childJobs).toHaveLength(2);
    expect((parent!.payload as ParentJobPayload).model).toBe("opus");
    expect(childJobs.map((job) => (job.payload as ChildJobPayload).model)).toEqual([
      "sonnet",
      "sonnet",
    ]);
    expect(events.indexOf(`snapshot:${parent!.id}`)).toBeLessThan(
      events.indexOf(`create-child:${childJobs[0]!.id}`),
    );

    baseClient.updateStatus(childJobs[1]!.id, "failed", "Summary draft blocked");
    baseClient.updateStatus(childJobs[0]!.id, "completed", "Facts gathered");

    const result = await runPromise;

    expect(result.status).toBe("failed");
    expect(result.planSnapshot.subtasks.map((subtask) => subtask.ask)).toEqual([
      "Gather facts",
      "draft summary",
    ]);
    expect(result.subtasks.map((subtask) => subtask.status)).toEqual(["completed", "failed"]);
    expect(result.output).toContain("## Subtask 1: Gather facts");
    expect(result.output).toContain("Facts gathered");
    expect(result.output).toContain("## Subtask 2: draft summary");
    expect(result.output).toContain("Summary draft blocked");
  });

  it("routes model defaults onto parent and child notebook job payloads", async () => {
    const baseClient = createNotebookClient();
    const createdJobs: Job[] = [];

    const client: NotebookClient = {
      createJob(input: CreateJobInput) {
        const job = baseClient.createJob(input);
        createdJobs.push(job);
        return job;
      },
      updateStatus(jobId: string, status: JobStatus, result?: unknown) {
        return baseClient.updateStatus(jobId, status, result);
      },
      getChildren(parentId: string) {
        return baseClient.getChildren(parentId);
      },
      writePlanSnapshot(jobId: string, snapshot: unknown) {
        return baseClient.writePlanSnapshot(jobId, snapshot);
      },
      observeCompletions(parentId: string) {
        return baseClient.observeCompletions(parentId);
      },
    };

    const runPromise = runOrchestrator("Summarize the roadmap", { client });

    await Promise.resolve();

    const parent = createdJobs.find((job) => job.parentId === null);
    expect(parent).toBeDefined();
    expect((parent!.payload as ParentJobPayload).kind).toBe("orchestrator");
    expect((parent!.payload as ParentJobPayload).model).toBe("opus");

    const [childJob] = baseClient.getChildren(parent!.id);
    expect(childJob).toBeDefined();
    expect((childJob!.payload as ChildJobPayload).kind).toBe("orchestrator-subtask");
    expect((childJob!.payload as ChildJobPayload).model).toBe("sonnet");

    baseClient.updateStatus(childJob!.id, "completed", "Roadmap summarized");

    const result = await runPromise;
    expect(result.status).toBe("completed");
  });

  it("captures the first session_id from worker stdout and ignores later ones", async () => {
    const correlator: Correlator = {
      registerSession: async () => {},
      recordHook: async () => null,
      resolveJobId: () => null,
      retireJob: async () => {},
    };
    const registerCalls: Array<{ jobId: string; sessionId: string }> = [];
    correlator.registerSession = async (jobId, sessionId) => {
      registerCalls.push({ jobId, sessionId });
    };

    const sessionId = await captureWorkerSessionIdFromLines({
      jobId: "job-stream",
      lines: (async function* () {
        yield "not-json";
        yield '{"type":"assistant"}';
        yield '{"session_id":"session-first","type":"assistant"}';
        yield '{"session_id":"session-second","type":"assistant"}';
      })(),
      correlator,
    });

    expect(sessionId).toBe("session-first");
    expect(registerCalls).toEqual([
      { jobId: "job-stream", sessionId: "session-first" },
    ]);
  });

  it("wires worker stdout capture and retires child mappings when jobs go terminal", async () => {
    const baseClient = createNotebookClient();
    const registerCalls: Array<{ jobId: string; sessionId: string }> = [];
    const retireCalls: string[] = [];
    const correlator: Correlator = {
      async registerSession(jobId, sessionId) {
        registerCalls.push({ jobId, sessionId });
      },
      async recordHook() {
        return null;
      },
      resolveJobId() {
        return null;
      },
      async retireJob(jobId) {
        retireCalls.push(jobId);
      },
    };

    const resultPromise = runOrchestrator("Summarize the roadmap", {
      client: baseClient,
      correlator,
      startWorker(job) {
        queueMicrotask(() => {
          baseClient.updateStatus(job.id, "completed", `${job.id} done`);
        });
        return {
          stdout: Readable.from([
            `{"session_id":"session-for-${job.id}","type":"assistant"}\n`,
          ]),
        };
      },
    });

    const result = await resultPromise;
    await vi.waitFor(() => {
      expect(registerCalls).toHaveLength(1);
    });

    expect(result.status).toBe("completed");
    expect(result.subtasks).toHaveLength(1);
    expect(registerCalls).toEqual([
      {
        jobId: result.subtasks[0]!.jobId,
        sessionId: `session-for-${result.subtasks[0]!.jobId}`,
      },
    ]);
    expect(retireCalls).toContain(result.subtasks[0]!.jobId);
    expect(retireCalls).toContain(result.parentJobId);
  });
});
