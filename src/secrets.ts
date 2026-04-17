/**
 * Secret loader — reads Miracle's four Keychain-backed secrets.
 *
 * Every lookup uses `security find-generic-password -s <service> -a miracle -w`.
 * No dotenv, no environment-variable reads, no hardcoded fallbacks. If any
 * lookup fails, this module throws; the bot refuses to start. Fail loudly.
 */

import { execFileSync } from "node:child_process";

const KEYCHAIN_ACCOUNT = "miracle";

const SERVICES = {
  TELEGRAM_BOT_TOKEN: "miracle-TELEGRAM_BOT_TOKEN",
  TELEGRAM_ALLOWED_USERS: "miracle-TELEGRAM_ALLOWED_USERS",
  ANTHROPIC_API_KEY: "miracle-ANTHROPIC_API_KEY",
  OPENAI_API_KEY: "miracle-OPENAI_API_KEY",
} as const;

export type MiracleSecrets = {
  readonly TELEGRAM_BOT_TOKEN: string;
  readonly TELEGRAM_ALLOWED_USERS: string;
  readonly ANTHROPIC_API_KEY: string;
  readonly OPENAI_API_KEY: string;
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

export function loadSecretsFromKeychain(): MiracleSecrets {
  return Object.freeze({
    TELEGRAM_BOT_TOKEN: readFromKeychain(SERVICES.TELEGRAM_BOT_TOKEN),
    TELEGRAM_ALLOWED_USERS: readFromKeychain(SERVICES.TELEGRAM_ALLOWED_USERS),
    ANTHROPIC_API_KEY: readFromKeychain(SERVICES.ANTHROPIC_API_KEY),
    OPENAI_API_KEY: readFromKeychain(SERVICES.OPENAI_API_KEY),
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
 * The three Keychain-sourced Telegram/OpenAI secrets are also stripped as
 * defense-in-depth — they should not be in process.env to begin with (we read
 * them via Keychain, not dotenv), but a misconfigured launchd plist or parent
 * shell could leak them.
 */
const STRIPPED_FROM_CHILD_ENV = [
  "ANTHROPIC_API_KEY",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_ALLOWED_USERS",
  "OPENAI_API_KEY",
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
