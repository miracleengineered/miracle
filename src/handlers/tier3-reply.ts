/**
 * Shared reply + streaming logic for the Tier 3 text + voice handlers.
 *
 * Provides two pieces MVP had but Tier 3 lost:
 *   - sendTier3Reply(ctx, result, opts):
 *       Post-runJob reply. Sends the output, fires the outer-turn
 *       signature phrase (Miracle, Delivered. / Miracle, Blocked.),
 *       and renders the context bar + action keyboard.
 *   - createTier3OnEvent(config):
 *       Factory for a runJob onEvent callback. Translates claude NDJSON
 *       events into (a) streaming status updates via statusCallback,
 *       (b) mid-stream signatures via candidatesForEvent (Engineered /
 *       sub-agent Blocked), and (c) context-bar percentage captured
 *       into a shared ref.
 *
 * MVP parity:
 *   - Signatures send as separate messages via ctx.api.sendMessage,
 *     not appended to the reply body. Dedup via signatures.ts
 *     hasFired/markFired.
 *   - Tool-status uses the same formatToolStatus helper as MVP.
 *   - Context-bar formula lifted verbatim from session.ts:~600.
 *   - The action keyboard attaches to a context-bar message, not to
 *     the reply itself. One-bar-at-a-time via getLastActionBar /
 *     setLastActionBar.
 */

import type { Context } from "grammy";
import type { OnEvent, OrchestratorResult } from "../orchestrator/types";
import type { StatusCallback } from "../types";
import {
  DELIVERED,
  BLOCKED,
  hasFired,
  markFired,
  candidatesForEvent,
} from "../signatures";
import {
  extractGsdCommands,
  extractNumberedOptions,
  buildActionKeyboard,
  formatToolStatus,
} from "../formatting";
import { getLastActionBar, setLastActionBar } from "./commands";
import type { StreamingState } from "./streaming";

// =============== Context percentage tracking ================

/**
 * Mutable ref passed to createTier3OnEvent and then to sendTier3Reply.
 * Populated from the NDJSON `result` event's `modelUsage` field.
 */
export interface Tier3ContextRef {
  percent: number | null;
}

export function createTier3ContextRef(): Tier3ContextRef {
  return { percent: null };
}

function renderContextBar(percent: number | null): string {
  if (percent === null) return "—";
  const clamped = Math.max(0, Math.min(percent, 100));
  const filled = Math.min(Math.round(clamped / 10), 10);
  return "█".repeat(filled) + "░".repeat(10 - filled) + ` ${clamped}%`;
}

// =============== Streaming state cleanup ================

/**
 * Delete the ephemeral tool/status messages tracked in StreamingState.
 * Called automatically by sendTier3Reply on the success path; handlers
 * call it directly in their catch branch so the Processing message
 * doesn't linger after an error.
 */
export async function cleanupStreamingState(
  ctx: Context,
  state: StreamingState,
): Promise<void> {
  for (const msg of state.toolMessages) {
    try {
      await ctx.api.deleteMessage(msg.chat.id, msg.message_id);
    } catch {
      // Already deleted or edited-away — fine.
    }
  }
  state.toolMessages = [];
  state.statusMsg = null;
}

// =============== Post-runJob reply ================

export interface SendTier3ReplyOpts {
  contextPercent?: number | null;
  /**
   * Ephemeral streaming state. If provided, its toolMessages are
   * deleted before the main reply is sent (so the "Processing..."
   * message goes away first). State is otherwise untouched.
   */
  streamingState?: StreamingState;
}

export async function sendTier3Reply(
  ctx: Context,
  result: OrchestratorResult,
  opts: SendTier3ReplyOpts = {},
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const output = result.output || "(no output)";

  // Delete ephemeral streaming/tool messages before the final reply lands
  if (opts.streamingState) {
    await cleanupStreamingState(ctx, opts.streamingState);
  }

  // 1. Main reply
  await ctx.reply(output);

  // 2. Outer-turn signature (Miracle, Delivered. / Miracle, Blocked.)
  //    parentJobId is unique per runJob so it's sufficient for dedup.
  const phrase = result.status === "completed" ? DELIVERED : BLOCKED;
  const tag = result.status === "completed" ? "delivered" : "blocked-outer";
  const dedupKey = `${result.parentJobId}:${tag}`;
  if (!hasFired(dedupKey)) {
    markFired(dedupKey);
    try {
      await ctx.api.sendMessage(chatId, phrase);
    } catch (err) {
      console.warn(`Signature "${phrase}" send failed:`, err);
    }
  }

  // 3. Context bar + action keyboard
  const barText = renderContextBar(opts.contextPercent ?? null);

  const { commands: gsdCmds, hasClearSuggestion } = extractGsdCommands(output);
  const numberedOpts = extractNumberedOptions(output);
  const keyboard = buildActionKeyboard({
    gsdCommands: gsdCmds,
    hasClearSuggestion,
    numberedOptions: numberedOpts,
  });

  // Delete previous action bar (one-at-a-time state from commands.ts)
  const oldBar = getLastActionBar();
  if (oldBar) {
    try {
      await ctx.api.deleteMessage(oldBar.chatId, oldBar.messageId);
    } catch {
      // Already deleted or chat changed — fine.
    }
  }

  const barMsg = await ctx.reply(barText, {
    reply_markup: keyboard,
    disable_notification: true,
  });
  setLastActionBar(chatId, barMsg.message_id);
}

