/**
 * Miracle v1 slice — Planner.
 *
 * Given a user intent ("summarize TAM for dev tools", "audit Genesis repo"),
 * calls Sonnet 4.6 via the Agent SDK to produce a structured plan matching
 * PlanSchema. Zod-validates the output; on failure retries ONCE with error
 * feedback appended; on second failure throws PlanValidationError so the
 * handler can mark the plan `failed_planner_output`.
 *
 * No tools — pure text-generation call. One round-trip normally, two on
 * retry. Costs logged via SDKResultSuccess.total_cost_usd.
 */

import {
  query,
  type SDKMessage,
  type SDKResultSuccess,
} from "@anthropic-ai/claude-agent-sdk";
import { resolveModel } from "../routing/resolveModel.js";
import { PlanSchema, formatZodError, type Plan } from "./plan-schema.js";
import { withSliceApiKey } from "./auth.js";

export class PlanValidationError extends Error {
  readonly zodErrorText: string;
  readonly rawOutputs: string[];

  constructor(zodErrorText: string, rawOutputs: string[]) {
    super(`Planner output failed Zod validation after 1 retry:\n${zodErrorText}`);
    this.name = "PlanValidationError";
    this.zodErrorText = zodErrorText;
    this.rawOutputs = rawOutputs;
  }
}

export interface PlannerResult {
  plan: Plan;
  costUsd: number;
  turnCount: number;
  /** The model-reported output on the attempt that succeeded (for debugging). */
  rawOutput: string;
  /** Number of attempts the planner made (1 for first-try success, 2 for retry-success). */
  attempts: number;
}

/**
 * Construct the system prompt for the Planner. Includes the JSON schema
 * contract and hard constraints on tool set + step count + cost bounds.
 */
function buildSystemPrompt(): string {
  return [
    "You are Miracle's Planner. Given a user intent, you produce a structured plan that the Executor will run after human approval.",
    "",
    "Output **only** a single JSON object matching this exact schema:",
    "",
    "```json",
    "{",
    '  "title": "string, ≤120 chars",',
    '  "summary": "string, ≤400 chars, one-line human-readable purpose",',
    '  "steps": ["≤5 items, each ≤100 chars, imperative voice"],',
    '  "tools": ["subset of: Read, Edit, Write, Bash"],',
    '  "rationale": "string, ≤800 chars, WHY these steps achieve the intent",',
    '  "estimated_cost_usd": number',
    "}",
    "```",
    "",
    "Constraints:",
    "- No commentary before or after the JSON. Just the JSON.",
    "- No ```json fences around the output.",
    "- `tools` must only contain names from: Read, Edit, Write, Bash.",
    "- `steps` must be ≤5 items. If the task feels bigger, scope it smaller or recommend a decomposition via the rationale.",
    "- `estimated_cost_usd` is your best-effort budget estimate. Be conservative; the user caps at $2/run default.",
    "- If the user intent is ambiguous, pick the most likely interpretation and explain in rationale.",
  ].join("\n");
}

function buildUserPrompt(intent: string, previousError?: string): string {
  if (!previousError) return intent;
  return [
    "Your previous output failed JSON schema validation:",
    previousError,
    "",
    "Produce a corrected plan. Output only the JSON object — no commentary, no fences.",
    "",
    "Original intent:",
    intent,
  ].join("\n");
}

/**
 * Consume the SDK query async generator, return the final
 * SDKResultSuccess (which carries `result: string`, cost, turns).
 * Throws on SDKResultError.
 */
async function runQueryOnce(
  userPrompt: string,
  systemPrompt: string,
  model: string,
  abortSignal?: AbortSignal,
): Promise<SDKResultSuccess> {
  const q = query({
    prompt: userPrompt,
    options: {
      model,
      systemPrompt,
      tools: [],
      maxTurns: 1,
      ...(abortSignal ? { abortController: abortControllerFrom(abortSignal) } : {}),
    },
  });

  let final: SDKResultSuccess | null = null;
  for await (const msg of q as AsyncIterable<SDKMessage>) {
    if (msg.type === "result") {
      if (msg.subtype === "success") {
        final = msg;
      } else {
        throw new Error(
          `Planner query ended with error: ${(msg as { subtype?: string }).subtype ?? "unknown"}`,
        );
      }
    }
  }

  if (!final) {
    throw new Error("Planner query produced no result message");
  }
  return final;
}

/**
 * Bridge an external AbortSignal into an AbortController the SDK expects.
 */
function abortControllerFrom(signal: AbortSignal): AbortController {
  const ac = new AbortController();
  if (signal.aborted) {
    ac.abort();
  } else {
    signal.addEventListener("abort", () => ac.abort(), { once: true });
  }
  return ac;
}

/**
 * Parse a string that should contain only a JSON object. Tolerates a
 * leading/trailing ```json fence since models sometimes emit one despite
 * instructions.
 */
function extractJsonPayload(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  const body = fenced?.[1]?.trim() ?? trimmed;
  return JSON.parse(body);
}

export interface RunPlannerOptions {
  intent: string;
  modelKind?: string;
  abortSignal?: AbortSignal;
}

export async function runPlanner(opts: RunPlannerOptions): Promise<PlannerResult> {
  const model = resolveModel(opts.modelKind ?? "miracle-planner");
  const systemPrompt = buildSystemPrompt();

  const rawOutputs: string[] = [];
  let zodErrorText: string | null = null;
  let totalCostUsd = 0;
  let totalTurns = 0;

  return withSliceApiKey(async () => {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const userPrompt = buildUserPrompt(opts.intent, zodErrorText ?? undefined);
      const final = await runQueryOnce(userPrompt, systemPrompt, model, opts.abortSignal);
      totalCostUsd += final.total_cost_usd;
      totalTurns += final.num_turns;
      rawOutputs.push(final.result);

      let parsed: unknown;
      try {
        parsed = extractJsonPayload(final.result);
      } catch (err) {
        zodErrorText = `JSON parse failed: ${(err as Error).message}`;
        continue;
      }

      const validation = PlanSchema.safeParse(parsed);
      if (validation.success) {
        return {
          plan: validation.data,
          costUsd: totalCostUsd,
          turnCount: totalTurns,
          rawOutput: final.result,
          attempts: attempt,
        };
      }

      zodErrorText = formatZodError(validation.error);
    }

    throw new PlanValidationError(zodErrorText ?? "unknown", rawOutputs);
  });
}
