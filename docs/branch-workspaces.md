# Independent branch workspaces

The managed workspace service supports two explicit modes. Existing records and calls without a mode keep the snapshot mode described in [Managed child workspaces](managed-child-workspaces.md).

| Mode | Starting files | Delivery |
| --- | --- | --- |
| `snapshot` | Supported tracked, staged, unstaged and untracked source files | Checked delivery into the direct parent's execution directory |
| `branch` | A local committed revision in a new branch | Independent branch retained for review; no automatic parent-file delivery |

Branch mode is useful when a task owns a separate development branch. It does not include uncommitted parent changes, ignored dependencies, local settings or untracked secrets. The caller must state this distinction when choosing the mode. Selecting branch mode does not by itself authorize pushing, opening a pull request, changing another branch or running repository setup scripts. Network access and local commits follow the dispatcher's permission ceiling (see [Project development workflows](project-development-workflows.md#permission-ceiling)).

## Service contract

`ManagedWorktrees.prepare` accepts the existing identity and source-directory fields plus:

- `mode?: 'snapshot' | 'branch'`: omitted means snapshot.
- `baseCommit?: string`: branch mode only; a full local SHA-1 or SHA-256 commit object ID. Omitted means the source HEAD observed during preparation. Branch names, tags, revision expressions and command options are not accepted here.
- `branch?: string`: branch mode only; a valid unused branch name. The default is `codex/managed-<workspace-id>`.

The source remains the direct parent's canonical execution directory, including when it is itself a managed worktree. An existing workspace ID cannot be rebound to another mode, task, parent, explicit baseline or branch. Current source HEAD changes do not replace an already recorded baseline.

The host creates the branch with `git worktree add`, with repository hooks and checkout filters disabled. Git handles the committed tree directly: the snapshot mode's 20,000-file, 128 MiB-total and 16 MiB-per-file limits do not apply. The service reads the repository/user `core.symlinks` setting and records `symlinkMode`; absent configuration defaults conservatively to placeholders on Windows and native links elsewhere. In `native` mode, the operating system must permit link creation. In `git-placeholder` mode, Git checks out the link target text as an ordinary working file while retaining Git mode `120000`; host commits preserve that Git type. A placeholder is not a usable filesystem link for build tools. No privilege escalation or source Git configuration changes are attempted.

Symlinks do not grant access to their targets outside the allowed task paths. Submodules are not recursively initialized, and missing partial-clone objects are not fetched automatically. Checkout failure reports an error instead of falling back to a shared directory. A real native-link test may be skipped when the test OS forbids link creation; that is not native-link acceptance. The placeholder-mode regression runs without symlink privileges.

## Git permissions and ownership

Successful branch preparation returns `mode`, `baseCommit`, `baseTree`, `branch`, `gitDirectory` and `gitWritePaths`. These are host-owned metadata, not permission requests accepted from a model or frontend.

The write paths contain only:

- This checkout's exact Git administration directory, including its index and HEAD.
- The repository's object directory, which is shared by Git worktrees.
- This branch's exact loose ref and reflog files and their adjacent lock-file paths.

They do not include the parent checkout, repository configuration, hooks, the common Git directory itself, other worktree administration directories or the whole shared refs directory. When a run may write, the run-time permission step may instead pass the common `objects`, `refs` and `logs` folders together with this checkout's Git directory, so a native CLI can run `git add` and `git commit`; it still never receives the common directory, `config`, `hooks`, `info` or `packed-refs`. The execution layer must independently validate the binding, grant only paths it can enforce, and retain the current task's permission ceiling and physical directory lease. Returning these paths alone does not enable writes in an adapter. Git object storage is shared; a worktree is not a separate repository or a security boundary.

Exact ref and lock paths can be absent until Git writes them. The current Codex adapter has no demonstrated enforcement contract for individual nonexistent writable files, so these paths are not evidence that native CLI commits work. Do not broaden the grant to the whole common Git directory to compensate; use the four folders above or the host commit operation below.

