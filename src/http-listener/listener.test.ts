// C5 skeleton tests — SKIPPED in this commit. The C5 sub-branch un-skips
// these and wires assertions against a real Express listener.
//
// The imports exist so the types compile in this tree; the tests are
// placeholders that document the contract surface.

import { describe, it, expect } from "vitest";
import type {
  HookEventPayload,
  HttpListener,
  HttpListenerConfig,
} from "./types.js";

describe.skip("HttpListener (Phase 3 / C5 — pending)", () => {
  it("binds to the configured host:port and accepts POST /hook", () => {
    const _config: HttpListenerConfig = { host: "127.0.0.1", port: 8787 };
    const _listener: HttpListener | null = null;
    expect(_config.port).toBe(8787);
  });

  it("persists the payload verbatim, session_id populated, job_id null", () => {
    const _payload: HookEventPayload = { session_id: "placeholder" };
    expect(_payload.session_id).toBe("placeholder");
  });

  it("returns 200 on notebook write success and 500 on failure", () => {
    expect(true).toBe(true);
  });
});
