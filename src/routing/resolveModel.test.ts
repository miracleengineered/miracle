import { describe, it, expect } from "vitest";
import { resolveModel } from "./resolveModel.js";

describe("resolveModel", () => {
  it("returns the routed default for orchestrator jobs", () => {
    expect(resolveModel("orchestrator")).toBe("opus");
  });

  it("returns the routed default for orchestrator subtask jobs", () => {
    expect(resolveModel("orchestrator-subtask")).toBe("sonnet");
  });

  it("returns the override when one is provided, ignoring the table", () => {
    expect(resolveModel("orchestrator", "sonnet")).toBe("sonnet");
    expect(resolveModel("orchestrator-subtask", "haiku")).toBe("haiku");
    expect(resolveModel("unknown-kind", "opus")).toBe("opus");
  });

  it("throws 'unknown kind' when the kind is absent from the table and no override is given", () => {
    expect(() => resolveModel("unknown-kind")).toThrow(/unknown kind: unknown-kind/);
  });
});
