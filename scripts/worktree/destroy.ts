import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface WorktreeRecord {
  path: string;
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function runGit(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd });
    return stdout;
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

function parseWorktreeList(output: string): WorktreeRecord[] {
  const records: WorktreeRecord[] = [];
  let currentPath: string | null = null;

  for (const line of output.split("\n")) {
    if (line.length === 0) {
      if (currentPath !== null) {
        records.push({ path: currentPath });
        currentPath = null;
      }
      continue;
    }

    if (line.startsWith("worktree ")) {
      currentPath = resolve(line.slice("worktree ".length));
    }
  }

  if (currentPath !== null) {
    records.push({ path: currentPath });
  }

  return records;
}

async function normalizeExistingPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    const absolutePath = resolve(path);

    try {
      return join(await realpath(dirname(absolutePath)), basename(absolutePath));
    } catch {
      return absolutePath;
    }
  }
}

export async function destroyWorktree(path: string): Promise<void> {
  const cwd = process.cwd();
  const mainRepoRoot = await resolveMainRepoRoot(cwd);
  const resolvedPath = await normalizeExistingPath(path);
  const worktrees = parseWorktreeList(await runGit(["worktree", "list", "--porcelain"], mainRepoRoot));

  const normalizedWorktreePaths = await Promise.all(
    worktrees.map(async (worktree) => normalizeExistingPath(worktree.path)),
  );

  if (!normalizedWorktreePaths.includes(resolvedPath)) {
    throw new Error(`Refusing to remove non-worktree path "${resolvedPath}"`);
  }

  try {
    await runGit(["worktree", "remove", "--force", resolvedPath], mainRepoRoot);
  } catch (error) {
    throw new Error(`Failed to destroy worktree "${resolvedPath}": ${formatErrorMessage(error)}`);
  }
}
