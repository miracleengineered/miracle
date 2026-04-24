import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("dependency pinning contract", () => {
  const pkg = JSON.parse(
    readFileSync(resolve(__dirname, "..", "package.json"), "utf8"),
  ) as { dependencies: Record<string, string> };

  it("pins @anthropic-ai/claude-agent-sdk to exact 0.2.118 (Fix 3.H)", () => {
    const ver = pkg.dependencies["@anthropic-ai/claude-agent-sdk"];
    expect(ver).toBe("0.2.118");
  });
});
