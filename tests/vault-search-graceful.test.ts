import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock fs so we can toggle DB existence
vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    existsSync: vi.fn(),
  };
});

import { existsSync } from "fs";
const mockExists = vi.mocked(existsSync);

describe("vault-search graceful fallback (Fix 3.B)", () => {
  beforeEach(() => {
    vi.resetModules();
    mockExists.mockReset();
  });

  it("getVaultStatus returns {available:false, reason:'disabled'} when DB absent", async () => {
    mockExists.mockReturnValue(false);
    const mod = await import("../src/vault-search");
    const status = mod.getVaultStatus();
    expect(status.available).toBe(false);
    expect(status.reason).toBe("disabled");
  });

  it("searchVault still returns empty array when DB absent (non-throwing)", async () => {
    mockExists.mockReturnValue(false);
    const mod = await import("../src/vault-search");
    const results = mod.searchVault("test query");
    expect(results).toEqual([]);
  });
});
