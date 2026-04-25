/**
 * Miracle v1 slice — Executor.
 *
 * Given an approved Plan, runs the implementing query against Sonnet 4.6
 * via the Agent SDK, with:
 *   - SqliteSessionStore for durability (Gate 2 smoke #10: restart-resume)
 *   - preToolUse check that denies any Bash invocation matching the MVP's
 *     BLOCKED_PATTERNS (Gate 2 smoke #8: blocklist)
 *   - post-turn budget cap — if total_cost_usd exceeds the plan's
 *     budget_usd_cap after the query completes, the run is marked
 *     `failed_budget` (Gate 2 smoke #6). Note: budget enforcement is
 *     post-completion, not mid-stream; the SDK reports cost only on the
 *     terminal `result` message. maxTurns caps runaway loops regardless.
 *   - live Telegram status to the plan's Topic in the supergroup
 *   - final `Miracle, Delivered.` signature on success
 *   - gate-3 log row (miracle_runs table + gate-3-log.md append)
 *
 * External controls:
 *   - abortSignal — wired to /miracle-halt for user-initiated stop
 *   - bot — grammY Api handle so we can send to the topic without a
 *     Context (the Executor runs async, outside the user's message flow)
 */

import { mkdirSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

import type { Api } from "grammy";
import {
  query,
  type SDKMessage,
  type SDKResultSuccess,
  type CanUseTool,
  type PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";
import { resolveModel } from "../routing/resolveModel.js";
import { BLOCKED_PATTERNS } from "../config";
import type { Plan } from "./plan-schema.js";
import { SqliteSessionStore } from "./session-store.js";
import { getSliceDb } from "./db.js";
import { withSliceApiKey } from "./auth.js";

export type ExecutorOutcome =
  | "completed"
  | "failed_budget"
  | "failed_halt"
  | "failed_max_turns"
  | "failed_error"
  | "failed_blocklist";

export interface ExecutorResult {
  outcome: ExecutorOutcome;
  output: string;
  usdSpent: number;
  turnCount: number;
  sessionId: string;
  blockedCommand?: string;
  errorMessage?: string;
}

export interface RunExecutorOptions {
  planId: string;
  plan: Plan;
  intent: string;
  chatId: number;
  topicId: number | undefined;
  budgetUsdCap: number;
  maxTurns?: number;
  cwd?: string;
  bot: Api;
  modelKind?: string;
}

/**
 * Module-level registry of AbortControllers for currently-running
 * executor invocations, keyed by planId. Lets /miracle-halt stop a
 * specific plan (or all). Cleared in runExecutor's finally clause.
 */
const activeControllers = new Map<string, AbortController>();

export function listRunningPlanIds(): string[] {
  return [...activeControllers.keys()];
}

export function isPlanRunning(planId: string): boolean {
  return activeControllers.has(planId);
}

export function haltPlanId(planId: string): boolean {
  const ac = activeControllers.get(planId);
  if (!ac) return false;
  ac.abort();
  return true;
}

export function haltAllPlans(): number {
  let count = 0;
  for (const ac of activeControllers.values()) {
    ac.abort();
    count++;
  }
  return count;
}

const DEFAULT_PROJECT_KEY = "miracle-slice";
const GATE3_LOG_PATH = join(homedir(), "miracle-workspace", "gate-3-log.md");

export const SLICE_SYSTEM_PROMPT_EXECUTOR = [
  "You are Miracle's Executor. A user has approved a specific plan and you will now run it.",
  "",
  "Constraints:",
  "- Only use the tools listed in the plan. Do not invoke others.",
  "- Be efficient — the user is paying per token. Prefer surgical changes over exploration.",
  "- When the plan is complete, write a short summary (≤500 words) of what you did and any caveats.",
  "- Never run Bash commands that touch system directories, `rm -rf`, `sudo`, disk formatting, etc. The caller enforces this via a permission hook, but you should also refuse internally.",
  "- If you get stuck or the plan appears impossible, stop and explain why instead of thrashing.",
].join("\n");

/**
 * Check whether a Bash command matches the MVP BLOCKED_PATTERNS list.
 * Returns the matching pattern on hit, null otherwise.
 */
function matchBlockedPattern(command: string): string | null {
  const lowered = command.toLowerCase();
  for (const pattern of BLOCKED_PATTERNS) {
    if (lowered.includes(pattern.toLowerCase())) return pattern;
  }
  return null;
}

export function makeSliceCanUseTool(
  onDeny?: (toolName: string, pattern: string, command: string) => void,
): CanUseTool {
  return async (toolName: string, input: Record<string, unknown>): Promise<PermissionResult> => {
    if (toolName === "Bash") {
      const command = typeof input.command === "string" ? input.command : "";
      const matched = matchBlockedPattern(command);
      if (matched) {
        onDeny?.(toolName, matched, command);
        return {
          behavior: "deny",
          message: `Blocked by MIRACLE blocklist pattern: ${matched}`,
          interrupt: true,
        };
      }
    }
    return { behavior: "allow" };
  };
}

function renderProgressPrompt(intent: string, plan: Plan): string {
  return [
    "User intent:",
    intent,
    "",
    "Approved plan:",
    `Title: ${plan.title}`,
    `Summary: ${plan.summary}`,
    "Steps:",
    ...plan.steps.map((s, i) => `  ${i + 1}. ${s}`),
    `Tools authorized: ${plan.tools.join(", ")}`,
    `Rationale: ${plan.rationale}`,
    "",
    "Execute the plan now. When you finish (or decide you can't finish), produce a short summary of outcome, changes made, and any follow-ups required.",
  ].join("\n");
}

async function sendToTopic(
  bot: Api,
  chatId: number,
  topicId: number | undefined,
  text: string,
  parseMode?: "HTML",
): Promise<void> {
  const opts: Parameters<Api["sendMessage"]>[2] = parseMode ? { parse_mode: parseMode } : {};
  if (topicId !== undefined) {
    (opts as Record<string, unknown>).message_thread_id = topicId;
  }
  try {
    await bot.sendMessage(chatId, text, opts);
  } catch (err) {
    console.warn("Executor: sendToTopic failed", err);
  }
}

/**
 * Chunk a long output across multiple topic messages. Telegram's
 * body limit is 4096 chars; we target 3800 to leave headroom for HTML tags.
 */
async function sendChunked(
  bot: Api,
  chatId: number,
  topicId: number | undefined,
  text: string,
): Promise<void> {
  const CHUNK = 3800;
  if (text.length <= CHUNK) {
    await sendToTopic(bot, chatId, topicId, text);
    return;
  }
  for (let i = 0; i < text.length; i += CHUNK) {
    await sendToTopic(bot, chatId, topicId, text.slice(i, i + CHUNK));
  }
}

function recordRun(
  planId: string,
  sessionId: string,
  startedAt: number,
  endedAt: number,
  outcome: ExecutorOutcome,
  usdSpent: number,
  turnCount: number,
  notes?: string,
): void {
  const db = getSliceDb();
  db.prepare(
    `INSERT INTO miracle_runs (
      plan_id, executor_session_id, started_at, ended_at,
      outcome, usd_spent, turn_count, notes
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(planId, sessionId, startedAt, endedAt, outcome, usdSpent, turnCount, notes ?? null);
}

function appendGate3Log(
  planId: string,
  plan: Plan,
  outcome: ExecutorOutcome,
  usdSpent: number,
  turnCount: number,
  startedAt: number,
  notes?: string,
): void {
  try {
    mkdirSync(dirname(GATE3_LOG_PATH), { recursive: true });
    const ts = new Date(startedAt).toISOString();
    const entry = [
      `\n## ${ts} — ${plan.title}`,
      `- plan_id: \`${planId}\``,
      `- outcome: \`${outcome}\``,
      `- usd_spent: \`$${usdSpent.toFixed(4)}\``,
      `- turn_count: \`${turnCount}\``,
      `- tools: ${plan.tools.join(", ")}`,
      notes ? `- notes: ${notes}` : "",
      "",
    ]
      .filter(Boolean)
      .join("\n");
    appendFileSync(GATE3_LOG_PATH, entry);
  } catch (err) {
    console.warn("Executor: gate-3-log append failed", err);
  }
}

/**
 * Drive the SDK query(), send live status to the topic, enforce budget
 * and blocklist, and return a structured result.
 */
export async function runExecutor(opts: RunExecutorOptions): Promise<ExecutorResult> {
  const sessionId = randomUUID();
  const startedAt = Date.now();
  const model = resolveModel(opts.modelKind ?? "miracle-executor");
  const sessionStore = new SqliteSessionStore();

  let blockedCommand: string | undefined;
  let blockedPattern: string | undefined;
  const canUseTool = makeSliceCanUseTool((toolName, pattern, command) => {
    blockedCommand = command;
    blockedPattern = pattern;
  });

  const abortController = new AbortController();
  activeControllers.set(opts.planId, abortController);

  await sendToTopic(
    opts.bot,
    opts.chatId,
    opts.topicId,
    `🚀 Executor started: <b>${escapeHtml(opts.plan.title)}</b>\nSession: <code>${sessionId.slice(0, 8)}</code>\nBudget cap: $${opts.budgetUsdCap.toFixed(2)}`,
    "HTML",
  );

  let final: SDKResultSuccess | null = null;
  let lastError: Error | null = null;

  try {
    try {
    await withSliceApiKey(async () => {
      const q = query({
        prompt: renderProgressPrompt(opts.intent, opts.plan),
        options: {
          model,
          systemPrompt: SLICE_SYSTEM_PROMPT_EXECUTOR,
          tools: [...opts.plan.tools],
          maxTurns: opts.maxTurns ?? 20,
          canUseTool,
          sessionStore,
          cwd: opts.cwd,
          abortController,
          permissionMode: "bypassPermissions",
        },
      });

      for await (const msg of q as AsyncIterable<SDKMessage>) {
        if (msg.type === "result") {
          if (msg.subtype === "success") {
            final = msg;
          } else {
            lastError = new Error(
              `Executor ended with subtype: ${(msg as { subtype?: string }).subtype ?? "unknown"}`,
            );
          }
        }
      }
    });
    } catch (err) {
      lastError = err as Error;
    }
  } finally {
    activeControllers.delete(opts.planId);
  }

  const endedAt = Date.now();

  // Decide outcome. `final` was populated inside an async closure so TS's
  // control-flow narrowing can't see the assignment; use a widened local.
  const finalResult = final as SDKResultSuccess | null;
  let outcome: ExecutorOutcome;
  let notes: string | undefined;
  let output = "";
  let usdSpent = 0;
  let turnCount = 0;

  if (blockedCommand) {
    outcome = "failed_blocklist";
    notes = `blocked command: ${blockedCommand.slice(0, 200)} (pattern: ${blockedPattern})`;
  } else if (abortController.signal.aborted) {
    outcome = "failed_halt";
    notes = "halted by /miracle-halt";
  } else if (finalResult) {
    usdSpent = finalResult.total_cost_usd;
    turnCount = finalResult.num_turns;
    output = finalResult.result;
    if (usdSpent > opts.budgetUsdCap) {
      outcome = "failed_budget";
      notes = `cost $${usdSpent.toFixed(4)} exceeded cap $${opts.budgetUsdCap.toFixed(2)}`;
    } else if (finalResult.stop_reason === "max_turns") {
      outcome = "failed_max_turns";
    } else {
      outcome = "completed";
    }
  } else if (lastError) {
    outcome = "failed_error";
    notes = lastError.message.slice(0, 500);
  } else {
    outcome = "failed_error";
    notes = "executor ended without a result message and without an error";
  }

  recordRun(opts.planId, sessionId, startedAt, endedAt, outcome, usdSpent, turnCount, notes);
  appendGate3Log(opts.planId, opts.plan, outcome, usdSpent, turnCount, startedAt, notes);

  // Final status to the topic.
  if (outcome === "completed") {
    if (output.trim().length > 0) {
      await sendChunked(opts.bot, opts.chatId, opts.topicId, output);
    }
    await sendToTopic(
      opts.bot,
      opts.chatId,
      opts.topicId,
      `✅ <i>Miracle, Delivered.</i>\nCost: $${usdSpent.toFixed(4)} · ${turnCount} turn${turnCount === 1 ? "" : "s"}`,
      "HTML",
    );
  } else {
    console.warn(`[BLOCKED] plan=${opts.planId} outcome=${outcome} turns=${turnCount} spend=$${usdSpent.toFixed(4)}`);
    await sendToTopic(
      opts.bot,
      opts.chatId,
      opts.topicId,
      `❌ <i>Miracle, Blocked.</i>\nOutcome: <code>${outcome}</code>${notes ? `\n${escapeHtml(notes)}` : ""}`,
      "HTML",
    );
    if (output.trim().length > 0) {
      await sendChunked(opts.bot, opts.chatId, opts.topicId, `Partial output:\n\n${output}`);
    }
  }

  return {
    outcome,
    output,
    usdSpent,
    turnCount,
    sessionId,
    blockedCommand,
    errorMessage: lastError?.message,
  };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
