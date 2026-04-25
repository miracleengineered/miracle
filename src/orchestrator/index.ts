import type { Correlator } from "../correlation/correlator.js";
import { createNotebookClient, type Job, type NotebookClient } from "../notebook/client.js";
import { resolveModel } from "../routing/resolveModel.js";
import { decomposeAsk } from "./decompose.js";
import { captureWorkerSessionId } from "./sessionCapture.js";
import { synthesizeResults } from "./synthesize.js";
import type {
  ChildJobPayload,
  OnEvent,
  OrchestratorResult,
  ParentJobPayload,
  PlanSnapshot,
  StartWorker,
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
  opts: {
    client?: NotebookClient;
    correlator?: Correlator;
    startWorker?: StartWorker;
    conversationSessionId?: string;
    onEvent?: OnEvent;
  } = {},
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
        ...(opts.conversationSessionId
          ? { conversationSessionId: opts.conversationSessionId }
          : {}),
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

    if (opts.startWorker) {
      for (const { job } of childJobs) {
        const handle = await opts.startWorker(job, { onEvent: opts.onEvent });
        if (handle?.stdout && opts.correlator) {
          void captureWorkerSessionId({
            jobId: job.id,
            stdout: handle.stdout,
            correlator: opts.correlator,
          });
        }
      }
    }

    const completionsById = new Map<string, Job>();
    const capturedSessionIds = new Map<string, string>();
    for await (const completedJob of client.observeCompletions(parentJob.id)) {
      completionsById.set(completedJob.id, completedJob);
      if (opts.correlator) {
        const sessionId = opts.correlator.resolveSessionId(completedJob.id);
        if (sessionId) {
          capturedSessionIds.set(completedJob.id, sessionId);
        }
        await opts.correlator.retireJob(completedJob.id);
      }
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

    const firstChildJobId = childJobs[0]?.job.id;
    const conversationSessionId = firstChildJobId
      ? (capturedSessionIds.get(firstChildJobId) ?? opts.conversationSessionId ?? null)
      : (opts.conversationSessionId ?? null);

    client.updateStatus(parentJob.id, status, {
      output,
      subtasks,
      planSnapshot,
    });
    if (opts.correlator) {
      await opts.correlator.retireJob(parentJob.id);
    }

    return {
      parentJobId: parentJob.id,
      ask: normalizedAsk,
      status,
      planSnapshot,
      subtasks,
      output,
      conversationSessionId,
    };
  } catch (error) {
    client.updateStatus(parentJob.id, "failed", toErrorResult(error));
    if (opts.correlator) {
      await opts.correlator.retireJob(parentJob.id);
    }
    throw error;
  }
}

export type { OrchestratorResult } from "./types.js";
export {
  captureWorkerSessionId,
  captureWorkerSessionIdFromLines,
} from "./sessionCapture.js";
