import { describe, expect, it } from "vitest";
import { synthesizeResults } from "./synthesize.js";
import type { SubtaskResult } from "./types.js";

describe("synthesizeResults", () => {
  it("concatenates ordered subtask sections with headers", () => {
    const subtasks: SubtaskResult[] = [
      {
        jobId: "child-b",
        index: 1,
        ask: "Draft the final answer",
        status: "completed",
        result: "Draft complete",
        completedAt: 2,
      },
      {
        jobId: "child-a",
        index: 0,
        ask: "Gather the requirements",
        status: "completed",
        result: "Requirements collected",
        completedAt: 1,
      },
    ];

    expect(synthesizeResults(subtasks)).toBe(
      [
        "## Subtask 1: Gather the requirements",
        "Status: completed",
        "",
        "Requirements collected",
        "",
        "## Subtask 2: Draft the final answer",
        "Status: completed",
        "",
        "Draft complete",
      ].join("\n"),
    );
  });

  it("serializes non-string child results and surfaces failures", () => {
    const output = synthesizeResults([
      {
        jobId: "child-a",
        index: 0,
        ask: "Investigate the discrepancy",
        status: "failed",
        result: { reason: "sources disagree", confidence: "low" },
        completedAt: 3,
      },
    ]);

    expect(output).toContain("## Subtask 1: Investigate the discrepancy");
    expect(output).toContain("Status: failed");
    expect(output).toContain('"reason": "sources disagree"');
  });
});
