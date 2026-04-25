/**
 * Miracle slice slash commands.
 *
 *   /plan <topic>    — spawn a Planner run, post approval card in a new
 *                      supergroup Topic, record the plan in miracle_plans.
 *   /miracle-halt    — abort all currently-running executors. Single-slot
 *                      scope (decision #18) so this is equivalent to
 *                      "halt whatever plan is running".
 *   /miracle-status  — list pending_approval + running plans.
 *   /miracle-cancel  <plan_id_prefix> — mark a pending_approval plan
 *                                        rejected without needing the
 *                                        original approval card.
 *
 * All commands check isAuthorized(); anything from a non-allowed user is
 * silently refused via a one-line reply.
 */

import type { Context } from "grammy";
import { randomUUID } from "node:crypto";

import { ALLOWED_USERS } from "../config";
import { isAuthorized } from "../security";
import { session } from "../session";
import { getSliceDb } from "../miracle/db.js";
import { runPlanner, PlanValidationError } from "../miracle/planner.js";
import { gatherCwdContext } from "../miracle/cwd-context.js";
import { renderApprovalCard, generateNonce } from "../miracle/approval-card.js";
import { haltAllPlans, haltPlanId, listRunningPlanIds } from "../miracle/executor.js";

interface MiraclePlanRow {
  id: string;
  chat_id: number;
  topic_id: number | null;
  status: string;
  intent: string;
  title: string | null;
  plan_json: string | null;
  budget_usd_cap: number;
  created_at: number;
}

const APPROVAL_TTL_MS = 72 * 60 * 60 * 1000; // 72h per decision #4
const DEFAULT_BUDGET_USD = Number(process.env.MIRACLE_SLICE_BUDGET_USD_DEFAULT ?? "2");
const MAX_BUDGET_USD = Number(process.env.MIRACLE_SLICE_BUDGET_USD_MAX ?? "5");

/**
 * Resolve the supergroup chat ID from env. Returns null if MIRACLE_SLICE_CHAT_ID
 * is not set (shouldn't happen when MIRACLE_SLICE_ENABLED=true — the secrets
 * loader asserts it).
 */
function sliceChatId(): number | null {
  const raw = process.env.MIRACLE_SLICE_CHAT_ID;
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return n;
}

function truncateTopicName(raw: string, max = 40): string {
  const normalized = raw.replace(/\s+/g, " ").trim();
  return normalized.length > max ? normalized.slice(0, max - 1) + "…" : normalized;
}

