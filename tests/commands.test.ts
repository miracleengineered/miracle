import { describe, it, expect, vi } from "vitest";

// Mock config to prevent side effects (process.exit, mkdirSync, etc.)
vi.mock("../src/config", () => ({
  ALLOWED_USERS: [12345],
  RESTART_FILE: "/tmp/restart.json",
}));

// Mock session (imported by commands.ts)
vi.mock("../src/session", () => ({
  session: {},
}));

// Mock utils (imported by commands.ts)
vi.mock("../src/utils", () => ({
  sleep: vi.fn(),
}));

// Mock registry (imported by commands.ts)
vi.mock("../src/registry", () => ({
  parseRegistry: vi.fn(() => []),
}));

// Mock security (imported by commands.ts)
vi.mock("../src/security", () => ({
  isAuthorized: vi.fn(() => false),
}));

// Mock fs for parseRoadmap
vi.mock("fs", async () => {
  const actual =
    await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
});

import { existsSync, readFileSync } from "fs";
import { GSD_OPERATIONS, parseRoadmap } from "../src/handlers/commands";

// ============== GSD_OPERATIONS ==============

describe("GSD_OPERATIONS", () => {
  it("has 19 entries", () => {
    expect(GSD_OPERATIONS).toHaveLength(19);
  });

  it("has no duplicate keys", () => {
    const keys = GSD_OPERATIONS.map((op) => op[0]);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("has no duplicate labels", () => {
    const labels = GSD_OPERATIONS.map((op) => op[1]);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("all commands start with /gsd:", () => {
    for (const [, , cmd] of GSD_OPERATIONS) {
      expect(cmd).toMatch(/^\/gsd:/);
    }
  });

  it("each entry has exactly 3 elements", () => {
    for (const entry of GSD_OPERATIONS) {
      expect(entry).toHaveLength(3);
    }
  });
});

// ============== parseRoadmap ==============

describe("parseRoadmap", () => {
  const mockExistsSync = vi.mocked(existsSync);
  const mockReadFileSync = vi.mocked(readFileSync);

  it("parses completed phases", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      "- [x] **Phase 1: Foundation** - Set up project structure\n"
    );

    const phases = parseRoadmap("/fake/project");
    expect(phases).toHaveLength(1);
    expect(phases[0]!.status).toBe("done");
    expect(phases[0]!.number).toBe("1");
    expect(phases[0]!.name).toBe("Foundation");
  });

  it("parses pending phases", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      "- [ ] **Phase 2: API Layer** - Build REST endpoints\n"
    );

    const phases = parseRoadmap("/fake/project");
    expect(phases).toHaveLength(1);
    expect(phases[0]!.status).toBe("pending");
  });

  it("parses skipped phases", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      "- [~] **Phase 3: Caching** - Add Redis cache layer\n"
    );

    const phases = parseRoadmap("/fake/project");
    expect(phases).toHaveLength(1);
    expect(phases[0]!.status).toBe("skipped");
  });

  it("extracts number, name, and description", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      "- [x] **Phase 4: Dashboard** - Web UI for monitoring\n"
    );

    const phases = parseRoadmap("/fake/project");
    expect(phases[0]).toEqual({
      number: "4",
      name: "Dashboard",
      description: "Web UI for monitoring",
      status: "done",
    });
  });

  it("handles decimal phase numbers", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      "- [ ] **Phase 2.1: Hotfix** - Emergency patch\n"
    );

    const phases = parseRoadmap("/fake/project");
    expect(phases[0]!.number).toBe("2.1");
  });

  it("returns empty array when directory has no roadmap", () => {
    mockExistsSync.mockReturnValue(false);

    const phases = parseRoadmap("/nonexistent/project");
    expect(phases).toEqual([]);
  });

  it("returns empty array for malformed content", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("This is not a roadmap.\nJust text.\n");

    const phases = parseRoadmap("/fake/project");
    expect(phases).toEqual([]);
  });
});
