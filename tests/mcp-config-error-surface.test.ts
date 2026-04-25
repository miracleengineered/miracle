import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("MCP config load surfaces errors (Fix 3.G)", () => {
  const src = readFileSync(resolve(__dirname, "..", "src", "config.ts"), "utf8");

  it("replaces silent .catch(() => null) with logging variant", () => {
    // Silent swallow is forbidden: any .catch on mcp-config import must log.
    const silentSwallow = /\.catch\(\s*\(\)\s*=>\s*null\s*\)/.test(src);
    expect(silentSwallow).toBe(false);
  });

  it("logs on mcp-config load failure", () => {
    // Either a .catch() with console.error or an outer catch block with it.
    const logsError =
      /console\.error\([^)]*mcp.*config/i.test(src) || /console\.error\([^)]*MCP/.test(src);
    expect(logsError).toBe(true);
  });
});
