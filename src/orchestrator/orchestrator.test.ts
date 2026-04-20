import { describe, expect, it } from "vitest";
import {
  createNotebookClient,
  type CreateJobInput,
  type Job,
  type JobStatus,
  type NotebookClient,
} from "../notebook/client.js";
import { runOrchestrator } from "./index.js";

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
});
