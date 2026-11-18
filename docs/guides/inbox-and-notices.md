# Inbox and notices

The **Inbox** button at the bottom of the sidebar collects account, CLI and connectivity problems that need your attention or explain why an executor was skipped, without interrupting your chat with pop-up dialogs.

## What the Inbox shows

The Inbox tracks eight notice kinds, each with a severity dot (**Needs attention** `action`, **Warning** `warning` or **Info** `info`) and a repeat counter (`×2`, `×3`…) when the same issue happens more than once:

| Issue | Severity | When it appears | Action button |
| --- | --- | --- | --- |
| **Incompatible CLI after an update** (`{0}'s CLI no longer works with PugPort`) | `warning` | A native CLI (`Claude`, `Codex`, `Grok` or `Cursor`) fails at startup or during discovery with `runtime-protocol-incompatible` because a CLI update changed its flags or output protocol. | **View run** (when triggered by a task run) |
| **Several executors unreachable** (`Multiple executors cannot connect; there may be a network problem`) | `warning` | Multiple cloud executors fail with network errors at the same time (`networkWide`), pointing to a local connection or proxy outage rather than a single account. | *(Clears automatically when a cloud run succeeds)* |
| **Repeated technical failures** (`{0} failed {1} times in a row`) | `warning` | An executor hits **3 consecutive technical failures** (`runtime-network-error`, `runtime-timeout` or `runtime-process-closed`) and enters technical cooldown. | **View run** |
| **Sign-in expired** (`{0} needs you to sign in again`) | `action` | A subscription CLI reports `authentication-required` or transitions from `ready`/`error` to `auth-required`. | **Sign in** |
| **API key rejected** (`{0}'s API key was rejected`) | `action` | An API provider rejects the configured key (`api-key-auth-or-configuration` or `authentication-required` on a key-based card). | **Replace key** |
| **CLI executable missing** (`{0}'s CLI can't be found`) | `action` | A previously working native CLI can no longer be found at its launch path (`missing`). | **Usage & connections** |
| **Account disabled by provider** (`The provider has disabled {0}`) | `action` | The provider reports that the account itself has been disabled (`account-disabled`). | **Usage & connections** |
| **API budget expired** (`{0}'s API configuration has expired`) | `action` | A local API budget with an `expiresAt` timestamp reaches its expiry date (`phase === 'expired'`). | **Usage & connections** |

### Project rules added by a foreground task

When a foreground main task saves a new project rule from your exact words in chat (`add_project_rule`), PugPort records the rule in **Project settings**, shows the quote and rule in the tool reply, and immediately broadcasts a project-rule update notice to other active tasks running in the same project. You can review or delete saved project rules anytime under **Project settings** → **Project rules**.

## The three-part notice

PugPort uses a structured three-part layout both for **incompatible CLI notices** in the Inbox and for **system notices** on stopped or failed tasks in chat, so you always see what happened, what PugPort did about it, and the raw evidence separately.

### 1. Incompatible CLI notices in the Inbox

When a CLI update breaks compatibility with PugPort's adapter, the Inbox notice body has three paragraphs, followed by expandable raw output:

1. **What failed** — names the executor and, when detected, the exact CLI version whose startup flags or protocol failed (`{0}'s CLI (version {1}) fails at startup, so tasks cannot start.`).
2. **How routing is handling it right now** — if the executor is in `error` state from discovery, it tells you automatic dispatch to that card is paused and tasks go to your other accounts (`Tasks are paused for {0} and will be assigned to other accounts.`); otherwise it notes that the run was handed over and later tasks can retry (`PugPort will try again when assigning the next task.`).
3. **What you need to do** — tells you that you don't need to fix anything right now while the adapter is being updated (`There is nothing you need to do for now; PugPort is investigating.`).
4. **Raw error** — an expandable `<details>` block containing the exact `stderr` / protocol error from the CLI, plus a **View run** button when a task triggered the notice.

### 2. System notices in chat

When a task stops, pauses (`blocked`), is interrupted or fails in a conversation, the system notice card separates three pieces of information without paraphrasing the model:

1. **Where and why it stopped (`stop`)** — on a blocked multi-step plan, shows the step number and step title (`Step N · <title>`), followed by the executor's own words (`reason`) for why it stopped. PugPort never rewrites or guesses a cause from the executor's prose.
2. **PugPort's status classification (`text`)** — a single line explaining the controller or adapter state (for example, that the run was read-only and blocked a write, hit a usage limit, failed verification, or was stopped by a provider content filter).
3. **Details (`details`)** — the raw error message and adapter diagnostic details.

## What you are expected to do

- **When the Inbox badge shows a count:** click **Inbox** in the bottom bar of the sidebar. Opening the Inbox marks open notices as read (and automatically resolves `info` notices).
- **For `action` notices (red/attention dot):**
  - Click **Sign in** on an isolated subscription account to open its official terminal sign-in window (for a default local CLI, it opens **Usage & connections** → **Connections**). Once you finish signing in, PugPort re-checks the account and clears the notice automatically.
  - Click **Replace key** or **Usage & connections** to update an expired or rejected API key, extend an expired API budget, or fix a missing CLI path.
- **For `warning` notices (incompatible CLI, repeated failures, network):**
  - You don't have to stop working — automatic routing routes around cooled-down or paused cards using your other connected accounts.
  - Click **View run** if you want to inspect the run's trajectory and **Raw error**.
- **Automatic resolution and cleanup:** whenever an executor completes a run or returns to `ready` on refresh, PugPort resolves its open login, key, missing-CLI, failing, incompatible-CLI and network notices automatically. You can also click `×` (**Dismiss notice**) on any row to hide it manually; resolved notices are pruned after 30 days (keeping at most 200 historical rows).
