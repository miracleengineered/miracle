import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import {
  loadSecretsFromKeychain,
  environmentForClaudeChild,
} from "../src/secrets";

const mockExec = vi.mocked(execFileSync);

describe("loadSecretsFromKeychain", () => {
  beforeEach(() => {
    mockExec.mockReset();
  });

  it("returns all four secrets on success", () => {
    mockExec
      .mockReturnValueOnce(Buffer.from("tg-bot-token\n"))
      .mockReturnValueOnce(Buffer.from("123,456\n"))
      .mockReturnValueOnce(Buffer.from("sk-ant-abc\n"))
      .mockReturnValueOnce(Buffer.from("sk-openai-xyz\n"));

    const secrets = loadSecretsFromKeychain();

    expect(secrets.TELEGRAM_BOT_TOKEN).toBe("tg-bot-token");
    expect(secrets.TELEGRAM_ALLOWED_USERS).toBe("123,456");
    expect(secrets.ANTHROPIC_API_KEY).toBe("sk-ant-abc");
    expect(secrets.OPENAI_API_KEY).toBe("sk-openai-xyz");
  });

  it("calls `security find-generic-password` with -a miracle for every service (no genesisai, no hardcoded fallback)", () => {
    mockExec.mockReturnValue(Buffer.from("dummy\n"));

    loadSecretsFromKeychain();

    expect(mockExec).toHaveBeenCalledTimes(4);
    for (const call of mockExec.mock.calls) {
      const [bin, argv] = call as [string, string[]];
      expect(bin).toBe("security");
      expect(argv[0]).toBe("find-generic-password");
      const aIdx = argv.indexOf("-a");
      expect(aIdx).toBeGreaterThanOrEqual(0);
      expect(argv[aIdx + 1]).toBe("miracle");
      expect(argv).not.toContain("genesisai");
    }
  });

  it("throws with the service name when a Keychain lookup fails", () => {
    mockExec
      .mockReturnValueOnce(Buffer.from("tg-bot-token\n"))
      .mockImplementationOnce(() => {
        throw new Error(
          "The specified item could not be found in the keychain.",
        );
      });

    expect(() => loadSecretsFromKeychain()).toThrow(
      /miracle-TELEGRAM_ALLOWED_USERS/,
    );
  });

  it("throws when a Keychain entry returns an empty value", () => {
    mockExec.mockReturnValueOnce(Buffer.from("\n"));

    expect(() => loadSecretsFromKeychain()).toThrow(/empty value/);
  });
});

describe("environmentForClaudeChild", () => {
  it("excludes ANTHROPIC_API_KEY from the returned env (subscription-auth guarantee)", () => {
    const parentEnv = {
      PATH: "/usr/bin",
      HOME: "/Users/x",
      ANTHROPIC_API_KEY: "sk-ant-would-leak",
    };
    const env = environmentForClaudeChild(parentEnv);

    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/Users/x");
  });

  it("also strips the three Keychain-sourced Telegram/OpenAI secret names", () => {
    const parentEnv = {
      PATH: "/usr/bin",
      TELEGRAM_BOT_TOKEN: "leak-1",
      TELEGRAM_ALLOWED_USERS: "1,2,3",
      OPENAI_API_KEY: "leak-2",
      ANTHROPIC_API_KEY: "leak-3",
      UNRELATED: "keep-me",
    };
    const env = environmentForClaudeChild(parentEnv);

    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(env.TELEGRAM_ALLOWED_USERS).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.UNRELATED).toBe("keep-me");
    expect(env.PATH).toBe("/usr/bin");
  });
});
