import type { NotebookClient } from "../notebook/client.js";

export type CorrelatorNotebookClient = Required<
  Pick<NotebookClient, "backfillHookEvents">
>;

export interface Correlator {
  // Called by the orchestrator when a worker subprocess first emits a session_id.
  // Stores the live mapping, then backfills any hook rows that arrived earlier.
  registerSession(jobId: string, sessionId: string): Promise<void>;

  // Hook-arrival moment. Kept as a dedicated method so the listener can trigger
  // eager correlation without duplicating the backfill logic itself.
  recordHook(sessionId: string): Promise<string | null>;

  // Synchronous because the default implementation keeps the live mapping in an
  // in-memory Map rather than consulting sqlite for each lookup.
  resolveJobId(sessionId: string): string | null;

  // Called when the orchestrator sees a terminal job state. Performs one final
  // best-effort backfill sweep, then retires the in-memory mapping.
  retireJob(jobId: string): Promise<void>;
}

export interface CorrelatorConfig {
  notebook: CorrelatorNotebookClient;
}

/**
 * Phase 4 keeps correlation state in memory on purpose.
 *
 * Recovery design call: if the orchestrator restarts mid-session, existing
 * live mappings are lost. Already-written hook rows remain in the notebook, but
 * any rows that never get re-associated by a later registerSession call may
 * stay NULL forever. That is acceptable under the best-effort contract for
 * hook_events.job_id.
 */
export class LiveCorrelator implements Correlator {
  private readonly sessionToJobId = new Map<string, string>();
  private readonly jobToSessionId = new Map<string, string>();

  constructor(private readonly config: CorrelatorConfig) {}

  async registerSession(jobId: string, sessionId: string): Promise<void> {
    const previousSessionId = this.jobToSessionId.get(jobId);
    if (previousSessionId && previousSessionId !== sessionId) {
      this.sessionToJobId.delete(previousSessionId);
    }

    const previousJobId = this.sessionToJobId.get(sessionId);
    if (previousJobId && previousJobId !== jobId) {
      this.jobToSessionId.delete(previousJobId);
    }

    this.jobToSessionId.set(jobId, sessionId);
    this.sessionToJobId.set(sessionId, jobId);

    await this.backfill(sessionId, jobId);
  }

  async recordHook(sessionId: string): Promise<string | null> {
    const jobId = this.resolveJobId(sessionId);
    if (!jobId) {
      return null;
    }

    await this.backfill(sessionId, jobId);
    return jobId;
  }

  resolveJobId(sessionId: string): string | null {
    return this.sessionToJobId.get(sessionId) ?? null;
  }

  async retireJob(jobId: string): Promise<void> {
    const sessionId = this.jobToSessionId.get(jobId);
    if (!sessionId) {
      return;
    }

    await this.backfill(sessionId, jobId);
    this.jobToSessionId.delete(jobId);
    this.sessionToJobId.delete(sessionId);
  }

  private async backfill(sessionId: string, jobId: string): Promise<void> {
    await Promise.resolve(this.config.notebook.backfillHookEvents(sessionId, jobId));
  }
}

export function createCorrelator(config: CorrelatorConfig): Correlator {
  return new LiveCorrelator(config);
}
