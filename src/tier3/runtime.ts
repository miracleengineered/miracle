// Tier-3 runtime factory (Phase 4 / C8).
//
// Composes the three pieces the integration chain needs to see each
// other: an HTTP listener that writes hook_events, a correlator that
// maps session_id → job_id, and an orchestrator that spawns workers.
// All three share one Correlator instance so eager (listener.recordHook)
// and lazy (orchestrator → captureWorkerSessionId → registerSession) paths
// are both served by the same in-memory map.
//
// Not a CLI entry. Callers (Phase 5 cutover glue, the e2e test) wire the
// runtime against whichever NotebookClient + StartWorker they prefer.

import { createCorrelator, type Correlator } from "../correlation/correlator.js";
import { createHttpListener } from "../http-listener/listener.js";
import type { HttpListener } from "../http-listener/types.js";
import type { NotebookClient } from "../notebook/client.js";
import { runOrchestrator } from "../orchestrator/index.js";
import type { OrchestratorResult, StartWorker } from "../orchestrator/types.js";

/**
 * Narrower notebook type: tier-3 needs both hook-event methods live. The
 * NotebookClient interface keeps them optional (see Phase 3 coordination
 * point 3); this intersection is the caller-boundary narrowing that was
 * established for the listener (HookEventNotebookClient) and correlator
 * (CorrelatorNotebookClient). SqliteNotebookClient declares both methods
 * as non-optional on the class, so it's structurally assignable here
 * without a cast.
 */
export type Tier3Notebook = NotebookClient &
  Required<Pick<NotebookClient, "appendHookEvent" | "backfillHookEvents">>;

export interface Tier3RuntimeConfig {
  notebook: Tier3Notebook;
  /** Pass 0 to bind an ephemeral port; use getFreePort() in tests. */
  port: number;
  /** Defaults to 127.0.0.1 (loopback). Do not bind to 0.0.0.0 in production. */
  host?: string;
  /**
   * Spawns a worker for a child job. C8 forwards whatever the caller
   * provides; Phase 5 ships a production claude spawner. runJob's opts
   * can override per-call.
   */
  startWorker?: StartWorker;
}

export interface Tier3Runtime {
  readonly listener: HttpListener;
  readonly correlator: Correlator;
  runJob(
    ask: string,
    opts?: { startWorker?: StartWorker; conversationSessionId?: string },
  ): Promise<OrchestratorResult>;
  stop(): Promise<void>;
}

export function createTier3Runtime(config: Tier3RuntimeConfig): Tier3Runtime {
  const correlator = createCorrelator({ notebook: config.notebook });
  const listener = createHttpListener({
    host: config.host ?? "127.0.0.1",
    port: config.port,
    notebook: config.notebook,
    correlator,
  });

  return {
    listener,
    correlator,
    async runJob(ask, opts) {
      return runOrchestrator(ask, {
        client: config.notebook,
        correlator,
        startWorker: opts?.startWorker ?? config.startWorker,
        conversationSessionId: opts?.conversationSessionId,
      });
    },
    async stop() {
      await listener.stop();
    },
  };
}
