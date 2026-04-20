import { access, lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorktree } from "./create.js";
import { cleanupFakeRepo, createFakeRepo, runCommand } from "./testUtils.js";

describe.sequential("createWorktree", () => {
  const originalCwd = process.cwd();
  const originalWorktreeRoot = process.env.MIRACLE_WORKTREE_ROOT;
  const tempDirs = new Set<string>();

  afterEach(async () => {
    process.chdir(originalCwd);

    if (originalWorktreeRoot === undefined) {
      delete process.env.MIRACLE_WORKTREE_ROOT;
    } else {
      process.env.MIRACLE_WORKTREE_ROOT = originalWorktreeRoot;
    }

    for (const tempDir of tempDirs) {
      await cleanupFakeRepo(tempDir);
      tempDirs.delete(tempDir);
    }
  });

  it("creates a git worktree and links supported .claude entries from the main repo", async () => {
    const repo = await createFakeRepo();
    tempDirs.add(repo.tempDir);
    process.chdir(repo.repoDir);
    process.env.MIRACLE_WORKTREE_ROOT = repo.worktreeRoot;

    const worktreePath = await createWorktree({ jobId: repo.jobId, branch: repo.branch });

    await access(worktreePath);
    const normalizedWorktreePath = await realpath(worktreePath);

    const listedWorktrees = await runCommand("git", ["worktree", "list", "--porcelain"], repo.repoDir);
    expect(listedWorktrees).toContain(`worktree ${normalizedWorktreePath}`);

    for (const entry of ["agents", "skills", "settings.json"] as const) {
      const targetPath = join(worktreePath, ".claude", entry);
      const stats = await lstat(targetPath);

      expect(stats.isSymbolicLink()).toBe(true);
      expect(await realpath(targetPath)).toBe(await realpath(join(repo.repoDir, ".claude", entry)));
    }

    await expect(access(join(worktreePath, ".claude", "settings.local.json"))).rejects.toThrow();
  });
});
