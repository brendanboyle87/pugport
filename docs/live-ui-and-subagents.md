# Live UI updates and managed subagents

## What users see

A project conversation can delegate independent work when useful. It does not need a separate swarm mode. Ordinary chats do not show child-agent controls or allow user/model delegation. Actual managed child tasks appear beneath the parent project conversation in the sidebar, separately from a Mod workspace. The tree starts collapsed and nested branches open on demand.

Select a member to read its progress and results, send additional requirements, stop that member, or open its existing execution record. A sent message is not proof that the member has acted on it. Completed members may resume through the existing continuation path. The main task collects child results and must verify or integrate them before reporting completion. A child failure remains visible; it is not silently reported as a successful result.

These are PugPort-managed tasks. A CLI may create its own agents internally; this tree cannot show details the CLI has not reported. An API child does not necessarily correspond to an operating-system process.

The project conversation toolbar also exposes manual child creation. Child rows offer archive, restore and delete actions that preserve the main conversation and execution evidence; active branches must be stopped first. Writable local Git children use managed worktrees, retain their baseline and recovery binding, and record file delivery separately from executor completion. Project routing profiles can be inherited or overridden per conversation. See [Managed child workspaces](managed-child-workspaces.md) for supported paths, delivery and recovery boundaries.

## Scheduling and ownership

- Reuse `agent-bridge`, `Workspace` delegation, the persisted workflow graph, mailbox and controller. The ordinary sidebar reads the existing conversation `/swarm` snapshot; the endpoint name is retained for compatibility.
- Conversation `delegationCount` is an indexed projection of persisted workflows, allowing the sidebar to discover historical children without fetching every graph. Full details load only when a tree is expanded. Active expanded trees can refresh periodically; live state events still update member status.
- Project families outside swarm mode have at most 12 child tasks and 3 active computing children. Explicit swarm mode retains its existing 60-child / 16-active limits. The root has depth 0, children may reach depth 4, and depth-4 children cannot delegate again. Waiting coordinators must release capacity so their own children can run.
- Limits apply to the root family, including concurrent reservations. A child cannot evade them by delegating to another child. Nested work inherits routing restrictions, budgets, read-only/write permissions and file scope; delegation never grants extra authority. Explicit child account/model choices remain binding. An automatic child selects its own account, model and effort within those restrictions rather than copying the parent task's manual selection.
- A main executor's early final response is retained while unfinished members are collected. The normal routed executor then checks and integrates results with bounded continuation. Cancellation and failures must settle this wait.
- Avoid parallel work with overlapping writes unless the existing scheduler can serialize it. Do not split a short answer simply to populate the tree.

For comparison, OpenCode documents [automatic subagents and per-agent permissions](https://opencode.ai/docs/agents/) and [parent/child session, asynchronous-message and cancellation APIs](https://opencode.ai/docs/server/). PugPort provides these interactions through its existing managed workflow IDs, bridge and real-time events, preserving its cross-CLI/API routing and authority checks.

## Updating a running interface

The desktop renderer and backend have separate lifetimes. This feature performs a safe renderer reload, not React development HMR and not arbitrary code evaluation. Backend tasks continue while the page reconnects to their persisted state and event stream.

1. The first installation of this capability needs a normal full build, then a safe backend/desktop restart.
2. For subsequent changes restricted to `src/ui` and compatible frontend assets, run the relevant checks, then `npm run build:ui`.
3. The build stages a complete immutable release in `dist/ui-releases/<build-id>`, validates its local assets, and atomically changes `active.json` only after success.
4. The page checks the small `/api/ui-release` response every 10 seconds. It loads a different compatible release only when it is safe. The current chat/Mod selection uses Studio's existing navigation persistence. The read-only Usage page also restores its subtab, card view, filters and grouping; an unsaved navigation selection defers activation. Settings and account editing continue to defer updates.
5. Text drafts, quotes, staged attachments, pending sends/uploads, member-message drafts, recording, private chats, open dialogs and Mod editing defer the update. Contents are kept in memory, not copied into a new plaintext draft cache. Finish the current editing or send/save it first. A small notice explains a pending update.

The build compares server/desktop/shared sources, package manifests and build tooling against the baseline, and verifies the built runtime hashes. The running backend also checks its compiled compatibility fingerprint. Changes to routing code, backend logic, shared schemas, desktop startup or dependencies therefore need a full build and safe restart. Editing a routing **setting** through the existing API remains different from editing routing **code**.

A startup watchdog runs before the entry module. If a new release cannot load or mount within 20 seconds, it requests a compatible previous release with the local session token and changes only that window. Failed build IDs are remembered in session storage so the page does not keep retrying the same broken release. If no safe previous release is available, it does not guess or restart the backend. Immutable prior assets are retained; they are not automatically deleted while other windows may use them.

## Agent-driven edits

An agent with permission to edit the PugPort project can modify its frontend, check the result, and run `build:ui`. The running app then picks up that release. This does not give every conversation access to the application source or installation directory. Existing project access and write permissions remain in force.

Installed Mods continue to use their declarative manifest and saved workspace APIs. This feature does not enable arbitrary imported JavaScript, silently change a Mod's stored schema, or grant it backend permissions. A new Mod capability that needs new backend APIs follows the full-build path.

## Verification

Use synthetic data and hidden renderer tests for drafts, recording, Mod edits, sidebar hierarchy, member messaging/cancellation, failed boot fallback, and backend task continuity. Check failed build IDs, incompatible releases, incomplete assets and concurrent source changes. Never use production conversations or paid model calls as test fixtures.

Run the application checks from `AGENTS.md` on the final candidate. A UI-only build being accepted does not itself prove UI behavior or test coverage. Report local test results separately from GitHub CI, and report renderer-only reloads separately from backend restarts.
