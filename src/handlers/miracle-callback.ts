/**
 * Handles Approve / Edit / Reject inline-keyboard taps on Miracle slice
 * approval cards.
 *
 * Flow:
 *  1. Parse + HMAC-verify the callback_data (format `mir:{aid8}:{nonce8}:{verdict}:{sig8}`).
 *  2. Look up the approval row by `hmac_nonce` prefix and confirm it's still
 *     in status `pending` and not expired. Treat reuse / forgery as 400-class
 *     errors — answerCallbackQuery with a short reason, no DB mutation.
 *  3. On a fresh valid tap: mark the approval consumed (status <- verdict),
 *     update the plan accordingly, and dispatch:
 *       - A → set plan.status=running, kick off runExecutor in the plan's
 *             Topic (fire-and-forget; the Executor owns its own lifecycle).
 *       - E → set plan.status=editing, ask the user in the Topic for the
 *             change they want. Simple text reply in the same Topic is the
 *             feedback signal (wired from miracle-commands.ts text listener
 *             in a later pass; for Gate 2.2 we just record the intent).
 *       - R → set plan.status=rejected. No further action.
 *  4. answerCallbackQuery with a short toast.
 */

import type { Context } from "grammy";
import { CALLBACK_PREFIX, verifyCallback, type Verdict } from "../miracle/approval-card.js";
import { getSliceDb } from "../miracle/db.js";
import { runExecutor } from "../miracle/executor.js";
import type { Plan } from "../miracle/plan-schema.js";

interface ApprovalRow {
  id: string;
  plan_id: string;
  hmac_nonce: string;
  status: string;
  expires_at: number;
  created_at: number;
}

interface PlanRow {
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

/**
 * True if the callback_data is a Miracle slice callback. Used by the
 * top-level callback router to peel slice traffic out of the main
 * handleCallback fallback in src/handlers/callback.ts.
 */
export function isMiracleCallback(data: string): boolean {
  return data.startsWith(CALLBACK_PREFIX + ":");
}

export async function handleMiracleCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data || !isMiracleCallback(data)) return;

  const parsed = verifyCallback(data);
  if (!parsed) {
    await ctx.answerCallbackQuery({ text: "Invalid or expired signature.", show_alert: false });
    return;
  }

  const { aid8, nonce8, verdict } = parsed;
  const db = getSliceDb();

  const approval = db
    .prepare<[string], ApprovalRow>(
      "SELECT id, plan_id, hmac_nonce, status, expires_at, created_at FROM miracle_approvals WHERE hmac_nonce LIKE ?",
    )
    .get(nonce8 + "%");

  if (!approval) {
    await ctx.answerCallbackQuery({ text: "Approval not found.", show_alert: false });
    return;
  }
  if (!approval.id.startsWith(aid8)) {
    await ctx.answerCallbackQuery({ text: "Approval id mismatch.", show_alert: false });
    return;
  }
  if (approval.status !== "pending") {
    await ctx.answerCallbackQuery({
      text: `Already ${approval.status}.`,
      show_alert: false,
    });
    return;
  }
  if (approval.expires_at < Date.now()) {
    // Mark expired so listings reflect it.
    db.prepare("UPDATE miracle_approvals SET status = 'expired' WHERE id = ?").run(approval.id);
    await ctx.answerCallbackQuery({ text: "Approval expired (72h).", show_alert: false });
    return;
  }

  // Load the plan row.
  const planRow = db
    .prepare<[string], PlanRow>(
      "SELECT id, chat_id, topic_id, status, intent, title, plan_json, budget_usd_cap, created_at FROM miracle_plans WHERE id = ?",
    )
    .get(approval.plan_id);

  if (!planRow) {
    await ctx.answerCallbackQuery({ text: "Plan not found.", show_alert: false });
    return;
  }

  // Mark approval consumed FIRST, atomically. Any downstream failure
  // is logged but doesn't roll this back — the button is single-use.
  db.prepare("UPDATE miracle_approvals SET status = ? WHERE id = ?").run(
    verdictToApprovalStatus(verdict),
    approval.id,
  );

  switch (verdict) {
    case "A":
      await handleApprove(ctx, planRow);
      break;
    case "E":
      await handleEdit(ctx, planRow);
      break;
    case "R":
      await handleReject(ctx, planRow);
      break;
  }
}