Recovery verifies the canonical checkout, common repository, branch, baseline ancestry, worktree registration back-pointer and recorded Git administration paths. Normal continuation retains committed and uncommitted child work. An interrupted initial creation can recover an already complete, clean checkout, but does not reset or overwrite a partially populated or changed checkout. A colliding branch is never adopted or reset. Failed, cancelled and unfinished work remains available for inspection; the service performs no force removal, pruning, branch deletion or push.

`apply` rejects branch-mode workspaces before creating a delivery receipt or touching the parent. Branch completion is not parent integration, successful verification or publication. A runtime using this mode must represent those states separately and must not wait for a snapshot delivery that cannot occur.

## Host-controlled commits

`commitBranch(id, { message, paths?, scope? }, signal?)` returns `{ status: 'committed' | 'unchanged', commit, branch, changedPaths }`. The caller must verify current workflow ownership, write permission and inherited scope, and hold the child's physical execution lease. The helper independently verifies the stored branch workspace and registration. `paths` selects literal repository-relative files or directories; omitted paths select all working changes. The operation commits working file contents, not a staged-only version, and preserves unrelated staged contents. It rejects traversal, Git metadata paths, submodule changes, unresolved index conflicts and active merge/rebase/cherry-pick operations. `scope` is host-supplied and checked against the actual commit delta.

Commits use temporary indexes, hooks and filters remain disabled, and the owned branch ref changes only if its previous commit still matches. The parent checkout, index and branch ref remain unchanged. Actual `user.name` and `user.email` are read from repository/user configuration; missing or invalid identity is an error, with no synthetic fallback. Configuration and credentials are not copied into the child. This endpoint does not sign, push or create a pull request.

No changes returns `unchanged` with the existing commit. Failure retains working files and existing staged content. Cancellation before the ref update leaves the branch unchanged; after that point the paired child-index update finishes. If an operating-system error prevents that last index update after the commit exists, the error includes the created commit ID and asks for index inspection instead of pretending nothing happened. The service does not reset the branch or overwrite working files to recover.

## Project-specific configuration

The project context UI saves an explicitly approved `autoMemoryDirectory` reference through authenticated project settings. `ProjectCliContextService` retains its canonical path and directory device/inode identity in project-owned metadata. Every use revalidates that identity; a removed or replaced directory requires the user to select it again. The CLI adapter receives only the approved directory reference. The service does not read or copy `.claude/settings.local.json`, its hooks, permissions, environment or credentials. No private project's conventions or model choices belong in product-wide defaults.

The same UI can authorize named, fixed SSH queries. An agent can list or run a saved name, but cannot change the host, command or arguments. The host serializes each fixed argument for a POSIX-compatible remote shell, uses existing local SSH identity configuration, requires existing host trust, and disables interactive authentication, forwarding, multiplexed connections, local commands and proxy commands. This does not prove an arbitrary saved command is read-only: the user must authorize its actual effect. Configuration writes require the user UI route, and revision checks prevent one window from overwriting another window's newer authorization.

Queries have a 1–120 second deadline (30 seconds by default), a combined 256 KiB output limit, secret-redacted results, and at most one pending/running query per project. Removing or changing the configuration cancels that project's old query. Cancellation and limits clean up the owned local SSH process; the result explicitly warns that the remote process may continue. Saving configuration does not connect to a server. Tests inject processes, and do not inspect SSH keys or connect to real hosts.

## Verification scope

Synthetic Git tests cover committed baseline selection with a dirty parent, exact metadata paths, independent commits and continuation, nested branch sources, collisions and invalid arguments, interrupted creation, cancellation, unchanged parent contents and index, disabled hooks/filters, real tracked symlinks where supported, and a committed tree containing more than 20,000 files and a 129 MiB blob. Existing snapshot and delivery tests remain in place. These tests do not call real models, push to a remote, inspect private repositories or prove operating-system permission enforcement.
