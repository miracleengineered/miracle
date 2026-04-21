import { createInterface } from "node:readline";

import type { Correlator } from "../correlation/correlator.js";

type SessionCaptureLogger = Pick<Console, "warn">;

export interface WorkerSessionLineCaptureConfig {
  jobId: string;
  lines: AsyncIterable<string>;
  correlator: Correlator;
  logger?: SessionCaptureLogger;
}

export interface WorkerSessionCaptureConfig {
  jobId: string;
  stdout: NodeJS.ReadableStream;
  correlator: Correlator;
  logger?: SessionCaptureLogger;
}

export async function captureWorkerSessionIdFromLines(
  config: WorkerSessionLineCaptureConfig,
): Promise<string | null> {
  try {
    for await (const line of config.lines) {
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }

      const sessionId =
        event &&
        typeof event === "object" &&
        "session_id" in event &&
        typeof event.session_id === "string"
          ? event.session_id
          : null;

      if (!sessionId) {
        continue;
      }

      await config.correlator.registerSession(config.jobId, sessionId);
      return sessionId;
    }
  } catch (error) {
    const logger = config.logger ?? console;
    logger.warn("Failed to capture worker session_id from stdout", error);
  }

  return null;
}

export async function captureWorkerSessionId(
  config: WorkerSessionCaptureConfig,
): Promise<string | null> {
  const rl = createInterface({ input: config.stdout });

  try {
    return await captureWorkerSessionIdFromLines({
      jobId: config.jobId,
      lines: rl,
      correlator: config.correlator,
      logger: config.logger,
    });
  } finally {
    rl.close();
  }
}