function verdictToApprovalStatus(verdict: Verdict): string {
  switch (verdict) {
    case "A":
      return "approved";
    case "E":
      return "edit_requested";
    case "R":
      return "rejected";
  }
}

async function handleApprove(ctx: Context, planRow: PlanRow): Promise<void> {
  const db = getSliceDb();

  // Enforce max 1 concurrent plan (decision #18). If another plan is
  // already running, do NOT start a second executor; leave the approval
  // consumed but mark the plan's status as queued-blocked until the
  // running one finishes.
  const running = db
    .prepare<[], { n: number }>("SELECT count(*) as n FROM miracle_plans WHERE status = 'running'")
    .get();

  if (running && running.n > 0) {
    db.prepare("UPDATE miracle_plans SET status = 'blocked_concurrent' WHERE id = ?").run(
      planRow.id,
    );
    await ctx.answerCallbackQuery({
      text: "Another plan is running — /miracle-halt it first.",
      show_alert: true,
    });
    return;
  }

  const now = Date.now();
  db.prepare("UPDATE miracle_plans SET status = ?, approved_at = ? WHERE id = ?").run(
    "running",
    now,
    planRow.id,
  );

  await ctx.answerCallbackQuery({ text: "Approved — launching executor.", show_alert: false });

  // Parse the plan JSON.
  let plan: Plan | null = null;
  try {
    plan = JSON.parse(planRow.plan_json ?? "null") as Plan;
  } catch {
    // fall through
  }
  if (!plan) {
    db.prepare(
      "UPDATE miracle_plans SET status = 'failed_plan_parse', completed_at = ? WHERE id = ?",
    ).run(now, planRow.id);
    return;
  }

  // Fire-and-forget the executor. Errors are logged inside runExecutor.
  void runExecutor({
    planId: planRow.id,
    plan,
    intent: planRow.intent,
    chatId: planRow.chat_id,
    topicId: planRow.topic_id ?? undefined,
    budgetUsdCap: planRow.budget_usd_cap,
    bot: ctx.api,
  })
    .then((result) => {
      const finalStatus =
        result.outcome === "completed"
          ? "completed"
          : result.outcome === "failed_halt"
            ? "halted"
            : result.outcome;
      db.prepare("UPDATE miracle_plans SET status = ?, completed_at = ? WHERE id = ?").run(
        finalStatus,
        Date.now(),
        planRow.id,
      );
    })
    .catch((err) => {
      console.error("runExecutor threw:", err);
      db.prepare(
        "UPDATE miracle_plans SET status = 'failed_error', completed_at = ? WHERE id = ?",
      ).run(Date.now(), planRow.id);
    });
}

async function handleEdit(ctx: Context, planRow: PlanRow): Promise<void> {
  const db = getSliceDb();
  db.prepare("UPDATE miracle_plans SET status = 'editing' WHERE id = ?").run(planRow.id);

  await ctx.answerCallbackQuery({ text: "Edit requested.", show_alert: false });
  try {
    await ctx.api.sendMessage(
      planRow.chat_id,
      "✏️ Reply in this thread with the change you want — I'll re-run the Planner with your feedback.",
      planRow.topic_id !== null ? { message_thread_id: planRow.topic_id } : {},
    );
  } catch (err) {
    console.warn("handleEdit: sendMessage failed", err);
  }
}

async function handleReject(ctx: Context, planRow: PlanRow): Promise<void> {
  const db = getSliceDb();
  db.prepare("UPDATE miracle_plans SET status = 'rejected', completed_at = ? WHERE id = ?").run(
    Date.now(),
    planRow.id,
  );

  await ctx.answerCallbackQuery({ text: "Rejected.", show_alert: false });
  try {
    await ctx.api.sendMessage(
      planRow.chat_id,
      "❌ Plan rejected. Nothing will run.",
      planRow.topic_id !== null ? { message_thread_id: planRow.topic_id } : {},
    );
  } catch (err) {
    console.warn("handleReject: sendMessage failed", err);
  }
}
