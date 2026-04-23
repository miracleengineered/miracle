import { describe, it, expect } from "vitest";
import { PlanSchema, formatZodError } from "../src/miracle/plan-schema";

function validPlan() {
  return {
    title: "Summarize TAM for dev tools",
    summary: "Research dev-tools market size and produce a 5-line brief.",
    steps: [
      "Pull recent market reports from public sources",
      "Extract TAM figures and year",
      "Aggregate into a single table",
      "Write a 5-line summary",
      "Save to vault",
    ],
    tools: ["Read", "Write"],
    rationale: "Quick research task; no code edits needed, just reading + summarization.",
    estimated_cost_usd: 0.5,
  };
}

describe("PlanSchema", () => {
  it("accepts a valid plan", () => {
    const result = PlanSchema.safeParse(validPlan());
    expect(result.success).toBe(true);
  });

  it("rejects plans with more than 5 steps", () => {
    const p = validPlan();
    p.steps.push("6th step");
    const result = PlanSchema.safeParse(p);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(formatZodError(result.error)).toMatch(/steps/);
    }
  });

  it("rejects step text longer than 100 chars", () => {
    const p = validPlan();
    p.steps[0] = "x".repeat(101);
    const result = PlanSchema.safeParse(p);
    expect(result.success).toBe(false);
  });

  it("rejects tools not in the fixed Read/Edit/Write/Bash set", () => {
    const p = { ...validPlan(), tools: ["Read", "NotATool"] };
    const result = PlanSchema.safeParse(p);
    expect(result.success).toBe(false);
  });

  it("rejects negative cost estimates", () => {
    const p = { ...validPlan(), estimated_cost_usd: -1 };
    const result = PlanSchema.safeParse(p);
    expect(result.success).toBe(false);
  });

  it("rejects unknown top-level fields (strict mode)", () => {
    const p = { ...validPlan(), extraField: "nope" };
    const result = PlanSchema.safeParse(p);
    expect(result.success).toBe(false);
  });

  it("formatZodError produces compact human-readable feedback for retry prompt", () => {
    const p = validPlan();
    p.title = ""; // required
    (p as unknown as { estimated_cost_usd: number }).estimated_cost_usd = -5;
    const result = PlanSchema.safeParse(p);
    expect(result.success).toBe(false);
    if (!result.success) {
      const formatted = formatZodError(result.error);
      expect(formatted).toMatch(/title/);
      expect(formatted).toMatch(/estimated_cost_usd/);
      expect(formatted.split("\n").length).toBeGreaterThanOrEqual(2);
    }
  });
});
