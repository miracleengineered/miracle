/**
 * Gate 2 smoke #7 — Planner Zod-retry.
 *
 * Mocks the Agent SDK's `query()` so we can inject two staged responses:
 * an invalid JSON body first, then a valid Plan on retry. Verifies the
 * Planner attempts twice, accumulates cost correctly, and returns a
 * well-formed PlannerResult on the second attempt.
 *
 * Also verifies PlanValidationError is thrown when BOTH attempts fail
 * (so the calling handler can mark the plan `failed_planner_output`).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

import { query } from "@anthropic-ai/claude-agent-sdk";
import { runPlanner, PlanValidationError } from "../src/miracle/planner";

const mockQuery = vi.mocked(query);

function makeResultMessage(
  resultText: string,
  opts: { costUsd?: number; numTurns?: number; stopReason?: string } = {},
) {
  return {
    type: "result",
    subtype: "success",
    result: resultText,
    total_cost_usd: opts.costUsd ?? 0.01,
    num_turns: opts.numTurns ?? 1,
    duration_ms: 100,
    duration_api_ms: 90,
    is_error: false,
    stop_reason: opts.stopReason ?? "end_turn",
    usage: {},
    modelUsage: {},
    permission_denials: [],
    uuid: "00000000-0000-0000-0000-000000000000",
    session_id: "test-session",
  };
}

function asyncGenerator<T>(
  items: T[],
): AsyncIterable<T> & { return?: () => Promise<IteratorResult<T>> } {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) yield item;
    },
  };
}

const validPlanJson = JSON.stringify({
  title: "Summarize X",
  summary: "Summarize the research doc.",
  steps: ["Read the doc", "Extract key points", "Write summary"],
  tools: ["Read", "Write"],
  rationale: "Simple read-and-summarize task; no edits to existing files.",
  estimated_cost_usd: 0.3,
});

describe("Planner Zod-retry (Gate 2 smoke #7)", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    process.env.ANTHROPIC_API_KEY_SLICE = "sk-ant-test";
    process.env.ANTHROPIC_API_KEY = "";
  });

  it("succeeds on attempt 1 when the Planner returns valid JSON on first call", async () => {
    mockQuery.mockReturnValueOnce(
      asyncGenerator([makeResultMessage(validPlanJson, { costUsd: 0.02 })]) as ReturnType<
        typeof query
      >,
    );

    const result = await runPlanner({ intent: "summarize the research doc" });

    expect(result.attempts).toBe(1);
    expect(result.costUsd).toBeCloseTo(0.02);
    expect(result.plan.title).toBe("Summarize X");
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("retries once when first output is invalid, succeeds on retry", async () => {
    mockQuery
      .mockReturnValueOnce(
        asyncGenerator([
          makeResultMessage("This is not JSON at all. The model went off-rails.", {
            costUsd: 0.01,
          }),
        ]) as ReturnType<typeof query>,
      )
      .mockReturnValueOnce(
        asyncGenerator([makeResultMessage(validPlanJson, { costUsd: 0.02 })]) as ReturnType<
          typeof query
        >,
      );

    const result = await runPlanner({ intent: "summarize" });

    expect(result.attempts).toBe(2);
    expect(result.costUsd).toBeCloseTo(0.03);
    expect(result.plan.title).toBe("Summarize X");
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it("retries on Zod schema failure (valid JSON but wrong shape), succeeds on retry", async () => {
    const invalidShape = JSON.stringify({ title: "x" }); // missing required fields
    mockQuery
      .mockReturnValueOnce(
        asyncGenerator([makeResultMessage(invalidShape, { costUsd: 0.01 })]) as ReturnType<
          typeof query
        >,
      )
      .mockReturnValueOnce(
        asyncGenerator([makeResultMessage(validPlanJson, { costUsd: 0.02 })]) as ReturnType<
          typeof query
        >,
      );

    const result = await runPlanner({ intent: "summarize" });

    expect(result.attempts).toBe(2);
    expect(result.plan.title).toBe("Summarize X");
  });

  it("throws PlanValidationError when both attempts fail Zod", async () => {
    mockQuery
      .mockReturnValueOnce(
        asyncGenerator([makeResultMessage("not json", { costUsd: 0.01 })]) as ReturnType<
          typeof query
        >,
      )
      .mockReturnValueOnce(
        asyncGenerator([
          makeResultMessage(JSON.stringify({ title: "incomplete" }), { costUsd: 0.01 }),
        ]) as ReturnType<typeof query>,
      );

    await expect(runPlanner({ intent: "test" })).rejects.toBeInstanceOf(PlanValidationError);
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it("tolerates ```json code fences in the output", async () => {
    const fenced = `\`\`\`json\n${validPlanJson}\n\`\`\``;
    mockQuery.mockReturnValueOnce(
      asyncGenerator([makeResultMessage(fenced, { costUsd: 0.01 })]) as ReturnType<typeof query>,
    );

    const result = await runPlanner({ intent: "summarize" });
    expect(result.attempts).toBe(1);
    expect(result.plan.title).toBe("Summarize X");
  });
});
