import type { Job, JobStatus } from "../notebook/client.js";
import type { ModelName } from "../types/phase3.js";

export type TerminalSubtaskStatus = Extract<JobStatus, "completed" | "failed">;

export interface DecomposedSubtask {
  index: number;
  ask: string;
}

export interface PlanSnapshot {
  strategy: "rule-based-v1";
  ask: string;
  subtaskCount: number;
  subtasks: DecomposedSubtask[];
}

export interface SubtaskResult {
  jobId: string;
  index: number;
  ask: string;
  status: TerminalSubtaskStatus;
  result: unknown;
  completedAt: number | null;
}

export interface OrchestratorResult {
  parentJobId: string;
  ask: string;
  status: TerminalSubtaskStatus;
  planSnapshot: PlanSnapshot;
  subtasks: SubtaskResult[];
  output: string;
  conversationSessionId: string | null;
}

export interface ParentJobPayload {
  kind: "orchestrator";
  ask: string;
  model: ModelName;
}

export interface ChildJobPayload {
  kind: "orchestrator-subtask";
  ask: string;
  index: number;
  parentAsk: string;
  model: ModelName;
  conversationSessionId?: string;
}

export interface WorkerHandle {
  stdout?: NodeJS.ReadableStream | null;
}

/**
 * Per-event callback fed by the worker's stdout NDJSON reader.
 * Optional and additive: when omitted, worker behavior is byte-identical
 * to pre-onEvent (just captures session_id + emits terminal status).
 */
export type OnEvent = (event: unknown) => void | Promise<void>;

export type StartWorker = (
  job: Job,
  opts?: { onEvent?: OnEvent },
) => void | WorkerHandle | Promise<void | WorkerHandle>;
