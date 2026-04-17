import { describe, it, expect, beforeEach } from "vitest";

import {
  ENGINEERED,
  DELIVERED,
  BLOCKED,
  candidatesForEvent,
  candidateForOuterError,
  hasFired,
  markFired,
  nextTurnId,
  resetAllSignatureState,
} from "../src/signatures";

const SESSION_ID = "sess-abc123";

function assistantToolUse(id: string, name: string) {
  return {
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name, input: {} }] },
  };
}

function userToolResult(tool_use_id: string, is_error: boolean) {
  return {
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id,
          is_error,
          content: is_error ? "boom" : "ok",
        },
      ],
    },
  };
}

function resultEvent(opts: {
  is_error?: boolean;
  subtype?: string;
  uuid?: string;
}) {
  return {
    type: "result",
    subtype: opts.subtype ?? "success",
    result: "done",
    is_error: opts.is_error ?? false,
    ...(opts.uuid ? { uuid: opts.uuid } : {}),
  };
}

/** Mimics the sendSignature helper in session.ts: dedup + "send". */
function attemptSend(dedupKey: string): boolean {
  if (hasFired(dedupKey)) return false;
  markFired(dedupKey);
  return true;
}

describe("signature routing", () => {
  let turnId: string;

  beforeEach(() => {
    resetAllSignatureState();
    turnId = nextTurnId();
  });

  it("Miracle, Engineered. fires on Agent tool_use + matching successful tool_result", () => {
    const pre = candidatesForEvent(
      assistantToolUse("toolu_1", "Agent"),
      SESSION_ID,
      turnId,
    );
    expect(pre).toEqual([]);

    const post = candidatesForEvent(
      userToolResult("toolu_1", false),
      SESSION_ID,
      turnId,
    );
    expect(post).toHaveLength(1);
    expect(post[0]!.phrase).toBe(ENGINEERED);
    expect(post[0]!.dedupKey).toBe(`${SESSION_ID}:toolu_1:engineered`);
  });

  it("Miracle, Delivered. fires on event.type === 'result' with no is_error", () => {
    const sigs = candidatesForEvent(resultEvent({}), SESSION_ID, turnId);
    expect(sigs).toHaveLength(1);
    expect(sigs[0]!.phrase).toBe(DELIVERED);
    expect(sigs[0]!.dedupKey).toBe(`${SESSION_ID}:${turnId}:delivered`);
  });

  it("Miracle, Delivered. uses event.uuid when present (preferred over turnId)", () => {
    const sigs = candidatesForEvent(
      resultEvent({ uuid: "result-uuid-xyz" }),
      SESSION_ID,
      turnId,
    );
    expect(sigs[0]!.dedupKey).toBe(
      `${SESSION_ID}:result-uuid-xyz:delivered`,
    );
  });

  it("Miracle, Blocked. fires on is_error: true with a matching Agent tool_use", () => {
    candidatesForEvent(
      assistantToolUse("toolu_2", "Agent"),
      SESSION_ID,
      turnId,
    );

    const sigs = candidatesForEvent(
      userToolResult("toolu_2", true),
      SESSION_ID,
      turnId,
    );
    expect(sigs).toHaveLength(1);
    expect(sigs[0]!.phrase).toBe(BLOCKED);
    expect(sigs[0]!.dedupKey).toBe(`${SESSION_ID}:toolu_2:blocked-sub`);
  });

  it("Miracle, Blocked. fires on outer-turn result event with is_error: true", () => {
    const sigs = candidatesForEvent(
      resultEvent({ is_error: true, subtype: "error" }),
      SESSION_ID,
      turnId,
    );
    expect(sigs).toHaveLength(1);
    expect(sigs[0]!.phrase).toBe(BLOCKED);
    expect(sigs[0]!.dedupKey).toBe(
      `${SESSION_ID}:${turnId}:blocked-outer`,
    );
  });

  it("candidateForOuterError produces Blocked with turn-scoped key", () => {
    const sig = candidateForOuterError(SESSION_ID, turnId);
    expect(sig.phrase).toBe(BLOCKED);
    expect(sig.dedupKey).toBe(`${SESSION_ID}:${turnId}:blocked-outer`);
  });

  it("ignores non-Agent tool completions (Bash, Read, etc.)", () => {
    candidatesForEvent(
      assistantToolUse("toolu_bash", "Bash"),
      SESSION_ID,
      turnId,
    );
    const sigs = candidatesForEvent(
      userToolResult("toolu_bash", false),
      SESSION_ID,
      turnId,
    );
    expect(sigs).toEqual([]);
  });

  it("accepts the legacy tool name 'Task' as equivalent to 'Agent' (pre-2.1.63 rename)", () => {
    candidatesForEvent(
      assistantToolUse("toolu_task", "Task"),
      SESSION_ID,
      turnId,
    );
    const sigs = candidatesForEvent(
      userToolResult("toolu_task", false),
      SESSION_ID,
      turnId,
    );
    expect(sigs).toHaveLength(1);
    expect(sigs[0]!.phrase).toBe(ENGINEERED);
  });
});

describe("signature dedup (sessionId + eventId + phrase-tag key composite)", () => {
  beforeEach(() => {
    resetAllSignatureState();
    nextTurnId();
  });

  it("same dedup key is consumed only once by attemptSend", () => {
    const key = `${SESSION_ID}:toolu_dup:engineered`;
    expect(attemptSend(key)).toBe(true);
    expect(attemptSend(key)).toBe(false);
    expect(attemptSend(key)).toBe(false);
  });

  it("replaying the same Agent tool_result does not fire Engineered twice", () => {
    const turnId = "t1";
    candidatesForEvent(
      assistantToolUse("toolu_replay", "Agent"),
      SESSION_ID,
      turnId,
    );

    const first = candidatesForEvent(
      userToolResult("toolu_replay", false),
      SESSION_ID,
      turnId,
    );
    expect(first).toHaveLength(1);
    expect(attemptSend(first[0]!.dedupKey)).toBe(true);

    // Replay: even if candidate were produced again, dedup key is already fired.
    expect(attemptSend(first[0]!.dedupKey)).toBe(false);
  });

  it("resetAllSignatureState clears dedup and allows refire in a new session", () => {
    const turnId = "t1";
    candidatesForEvent(
      assistantToolUse("toolu_a", "Agent"),
      SESSION_ID,
      turnId,
    );
    const first = candidatesForEvent(
      userToolResult("toolu_a", false),
      SESSION_ID,
      turnId,
    );
    expect(attemptSend(first[0]!.dedupKey)).toBe(true);

    resetAllSignatureState();
    const newTurnId = nextTurnId();

    candidatesForEvent(
      assistantToolUse("toolu_a", "Agent"),
      SESSION_ID,
      newTurnId,
    );
    const second = candidatesForEvent(
      userToolResult("toolu_a", false),
      SESSION_ID,
      newTurnId,
    );
    expect(attemptSend(second[0]!.dedupKey)).toBe(true);
  });
});
