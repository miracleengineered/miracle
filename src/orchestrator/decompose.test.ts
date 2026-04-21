import { describe, expect, it } from "vitest";
import { decomposeAsk } from "./decompose.js";

describe("decomposeAsk", () => {
  it("treats a simple ask as one subtask", () => {
    expect(decomposeAsk("Summarize the roadmap")).toEqual([
      { index: 0, ask: "Summarize the roadmap" },
    ]);
  });

  it("splits asks joined by and", () => {
    expect(decomposeAsk("Research the customer pain points and draft a reply")).toEqual([
      { index: 0, ask: "Research the customer pain points" },
      { index: 1, ask: "draft a reply" },
    ]);
  });

  it("splits asks joined by then", () => {
    expect(decomposeAsk("Review the notes then prepare the summary")).toEqual([
      { index: 0, ask: "Review the notes" },
      { index: 1, ask: "prepare the summary" },
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
