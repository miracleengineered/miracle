import { homedir } from "node:os";
import { resolve } from "node:path";

export interface Tier3Env {
  tier3Enabled: boolean;
  miracleDbPath: string;
  miracleWorktreeRoot: string;
}

function expandHome(p: string): string {
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  if (p === "~") return homedir();
  return p;
}

export function loadEnv(env: NodeJS.ProcessEnv = process.env): Tier3Env {
  const flag = (env.TIER_3_ENABLED ?? "false").trim().toLowerCase();
  if (flag !== "true" && flag !== "false") {
    throw new Error(`TIER_3_ENABLED must be "true" or "false"; got "${env.TIER_3_ENABLED}"`);
  }
  return {
    tier3Enabled: flag === "true",
    miracleDbPath: expandHome(env.MIRACLE_DB_PATH ?? "~/.miracle/queue.db"),
    miracleWorktreeRoot: expandHome(
      env.MIRACLE_WORKTREE_ROOT ?? "~/Projects/miracle/tier-3-build/worktrees",
    ),
  };
}
