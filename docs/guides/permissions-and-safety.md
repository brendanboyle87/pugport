# Permissions and safety

PugPort enforces permissions at two layers: what a task is allowed to do (read-only vs writable, network access, and Git publishing) and who is allowed to change permissions or approve actions (with desktop confirmation for protected changes and approvals).

## Read-only vs writable tasks

Every task in PugPort runs in either **Read-only** (`read-only`) or **Writable** (`workspace-write`) mode:

- **Read-only (default for questions, terminal runs without `-w`, and delegated subtasks)** — the executor can read files, search text (`find_files`, `search_text`, `read_document`), and run read-only Git inspection commands (`log`, `show`, `diff`, `status`, `blame`, `grep`, `rev-parse`, `merge-base`, `ls-files`, `cat-file`, `ls-tree`, `describe`, `shortlog`, plus read-only `branch`, `tag`, `remote`, `stash` and `worktree` listings with external diff/textconv disabled). Modifying project files, organizing files, or calling write MCP tools is refused.
- **Writable** — the executor can modify files inside the project folder (or its isolated worktree/branch lane). Writes to the same project folder are serialized so two tasks don't overwrite each other's files at the same time (unless delegated subtasks declare non-overlapping `files` scopes).
- **Safe deletion via system Recycle Bin / Trash** — in **Settings** → **Permissions & security**, **Move deleted files directly to Recycle Bin** (or **Trash** on macOS/Linux, `recycleWithoutAsking`, enabled by default) gives writable tasks a `recycle_files` tool that moves project files to the system Recycle Bin / Trash instead of deleting them permanently. Protected system and app folders are always blocked, and files that cannot be moved to the Trash are skipped rather than permanently deleted.

## Tasks from other tools inherit the caller's permissions

When another coding tool dispatches a task through PugPort's MCP server, or an agent delegates a subtask, PugPort applies the caller's permission ceiling. Unknown callers default to read-only. A writable request above the ceiling is refused.

For MCP callers, PugPort inspects the process chain and available caller configuration, including sandbox network settings. It applies the resulting network and local Git restrictions where supported; the run shows inherited restrictions and executors that cannot enforce them. A local Git commit also requires an appropriate isolated worktree or work lane.

## Approvals and “always allow” only from the desktop window

The local HTTP approval route permits rejection, but allowing an action or remembering an approval requires a click in the desktop window. Protected changes require desktop confirmation: lowering a sandbox mode, allowing normal execution when the sandbox is unavailable, switching tool approval to automatic, enabling automatic reset-card use, changing launch commands, widening external caller permissions, trusting a project, changing verification or MCP extension commands, and adopting sandbox learning records. The HTTP error says: “Relaxing safety settings or changing launch commands requires confirmation in the desktop app.”

### Tool approvals and “Always allow in this chat”

In **Settings** → **Permissions & security** → **Tool execution**, **Commands and file operations** can be set to:

- **Auto-run · Default (`auto`)** — everyday tool calls within the task's read/write scope run automatically; out-of-scope operations are refused.
- **Confirm each item when needed (`ask`)** — mutating MCP tools and native CLI tool requests pause the run (`waiting-approval`) and show a **Needs your confirmation** (`ApprovalCard`) in the desktop window with **Reject** and **Allow this action**.

For repeatable Bash commands and Edit, Write or Codex file-change paths, the card can offer **Always allow in this chat: …**. High-risk actions still require a one-time confirmation.

## What an agent dispatched through MCP or the HTTP task API can and cannot do

External tools can use the MCP server or `/api/external/tasks`, subject to caller permissions and project validation. The MCP server offers `dispatch_task`, `list_agents`, `list_routing_profiles`, `task_status`, `task_result`, `list_tasks`, `cancel_task`, `list_conversations`, `read_conversation` and `send_message`.

External tasks cannot grant their own approvals. Foreground-only tools for asking the user, adding project rules and publishing branches are unavailable to them. Agent-started conversations can be hidden from the sidebar; **Settings** → **Advanced** → **Show conversations other agents start** shows them.

## Sandbox

Open **Settings** → **Permissions & security** → **Sandbox** to inspect the provider settings. The bundled MXC SDK 1.0.0 cannot run Learning mode. Codex uses its own sandbox.

A turn containing web search results does not use a trusted project's full access; the CLI's own sandbox applies for that turn. PugPort does not provide its web search tools to a turn left unnarrowed.
