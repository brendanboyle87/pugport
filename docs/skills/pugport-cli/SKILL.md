---
name: pugport-cli
description: Hand a task to PugPort from a script or another agent and get the answer back as JSON. Use when you need PugPort's routed executors (Claude, Codex and others) to do work, continue an earlier PugPort conversation, pipe a file or log in as the task, list executors or tasks, cancel a task, or check that the PugPort desktop app and terminal command are healthy.
---

# PugPort CLI

Use `pugport ask --json "task"` for a single JSON result. Progress goes to stderr.
Use `pugport ask -` to read stdin, or `pugport ask "context" -` to append it after a blank line.
The task, trimmed, may be at most 50 000 characters.
Use `pugport ask -r <conversationId> "follow-up"` to continue a conversation.
Add `-w` when the task is authorized to write files.

`ask --json` prints one line on stdout. When PugPort runs the task:

- `taskId`, `conversationId`, `status` (`completed`, `failed`, `cancelled`, `blocked` or `interrupted`)
- `executor`, `model`, `result`, `error` (absent fields are left out)

When the reply has no task (handed to a device or outside agent, or queued), it exits 0 with:

- `conversationId`, `note`, `queued` or `handedTo`

Use `pugport agents --json` to list executors and `pugport tasks --json` to list tasks.
Use `pugport cancel <taskId> --json` to cancel a task.
Use `pugport status --json` for quota data and `pugport doctor` for diagnostics.

Exit codes: 0 completed, 1 failed or rejected, 2 invalid input, 3 paused, 130 interrupted.
Waiting for approval or confirmation has no deadline. Wrap calls in your own timeout.