export async function handlePlanCommand(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const intent = (ctx.match as string | undefined)?.trim() ?? "";
  if (!intent) {
    await ctx.reply("Usage: /plan <topic> — e.g. /plan audit current state of the Genesis repo");
    return;
  }

  const chatId = sliceChatId();
  if (chatId === null) {
    await ctx.reply("MIRACLE_SLICE_CHAT_ID not set. Gate 1 secrets must be in keychain.");
    return;
  }

  // Enforce max 1 concurrent `running` plan (decision #18). Pending
  // approvals don't block — only running executors do.
  const db = getSliceDb();
  const running = db
    .prepare<[], { n: number; id: string | null }>(
      "SELECT count(*) as n, min(id) as id FROM miracle_plans WHERE status = 'running'",
    )
    .get();
  if (running && running.n > 0) {
    await ctx.reply(
      `Plan ${running.id?.slice(0, 8) ?? "?"} running — /miracle-halt to cancel or wait.`,
    );
    return;
  }

  // Create a new Topic in the supergroup for this plan.
  let topicId: number | undefined;
  try {
    const topic = await ctx.api.createForumTopic(chatId, truncateTopicName(intent));
    topicId = topic.message_thread_id;
  } catch (err) {
    console.warn("/plan: createForumTopic failed (falling back to no-topic)", err);
  }

  // Reply to the originating chat (may be DM or supergroup main).
  await ctx.reply(
    topicId !== undefined
      ? `📝 Plan topic created. Running Planner — approval card incoming in the new thread.`
      : `📝 Running Planner (no topic — add bot's Manage Topics permission for per-plan threads).`,
  );

  // Run Planner (Agent SDK call; takes a few seconds).
  let plannerResult;
  try {
    const ctxBundle = gatherCwdContext(session.currentWorkingDir);
    plannerResult = await runPlanner({
      intent,
      cwd: session.currentWorkingDir,
      ...ctxBundle,
    });
  } catch (err) {
    const message =
      err instanceof PlanValidationError
        ? `Planner output failed validation twice:\n${err.zodErrorText}`
        : `Planner failed: ${(err as Error).message}`;
    await ctx.api.sendMessage(
      chatId,
      message,
      topicId !== undefined ? { message_thread_id: topicId } : {},
    );
    return;
  }

  // Persist plan + approval.
  const planId = randomUUID();
  const nonce = generateNonce();
  const approvalId = randomUUID();
  const now = Date.now();
  const budgetCap = Math.min(
    plannerResult.plan.estimated_cost_usd > 0
      ? plannerResult.plan.estimated_cost_usd * 2.5
      : DEFAULT_BUDGET_USD,
    MAX_BUDGET_USD,
  );

  db.prepare(
    `INSERT INTO miracle_plans (
      id, chat_id, topic_id, status, intent, title, plan_json,
      tool_set, budget_usd_cap, budget_usd_spent, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    planId,
    chatId,
    topicId ?? null,
    "pending_approval",
    intent,
    plannerResult.plan.title,
    JSON.stringify(plannerResult.plan),
    JSON.stringify(plannerResult.plan.tools),
    budgetCap,
    0,
    now,
  );

  db.prepare(
    `INSERT INTO miracle_approvals (
      id, plan_id, hmac_nonce, status, expires_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(approvalId, planId, nonce, "pending", now + APPROVAL_TTL_MS, now);

  const card = renderApprovalCard(plannerResult.plan, approvalId, nonce);

  await ctx.api.sendMessage(chatId, card.text, {
    parse_mode: "HTML",
    reply_markup: card.replyMarkup,
    ...(topicId !== undefined ? { message_thread_id: topicId } : {}),
  });
}

export async function handleMiracleHalt(ctx: Context): Promise<void> {
  if (!isAuthorized(ctx.from?.id, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }
  const count = haltAllPlans();
  if (count === 0) {
    await ctx.reply("No plans currently running.");
    return;
  }
  await ctx.reply(`🛑 Halted ${count} running plan${count === 1 ? "" : "s"}.`);
}

export async function handleMiracleStatus(ctx: Context): Promise<void> {
  if (!isAuthorized(ctx.from?.id, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const db = getSliceDb();
  const pending = db
    .prepare<[], MiraclePlanRow>(
      "SELECT id, chat_id, topic_id, status, intent, title, plan_json, budget_usd_cap, created_at FROM miracle_plans WHERE status IN ('pending_approval', 'running', 'editing') ORDER BY created_at DESC",
    )
    .all() as unknown as Array<{
    id: string;
    status: string;
    title: string | null;
    intent: string;
    created_at: number;
  }>;

  if (pending.length === 0) {
    await ctx.reply("No pending or running plans.");
    return;
  }

  const running = new Set(listRunningPlanIds());
  const lines = pending.map((p) => {
    const ageH = ((Date.now() - p.created_at) / 3600_000).toFixed(1);
    const status = running.has(p.id) ? "🟢 running" : `⚪ ${p.status}`;
    return `${status} · ${p.id.slice(0, 8)} · ${p.title ?? p.intent.slice(0, 40)} · ${ageH}h ago`;
  });

  await ctx.reply(["<b>Miracle plans:</b>", ...lines].join("\n"), {
    parse_mode: "HTML",
  });
}

export async function handleMiracleCancel(ctx: Context): Promise<void> {
  if (!isAuthorized(ctx.from?.id, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const arg = (ctx.match as string | undefined)?.trim() ?? "";
  if (!arg) {
    await ctx.reply("Usage: /miracle-cancel <plan_id_prefix>");
    return;
  }

  const db = getSliceDb();
  const row = db
    .prepare<[string], MiraclePlanRow>(
      "SELECT id, chat_id, topic_id, status, intent, title, plan_json, budget_usd_cap, created_at FROM miracle_plans WHERE id LIKE ? ORDER BY created_at DESC LIMIT 1",
    )
    .get(arg + "%");

  if (!row) {
    await ctx.reply(`No plan with id prefix ${arg}.`);
    return;
  }

  if (row.status === "running") {
    const halted = haltPlanId(row.id);
    db.prepare("UPDATE miracle_plans SET status = 'halted', completed_at = ? WHERE id = ?").run(
      Date.now(),
      row.id,
    );
    await ctx.reply(
      halted
        ? `🛑 Halted plan ${row.id.slice(0, 8)}.`
        : `Marked plan ${row.id.slice(0, 8)} halted (no running executor to abort).`,
    );
    return;
  }

  if (row.status === "pending_approval" || row.status === "editing") {
    db.prepare("UPDATE miracle_plans SET status = 'cancelled', completed_at = ? WHERE id = ?").run(
      Date.now(),
      row.id,
    );
    db.prepare(
      "UPDATE miracle_approvals SET status = 'cancelled' WHERE plan_id = ? AND status = 'pending'",
    ).run(row.id);
    await ctx.reply(`❌ Cancelled plan ${row.id.slice(0, 8)}.`);
    return;
  }

  await ctx.reply(`Plan ${row.id.slice(0, 8)} is already ${row.status}.`);
}
