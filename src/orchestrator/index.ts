import { createNotebookClient, type Job, type NotebookClient } from "../notebook/client.js";
import { resolveModel } from "../routing/resolveModel.js";
import { decomposeAsk } from "./decompose.js";
import { synthesizeResults } from "./synthesize.js";
import type {
  ChildJobPayload,
  OrchestratorResult,
  ParentJobPayload,
  PlanSnapshot,
  SubtaskResult,
  TerminalSubtaskStatus,
} from "./types.js";

function createPlanSnapshot(ask: string): PlanSnapshot {
  const subtasks = decomposeAsk(ask);
  return {
    strategy: "rule-based-v1",
    ask,
    subtaskCount: subtasks.length,
    subtasks,
  };
}

function toSubtaskResult(job: Job, prompt: string, index: number): SubtaskResult {
  if (job.status !== "completed" && job.status !== "failed") {
    throw new Error(`Child job ${job.id} is not terminal`);
  }

  return {
    jobId: job.id,
    index,
    ask: prompt,
    status: job.status,
    result: job.result,
    completedAt: job.completedAt,
  };
}

function toErrorResult(error: unknown): { message: string } {
  if (error instanceof Error) {
    return { message: error.message };
  }

  return { message: String(error) };
}

export async function runOrchestrator(
  ask: string,
  opts: { client?: NotebookClient } = {},
): Promise<OrchestratorResult> {
  const normalizedAsk = ask.trim();
  if (!normalizedAsk) {
    throw new Error("Orchestrator ask must not be empty");
  }

  const client = opts.client ?? createNotebookClient();
  const parentPayload: ParentJobPayload = {
    kind: "orchestrator",
    ask: normalizedAsk,
    model: resolveModel("orchestrator"),
  };
  const parentJob = client.createJob({ payload: parentPayload });

  try {
    const planSnapshot = createPlanSnapshot(normalizedAsk);
    client.writePlanSnapshot(parentJob.id, planSnapshot);

    const childJobs = planSnapshot.subtasks.map((subtask) => {
      const payload: ChildJobPayload = {
        kind: "orchestrator-subtask",
        ask: subtask.ask,
        index: subtask.index,
        parentAsk: normalizedAsk,
        model: resolveModel("orchestrator-subtask"),
      };
      const job = client.createJob({
        parentId: parentJob.id,
        payload,
      });
      return {
        job,
        subtask,
      };
    });

    client.updateStatus(parentJob.id, "running");

    const completionsById = new Map<string, Job>();
    for await (const completedJob of client.observeCompletions(parentJob.id)) {
      completionsById.set(completedJob.id, completedJob);
      if (completionsById.size === childJobs.length) {
        break;
      }
    }

    const subtasks = childJobs.map(({ job, subtask }) => {
      const terminalJob = completionsById.get(job.id);
      if (!terminalJob) {
        throw new Error(`Missing terminal result for child job ${job.id}`);
      }
      return toSubtaskResult(terminalJob, subtask.ask, subtask.index);
    });

    const status: TerminalSubtaskStatus = subtasks.some((subtask) => subtask.status === "failed")
      ? "failed"
      : "completed";
    const output = synthesizeResults(subtasks);

    client.updateStatus(parentJob.id, status, {
      output,
      subtasks,
      planSnapshot,
    });

    return {
      parentJobId: parentJob.id,
      ask: normalizedAsk,
      status,
      planSnapshot,
      subtasks,
      output,
    };
  } catch (error) {
    client.updateStatus(parentJob.id, "failed", toErrorResult(error));
    throw error;
  }
}

export type { OrchestratorResult } from "./types.js";
