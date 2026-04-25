/**
 * Digest drill-down pre-processor.
 *
 * Detects three patterns in operator replies and prepends grounded context
 * from digest snapshots OR spawns subject-search.ts when needed:
 *
 *   - Section drill-down: "more on 3" / "expand 3" / "tell me about 3" / "3"
 *     → reads ~/Library/Caches/com.miracle.digest/last-morning.json
 *       (falls back to last-yesterday.json), injects matching section's content
 *
 *   - Module-name drill-down: "tell me about the news" / "more on weather" etc.
 *     → same snapshot lookup, keyed by module name instead of number
 *
 *   - Subject lookup: "where did we leave off on Hub-365"
 *     → shells out to digest/subject-search.ts, injects returned summary
 *
 * Non-mutating: modifies a local copy only, never touches the caller's `message`
 * variable (preserves session.lastMessage retry semantics + conversationTitle).
 *
 * All failure paths return "" → bot falls through to normal Claude handling.
 *
 * Fixture injection: tests set DIGEST_CONTEXT_CACHE_DIR to override the cache
 * path; falls back to ~/Library/Caches/com.miracle.digest in production.
 */

import { readFileSync, existsSync } from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const execFileAsync = promisify(execFile);

const DEFAULT_CACHE_DIR = `${process.env.HOME}/Library/Caches/com.miracle.digest`;

function cacheDir(): string {
  return process.env.DIGEST_CONTEXT_CACHE_DIR || DEFAULT_CACHE_DIR;
}

// Resolve paths relative to this module so the bot works from any clone.
// __filename = /<repo-root>/bot/src/handlers/digest-context.ts
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BOT_ROOT = resolve(__dirname, "..", ".."); // <repo>/bot
const REPO_ROOT = resolve(BOT_ROOT, ".."); // <repo>
const SUBJECT_SEARCH_SCRIPT = resolve(REPO_ROOT, "digest", "subject-search.ts");
const TSX_BIN = resolve(BOT_ROOT, "node_modules", ".bin", "tsx");
const SUBJECT_SEARCH_TIMEOUT_MS = 32_000; // slightly over the script's internal 30s

type SnapshotSection = {
  n: number;
  module: string;
  content: string;
};

type Snapshot = {
  job: string;
  fired_at: string;
  date_local: string;
  sections: SnapshotSection[];
};

export function readSnapshot(filename: string): Snapshot | null {
  const path = `${cacheDir()}/${filename}`;
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Snapshot;
  } catch {
    return null;
  }
}

/**
 * Build a context prefix string to prepend to the operator's message before
 * sending to Claude. Returns "" if no drill-down pattern matched or if lookup
 * failed — caller should pass the raw message through unchanged in that case.
 */
export async function buildDigestContextPrefix(message: string): Promise<string> {
  const trimmed = message.trim();

  // Section drill-down: optional verb + digit
  const mSection = trimmed.match(/^(?:more on |expand |tell me (?:more )?about )?(\d+)\s*\??$/i);

  // Module-name drill-down
  const mModule = trimmed.match(
    /^(?:more on |tell me (?:more )?about (?:the )?)(weather|news|tip|today|focus|yesterday)\b/i,
  );

  // Subject lookup
  const mSubject = trimmed.match(
    /^where (?:did|have) we (?:left? off|leave off|stop) on (.+?)\??$/i,
  );

  if (mSection || mModule) {
    const morning = readSnapshot("last-morning.json");
    const yesterday = readSnapshot("last-yesterday.json");

    let section: SnapshotSection | undefined;
    let sourceSnapshot: Snapshot | null = null;

    if (mSection) {
      const n = parseInt(mSection[1]!, 10);
      const fromMorning = morning?.sections?.find((s) => s.n === n);
      if (fromMorning) {
        section = fromMorning;
        sourceSnapshot = morning;
      } else {
        const fromYesterday = yesterday?.sections?.find((s) => s.n === n);
        if (fromYesterday) {
          section = fromYesterday;
          sourceSnapshot = yesterday;
        }
      }
    } else if (mModule) {
      const raw = mModule[1]!.toLowerCase();
      const alias = raw === "focus" ? "today" : raw;
      const fromMorning = morning?.sections?.find((s) => s.module === alias);
      if (fromMorning) {
        section = fromMorning;
        sourceSnapshot = morning;
      } else {
        const fromYesterday = yesterday?.sections?.find((s) => s.module === alias);
        if (fromYesterday) {
          section = fromYesterday;
          sourceSnapshot = yesterday;
        }
      }
    }

    if (section && sourceSnapshot) {
      return `[Drill-down — section ${section.n} (${section.module}) from ${sourceSnapshot.job} at ${sourceSnapshot.fired_at}]\n${section.content}\n\n`;
    }
  }

  if (mSubject) {
    const subject = mSubject[1]!.trim();
    if (subject.length > 0 && subject.length < 200) {
      try {
        const { stdout } = await execFileAsync(TSX_BIN, [SUBJECT_SEARCH_SCRIPT, subject], {
          timeout: SUBJECT_SEARCH_TIMEOUT_MS,
          maxBuffer: 2 * 1024 * 1024,
        });
        const summary = stdout.toString().trim();
        if (summary) {
          return `[Subject context: ${subject}]\n${summary}\n\n`;
        }
      } catch {
        // timeout or failure — skip injection, let Claude answer normally
      }
    }
  }

  return "";
}
