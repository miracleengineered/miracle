import type { Server } from "node:http";
import express, { type Request, type Response } from "express";

import type { Correlator } from "../correlation/correlator.js";
import type { NotebookClient } from "../notebook/client.js";
import type { HookEventPayload, HttpListener, HttpListenerConfig } from "./types.js";

type ListenerLogger = Pick<Console, "warn" | "error">;
type HookEventNotebookClient = NotebookClient &
  Required<Pick<NotebookClient, "appendHookEvent">>;

export interface ExpressHttpListenerConfig extends HttpListenerConfig {
  notebook: HookEventNotebookClient;
  correlator?: Correlator;
  logger?: ListenerLogger;
}

export class ExpressHttpListener implements HttpListener {
  private readonly app = express();
  private readonly logger: ListenerLogger;
  private server: Server | null = null;

  constructor(private readonly config: ExpressHttpListenerConfig) {
    this.logger = config.logger ?? console;

    this.app.disable("x-powered-by");
    this.app.use(
      express.text({
        type: () => true,
      }),
    );

    this.app.post("/hook", (req, res) => {
      void this.handleHook(req, res);
    });
  }

  async start(): Promise<void> {
    if (this.server) return;

    await new Promise<void>((resolve, reject) => {
      const server = this.app.listen(this.config.port, this.config.host, () => {
        server.off("error", reject);
        this.server = server;
        resolve();
      });

      server.once("error", reject);
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;

    const server = this.server;
    this.server = null;

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private async handleHook(req: Request, res: Response): Promise<void> {
    const bodyText = typeof req.body === "string" ? req.body : "";
    const receivedAt = Date.now();
    const parsedPayload = parseHookPayload(bodyText, this.logger);
    const sessionId = getSessionId(parsedPayload, this.logger);
    const eventType = getEventType(parsedPayload, this.logger);

    try {
      this.config.notebook.appendHookEvent({
        sessionId,
        eventType,
        payloadJson: bodyText,
        receivedAt,
      });

      if (this.config.correlator) {
        try {
          await this.config.correlator.recordHook(sessionId);
        } catch (error) {
          this.logger.warn("Failed to correlate hook event; leaving job_id NULL", error);
        }
      }

      res.status(200).end();
    } catch (error) {
      this.logger.error("Failed to append hook event to notebook", error);
      res.status(500).json({
        error: error instanceof Error ? error.message : "notebook write failed",
      });
    }
  }
}

export function createHttpListener(
  config: ExpressHttpListenerConfig,
): HttpListener {
  return new ExpressHttpListener(config);
}

function parseHookPayload(
  bodyText: string,
  logger: ListenerLogger,
): HookEventPayload | null {
  if (bodyText.length === 0) {
    logger.warn("Received hook payload with empty body");
    return null;
  }

  try {
    const parsed = JSON.parse(bodyText) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      logger.warn("Received hook payload with unexpected JSON shape", parsed);
      return null;
    }
    return parsed as HookEventPayload;
  } catch (error) {
    logger.warn("Received malformed hook payload JSON", error);
    return null;
  }
}

function getSessionId(
  payload: HookEventPayload | null,
  logger: ListenerLogger,
): string {
  if (payload && typeof payload.session_id === "string") {
    return payload.session_id;
  }

  logger.warn("Hook payload missing session_id; storing empty string", payload);
  return "";
}

function getEventType(
  payload: HookEventPayload | null,
  logger: ListenerLogger,
): string {
  if (!payload) {
    logger.warn("Hook payload missing event type; storing empty string");
    return "";
  }

  const hookEventName = payload["hook_event_name"];
  if (typeof hookEventName === "string") {
    return hookEventName;
  }

  const hookEventNameCamel = payload["hookEventName"];
  if (typeof hookEventNameCamel === "string") {
    return hookEventNameCamel;
  }

  const eventType = payload["event_type"];
  if (typeof eventType === "string") {
    return eventType;
  }

  logger.warn("Hook payload missing event type; storing empty string", payload);
  return "";
}
