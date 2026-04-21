// Production StartWorker for Tier3Runtime.
//
// Phase 5a item 1 wired createTier3Runtime into index.ts but left startWorker
// undefined. Without it runOrchestrator creates child jobs in "pending" and
// then blocks in observeCompletions forever because no one advances them to
// terminal. This module fills that gap.
//
// Design:
// - Spawns `claude -p --verbose --output-format stream-json
//   --dangerously-skip-permissions --model <payload.model>` with the child
//   job's ask piped to stdin. Same CLI shape as src/session.ts (the MVP
//   ClaudeSession) but stripped of the Telegram streaming machinery.
// - Consumes stdout itself (NDJSON via readline), so it returns
//   `{ stdout: null }` from the StartWorker handle. This keeps the
//   orchestrator's built-in captureWorkerSessionId path off — there's only
//   one reader on the stream.
// - Calls correlator.registerSession(jobId, session_id) on the first event
//   carrying session_id. That's what lets hook events posted by the subprocess
//   (via ~/miracle-workspace/.claude/settings.json HTTP hooks) get correlated
//   to this job_id in hook_events.
// - Calls client.updateStatus(jobId, terminalStatus, result) when the
//   subprocess either emits a `type:"result"` NDJSON event or exits. This is
//   the signal observeCompletions waits for.
// - Returns from the StartWorker call as soon as spawn() returns. Subprocess
//   processing runs as a detached Promise; multiple children run in parallel.
// - Scrubs ANTHROPIC_API_KEY et al. from the child env via
//   environmentForClaudeChild() so billing stays on the subscription CLI.
//
// Not reused from session.ts: session persistence (single-shot per subtask,
// no resume), message queue (orchestrator owns concurrency), Telegram
// streaming/signatures (no UI here), ask_user MCP handling, partial-message
// dedup (only the final `result` event matters), prompt-too-long auto-clear
// (subtasks are single-shot).

