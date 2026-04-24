import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import { loadSecretsFromKeychain } from "../src/secrets";

const mockExec = vi.mocked(execFileSync);

describe("loadSecretsFromKeychain — HMAC_SECRET (Fix 3.J)", () => {
  beforeEach(() => {
    mockExec.mockReset();
  });

  it("requires miracle-HMAC_SECRET when MIRACLE_SLICE_ENABLED=true", () => {
    // Order: slice key, slice chat id, 4 required, HMAC
    mockExec
      .mockReturnValueOnce(Buffer.from("sk-ant-slice\n"))
      .mockReturnValueOnce(Buffer.from("-1001234\n"))
      .mockReturnValueOnce(Buffer.from("tg-bot\n"))
      .mockReturnValueOnce(Buffer.from("123\n"))
      .mockReturnValueOnce(Buffer.from("sk-ant-main\n"))
      .mockReturnValueOnce(Buffer.from("sk-openai\n"))
      .mockImplementationOnce(() => {
        throw new Error("The specified item could not be found in the keychain.");
      });

    expect(() =>
      loadSecretsFromKeychain({ MIRACLE_SLICE_ENABLED: "true" }),
    ).toThrow(/miracle-HMAC_SECRET/);
  });

  it("exports HMAC_SECRET into process.env when slice enabled", () => {
    mockExec
      .mockReturnValueOnce(Buffer.from("sk-ant-slice\n"))
      .mockReturnValueOnce(Buffer.from("-1001234\n"))
      .mockReturnValueOnce(Buffer.from("tg-bot\n"))
      .mockReturnValueOnce(Buffer.from("123\n"))
      .mockReturnValueOnce(Buffer.from("sk-ant-main\n"))
      .mockReturnValueOnce(Buffer.from("sk-openai\n"))
      .mockReturnValueOnce(Buffer.from("abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789\n"));

    const env: NodeJS.ProcessEnv = { MIRACLE_SLICE_ENABLED: "true" };
    const secrets = loadSecretsFromKeychain(env);
    expect(secrets.HMAC_SECRET).toBe(
      "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    );
    expect(env.MIRACLE_HMAC_SECRET).toBe(
      "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    );
  });

  it("does not read HMAC when slice disabled (6 calls total)", () => {
    mockExec.mockReturnValue(Buffer.from("dummy\n"));
    loadSecretsFromKeychain({});
    expect(mockExec).toHaveBeenCalledTimes(6);
  });
});
