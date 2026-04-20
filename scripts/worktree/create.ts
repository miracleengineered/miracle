import { execFile } from "node:child_process";
import { lstat, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { loadEnv } from "../../src/config/env.js";
import type { CreateWorktreeOptions, WorktreePath } from "./types.js";

const execFileAsync = promisify(execFile);

const CLAUDE_ENTRIES = [
  { name: "agents", type: "dir" as const },
  { name: "skills", type: "dir" as const },
  { name: "settings.json", type: "file" as const },
];

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function runGit(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd });
    return stdout.trim();
  } catch (error) {
    const details =
      typeof error === "object" && error !== null && "stderr" in error
        ? String(error.stderr).trim()
        : "";
    const suffix = details ? `: ${details}` : "";
    throw new Error(`git ${args.join(" ")} failed${suffix}`);
  }
}

async function resolveMainRepoRoot(cwd: string): Promise<string> {
  const commonDir = await runGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
  return dirname(commonDir);
}

async function linkClaudeEntries(worktreePath: string, mainRepoRoot: string): Promise<void> {
  const sourceClaudeDir = join(mainRepoRoot, ".claude");
  const targetClaudeDir = join(worktreePath, ".claude");

  for (const entry of CLAUDE_ENTRIES) {
    const sourcePath = join(sourceClaudeDir, entry.name);
    if (!(await pathExists(sourcePath))) {
      continue;
    }

    await mkdir(targetClaudeDir, { recursive: true });
    const targetPath = join(targetClaudeDir, entry.name);

    if (await pathExists(targetPath)) {
      const stats = await lstat(targetPath);
      if (stats.isSymbolicLink()) {
        if ((await realpath(targetPath)) === (await realpath(sourcePath))) {
          continue;
        }

        throw new Error(`existing symlink at ${targetPath} points somewhere unexpected`);
      }

      throw new Error(`refusing to overwrite existing ${targetPath}`);
    }

    await symlink(sourcePath, targetPath, entry.type);
  }
}

async function cleanupFailedCreate(repoRoot: string, worktreePath: string): Promise<void> {
  try {
    await runGit(["worktree", "remove", "--force", worktreePath], repoRoot);
  } catch {
    // Best-effort cleanup. The directory removal below handles partially-created paths.
  }

  await rm(worktreePath, { force: true, recursive: true });
}

export async function createWorktree(opts: CreateWorktreeOptions): Promise<WorktreePath> {
  const { miracleWorktreeRoot } = loadEnv();
  const cwd = process.cwd();
  const mainRepoRoot = await resolveMainRepoRoot(cwd);
  const worktreePath = resolve(miracleWorktreeRoot, opts.jobId);
  const worktreePathExisted = await pathExists(worktreePath);

  if (worktreePathExisted) {
    throw new Error(`Worktree path already exists: "${worktreePath}"`);
  }

  try {
    await mkdir(dirname(worktreePath), { recursive: true });
    await runGit(["worktree", "add", worktreePath, opts.branch], mainRepoRoot);
    await linkClaudeEntries(worktreePath, mainRepoRoot);
    return worktreePath as WorktreePath;
  } catch (error) {
    let cleanupNote = "";

    try {
      if (!worktreePathExisted) {
        await cleanupFailedCreate(mainRepoRoot, worktreePath);
      }
    } catch (cleanupError) {
      cleanupNote = ` Cleanup also failed: ${formatErrorMessage(cleanupError)}`;
    }

    throw new Error(
      `Failed to create worktree for job "${opts.jobId}" on branch "${opts.branch}" at "${worktreePath}": ${formatErrorMessage(error)}.${cleanupNote}`.trim(),
    );
  }
}