import {
  spawn as defaultSpawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { createInterface } from "node:readline";

import type { Correlator } from "../../correlation/correlator.js";
import type { NotebookClient } from "../../notebook/client.js";
import type { StartWorker, WorkerHandle } from "../../orchestrator/types.js";

type WorkerLogger = Pick<Console, "warn" | "error">;

type SpawnLike = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface ClaudeWorkerConfig {
  client: NotebookClient;
  correlator: Correlator;
  /** Absolute path to the claude CLI binary (CLAUDE_CLI_PATH env). */
  claudeCliPath: string;
  /** Working directory claude runs in (CLAUDE_WORKING_DIR env). */
  workingDir: string;
  /**
   * Environment for the child. Callers pass the result of
   * environmentForClaudeChild() to strip ANTHROPIC_API_KEY etc. Passing
   * `undefined` means inherit process.env verbatim — tests use that path;
   * production wiring must pass the scrubbed env.
   */
  env?: NodeJS.ProcessEnv;
  logger?: WorkerLogger;
  /** Injectable for tests. Defaults to node's spawn. */
  spawn?: SpawnLike;
}

interface ChildPayload {
  ask?: unknown;
  model?: unknown;
}

/**
 * Build a StartWorker that drives claude CLI subprocesses to completion and
 * records session_id → job_id mappings as it goes.
 */
export function createClaudeWorker(config: ClaudeWorkerConfig): StartWorker {
  const logger = config.logger ?? console;
  const spawnFn = config.spawn ?? defaultSpawn;

  return (job) => {
    const payload = (job.payload ?? {}) as ChildPayload;
    const ask = typeof payload.ask === "string" ? payload.ask : "";
    const model = typeof payload.model === "string" ? payload.model : null;

    if (!ask.trim()) {
      config.client.updateStatus(job.id, "failed", {
        error: "Child job payload missing non-empty `ask`",
      });
      return { stdout: null } satisfies WorkerHandle;
    }

    const args = [
      "-p",
      "--verbose",
      "--output-format",
      "stream-json",
      "--dangerously-skip-permissions",
    ];
    if (model) {
      args.push("--model", model);
    }

    let child: ChildProcess;
    try {
      child = spawnFn(config.claudeCliPath, args, {
        cwd: config.workingDir,
        env: config.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (spawnError) {
      config.client.updateStatus(job.id, "failed", {
        error: `Failed to spawn claude: ${stringifyError(spawnError)}`,
      });
      return { stdout: null } satisfies WorkerHandle;
    }

    const stdin = child.stdin;
    if (stdin) {
      try {
        stdin.write(ask);
        stdin.end();
      } catch (writeError) {
        logger.warn(
          `claudeWorker: failed to write prompt for job ${job.id}`,
          writeError,
        );
      }
    }

    // Drive completion in the background. Orchestrator awaits observeCompletions
    // for the terminal status written inside this promise.
    void driveSubprocess({
      job,
      child,
      client: config.client,
      correlator: config.correlator,
      logger,
    });

    // stdout is null in the returned handle because we own its reader. If we
    // returned child.stdout here the orchestrator's captureWorkerSessionId
    // would attach a second readline, and readline/stdout only has one
    // consumer safely.
    return { stdout: null } satisfies WorkerHandle;
  };
}

interface DriveSubprocessConfig {
  job: Parameters<StartWorker>[0];
  child: ChildProcess;
  client: NotebookClient;
  correlator: Correlator;
  logger: WorkerLogger;
}

async function driveSubprocess(
  config: DriveSubprocessConfig,
): Promise<void> {
  const { job, child, client, correlator, logger } = config;

  const stderrChunks: string[] = [];
  if (child.stderr) {
    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk.toString());
    });
  }

  let resultText: string | null = null;
  let errorText: string | null = null;
  let sessionIdCaptured = false;

  try {
    if (child.stdout) {
      const rl = createInterface({ input: child.stdout });
      for await (const line of rl) {
        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }

        if (!event || typeof event !== "object") {
          continue;
        }
        const e = event as Record<string, unknown>;

        if (!sessionIdCaptured && typeof e.session_id === "string") {
          sessionIdCaptured = true;
          try {
            await correlator.registerSession(job.id, e.session_id);
          } catch (registerError) {
            logger.warn(
              `claudeWorker: correlator.registerSession failed for job ${job.id}`,
              registerError,
            );
          }
        }

        if (e.type === "result") {
          const isError =
            e.is_error === true || e.subtype === "error";
          if (isError) {
            errorText =
              typeof e.error === "string"
                ? e.error
                : typeof e.result === "string"
                  ? e.result
                  : "claude CLI reported error result";
          } else if (typeof e.result === "string") {
            resultText = e.result;
          }
        }
      }
    }
  } catch (streamError) {
    logger.warn(
      `claudeWorker: stdout stream errored for job ${job.id}`,
      streamError,
    );
    if (!errorText) {
      errorText = `stdout read failed: ${stringifyError(streamError)}`;
    }
  }

  const exitCode = child.exitCode;
  const exitSignal = child.signalCode;
  const stderrJoined = stderrChunks.join("").trim();

  if (errorText) {
    client.updateStatus(job.id, "failed", {
      error: errorText,
      stderr: stderrJoined || undefined,
    });
    return;
  }

  if (exitCode !== null && exitCode !== 0) {
    client.updateStatus(job.id, "failed", {
      error: `claude CLI exited with code ${exitCode}${
        exitSignal ? ` (signal ${exitSignal})` : ""
      }`,
      stderr: stderrJoined || undefined,
    });
    return;
  }

  if (resultText === null) {
    client.updateStatus(job.id, "failed", {
      error: "claude CLI closed without emitting a result event",
      stderr: stderrJoined || undefined,
    });
    return;
  }

  client.updateStatus(job.id, "completed", resultText);
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
