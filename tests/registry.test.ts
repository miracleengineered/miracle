import { describe, it, expect, vi } from "vitest";

// Mock fs before importing registry
vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    readFileSync: vi.fn(),
  };
});

import { readFileSync } from "fs";
import { parseRegistry } from "../src/registry";

const mockReadFileSync = vi.mocked(readFileSync);

const FIXTURE = `# Project Registry

| Name | Type | Status | Location | Description |
|------|------|--------|----------|-------------|
| AlphaProject | App | Active | D:\\Projects\\Alpha | Main application |
| BetaScript | Script | Archived | D:\\___ATM\\Beta | Utility script |
| GammaLib | Library | Active | D:\\Projects\\Gamma | Shared library |
| DeltaTool | Tool | Paused | D:\\Projects\\Delta | Dev tooling |

## Definitions
Status values...
`;

describe("parseRegistry", () => {
  it("parses all rows from the table", () => {
    mockReadFileSync.mockReturnValue(FIXTURE);
    const projects = parseRegistry();
    expect(projects).toHaveLength(4);
  });

  it("extracts all fields correctly", () => {
    mockReadFileSync.mockReturnValue(FIXTURE);
    const projects = parseRegistry();
    const alpha = projects.find((p) => p.name === "AlphaProject");
    expect(alpha).toEqual({
      name: "AlphaProject",
      type: "App",
      status: "Active",
      location: "D:/Projects/Alpha",
      description: "Main application",
    });
  });

  it("normalizes backslashes to forward slashes in location", () => {
    mockReadFileSync.mockReturnValue(FIXTURE);
    const projects = parseRegistry();
    for (const p of projects) {
      expect(p.location).not.toContain("\\");
    }
  });

  it("sorts Active projects first, then alphabetically", () => {
    mockReadFileSync.mockReturnValue(FIXTURE);
    const projects = parseRegistry();
    // Active: AlphaProject, GammaLib (alphabetical)
    // Non-active: BetaScript, DeltaTool (alphabetical)
    expect(projects.map((p) => p.name)).toEqual([
      "AlphaProject",
      "GammaLib",
      "BetaScript",
      "DeltaTool",
    ]);
  });

  it("returns empty array on read error", () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    const projects = parseRegistry();
    expect(projects).toEqual([]);
  });

  it("returns empty array for empty file", () => {
    mockReadFileSync.mockReturnValue("");
    const projects = parseRegistry();
    expect(projects).toEqual([]);
  });

  it("skips rows with fewer than 5 columns", () => {
    const badTable = `| Name | Type | Status | Location | Description |
|------|------|--------|----------|-------------|
| Good | App | Active | D:\\Projects\\Good | Works fine |
| Bad | App |
`;
    mockReadFileSync.mockReturnValue(badTable);
    const projects = parseRegistry();
    expect(projects).toHaveLength(1);
    expect(projects[0]!.name).toBe("Good");
  });

  it("stops parsing at empty line after table", () => {
    const tableWithTrailing = `| Name | Type | Status | Location | Description |
|------|------|--------|----------|-------------|
| First | App | Active | D:\\Projects\\First | First project |

| Stray | Row | After | Gap | Should be ignored |
`;
    mockReadFileSync.mockReturnValue(tableWithTrailing);
    const projects = parseRegistry();
    expect(projects).toHaveLength(1);
    expect(projects[0]!.name).toBe("First");
  });
});
