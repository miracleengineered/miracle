import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("global error handlers in index.ts (Fix 3.E)", () => {
  const src = readFileSync(resolve(__dirname, "..", "src", "index.ts"), "utf8");

  it("registers process.on('unhandledRejection')", () => {
    expect(src).toMatch(/process\.on\(\s*["']unhandledRejection["']/);
  });

  it("registers process.on('uncaughtException')", () => {
    expect(src).toMatch(/process\.on\(\s*["']uncaughtException["']/);
  });

  it("logs rejection / exception with a grep-able prefix", () => {
    expect(src).toMatch(/UNHANDLED-REJECTION/);
    expect(src).toMatch(/UNCAUGHT-EXCEPTION/);
  });

  it("no empty catch block remains at unlink(RESTART_FILE)", () => {
    // The old code had: try { unlinkSync(RESTART_FILE); } catch {}
    expect(src).not.toMatch(/try\s*\{\s*unlinkSync\(RESTART_FILE\);\s*\}\s*catch\s*\{\s*\}/);
  });
});
