// SCAFFOLDING — replaced by C3 in Phase 3. Do not extend.

import { newJobId } from "../util/jobId.js";

export type JobStatus = "pending" | "running" | "completed" | "failed";

export interface CreateJobInput {
  id?: string;
  parentId?: string | null;
  payload: unknown;
}

export interface Job {
  id: string;
  parentId: string | null;
  status: JobStatus;
  payload: unknown;
  planSnapshot: unknown | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  result: unknown | null;
}

export interface NotebookClient {
  createJob(input: CreateJobInput): Job;
  updateStatus(jobId: string, status: JobStatus, result?: unknown): Job;
  getChildren(parentId: string): Job[];
  writePlanSnapshot(jobId: string, snapshot: unknown): Job;
  observeCompletions(parentId: string): AsyncIterable<Job>;
}

class InMemoryNotebookClient implements NotebookClient {
  private jobs = new Map<string, Job>();
  // Per-parent buffer of completions waiting to be observed.
  private buffers = new Map<string, Job[]>();
  // Per-parent single pending resolver (set when an iterator is currently awaiting).
  private waiters = new Map<string, (job: Job) => void>();

  createJob(input: CreateJobInput): Job {
    const now = Date.now();
    const job: Job = {
      id: input.id ?? newJobId(),
      parentId: input.parentId ?? null,
      status: "pending",
      payload: input.payload,
      planSnapshot: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      result: null,
    };
    this.jobs.set(job.id, job);
    return job;
  }

  updateStatus(jobId: string, status: JobStatus, result?: unknown): Job {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);
    const now = Date.now();
    const isTerminal = status === "completed" || status === "failed";
    const next: Job = {
      ...job,
      status,
      updatedAt: now,
      completedAt: isTerminal ? now : job.completedAt,
      result: result ?? job.result,
    };
    this.jobs.set(jobId, next);
    if (isTerminal && next.parentId) {
      const waiter = this.waiters.get(next.parentId);
      if (waiter) {
        this.waiters.delete(next.parentId);
        waiter(next);
      } else {
        const buf = this.buffers.get(next.parentId) ?? [];
        buf.push(next);
        this.buffers.set(next.parentId, buf);
      }
    }
    return next;
  }

  getChildren(parentId: string): Job[] {
    return [...this.jobs.values()].filter((j) => j.parentId === parentId);
  }

  writePlanSnapshot(jobId: string, snapshot: unknown): Job {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);
    const next: Job = { ...job, planSnapshot: snapshot, updatedAt: Date.now() };
    this.jobs.set(jobId, next);
    return next;
  }

  async *observeCompletions(parentId: string): AsyncIterable<Job> {
    const seen = new Set<string>();
    for (const j of this.getChildren(parentId)) {
      if ((j.status === "completed" || j.status === "failed") && !seen.has(j.id)) {
        seen.add(j.id);
        yield j;
      }
    }
    while (this.getChildren(parentId).some((j) => !seen.has(j.id))) {
      const buf = this.buffers.get(parentId) ?? [];
      let next: Job | undefined;
      while (buf.length > 0) {
        const candidate = buf.shift();
        if (candidate && !seen.has(candidate.id)) {
          next = candidate;
          break;
        }
      }
      if (buf.length === 0) this.buffers.delete(parentId);
      else this.buffers.set(parentId, buf);

      if (!next) {
        next = await new Promise<Job>((resolve) => {
          this.waiters.set(parentId, resolve);
        });
      }
      if (!seen.has(next.id)) {
        seen.add(next.id);
        yield next;
      }
    }
  }
}

export function createNotebookClient(): NotebookClient {
  return new InMemoryNotebookClient();
}
