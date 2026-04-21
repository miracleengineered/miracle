import { describe, expect, it } from "vitest";
import {
  createNotebookClient,
  type CreateJobInput,
  type Job,
  type JobStatus,
  type NotebookClient,
} from "../notebook/client.js";
import { runOrchestrator } from "./index.js";
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
});
