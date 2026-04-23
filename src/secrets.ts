/**
 * Secret loader — reads Miracle's Keychain-backed secrets.
 *
 * Every lookup uses `security find-generic-password -s <service> -a miracle -w`.
 * No dotenv, no environment-variable reads, no hardcoded fallbacks.
 *
 * The four MVP secrets are required — any missing one throws and the bot
 * refuses to start. The two slice secrets are optional by default and only
 * required when `MIRACLE_SLICE_ENABLED=true`. When present, they are also
 * exported into `process.env` so downstream code (e.g. Agent SDK clients
 * that read `ANTHROPIC_API_KEY_SLICE`) can pick them up without a direct
 * dependency on this module.
 */

import { execFileSync } from "node:child_process";

const KEYCHAIN_ACCOUNT = "miracle";

const SERVICES = {
  TELEGRAM_BOT_TOKEN: "miracle-TELEGRAM_BOT_TOKEN",
  TELEGRAM_ALLOWED_USERS: "miracle-TELEGRAM_ALLOWED_USERS",
  ANTHROPIC_API_KEY: "miracle-ANTHROPIC_API_KEY",
  OPENAI_API_KEY: "miracle-OPENAI_API_KEY",
  ANTHROPIC_API_KEY_SLICE: "miracle-slice-ANTHROPIC_API_KEY",
  MIRACLE_SLICE_CHAT_ID: "miracle-slice-TELEGRAM_SUPERGROUP_ID",
} as const;

export type MiracleSecrets = {
  readonly TELEGRAM_BOT_TOKEN: string;
  readonly TELEGRAM_ALLOWED_USERS: string;
  readonly ANTHROPIC_API_KEY: string;
  readonly OPENAI_API_KEY: string;
  readonly ANTHROPIC_API_KEY_SLICE?: string;
  readonly MIRACLE_SLICE_CHAT_ID?: string;
};

function readFromKeychain(service: string): string {
  let out: Buffer;
  try {
    out = execFileSync(
      "security",
      ["find-generic-password", "-s", service, "-a", KEYCHAIN_ACCOUNT, "-w"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to read Keychain entry ${service} (account ${KEYCHAIN_ACCOUNT}): ${reason}`,
    );
  }
  const value = out.toString("utf8").replace(/\r?\n$/, "");
  if (!value) {
    throw new Error(
      `Keychain entry ${service} (account ${KEYCHAIN_ACCOUNT}) returned an empty value`,
    );
  }
  return value;
}

function readFromKeychainOptional(service: string): string | undefined {
  try {
    const out = execFileSync(
      "security",
      ["find-generic-password", "-s", service, "-a", KEYCHAIN_ACCOUNT, "-w"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const value = out.toString("utf8").replace(/\r?\n$/, "");
    return value || undefined;
  } catch {
    return undefined;
  }
}

export function loadSecretsFromKeychain(
  env: NodeJS.ProcessEnv = process.env,
): MiracleSecrets {
  const sliceEnabled = env.MIRACLE_SLICE_ENABLED === "true";

  const sliceKey = sliceEnabled
    ? readFromKeychain(SERVICES.ANTHROPIC_API_KEY_SLICE)
    : readFromKeychainOptional(SERVICES.ANTHROPIC_API_KEY_SLICE);
  const sliceChatId = sliceEnabled
    ? readFromKeychain(SERVICES.MIRACLE_SLICE_CHAT_ID)
    : readFromKeychainOptional(SERVICES.MIRACLE_SLICE_CHAT_ID);

  if (sliceKey) env.ANTHROPIC_API_KEY_SLICE = sliceKey;
  if (sliceChatId) env.MIRACLE_SLICE_CHAT_ID = sliceChatId;

  return Object.freeze({
    TELEGRAM_BOT_TOKEN: readFromKeychain(SERVICES.TELEGRAM_BOT_TOKEN),
    TELEGRAM_ALLOWED_USERS: readFromKeychain(SERVICES.TELEGRAM_ALLOWED_USERS),
    ANTHROPIC_API_KEY: readFromKeychain(SERVICES.ANTHROPIC_API_KEY),
    OPENAI_API_KEY: readFromKeychain(SERVICES.OPENAI_API_KEY),
    ANTHROPIC_API_KEY_SLICE: sliceKey,
    MIRACLE_SLICE_CHAT_ID: sliceChatId,
  });
}

/**
 * Names stripped from any environment passed to the `claude` CLI subprocess.
 *
 * ANTHROPIC_API_KEY is intentionally in this list: Miracle uses Claude Max/Pro
 * subscription auth, not API-key billing. If the key were present in the child's
 * environment, the CLI would switch to API-key mode silently, costing per-token
 * and defeating the whole point of spawning the CLI as a subprocess.
 *
 * ANTHROPIC_API_KEY_SLICE is stripped for the same reason — it's a separate
 * workspace-scoped key, but leaking it into the CLI child would still flip the
 * CLI to API-key auth mode. The slice executor calls Anthropic via the Agent
 * SDK in-process, not via this CLI subprocess, so the child never needs it.
 *
 * The Keychain-sourced Telegram/OpenAI secrets and MIRACLE_SLICE_CHAT_ID are
 * also stripped as defense-in-depth — they shouldn't be in process.env (we
 * read them via Keychain, not dotenv), but a misconfigured launchd plist or
 * parent shell could leak them.
 */
const STRIPPED_FROM_CHILD_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_API_KEY_SLICE",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_ALLOWED_USERS",
  "OPENAI_API_KEY",
  "MIRACLE_SLICE_CHAT_ID",
] as const;

export function environmentForClaudeChild(
  parentEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...parentEnv };
  for (const name of STRIPPED_FROM_CHILD_ENV) {
    delete out[name];
  }
  return out;
}