// =============== onEvent factory ================

export interface Tier3EventHandlerConfig {
  ctx: Context;
  chatId: number;
  state: StreamingState;
  statusCallback: StatusCallback;
  contextRef: Tier3ContextRef;
  /**
   * Conversation session id known at handler-entry time (from the
   * MVP session singleton's cached value). Used for signature
   * dedup keys. May be null on the very first message of a new
   * conversation, in which case we adopt the first session_id we
   * see on the NDJSON stream.
   */
  conversationSessionId: string | null;
  /** Per-turn id from signatures.nextTurnId() — called once per runJob. */
  turnId: string;
}

export function createTier3OnEvent(cfg: Tier3EventHandlerConfig): OnEvent {
  const {
    ctx,
    chatId,
    statusCallback,
    contextRef,
    conversationSessionId,
    turnId,
  } = cfg;

  // Track session_id locally for signature dedup keys. The claudeWorker
  // already registers it with the correlator for routing; this is a
  // separate capture for phrase emission.
  let capturedSessionId: string | null = conversationSessionId;

  const sendSignature = async (phrase: string, dedupKey: string) => {
    if (hasFired(dedupKey)) return;
    markFired(dedupKey);
    try {
      await ctx.api.sendMessage(chatId, phrase);
    } catch (err) {
      console.warn(`Signature "${phrase}" send failed:`, err);
    }
  };

  return async (event: unknown) => {
    if (!event || typeof event !== "object") return;
    const e = event as Record<string, any>;

    // Capture session_id on first sighting (for dedup key scoping).
    if (!capturedSessionId && typeof e.session_id === "string") {
      capturedSessionId = e.session_id;
    }

    // ── Mid-stream signatures (Miracle, Engineered. for sub-agent
    //    completions; sub-agent Blocked on sub-agent error). Outer
    //    Delivered/Blocked is also generated here but is deduped by
    //    sendTier3Reply's parentJobId-keyed firing, so at worst it
    //    fires once from whichever path runs first.
    for (const sig of candidatesForEvent(event, capturedSessionId, turnId)) {
      await sendSignature(sig.phrase, sig.dedupKey);
    }

    // ── Assistant messages: surface tool-use + thinking in the
    //    single "Processing..." status message.
    if (e.type === "assistant" && e.message?.content) {
      const content = e.message.content as any[];
      for (const block of content) {
        if (
          block?.type === "tool_use" &&
          typeof block.id === "string" &&
          typeof block.name === "string"
        ) {
          const toolInput = (block.input || {}) as Record<string, unknown>;
          const toolDisplay = formatToolStatus(block.name, toolInput);
          // Skip ask_user — its inline buttons are self-explanatory.
          if (!block.name.startsWith("mcp__ask-user")) {
            try {
              await statusCallback("tool", toolDisplay);
            } catch (cbErr) {
              console.debug("tier3 statusCallback(tool) failed:", cbErr);
            }
          }
        } else if (block?.type === "thinking" && typeof block.thinking === "string") {
          try {
            await statusCallback("thinking", block.thinking);
          } catch (cbErr) {
            console.debug("tier3 statusCallback(thinking) failed:", cbErr);
          }
        }
      }
    }

    // ── Result event: extract context-bar percentage from modelUsage.
    //    Formula lifted from session.ts:~600. Fires once per runJob.
    if (e.type === "result" && e.modelUsage && typeof e.modelUsage === "object") {
      const models = Object.values(e.modelUsage) as any[];
      if (models.length > 0) {
        const m = models[0];
        const totalTokens =
          (Number(m?.inputTokens) || 0) +
          (Number(m?.outputTokens) || 0) +
          (Number(m?.cacheReadInputTokens) || 0) +
          (Number(m?.cacheCreationInputTokens) || 0);
        const contextWindow = Number(m?.contextWindow) || 200000;
        if (contextWindow > 0) {
          contextRef.percent = Math.round((totalTokens / contextWindow) * 100);
        }
      }
    }
  };
}
