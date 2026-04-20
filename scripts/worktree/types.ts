export type WorktreePath = string & { readonly __worktreePath: unique symbol };

export interface CreateWorktreeOptions {
  jobId: string;
  branch: string;
}
