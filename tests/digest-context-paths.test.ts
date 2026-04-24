import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("digest-context path derivation (Fix 3.F)", () => {
  const src = readFileSync(
    resolve(__dirname, "..", "src", "handlers", "digest-context.ts"),
    "utf8",
  );

  it("does not hardcode /Users/genesisai/Projects/miracle paths", () => {
    expect(src).not.toMatch(/\/Users\/genesisai\/Projects\/miracle\//);
  });

  it("derives paths via import.meta.url or fileURLToPath", () => {
    expect(src).toMatch(/import\.meta\.url|fileURLToPath/);
  });
});
