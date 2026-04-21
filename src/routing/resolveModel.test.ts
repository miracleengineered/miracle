import { describe, it, expect } from "vitest";
import { resolveModel } from "./resolveModel.js";

// These tests run against the empty scaffolded routing table. C6's
// sub-branch populates the table and adds lookup tests.

describe("resolveModel", () => {
  it("returns the override when one is provided, ignoring the table", () => {
    expect(resolveModel("any-kind", "opus")).toBe("opus");
    expect(resolveModel("another-kind", "sonnet")).toBe("sonnet");
    expect(resolveModel("third-kind", "haiku")).toBe("haiku");
  });

  it("throws 'unknown kind' when the kind is absent from the table and no override is given", () => {
    expect(() => resolveModel("orchestrator")).toThrow(/unknown kind: orchestrator/);
    expect(() => resolveModel("orchestrator-subtask")).toThrow(
      /unknown kind: orchestrator-subtask/,
    );
  });
});
