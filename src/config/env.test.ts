import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadEnv } from "./env.js";

describe("loadEnv — TIER_3_ENABLED", () => {
  let originalFlag: string | undefined;

  beforeEach(() => {
    originalFlag = process.env.TIER_3_ENABLED;
  });

  afterEach(() => {
    if (originalFlag === undefined) {
      delete process.env.TIER_3_ENABLED;
    } else {
      process.env.TIER_3_ENABLED = originalFlag;
    }
  });

  it("defaults to false when TIER_3_ENABLED is unset (process.env path)", () => {
    delete process.env.TIER_3_ENABLED;
    expect(loadEnv().tier3Enabled).toBe(false);
  });

  it("defaults to false when TIER_3_ENABLED is unset (explicit env arg)", () => {
    expect(loadEnv({}).tier3Enabled).toBe(false);
  });

  it('treats exact "true" as true', () => {
    expect(loadEnv({ TIER_3_ENABLED: "true" }).tier3Enabled).toBe(true);
  });

  it('treats "false" as false', () => {
    expect(loadEnv({ TIER_3_ENABLED: "false" }).tier3Enabled).toBe(false);
  });

  it('treats "True" (any other value) as false', () => {
    expect(loadEnv({ TIER_3_ENABLED: "True" }).tier3Enabled).toBe(false);
    expect(loadEnv({ TIER_3_ENABLED: "TRUE" }).tier3Enabled).toBe(false);
    expect(loadEnv({ TIER_3_ENABLED: "1" }).tier3Enabled).toBe(false);
    expect(loadEnv({ TIER_3_ENABLED: "yes" }).tier3Enabled).toBe(false);
    expect(loadEnv({ TIER_3_ENABLED: "" }).tier3Enabled).toBe(false);
  });
});
