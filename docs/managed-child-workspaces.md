# Managed child tasks and project routing

PugPort keeps one task graph for Claude Code, Codex and API executors. A child task has its own task record, progress and result; a child is not necessarily a new operating-system process. Provider-internal agents are only visible when that provider reports them.

## Using child tasks

Child agents are available in project conversations. Give the main agent a task normally; it can delegate investigation, implementation or review through the existing bridge tools. You can also choose **Create child agent** in the project conversation toolbar, or create a child from a selected member. The form uses the same delegation service as agent-initiated work. A new empty conversation needs a real parent task first. Ordinary chats do not expose child-agent controls or allow user/model delegation; their internal working directory does not turn them into projects. Existing legacy records remain available in task/execution history.

Investigation and review remain read-only. Implementation cannot exceed the parent task's permissions. Existing routing restrictions, account budgets, concurrency limits and dependency checks still apply. Project conversations outside swarm mode allow 12 children and 3 concurrent children; swarm mode allows 60 members, 16 concurrent members and a maximum depth of 4. This change does not increase those limits.

The sidebar keeps child tasks under their parent. Open a child to inspect its progress, execution directory, delivery and recovery state. Dispatch acknowledgement only means that a task was created. The final result and verification evidence remain separate.

Right-click a child or open its **More** menu to archive or delete that child branch. Running or queued work must be stopped first, including active descendants. Archived children can be restored from the compact archived section. These actions preserve the main conversation, its messages and unrelated sibling tasks. Deleting a task card retains its execution records, audit history and managed worktree; it is not a disk-cleanup action. Archive state does not turn a failed delivery into successful acceptance or reset safety limits.

The authenticated child archive endpoint is `POST /api/workflows/:id/archive` with `{ "archived": true | false }`; removal reuses `DELETE /api/workflows/:id`. Archive accepts delegated workflows only. Both actions validate the current stored branch before writing and retain the parent. UI filtering is not the authorization boundary: manual and model delegation also validate the owning project's scope in the server.

## Isolated Git workspaces

Writable local children inside a work lane use the lane's worktree as their source and do not share its directory.

A writable local child in a Git project receives an application-managed worktree. It uses the parent's actual execution directory as its source, so a nested child starts from its direct parent's worktree rather than the original checkout. Read-only work on an isolated task uses that task's execution directory.

The managed binding records the stable project and task identities, source directory, repository identity, branch, immutable baseline and delivery state. A continuation retains this binding. A provider session cannot silently move between different execution directories.

The baseline includes supported uncommitted source changes through a bounded snapshot. Creating the snapshot does not commit on, switch or rewrite the user's branch or index. If the source cannot be safely captured, creation reports the reason instead of silently starting from stale committed files. Ignored dependency directories and executable setup hooks are not automatically copied or run.

The initial implementation requires the project directory to be the Git repository root with at least one commit. Snapshots support ordinary files, up to 20,000 files, 128 MiB total and 16 MiB per file. Symbolic links, submodules and conflicted indexes require explicit handling and block creation. Ignored files are omitted. Dependency installation, when necessary for the assigned task, must happen in the child's directory under its existing permissions; sharing another checkout's dependency links is not proof that tests exercise the child's code.

A worktree isolates ordinary file changes. It is **not a security sandbox**: processes still need their existing permission controls. Non-Git directories use the existing shared-directory scope and writer scheduling, and must not be described as isolated. Incognito writable Git delegation is unavailable while retained-worktree recovery cannot satisfy the incognito deletion contract.

The Windows native learning policy exposes the exact host-validated child checkout according to task permissions and requests read-only access to its common Git metadata. Snapshot-mode children get no Git write paths even when the dispatcher can commit; child instructions leave staging, commits and integration to the host delivery workflow. Branch lanes follow the permission ceiling in [Project development workflows](project-development-workflows.md#permission-ceiling). In Windows learn mode a branch lane's host-decided Git folders are added to the writable paths; network egress is unchanged and learn mode still only records. This preserves the existing permissive learning and fallback behavior; policy-construction tests do not prove operating-system containment.

## Delivery and recovery

Completing a child run does not mean its changes have reached the parent. Delivery is recorded separately. Changes are checked against the captured baseline and the direct parent's current files while holding the parent's writer lease. Unrelated parent changes must survive. Conflicts or an uncertain interrupted application keep the child workspace and report the problem; they do not count as accepted delivery or release dependent writers as though integration succeeded.

Archiving a lane releases its managed worktree and local branch when it is safe. Dirty worktrees and commits found on neither a remote-tracking branch nor another local branch are retained with a reason; Git refusals are reported for inspection. There is no automatic force removal, reset, pruning or branch merge. Cancellation, errors and application restarts retain the workspace for inspection and continuation. Recovery checks repository and path ownership before reuse; merely finding a directory or starting an executor is not proof of successful recovery. A delivery receipt is also not a test result: the main agent must still evaluate the returned work and applicable verification evidence.

Purging a project does not remove retained child worktrees or their Git registrations. If an application-created source directory holds their shared Git metadata, that source is retained too. The purge result reports this retained storage instead of claiming that all disk space was freed.

## Project routing defaults

Create a named routing profile in Settings, then select it in the project's settings. Future turns in that project inherit it. In an individual conversation, the executor menu offers:

- **Project default**: use the project's current default.
- **Automatic**: explicitly use the normal global/conversation rules instead of inheriting a named project profile.
- A named profile: override the project default for this conversation.

Profiles select among the user's configured executors. They never grant write permission or bypass account availability, budget and strict-routing checks. Editing a profile or changing the project's default affects future tasks. Queued/running tasks retain their captured rules, profile identity and revision; children retain their parent's task context.

Project records store `routingProfileId?: string`. Conversation records distinguish an absent value (inherit), `null` (explicit automatic) and a profile ID (explicit override). The shared `effectiveRoutingProfileId` resolver is used by both UI and runtime. The authenticated endpoints are:

```text
PATCH /api/projects/:id/routing-profile       { "profileId": "<id>" | null }
PATCH /api/conversations/:id/routing-profile { "profileId": "<id>" | null }
PATCH /api/conversations/:id/routing-profile { "inheritProject": true }
```

A referenced project profile cannot be deleted, including references from removed projects that remain restorable. Missing profiles fail explicitly. This feature does not install private project policies as product defaults and does not claim a provider session is a clean-context independent judge.

## Implementation references

These are design references, not embedded schedulers or copied implementation code:

- [Claude Code worktrees](https://code.claude.com/docs/en/worktrees): separate execution directories, explicit baselines, retaining uncertain or modified workspaces.
- [OpenCode agents](https://opencode.ai/docs/agents/) and [worktree implementation](https://github.com/anomalyco/opencode/blob/a4eb2f89a5a66b726b25fe3fc596d4c477292542/packages/core/src/worktree.ts): owned child sessions and worktree lifecycle. OpenCode is MIT licensed.
- [OpenRig delivery](https://github.com/mvschwarz/openrig/blob/2e428ef8a2d4cadd830e96bd0cbe5a7b1650d16e/docs/reference/seat-delivery.md) and [worktree builds](https://github.com/mvschwarz/openrig/blob/2e428ef8a2d4cadd830e96bd0cbe5a7b1650d16e/docs/reference/worktree-builds.md): delivery evidence, recovery uncertainty and checking that tests actually execute the isolated source. OpenRig is Apache-2.0 licensed.

PugPort continues to own delegation, budgets, permissions, persistence and UI updates. Git operates on local synthetic repositories in tests; tests must not launch real provider calls, use private project repositories or modify production conversations.
