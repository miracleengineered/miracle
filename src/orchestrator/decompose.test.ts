import { describe, expect, it } from "vitest";
import { decomposeAsk } from "./decompose.js";

describe("decomposeAsk", () => {
  it("treats a simple ask as one subtask", () => {
    expect(decomposeAsk("Summarize the roadmap")).toEqual([
      { index: 0, ask: "Summarize the roadmap" },
    ]);
  });

  it("prefers numbered lists when present", () => {
    expect(
      decomposeAsk("1. Collect user feedback\n2. Identify themes\n3. Suggest next actions"),
    ).toEqual([
      { index: 0, ask: "Collect user feedback" },
      { index: 1, ask: "Identify themes" },
      { index: 2, ask: "Suggest next actions" },
    ]);
  });
});
