/**
 * Planner output schema.
 *
 * Enforces structural validity of what the Planner returns before we
 * show an approval card. On validation failure the Planner gets one
 * retry with the error appended; second failure marks the plan
 * `failed_planner_output`.
 *
 * Layout constraints come from Gate 2 decision #21 (medium approval
 * card): ≤5 steps, each ≤100 chars, plus metadata. Token budget
 * targets ~800–1500 chars rendered.
 */

import { z } from "zod";

/**
 * Pre-approved tool set, per decision #5: Executor gets Read/Edit/Write/Bash.
 * No Channels permission relay in v1 — all four are authorized at approval
 * time, and the preToolUse hook filters Bash via BLOCKED_PATTERNS.
 */
export const SLICE_TOOL_NAMES = ["Read", "Edit", "Write", "Bash"] as const;
export type SliceToolName = (typeof SLICE_TOOL_NAMES)[number];

const ToolNameEnum = z.enum(SLICE_TOOL_NAMES);

export const PlanSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(1, "title is required")
      .max(120, "title must be ≤120 chars"),
    summary: z
      .string()
      .trim()
      .min(1, "summary is required")
      .max(400, "summary must be ≤400 chars"),
    steps: z
      .array(
        z
          .string()
          .trim()
          .min(1, "step text is required")
          .max(100, "each step must be ≤100 chars"),
      )
      .min(1, "at least one step is required")
      .max(5, "max 5 steps per approval card"),
    tools: z
      .array(ToolNameEnum)
      .min(1, "tool list is required")
      .max(SLICE_TOOL_NAMES.length, "duplicate tools"),
    rationale: z
      .string()
      .trim()
      .min(1, "rationale is required")
      .max(2000, "rationale must be ≤2000 chars"),
    estimated_cost_usd: z
      .number()
      .nonnegative("estimated cost must be ≥ 0")
      .max(100, "estimated cost cap sanity check (≤$100)"),
  })
  .strict();

export type Plan = z.infer<typeof PlanSchema>;

/**
 * Render a Zod failure as human-readable feedback for the Planner's
 * retry prompt. Keeps the error compact — no full stack, just
 * field paths + messages — so the retry prompt stays tight.
 */
export function formatZodError(err: z.ZodError): string {
  return err.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `- ${path}: ${issue.message}`;
    })
    .join("\n");
}
