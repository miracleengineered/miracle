// HTTP listener types (Phase 3 / C5).
//
// The listener binds 127.0.0.1:8787 and accepts CC hook POSTs at /hook.
// Payload shape is CC's verbatim HTTP hook body:
//   https://code.claude.com/docs/en/hooks
// See INTERFACES.md → "Phase 3 contracts" for the authoritative contract.
//
// This file is scaffolding; the C5 sub-branch adds the Express server
// and the write-to-notebook glue. No Express import lives here yet.

export type {
  HookEventPayload,
  HttpListenerConfig,
} from "../types/phase3.js";

/**
 * Lifecycle handle for the HTTP listener. The listener starts as part
 * of the orchestrator process (not standalone) and ack's posts without
 * blocking CC (per CC's HTTP hook spec, 5xx is non-blocking).
 */
export interface HttpListener {
  start(): Promise<void>;
  stop(): Promise<void>;
}
