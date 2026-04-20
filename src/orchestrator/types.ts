import type { JobStatus } from "../notebook/client.js";

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
}

export interface ParentJobPayload {
  kind: "orchestrator";
  ask: string;
}

export interface ChildJobPayload {
  kind: "orchestrator-subtask";
  ask: string;
  index: number;
  parentAsk: string;
}
