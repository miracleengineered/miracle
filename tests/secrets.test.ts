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

function emptyEnv(): NodeJS.ProcessEnv {
  return {};
}

describe("loadSecretsFromKeychain", () => {
  beforeEach(() => {
    mockExec.mockReset();
  });

  it("returns the four required secrets when slice secrets are absent", () => {
    mockExec
      // Slice secrets read first — optional, empty means absent.
      .mockReturnValueOnce(Buffer.from("\n"))
      .mockReturnValueOnce(Buffer.from("\n"))
      // Then the four required secrets.
      .mockReturnValueOnce(Buffer.from("tg-bot-token\n"))
      .mockReturnValueOnce(Buffer.from("123,456\n"))
      .mockReturnValueOnce(Buffer.from("sk-ant-abc\n"))
      .mockReturnValueOnce(Buffer.from("sk-openai-xyz\n"));

    const secrets = loadSecretsFromKeychain(emptyEnv());

    expect(secrets.TELEGRAM_BOT_TOKEN).toBe("tg-bot-token");
    expect(secrets.TELEGRAM_ALLOWED_USERS).toBe("123,456");
    expect(secrets.ANTHROPIC_API_KEY).toBe("sk-ant-abc");
    expect(secrets.OPENAI_API_KEY).toBe("sk-openai-xyz");
    expect(secrets.ANTHROPIC_API_KEY_SLICE).toBeUndefined();
    expect(secrets.MIRACLE_SLICE_CHAT_ID).toBeUndefined();
  });

  it("calls `security find-generic-password` with -a miracle for every service (no genesisai, no hardcoded fallback)", () => {
    mockExec.mockReturnValue(Buffer.from("dummy\n"));

    loadSecretsFromKeychain(emptyEnv());

    expect(mockExec).toHaveBeenCalledTimes(6);
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

  it("throws with the service name when a required Keychain lookup fails", () => {
    mockExec
      .mockReturnValueOnce(Buffer.from("\n")) // slice key absent
      .mockReturnValueOnce(Buffer.from("\n")) // slice chat id absent
      .mockReturnValueOnce(Buffer.from("tg-bot-token\n"))
      .mockImplementationOnce(() => {
        throw new Error(
          "The specified item could not be found in the keychain.",
        );
      });

    expect(() => loadSecretsFromKeychain(emptyEnv())).toThrow(
      /miracle-TELEGRAM_ALLOWED_USERS/,
    );
  });

  it("throws when a required Keychain entry returns an empty value", () => {
    mockExec
      .mockReturnValueOnce(Buffer.from("\n")) // slice key absent (tolerated)
      .mockReturnValueOnce(Buffer.from("\n")) // slice chat id absent (tolerated)
      .mockReturnValueOnce(Buffer.from("\n")); // TELEGRAM_BOT_TOKEN empty → throws

    expect(() => loadSecretsFromKeychain(emptyEnv())).toThrow(/empty value/);
  });

  it("exports slice secrets into process.env when present", () => {
    mockExec
      .mockReturnValueOnce(Buffer.from("sk-ant-slice\n"))
      .mockReturnValueOnce(Buffer.from("-1001234567890\n"))
      .mockReturnValueOnce(Buffer.from("tg-bot-token\n"))
      .mockReturnValueOnce(Buffer.from("123\n"))
      .mockReturnValueOnce(Buffer.from("sk-ant-main\n"))
      .mockReturnValueOnce(Buffer.from("sk-openai\n"));

    const env: NodeJS.ProcessEnv = {};
    const secrets = loadSecretsFromKeychain(env);

    expect(secrets.ANTHROPIC_API_KEY_SLICE).toBe("sk-ant-slice");
    expect(secrets.MIRACLE_SLICE_CHAT_ID).toBe("-1001234567890");
    expect(env.ANTHROPIC_API_KEY_SLICE).toBe("sk-ant-slice");
    expect(env.MIRACLE_SLICE_CHAT_ID).toBe("-1001234567890");
  });

  it("does NOT mutate env when slice secrets are absent", () => {
    mockExec
      .mockReturnValueOnce(Buffer.from("\n"))
      .mockReturnValueOnce(Buffer.from("\n"))
      .mockReturnValueOnce(Buffer.from("tg-bot-token\n"))
      .mockReturnValueOnce(Buffer.from("123\n"))
      .mockReturnValueOnce(Buffer.from("sk-ant-main\n"))
      .mockReturnValueOnce(Buffer.from("sk-openai\n"));

    const env: NodeJS.ProcessEnv = {};
    loadSecretsFromKeychain(env);

    expect(env.ANTHROPIC_API_KEY_SLICE).toBeUndefined();
    expect(env.MIRACLE_SLICE_CHAT_ID).toBeUndefined();
  });

  it("fails loudly with service name when MIRACLE_SLICE_ENABLED=true and the slice key is missing", () => {
    mockExec.mockImplementationOnce(() => {
      throw new Error("The specified item could not be found in the keychain.");
    });

    expect(() =>
      loadSecretsFromKeychain({ MIRACLE_SLICE_ENABLED: "true" }),
    ).toThrow(/miracle-slice-ANTHROPIC_API_KEY/);
  });

  it("fails loudly with service name when MIRACLE_SLICE_ENABLED=true and the slice chat id is missing", () => {
    mockExec
      .mockReturnValueOnce(Buffer.from("sk-ant-slice\n"))
      .mockImplementationOnce(() => {
        throw new Error(
          "The specified item could not be found in the keychain.",
        );
      });

    expect(() =>
      loadSecretsFromKeychain({ MIRACLE_SLICE_ENABLED: "true" }),
    ).toThrow(/miracle-slice-TELEGRAM_SUPERGROUP_ID/);
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

  it("strips Keychain-sourced Telegram/OpenAI secret names and slice-scoped secrets", () => {
    const parentEnv = {
      PATH: "/usr/bin",
      TELEGRAM_BOT_TOKEN: "leak-1",
      TELEGRAM_ALLOWED_USERS: "1,2,3",
      OPENAI_API_KEY: "leak-2",
      ANTHROPIC_API_KEY: "leak-3",
      ANTHROPIC_API_KEY_SLICE: "leak-4",
      MIRACLE_SLICE_CHAT_ID: "-1001",
      UNRELATED: "keep-me",
    };
    const env = environmentForClaudeChild(parentEnv);

    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(env.TELEGRAM_ALLOWED_USERS).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY_SLICE).toBeUndefined();
    expect(env.MIRACLE_SLICE_CHAT_ID).toBeUndefined();
    expect(env.UNRELATED).toBe("keep-me");
    expect(env.PATH).toBe("/usr/bin");
  });
});
