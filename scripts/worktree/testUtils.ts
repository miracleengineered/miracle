import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface FakeRepoContext {
  branch: string;
  jobId: string;
  repoDir: string;
  tempDir: string;
  worktreeRoot: string;
}

export async function runCommand(command: string, args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync(command, args, { cwd });
  return stdout.trim();
}

export async function createFakeRepo(): Promise<FakeRepoContext> {
  const tempDir = await mkdtemp(join(tmpdir(), "miracle-worktree-"));
  const repoDir = join(tempDir, "repo");
  const worktreeRoot = join(tempDir, "worktrees");
  const branch = "worker-branch";
  const jobId = "job-123";

  await mkdir(repoDir, { recursive: true });
  await runCommand("git", ["init", "--initial-branch=main"], repoDir);
  await runCommand("git", ["config", "user.name", "Miracle Test"], repoDir);
  await runCommand("git", ["config", "user.email", "tests@miracle.invalid"], repoDir);

  await mkdir(join(repoDir, ".claude", "agents"), { recursive: true });
  await mkdir(join(repoDir, ".claude", "skills"), { recursive: true });
  await writeFile(join(repoDir, ".claude", "agents", "README.md"), "agent docs\n");
  await writeFile(join(repoDir, ".claude", "skills", "README.md"), "skill docs\n");
  await writeFile(join(repoDir, ".claude", "settings.json"), '{"theme":"light"}\n');
  await writeFile(join(repoDir, "tracked.txt"), "tracked\n");

  await runCommand("git", ["add", "tracked.txt"], repoDir);
  await runCommand("git", ["commit", "-m", "Initial commit"], repoDir);
  await runCommand("git", ["branch", branch], repoDir);

  return { branch, jobId, repoDir, tempDir, worktreeRoot };
}

export async function cleanupFakeRepo(tempDir: string): Promise<void> {
  await rm(tempDir, { force: true, recursive: true });
}
