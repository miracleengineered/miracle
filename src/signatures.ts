/**
 * Miracle signature-phrase routing + dedup.
 *
 * Three phrases fire from the bot's response handler:
 *   - Miracle, Engineered.  — after a sub-agent (Agent tool) completes.
 *   - Miracle, Delivered.   — after a full requested task completes.
 *   - Miracle, Blocked.     — when a sub-agent or full task fails.
 *
 * Module-level state:
 *   - dedupFired: composite "sessionId:eventId:phrase-tag" keys already fired.
 *   - pendingAgentToolIds: Agent/Task tool_use.ids awaiting a matching tool_result.
 *   - turnCounter: monotone per-call id for result events that lack event.uuid.
 *
 * Reset with resetAllSignatureState() at the start of a new Claude session.
 */

export const ENGINEERED = "Miracle, Engineered." as const;
export const DELIVERED = "Miracle, Delivered." as const;
export const BLOCKED = "Miracle, Blocked." as const;
export type SignaturePhrase =
  | typeof ENGINEERED
  | typeof DELIVERED
  | typeof BLOCKED;

export type SignatureEvent = {
  phrase: SignaturePhrase;
  dedupKey: string;
};

// ---------- module-level state ----------

const dedupFired = new Set<string>();
const pendingAgentToolIds = new Set<string>();
let turnCounter = 0;

export function hasFired(key: string): boolean {
  return dedupFired.has(key);
}

export function markFired(key: string): void {
  dedupFired.add(key);
}

export function nextTurnId(): string {
  turnCounter += 1;
  return `t${turnCounter}`;
}

/** Called at the start of a new Claude session (fresh session_id). */
export function resetAllSignatureState(): void {
  dedupFired.clear();
  pendingAgentToolIds.clear();
  turnCounter = 0;
}

// ---------- pure decision logic ----------

/**
 * Inspect one NDJSON stream event and return the candidate signatures it produces.
 * Dedup is applied by the caller via sendSignature / hasFired+markFired.
 *
 * Side effect: mutates the module-level pendingAgentToolIds set as Agent tool_use
 * events arrive and their matching tool_results are consumed.
 */
export function candidatesForEvent(
  event: unknown,
  sessionId: string | null,
  turnId: string,
): SignatureEvent[] {
  if (!event || typeof event !== "object") return [];
  const e = event as Record<string, any>;
  const sid = sessionId ?? "no-session";
  const out: SignatureEvent[] = [];

  // 1) Track Agent/Task tool_use ids from assistant messages.
  if (e.type === "assistant" && Array.isArray(e.message?.content)) {
    for (const block of e.message.content) {
      if (
        block?.type === "tool_use" &&
        typeof block.id === "string" &&
        (block.name === "Agent" || block.name === "Task")
      ) {
        pendingAgentToolIds.add(block.id);
      }
    }
  }

  // 2) Match tool_result events back to Agent tool_use ids.
  if (e.type === "user" && Array.isArray(e.message?.content)) {
    for (const block of e.message.content) {
      if (
        block?.type === "tool_result" &&
        typeof block.tool_use_id === "string" &&
        pendingAgentToolIds.has(block.tool_use_id)
      ) {
        const tuid = block.tool_use_id;
        if (block.is_error === true) {
          out.push({
            phrase: BLOCKED,
            dedupKey: `${sid}:${tuid}:blocked-sub`,
          });
        } else {
          out.push({
            phrase: ENGINEERED,
            dedupKey: `${sid}:${tuid}:engineered`,
          });
        }
        pendingAgentToolIds.delete(tuid);
      }
    }
  }

  // 3) Result event = outer-turn completion (success or failure).
  if (e.type === "result") {
    const resultId = typeof e.uuid === "string" ? e.uuid : turnId;
    if (e.is_error === true || e.subtype === "error") {
      out.push({
        phrase: BLOCKED,
        dedupKey: `${sid}:${resultId}:blocked-outer`,
      });
    } else {
      out.push({
        phrase: DELIVERED,
        dedupKey: `${sid}:${resultId}:delivered`,
      });
    }
  }

  return out;
}

/**
 * Used by the outer catch block in session.ts when the stream loop itself throws
 * (non-zero exit, parse error, network hiccup) without producing a result event.
 */
export function candidateForOuterError(
  sessionId: string | null,
  turnId: string,
): SignatureEvent {
  const sid = sessionId ?? "no-session";
  return {
    phrase: BLOCKED,
    dedupKey: `${sid}:${turnId}:blocked-outer`,
  };
}
