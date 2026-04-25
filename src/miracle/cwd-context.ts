/**
 * Gather lightweight context about a working directory so the planner
 * isn't blind to what's already there.
 *
 * Three pieces, each independently capped:
 *   - Top-level file listing (~30 entries, dirs marked with /)
 *   - Project intro (first ~500 chars of CLAUDE.md / AGENTS.md / README.md)
 *   - Recent git history (`git log --oneline -5`)
 *
 * All three are best-effort. Any failure returns empty string for that piece;
 * the planner just gets less context that turn, not a crash.
 */

import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const MAX_LISTING_ENTRIES = 30;
const INTRO_FILES = ["CLAUDE.md", "AGENTS.md", "README.md", "README"];

export interface CwdContext {
  cwdListing?: string;
  projectIntro?: string;
  recentChanges?: string;
}

function gatherListing(cwd: string): string {
  try {
    const entries = readdirSync(cwd).sort();
    const tagged: string[] = [];
    for (const name of entries.slice(0, MAX_LISTING_ENTRIES)) {
      try {
        const st = statSync(join(cwd, name));
        tagged.push(st.isDirectory() ? `${name}/` : name);
      } catch {
        tagged.push(name);
      }
    }
    if (entries.length > MAX_LISTING_ENTRIES) {
      tagged.push(`... (${entries.length - MAX_LISTING_ENTRIES} more)`);
    }
    return tagged.join("\n");
  } catch {
    return "";
  }
}

function gatherIntro(cwd: string): string {
  for (const name of INTRO_FILES) {
    const path = join(cwd, name);
    if (existsSync(path)) {
      try {
        return readFileSync(path, "utf8").slice(0, 500);
      } catch {
        // try next
      }
    }
  }
  return "";
}

function gatherRecentChanges(cwd: string): string {
  try {
    const res = spawnSync("git", ["-C", cwd, "log", "--oneline", "-5"], {
      encoding: "utf8",
      timeout: 1500,
    });
    if (res.status !== 0) return "";
    return res.stdout.trim();
  } catch {
    return "";
  }
}

export function gatherCwdContext(cwd: string): CwdContext {
  if (!cwd || !existsSync(cwd)) return {};
  return {
    cwdListing: gatherListing(cwd),
    projectIntro: gatherIntro(cwd),
    recentChanges: gatherRecentChanges(cwd),
  };
}
