import { describe, it, expect, beforeEach } from "vitest";
import { withSliceApiKey } from "../src/miracle/auth";

describe("withSliceApiKey", () => {
  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY_SLICE;
  });

  it("throws loudly if ANTHROPIC_API_KEY_SLICE is not set", async () => {
    await expect(withSliceApiKey(async () => "ok")).rejects.toThrow(/ANTHROPIC_API_KEY_SLICE/);
  });

  it("swaps ANTHROPIC_API_KEY to the slice key for the callback duration", async () => {
    process.env.ANTHROPIC_API_KEY_SLICE = "sk-ant-slice";
    let observed: string | undefined;
    const result = await withSliceApiKey(async () => {
      observed = process.env.ANTHROPIC_API_KEY;
      return "return-value";
    });
    expect(result).toBe("return-value");
    expect(observed).toBe("sk-ant-slice");
  });

  it("restores the prior ANTHROPIC_API_KEY value after the callback", async () => {
    process.env.ANTHROPIC_API_KEY_SLICE = "sk-ant-slice";
    process.env.ANTHROPIC_API_KEY = "sk-ant-original";
    await withSliceApiKey(async () => {
      expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-slice");
    });
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-original");
  });

  it("leaves ANTHROPIC_API_KEY undefined after the callback when it was undefined before", async () => {
    process.env.ANTHROPIC_API_KEY_SLICE = "sk-ant-slice";
    await withSliceApiKey(async () => {
      expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-slice");
    });
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("restores env even if the callback throws", async () => {
    process.env.ANTHROPIC_API_KEY_SLICE = "sk-ant-slice";
    process.env.ANTHROPIC_API_KEY = "sk-ant-original";
    await expect(
      withSliceApiKey(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow(/boom/);
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-original");
  });
});
