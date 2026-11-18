# Desktop, tray and sidebar

Closing the PugPort window hides the app to the system tray so running tasks, queued messages and scheduled routines keep working in the background.

## System tray popup and menu

Left-click the tray icon to see CPU, GPU and memory usage, account usage limits, **Refresh usage** and **Open main window**. On macOS, clicking the menu bar icon opens the native menu.

Right-click the tray icon for **Open PugPort**, the current task count, **Black out now**, **Keep awake** and **Quit PugPort**. The tray's **Keep awake** is a separate manual switch from the task-based setting.

## Blackout

Choose **Black out now** or use the global `Ctrl+Alt+B` shortcut, which you can change in Settings. Blackout covers each display with a black window while PugPort continues running. Press any key to close the overlays; a mouse click does not end blackout.

## Keep awake and finish notifications

In **Settings** → **General**:

- **Keep the computer awake while tasks run** (`keepAwake`, enabled by default) — uses Electron's `powerSaveBlocker` (`prevent-app-suspension`) whenever at least one task is `running` or `waiting-approval`. As soon as all tasks finish, the blocker releases so your computer can sleep normally.
- **Completion notification** — sends a native OS notification when a task completes, fails, stops, or pauses for your confirmation (`Waiting for your confirmation`, `Task completed`, `Task failed` or `Task stopped`). Click the notification to focus PugPort and jump straight to that chat. Choose between:
  - **When you're not viewing the chat** (`background`, default) — notifies you only when the window isn't focused or you're looking at a different chat or page.
  - **Always** (`always`) — notifies you on every finished or waiting task.
  - **Never** (`never`) — turns off desktop finish notifications.

## The sidebar

The left sidebar organizes your work into:

- **New chat (`Ctrl+N`)** and **New incognito chat (`Ctrl+Shift+N`)** — an incognito chat runs without saving to long-term history and is permanently deleted when you leave or close it.
- **Activity filter bar** — filter the sidebar by **All**, **Running**, **Needs me** (needs approval or confirmation) or **Unread**. Click `…` beside the filter bar to **Mark all as read**, or press `Ctrl+Shift+J` to jump to the next chat that is waiting for you or unread.
- **Pinned**, **Chats** (with custom folders) and **Projects** — right-click any chat to **Pin**, **Mark as unread** (`Ctrl+Shift+U`), **Move to category**, **Open in split view** (`Ctrl+Click` or middle-click, up to 3 side-by-side panes), **Open in new window** (`Ctrl+Shift+O`), **Export** (`Markdown` or `JSON`), **Archive** or **Delete**.
- **Bottom navigation** — **Extensions** (**Mods**, **Skills**, **Connections**, **Components**), **Tasks** (**Scheduled**, **Queue**, **Run history**), **Usage & connections** (**Quota**, **Spend**, **Connections**), **Settings** (`Ctrl+,`) and **Inbox**. Press `Ctrl+B` to collapse or expand the sidebar.

### Hiding chats started by other agents

When an external coding tool or another agent starts a conversation through PugPort's MCP server or HTTP task API, PugPort marks that conversation in `agentConversationIds`:

- **Hidden by default** — to keep your sidebar clean, conversations started by other agents (and projects whose only conversations were started by other agents) are hidden from the sidebar list.
- **Shown automatically when they need you** — if an agent-started conversation pauses waiting for your confirmation or approval (`workflowNeedsUser`), it appears in the sidebar automatically until you handle it.
- **The Advanced switch** — to show all agent-started conversations in the sidebar at all times, open **Settings** → **Advanced** and turn on **Show conversations other agents start** (`showAgentConversations`). Even when the switch is off, you can still open those tasks from **Tasks**, **Search**, or a direct link.

## Search

PugPort gives you three ways to find anything quickly:

- **Search chat content (`Ctrl+Shift+F`)** — opens the full-history search dialog. Type any keywords to search across all saved conversations and messages (including archived chats). Results show the matching snippet, conversation title, project name (`General chat` or project), role (`You` or `Reply`), and timestamp; press `Enter` or click a result to open that conversation and scroll straight to the matching message.
- **Command palette (`Ctrl+K`)** — jump to any conversation, project, page or setting, or run quick actions (toggle theme, pin window on top, refresh usage, open split view).
- **Find in conversation (`Ctrl+F`)** — searches within the currently open chat.
