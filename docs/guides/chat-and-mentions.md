# Chat and mentions

## Sending messages

Type your question or task in the chat composer:

- **Send shortcut** — `Enter` sends and `Shift+Enter` adds a newline by default. In **Settings** → **Chats**, you can switch **Send shortcut** to `Ctrl+Enter` (`Cmd+Enter` on macOS); `Shift+Enter` always inserts a newline, and confirming an IME composition never sends early.
- **Read-only vs Writable** — questions run **Read-only** by default. Switch the permission pill in the composer footer to **Writable** (or ask the agent to edit files) when you want it to modify project files.
- **Attachments** — drag files into the chat, click `+` → **Attach files or images**, or paste images from the clipboard. You can attach up to 8 files per message (up to 50 MB per file, 200 MB total).

## Steering a running task and queuing

You don't have to wait for a running task to finish before typing your next message.

### Steering vs queuing

When a task is already running in the current chat, what `Enter` and `Ctrl+Enter` (`Cmd+Enter` on macOS) do depends on **Auto-steer** in **Settings** → **Chats** (enabled by default):

- **Auto-steer on (default):** pressing your send key **steers** the running task with your follow-up (`Steer`), while pressing the queue key (`Ctrl+Enter` in `Enter` mode, or `Ctrl+Shift+Enter` in `Ctrl+Enter` mode) adds the message to the **Message queue**.
- **Auto-steer off:** pressing your send key **queues** the message for after the current task finishes, and pressing the alternate shortcut steers the running task.
- **Quick steer from the queue:** if the composer is empty and a message is waiting in the queue, pressing the steer shortcut sends the first queued message into the running task immediately.

Native in-session steering is supported on Codex, Grok, Pi and modern Claude sessions. If the running task is still planning, waiting for an approval card, running on an executor that doesn't accept mid-run input, or if you changed approval settings for the new message, PugPort queues the message instead of steering.

### Managing the message queue

Queued messages appear in the **Message queue** bar above the composer. For any queued item, you can:

- Drag it or use the up/down arrows to reorder it.
- Click **Steer current task** to feed it into the active run right away.
- Click **Open in side chat** to move the question into a side chat without disturbing the main run.
- **Edit** or **Delete** it before it starts.

### Scheduling a message

Click `+` → **Schedule** in the composer footer before sending to queue a task with scheduling rules:

- **Delay start** — wait a set number of minutes (up to 30 days) or until a specific date and time before starting.
- **Deadline** — tell the queue when the task needs to finish.
- **High priority** — move the task ahead of normal queued work.
- **Prefer limits resetting soon** — prefer accounts whose usage windows are about to reset.

## The `/` menu

Type `/` at the start of the composer (or click `+` in the composer footer) to open the slash-command menu:

| Command | Action | What it does |
| --- | --- | --- |
| `/搜索` (matches `/search`) | **Web search** | Inserts `/搜索 ` at the start of your message so PugPort runs a web search first (attachments aren't allowed with direct search). |
| `/plan` | **Plan first** | Toggles **Plan first** for this message so a multi-step task creates a read-only plan (up to 6 steps) before executing. |
| `/side` | **Side chat** | Opens the **Side chat** panel beside the current conversation (unavailable in incognito chats). |
| `/new` | **New chat** | Starts a fresh conversation in the current project. |

## Mentions in three tiers (`@`, `@@`, `@@@`)

Type `@`, `@@` or `@@@` in the composer (or click `@` in the composer toolbar) to call specific participants. Keep typing after the `@` symbols to filter the list, then press `Enter` or `Tab` to insert the mention.

### Tier 1: `@` — Roles, executors and project files

Typing a single `@` shows:

- **Frequent** — up to 4 roles or executors you call most often.
- **Role** — built-in and custom roles (such as product manager, architect, code reviewer, tester) that shape how the agent approaches the task. Select **New role** at the bottom of the menu to create a custom role with its own instructions and default read/write mode.
- **Executor** — any enabled executor or specific account card on this computer (for example `@Claude`, `@Second Codex`, or `@Free` to pick a free model).
- **Project files** — in a project chat, type `@` followed by part of a filename or path to reference files in the project folder.

### Tier 2: `@@` — Devices and bots

Typing `@@` expands the menu to include:

- **Devices** — your other computers running `pugport node` over Tailscale (for example `@@MacBook`).
- **External agents** — bots you've added under **Usage & connections** → **Connections** → **Add** → **Bot** (`@@Muse` and `@@Grok Bot`).

### Tier 3: `@@@` — Remote servers

Typing `@@@` adds:

- **Servers** — remote Linux servers from `remote-servers.json`. Connected servers run your task through an on-demand SSH tunnel. If you pick a server that has an `ssh` host alias in `remote-servers.json` but isn't connected yet, PugPort opens the **Connect** dialog so you can set it up on the spot.

### Calling one participant vs several

- **One participant** — routes the message directly to that role, executor, device, bot or server.
- **Two to six participants** — mentioning 2 to 6 participants in one message starts a coordinated workflow where a coordinator delegates each participant's part and combines the results.

## Pinned messages, branches and side chat

### Pinned messages

Hover over any message in a conversation and click **Pin** to pin it to the **Pinned messages** bar at the top of the chat:

- Click any pinned item in the bar to scroll straight to that message in the conversation.
- Pinned items linked to a task show live **Task status** (`Queued`, `Planning`, `Running`, `Waiting for confirmation`, `Completed`, `Paused`, `Interrupted`, `Failed` or `Stopped`).
- You can also track a manual follow-up state on any pinned message: **To follow up**, **Waiting for confirmation** or **Completed**.

### Branches (fork, edit and resend)

Every message has branch actions so you can explore alternatives without losing your earlier thread:

- **Fork from here** — available on any user or assistant message. Creates a new conversation in the same project containing the history up to that message.
- **Edit** — available on your own messages. Edit the text (and whether it runs read-only or writable) and send; PugPort creates a new branched conversation from that point and runs your updated prompt.
- **Resend** — available on the last user message when no task is currently running in the chat.

### Side chat

Use **Side chat** when you want to ask a quick question about the current conversation without interrupting a running task or cluttering the main thread:

- **How to open** — type `/side`, click the **Side chat** button in the chat header, select text in a message to quote it into a side chat, or click **Open in side chat** on a queued message.
- **Context and isolation** — a side chat inherits the main chat's executor, model, effort and routing profile, and has its own **Read-only** / **Writable** toggle (read-only by default). Each question reads recent main-chat context locally (up to 12 recent messages / 12,000 characters, up to 2 active streaming runs / 3,000 characters, plus any quoted text up to 6,000 characters). It never shares native CLI session IDs with the main chat or writes back into main-chat memory.
- **Side chat history** — you can create multiple side chats per conversation and reopen them anytime from **Side chat history** in the side-chat header. Right-click a side chat in history to **Rename**, **Move to the main chat's folder** (promoting it to a full conversation in the sidebar), or **Delete** it.
