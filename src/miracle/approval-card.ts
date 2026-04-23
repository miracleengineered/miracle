/**
 * Approval-card renderer.
 *
 * Given a validated Plan + plan_id + fresh nonce, produces:
 *  - Telegram-HTML body text (~800–1500 chars, medium layout per decision #21)
 *  - An InlineKeyboardMarkup with three HMAC-signed Approve/Edit/Reject buttons
 *
 * Callback data format: `mir:{aid8}:{nonce8}:{verdict}:{sig8}` — 32 bytes,
 * well under Telegram's 64-byte callback_data limit. The HMAC is SHA-256
 * over `mir:{aid8}:{nonce8}:{verdict}` using MIRACLE_HMAC_SECRET, truncated
 * to 8 hex chars. Truncation is fine: 32 bits of entropy is enough to stop
 * guessing attacks against a specific (aid, nonce, verdict) triple, which
 * already requires knowing two 32-bit random values first.
 */

import { createHmac, randomBytes } from "node:crypto";
import type { Plan } from "./plan-schema.js";

export type Verdict = "A" | "E" | "R";

const VERDICT_LABELS: Record<Verdict, string> = {
  A: "Approve",
  E: "Edit",
  R: "Reject",
};

export interface ApprovalCard {
  text: string;
  replyMarkup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
}

/**
 * Stable callback_data prefix. Handlers filter on this.
 */
export const CALLBACK_PREFIX = "mir";

export interface SignedCallback {
  aid8: string;
  nonce8: string;
  verdict: Verdict;
  sig8: string;
  encoded: string;
}

function getHmacSecret(): string {
  const secret = process.env.MIRACLE_HMAC_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error(
      "MIRACLE_HMAC_SECRET missing or too short (need ≥16 chars). Set it in the launchd plist or bot env.",
    );
  }
  return secret;
}

export function signCallback(
  approvalId: string,
  nonce: string,
  verdict: Verdict,
): SignedCallback {
  const aid8 = approvalId.replace(/-/g, "").slice(0, 8);
  const nonce8 = nonce.replace(/-/g, "").slice(0, 8);
  const secret = getHmacSecret();
  const body = `${CALLBACK_PREFIX}:${aid8}:${nonce8}:${verdict}`;
  const sig8 = createHmac("sha256", secret).update(body).digest("hex").slice(0, 8);
  const encoded = `${body}:${sig8}`;
  return { aid8, nonce8, verdict, sig8, encoded };
}

export function verifyCallback(
  encoded: string,
): { aid8: string; nonce8: string; verdict: Verdict } | null {
  const parts = encoded.split(":");
  if (parts.length !== 5) return null;
  const [prefix, aid8, nonce8, verdict, sig8] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (prefix !== CALLBACK_PREFIX) return null;
  if (!/^[a-f0-9]{8}$/i.test(aid8)) return null;
  if (!/^[a-f0-9]{8}$/i.test(nonce8)) return null;
  if (verdict !== "A" && verdict !== "E" && verdict !== "R") return null;
  if (!/^[a-f0-9]{8}$/i.test(sig8)) return null;

  const secret = getHmacSecret();
  const body = `${CALLBACK_PREFIX}:${aid8}:${nonce8}:${verdict}`;
  const expected = createHmac("sha256", secret).update(body).digest("hex").slice(0, 8);
  if (!constantTimeEquals(sig8.toLowerCase(), expected.toLowerCase())) return null;

  return { aid8, nonce8, verdict };
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Generate a fresh random nonce as 32 hex chars (128 bits). We use the
 * first 8 hex chars in callback_data but store the full 32 in the DB so
 * collisions are astronomically unlikely even over years of runs.
 */
export function generateNonce(): string {
  return randomBytes(16).toString("hex");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderStepsBlock(steps: string[]): string {
  return steps.map((step, i) => `${i + 1}. ${escapeHtml(step)}`).join("\n");
}

/**
 * Render a Plan into a Telegram HTML approval card + inline keyboard
 * with three HMAC-signed verdict buttons.
 */
export function renderApprovalCard(
  plan: Plan,
  approvalId: string,
  nonce: string,
): ApprovalCard {
  const parts: string[] = [];
  parts.push(`<b>${escapeHtml(plan.title)}</b>`);
  parts.push(escapeHtml(plan.summary));
  parts.push("");
  parts.push("<b>Steps:</b>");
  parts.push(renderStepsBlock(plan.steps));
  parts.push("");
  parts.push(`<b>Tools:</b> ${plan.tools.map(escapeHtml).join(", ")}`);
  parts.push(`<b>Est. cost:</b> $${plan.estimated_cost_usd.toFixed(2)}`);
  parts.push("");
  parts.push(`<i>${escapeHtml(plan.rationale)}</i>`);

  const text = parts.join("\n");

  const approve = signCallback(approvalId, nonce, "A");
  const edit = signCallback(approvalId, nonce, "E");
  const reject = signCallback(approvalId, nonce, "R");

  const keyboard: ApprovalCard["replyMarkup"] = {
    inline_keyboard: [
      [
        { text: `✅ ${VERDICT_LABELS.A}`, callback_data: approve.encoded },
        { text: `✏️ ${VERDICT_LABELS.E}`, callback_data: edit.encoded },
        { text: `❌ ${VERDICT_LABELS.R}`, callback_data: reject.encoded },
      ],
    ],
  };

  return { text, replyMarkup: keyboard };
}
