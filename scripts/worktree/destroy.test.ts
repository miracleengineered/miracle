import { access, realpath } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createWorktree } from "./create.js";
import { destroyWorktree } from "./destroy.js";
import { cleanupFakeRepo, createFakeRepo, runCommand } from "./testUtils.js";

describe.sequential("destroyWorktree", () => {
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

  it("removes an existing worktree without deleting its branch", async () => {
    const repo = await createFakeRepo();
    tempDirs.add(repo.tempDir);
    process.chdir(repo.repoDir);
    process.env.MIRACLE_WORKTREE_ROOT = repo.worktreeRoot;

    const worktreePath = await createWorktree({ jobId: repo.jobId, branch: repo.branch });

    await destroyWorktree(worktreePath);

    await expect(access(worktreePath)).rejects.toThrow();
    await runCommand("git", ["rev-parse", "--verify", `refs/heads/${repo.branch}`], repo.repoDir);
  });

  it("rejects paths that are not registered git worktrees", async () => {
    const repo = await createFakeRepo();
    tempDirs.add(repo.tempDir);
    process.chdir(repo.repoDir);
    process.env.MIRACLE_WORKTREE_ROOT = repo.worktreeRoot;

    const normalizedPath = await realpath(repo.tempDir).then((tempDir) => `${tempDir}/worktrees`);
    await expect(destroyWorktree(repo.worktreeRoot)).rejects.toThrow(
      `Refusing to remove non-worktree path "${normalizedPath}"`,
    );
  });
});
