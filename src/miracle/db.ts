/**
 * Miracle slice SQLite singleton.
 *
 * Opens ~/.miracle/slice.db (or MIRACLE_SLICE_DB_PATH override) on first
 * call, runs migrations/0005_miracle_slice.sql idempotently, returns a
 * shared better-sqlite3 handle. Separate DB file from the Tier 3 queue
 * DB so the slice can be rolled back by deleting one file.
 */

import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

type SqliteDatabase = import("better-sqlite3").Database;

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3") as {
  new (filename?: string, options?: { readonly?: boolean }): SqliteDatabase;
};

const MIGRATION_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../migrations/0005_miracle_slice.sql",
);

let cachedDb: SqliteDatabase | null = null;
let cachedPath: string | null = null;

function resolveDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.MIRACLE_SLICE_DB_PATH;
  if (override && override.length > 0) {
    return override.startsWith("~/")
      ? resolve(homedir(), override.slice(2))
      : override;
  }
  return join(homedir(), ".miracle", "slice.db");
}

export function getSliceDb(
  env: NodeJS.ProcessEnv = process.env,
): SqliteDatabase {
  if (cachedDb) return cachedDb;

  const path = resolveDbPath(env);
  mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");

  const migration = readFileSync(MIGRATION_PATH, "utf8");
  db.exec(migration);

  cachedDb = db;
  cachedPath = path;
  return db;
}

// Test-only helpers. Not used in production code paths.
export function _resetSliceDbForTests(): void {
  if (cachedDb) {
    cachedDb.close();
  }
  cachedDb = null;
  cachedPath = null;
}

export function _getCachedSliceDbPath(): string | null {
  return cachedPath;
}
