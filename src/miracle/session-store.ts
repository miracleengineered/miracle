/**
 * SQLite-backed SessionStore adapter for @anthropic-ai/claude-agent-sdk.
 *
 * Implements the alpha SessionStore interface so the Executor can resume
 * after bot restart (Gate 2 smoke #10). Entries are opaque JSONL rows from
 * the CLI's transcript format — we pass them through, serialize them as a
 * single JSON array in miracle_sessions.entries_json, and re-hydrate on load.
 *
 * Key encoding: SessionKey (projectKey, sessionId, optional subpath) is
 * serialized as JSON.stringify([projectKey, sessionId, subpath ?? null]) to
 * avoid delimiter-in-value collisions.
 *
 * Concurrency: append() reads the current entries, concatenates, and writes
 * back inside a single SQLite transaction. better-sqlite3 is synchronous +
 * serializes at the connection layer, so the read-modify-write sequence is
 * safe within a process. The bot is single-process, so cross-process races
 * aren't a concern in the slice scope.
 */

import type { SessionKey, SessionStore, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import { getSliceDb } from "./db";

type SqliteDatabase = import("better-sqlite3").Database;

function keyToString(key: SessionKey): string {
  return JSON.stringify([key.projectKey, key.sessionId, key.subpath ?? null]);
}

export class SqliteSessionStore implements SessionStore {
  private readonly db: SqliteDatabase;

  constructor(db: SqliteDatabase = getSliceDb()) {
    this.db = db;
  }

  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    if (entries.length === 0) return;

    const encoded = keyToString(key);
    const now = Date.now();

    const tx = this.db.transaction(() => {
      const row = this.db
        .prepare<[string], { entries_json: string }>(
          "SELECT entries_json FROM miracle_sessions WHERE session_key = ?",
        )
        .get(encoded);

      const existing: SessionStoreEntry[] = row
        ? (JSON.parse(row.entries_json) as SessionStoreEntry[])
        : [];
      const merged = existing.concat(entries);

      this.db
        .prepare(
          `INSERT INTO miracle_sessions (session_key, entries_json, mtime)
           VALUES (?, ?, ?)
           ON CONFLICT(session_key) DO UPDATE SET
             entries_json = excluded.entries_json,
             mtime = excluded.mtime`,
        )
        .run(encoded, JSON.stringify(merged), now);
    });

    tx();
  }

  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    const row = this.db
      .prepare<[string], { entries_json: string }>(
        "SELECT entries_json FROM miracle_sessions WHERE session_key = ?",
      )
      .get(keyToString(key));

    if (!row) return null;
    return JSON.parse(row.entries_json) as SessionStoreEntry[];
  }

  async delete(key: SessionKey): Promise<void> {
    this.db.prepare("DELETE FROM miracle_sessions WHERE session_key = ?").run(keyToString(key));
  }

  async listSessions(projectKey: string): Promise<Array<{ sessionId: string; mtime: number }>> {
    // Encode as the prefix of the JSON array form so we match
    // keys that share projectKey regardless of sessionId/subpath.
    const prefix = JSON.stringify([projectKey]).slice(0, -1); // e.g. '["miracle-slice"' (trailing ] stripped)
    const rows = this.db
      .prepare<[string], { session_key: string; mtime: number }>(
        "SELECT session_key, mtime FROM miracle_sessions WHERE session_key LIKE ? ORDER BY mtime DESC",
      )
      .all(prefix + "%");

    const sessions = new Map<string, number>();
    for (const row of rows) {
      try {
        const [pk, sessionId] = JSON.parse(row.session_key) as [string, string, string | null];
        if (pk !== projectKey) continue;
        const prior = sessions.get(sessionId);
        if (prior === undefined || row.mtime > prior) {
          sessions.set(sessionId, row.mtime);
        }
      } catch {
        // Skip malformed rows.
      }
    }

    return [...sessions.entries()]
      .map(([sessionId, mtime]) => ({ sessionId, mtime }))
      .sort((a, b) => b.mtime - a.mtime);
  }

  async listSubkeys(key: { projectKey: string; sessionId: string }): Promise<string[]> {
    const rows = this.db
      .prepare<[], { session_key: string }>("SELECT session_key FROM miracle_sessions")
      .all();

    const subkeys: string[] = [];
    for (const row of rows) {
      try {
        const [pk, sid, subpath] = JSON.parse(row.session_key) as [string, string, string | null];
        if (pk === key.projectKey && sid === key.sessionId && subpath) {
          subkeys.push(subpath);
        }
      } catch {
        // Skip malformed rows.
      }
    }
    return subkeys;
  }
}
