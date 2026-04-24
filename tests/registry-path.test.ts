import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";

describe("registry path resolution (Fix 3.A)", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.MIRACLE_REGISTRY_PATH;
    delete process.env.MIRACLE_REGISTRY_PATH;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.MIRACLE_REGISTRY_PATH = originalEnv;
    } else {
      delete process.env.MIRACLE_REGISTRY_PATH;
    }
  });

  it("resolves to $HOME/miracle-workspace/registry.md by default", async () => {
    const mod = await import("../src/registry");
    const p = mod.resolveRegistryPath();
    expect(p).toBe(join(homedir(), "miracle-workspace", "registry.md"));
  });

  it("uses MIRACLE_REGISTRY_PATH env override when set", async () => {
    process.env.MIRACLE_REGISTRY_PATH = "/tmp/custom-registry.md";
    const mod = await import("../src/registry");
    const p = mod.resolveRegistryPath();
    expect(p).toBe("/tmp/custom-registry.md");
  });

  it("does not contain Windows-style D: prefix", async () => {
    const mod = await import("../src/registry");
    const p = mod.resolveRegistryPath();
    expect(p).not.toMatch(/^[A-Za-z]:/);
  });
});
