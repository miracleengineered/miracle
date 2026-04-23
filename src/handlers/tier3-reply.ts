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
import type { OnEvent, OrchestratorResult, StartWorker } from "../orchestrator/types";
import type { Tier3Runtime } from "../tier3/runtime";
import type { StatusCallback } from "../types";
import {
  DELIVERED,
  BLOCKED,
  hasFired,
  markFired,
  candidatesForEvent,
  nextTurnId,
} from "../signatures";
import {
  extractGsdCommands,
  extractNumberedOptions,
  buildActionKeyboard,
  formatToolStatus,
  convertMarkdownToHtml,
} from "../formatting";
import { getLastActionBar, setLastActionBar } from "./commands";
import { StreamingState, createStatusCallback, sendChunkedMessages } from "./streaming";
import { TELEGRAM_MESSAGE_LIMIT } from "../config";

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

// =============== Crash detection + retry wrapper ================

/**
 * Detect a claude subprocess crash from an OrchestratorResult.
 *
 * Tier 3 surfaces subprocess exits as a failed subtask whose result
 * payload contains "exited with code N" (set by claudeWorker's
 * non-zero-exit branch). Matches the MVP heuristic at text.ts:153-154.
 */
export function isClaudeCrash(result: OrchestratorResult): boolean {
  if (result.status !== "failed") return false;
  for (const sub of result.subtasks) {
    if (sub.status !== "failed") continue;
    const r = sub.result;
    if (r && typeof r === "object") {
      const err = (r as Record<string, unknown>).error;
      if (typeof err === "string" && err.includes("exited with code")) {
        return true;
      }
    }
  }
  return false;
}

export interface Tier3JobConfig {
  ctx: Context;
  runtime: Tier3Runtime;
  ask: string;
  startWorker: StartWorker;
  conversationSessionId: string | null;
  /** Called once before each retry (not called on the initial attempt). */
  onCrashRetry?: () => Promise<void>;
}

export interface Tier3JobOutcome {
  result: OrchestratorResult;
  state: StreamingState;
  contextRef: Tier3ContextRef;
}

const MAX_RETRIES = 1; // matches MVP text.ts:94

/**
 * Runs runJob with streaming state + crash-retry. On claude subprocess
 * crash (per isClaudeCrash), cleans up the failed attempt's tool
 * messages, fires onCrashRetry, and re-runs once. Other failures
 * (non-crash subtask errors, orchestrator exceptions) are not retried
 * and bubble up via the returned result or a thrown error.
 */
export async function runTier3JobWithRetry(
  cfg: Tier3JobConfig,
): Promise<Tier3JobOutcome> {
  const { ctx, runtime, ask, startWorker, conversationSessionId, onCrashRetry } = cfg;
  const chatId = ctx.chat?.id;
  if (!chatId) {
    throw new Error("runTier3JobWithRetry: ctx.chat.id is required");
  }

  let outcome: Tier3JobOutcome | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const state = new StreamingState();
    const statusCallback = createStatusCallback(ctx, state);
    const contextRef = createTier3ContextRef();
    const turnId = nextTurnId();
    const processingMsg = await ctx.reply("Processing...", {
      disable_notification: true,
    });
    state.statusMsg = processingMsg;
    state.toolMessages.push(processingMsg);
    const onEvent = createTier3OnEvent({
      ctx,
      chatId,
      state,
      statusCallback,
      contextRef,
      conversationSessionId,
      turnId,
    });

    let result: OrchestratorResult;
    try {
      result = await runtime.runJob(ask, {
        startWorker,
        conversationSessionId: conversationSessionId ?? undefined,
        onEvent,
      });
    } catch (runJobError) {
      // Not a subprocess crash — orchestrator-level throw. Clean up
      // this attempt's messages and propagate so the handler's catch
      // branch reports the generic error.
      await cleanupStreamingState(ctx, state);
      throw runJobError;
    }

    if (isClaudeCrash(result) && attempt < MAX_RETRIES) {
      await cleanupStreamingState(ctx, state);
      if (onCrashRetry) {
        try {
          await onCrashRetry();
        } catch (retryCbError) {
          console.debug("onCrashRetry callback failed:", retryCbError);
        }
      }
      continue;
    }

    outcome = { result, state, contextRef };
    break;
  }

  if (!outcome) {
    // Defensive: should be unreachable since the loop either assigns
    // outcome or re-enters after cleanup. If we ever escape without
    // assignment (e.g., MAX_RETRIES bumped without loop-bound update),
    // fail loudly.
    throw new Error("runTier3JobWithRetry: loop exited without outcome");
  }

  return outcome;
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

  // 1. Main reply — convert markdown → HTML and chunk if the rendered
  //    content exceeds Telegram's 4096-byte message limit. Mirrors the
  //    MVP streaming path in streaming.ts (segment_end branch). The
  //    digest drill-down concatenates subtask output that routinely
  //    runs past the limit; without chunking, Telegram 400s the entire
  //    reply and the user sees nothing.
  const formatted = convertMarkdownToHtml(output);
  if (formatted.length <= TELEGRAM_MESSAGE_LIMIT) {
    try {
      await ctx.reply(formatted, { parse_mode: "HTML" });
    } catch (htmlErr) {
      // HTML rejected (unbalanced tags from broken markdown etc.) —
      // fall back to plain text.
      try {
        await ctx.reply(output);
      } catch (plainErr) {
        console.warn("sendTier3Reply: both HTML and plain-text reply failed", {
          htmlErr: String(htmlErr),
          plainErr: String(plainErr),
        });
      }
    }
  } else {
    await sendChunkedMessages(ctx, formatted);
  }

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
