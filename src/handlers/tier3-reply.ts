/**
 * Shared post-runJob reply logic for the Tier 3 text + voice handlers.
 *
 * Restores the MVP reply shape on the Tier 3 path:
 *   1. Main reply (result.output)
 *   2. Signature phrase (Miracle, Delivered. / Miracle, Blocked.)
 *   3. Context bar + action keyboard (bar is a placeholder in PR 2.1;
 *      PR 2.2 wires real per-event context percentage.)
 *
 * Matches MVP conventions:
 *   - Signatures send as separate messages via ctx.api.sendMessage,
 *     not appended to the reply body. Dedup via signatures.ts
 *     hasFired/markFired.
 *   - The action keyboard attaches to a context-bar message, not
 *     directly to the reply. One-bar-at-a-time via
 *     getLastActionBar / setLastActionBar.
 */

import type { Context } from "grammy";
import type { OrchestratorResult } from "../orchestrator/types";
import { DELIVERED, BLOCKED, hasFired, markFired } from "../signatures";
import {
  extractGsdCommands,
  extractNumberedOptions,
  buildActionKeyboard,
} from "../formatting";
import { getLastActionBar, setLastActionBar } from "./commands";

export async function sendTier3Reply(
  ctx: Context,
  result: OrchestratorResult,
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const output = result.output || "(no output)";

  // 1. Main reply
  await ctx.reply(output);

  // 2. Signature phrase
  //    parentJobId is unique per runJob invocation, so it's a sufficient
  //    dedup key on its own. No sessionId component needed here.
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
  //    PR 2.1 stubs the bar as "—"; PR 2.2 fills in the real percentage
  //    when onEvent plumbing is available.
  const barText = "—";

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
