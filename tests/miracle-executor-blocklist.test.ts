/**
 * Gate 2 smoke #8 — preToolUse blocklist enforcement.
 *
 * Exercises the canUseTool factory in src/miracle/executor.ts directly.
 * Full executor + SDK integration is tested in the live smoke on Tren's
 * phone (smoke #1/#6); here we confirm the blocking primitive itself.
 */

import { describe, it, expect, vi } from "vitest";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { makeSliceCanUseTool } from "../src/miracle/executor";

// The SDK's CanUseTool options carries many fields the hook body never
// reads; our implementation only inspects `input`. Synthesize just enough
// to satisfy the signature for test calls.
type CanUseToolOpts = Parameters<CanUseTool>[2];
const opts = {
  signal: new AbortController().signal,
  toolUseID: "test",
} as unknown as CanUseToolOpts;

describe("Executor blocklist (Gate 2 smoke #8)", () => {
  it("denies Bash `rm -rf /`", async () => {
    const onDeny = vi.fn();
    const fn = makeSliceCanUseTool(onDeny);
    const result = await fn("Bash", { command: "rm -rf /" }, opts);
    expect(result.behavior).toBe("deny");
    if (result.behavior === "deny") {
      expect(result.message).toMatch(/MIRACLE blocklist/);
      expect(result.interrupt).toBe(true);
    }
    expect(onDeny).toHaveBeenCalledOnce();
    expect(onDeny).toHaveBeenCalledWith("Bash", "rm -rf /", "rm -rf /");
  });

  it("denies Bash when pattern is embedded in a longer command", async () => {
    const fn = makeSliceCanUseTool();
    const result = await fn(
      "Bash",
      { command: "cd /tmp && sudo rm -rf /var" },
      opts,
    );
    expect(result.behavior).toBe("deny");
  });

  it("denies Bash `mkfs.ext4 ...`", async () => {
    const fn = makeSliceCanUseTool();
    const result = await fn("Bash", { command: "mkfs.ext4 /dev/sda" }, opts);
    expect(result.behavior).toBe("deny");
  });

  it("denies Bash `dd if=...`", async () => {
    const fn = makeSliceCanUseTool();
    const result = await fn(
      "Bash",
      { command: "dd if=/dev/zero of=/dev/sda" },
      opts,
    );
    expect(result.behavior).toBe("deny");
  });

  it("allows Bash commands that don't match any blocked pattern", async () => {
    const fn = makeSliceCanUseTool();
    const result = await fn("Bash", { command: "ls -la" }, opts);
    expect(result.behavior).toBe("allow");
  });

  it("is case-insensitive on the pattern match", async () => {
    const fn = makeSliceCanUseTool();
    const result = await fn("Bash", { command: "SUDO RM -rf /tmp/x" }, opts);
    expect(result.behavior).toBe("deny");
  });

  it("allows non-Bash tool calls regardless of input payload", async () => {
    const fn = makeSliceCanUseTool();
    const read = await fn("Read", { file_path: "/etc/passwd" }, opts);
    expect(read.behavior).toBe("allow");

    const edit = await fn(
      "Edit",
      { file_path: "/etc/passwd", new_string: "x" },
      opts,
    );
    expect(edit.behavior).toBe("allow");

    const write = await fn(
      "Write",
      { file_path: "/tmp/x", content: "hi" },
      opts,
    );
    expect(write.behavior).toBe("allow");
  });
});
