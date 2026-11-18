export type ManagedWorktreeChange = {
  path: string;
  before?: string;
  after?: string;
  afterMode?: string;
};

export type ManagedWorktreeRelease =
  | { status: 'removed'; branch: string; head?: string; branchDeleted: boolean; unlinked: string[]; note?: string }
  | { status: 'kept'; reason: string; branch?: string; head?: string; detached?: boolean };

export type ManagedWorktreeDelivery = {
  status: 'applying' | 'applied' | 'unchanged' | 'conflict' | 'blocked' | 'recovery-required';
  at: string;
  changedPaths: string[];
  reason?: string;
  childTree?: string;
  parentBeforeTree?: string;
  parentAfterTree?: string;
  changes?: ManagedWorktreeChange[];
};

/** Host-owned binding. A continuation retains the same id and physical checkout. */
export type ManagedWorktree = {
  version: 1;
  /** Missing on older records means snapshot delivery into the direct parent. */
  mode?: 'snapshot' | 'branch';
  id: string;
  projectId: string;
  ownerWorkflowId: string;
  parentWorkflowId: string;
  directory: string;
  sourceDirectory: string;
  repositoryCommonDirectory: string;
  branch: string;
  sourceHead?: string;
  baseCommit?: string;
  baseTree?: string;
  /** Host-verified Git administration paths; only independent branch tasks may write these. */
  gitDirectory?: string;
  gitWritePaths?: string[];
  /** Git's symlink checkout behavior, retained for this branch rather than requiring OS privileges. */
  symlinkMode?: 'native' | 'git-placeholder';
  /** Repository-relative dependency links, persisted before creation for safe recovery and cleanup. */
  linkedDependencyPaths?: string[];
  /** An interrupted dependency layout must be inspected before this checkout can run. */
  dependencyPreparationPath?: string;
  state: 'preparing' | 'ready' | 'failed' | 'recovery-required';
  createdAt: string;
  updatedAt: string;
  error?: string;
  delivery?: ManagedWorktreeDelivery;
  lastApplied?: ManagedWorktreeDelivery;
};

export type PrepareManagedWorktree = {
  id: string;
  projectId: string;
  ownerWorkflowId: string;
  parentWorkflowId: string;
  /** The direct parent's execution root, including when that parent is itself isolated. */
  sourceDirectory: string;
  /** Branch mode starts at a committed revision and never applies files into the parent. */
  mode?: 'snapshot' | 'branch';
  /** A full, existing commit object ID. Omitted means the source HEAD observed at preparation. */
  baseCommit?: string;
  /** An unused branch name. Omitted means codex/managed-<id>. */
  branch?: string;
};

export type ManagedBranchCommit = {
  status: 'committed' | 'unchanged';
  commit: string;
  branch: string;
  changedPaths: string[];
};

export type CommitManagedBranch = {
  message: string;
  /** Literal repository-relative files or directories. Omitted selects all working changes. */
  paths?: string[];
  /** Host-provided inherited file scope, checked against the actual commit delta. */
  scope?: string[];
};
