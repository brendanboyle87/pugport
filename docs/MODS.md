# Mods author guide

PugPort sets no design rules: style your Mod however you like; only the interface below must match.

## 1. What a Mod is

A Mod is a small app that lives inside one chat. When someone opens a chat that has your Mod, **everything to the right of PugPort's sidebar is yours**: PugPort keeps one thin bar at the top, and the chat itself moves into a drawer that slides in from the right when the user wants it.

```
┌ sidebar ┬ [icon] Your Mod                         Chat   …  ┐  ← host bar (PugPort)
│         │                                                    │
│  chats  │                 your Mod, full size                │
│         │                                                    │
│         │                                       ┌ chat ─────┐│  ← drawer, on demand
└─────────┴───────────────────────────────────────┴───────────┘┘
```

The chat keeps its messages, model, tools, permissions and budget. Your Mod adds the interface around it and its own saved state. People open a Mod from **Extensions › Mods › Open** or by clicking its chat in the sidebar; they can hide it (back to the plain chat) or remove it from the `…` menu.

A `mainView` web entry gets the full workspace. `rightPanel` and `sidebarPanel` are also supported; their host layouts are described below.

## 2. Host surfaces

The host wraps entry HTML in `#mod-root`. A workspace frame resizes when the chat drawer opens beside it; when space is insufficient, the drawer overlays the frame.

- `composer.insert({text, mode})` puts text in the message box. In the workspace PugPort opens the chat drawer and focuses the message box for you. The user always presses Send; your Mod never sends.
- `ui.chat({ open: true })` opens the drawer; `ui.chat({ open: false })` closes it. It fails with `E_UNAVAILABLE` when your Mod is hidden or not in the workspace.
- `host.info().layout` is `'workspace'` for a `mainView` entry (`'panel'` or `'sidebar'` for the older slots).
- The `chat` event `{open}` reports drawer changes.

### Existing companion layouts and surface ownership

| Contribution             | Layout reported by `host.info()` | Behavior                                                                                                                |
| ------------------------ | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Web `mainView`           | `workspace`                      | Owns everything right of the left sidebar below the thin host bar. Normal chat chrome is hidden; Chat opens the drawer. |
| Web or form `rightPanel` | `panel` for web                  | Legacy companion beside normal chat. Opening a side chat temporarily hides it.                                          |
| Web `sidebarPanel`       | `sidebar`                        | Legacy companion above the conversation list, within 40% of the sidebar height.                                         |

When a package declares `mainView`, its right and sidebar companions remain mounted but hidden. The workspace is its sole visible Mod surface; hiding the Mod returns to plain chat. The package remains valid and its saved state stays intact.

Within a window, the first pane displaying a chat owns its surfaces. A pop-out owns its own set of frames; revisions protect concurrent saves. Hidden frames stay mounted with unsaved input. The chat has one Mod visibility flag. Switching chats, replacing/removing a Mod, or changing pane ownership revokes and unmounts old frames. Save before leaving; an unmounted frame cannot retain local edits. Each web slot has its own frame, at most three per chat per window. A package with no contributions keeps the ordinary chat layout.

## 3. Package contract

A package is one UTF-8 JSON file. Unknown fields are rejected. Versions are immutable: use a new version when changing content. V1 is still accepted and displayed as a right-panel form with its original limits.

| V2 field                        | Contract                                                                                                                                                                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `schemaVersion`                 | Required, exactly `2`.                                                                                                                                                                                                                     |
| `id`                            | Required, ≤80 characters, `/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/`; choose your own stable namespace.                                                                                                                                        |
| `version`                       | Required, numeric `major.minor.patch`, ≤32 characters.                                                                                                                                                                                     |
| `title`, `description`          | Required, respectively 1–60 and 1–200 characters.                                                                                                                                                                                          |
| `author`, `category`, `license` | Optional nonempty strings, respectively ≤80, ≤40, ≤40 characters. License is stored only.                                                                                                                                                  |
| `icon`                          | Optional host icon from section 6.                                                                                                                                                                                                         |
| `logo`, `cover`, `card`         | Optional `{ "src": "data:image/png;base64,...", "alt": "Description" }`; `alt` is 1–160 characters. PNG or WebP only; section 6 gives image limits.                                                                                        |
| `readme`                        | Optional Markdown, ≤20,000 characters.                                                                                                                                                                                                     |
| `homepage`                      | Optional HTTPS URL ≤2,000 characters with no username/password.                                                                                                                                                                            |
| `permissions`                   | Optional unique array of `chat:read`, `composer:draft`, `model:run`, `voice:session`, `data:store`, `connections:read` and `files:import`. No `chat:send`. `model:run`, `voice:session` and `connections:read` need approval when loading. |
| `state`                         | Optional `{ "keys": [{ "id": "notes" }] }`; at most 32 unique key IDs, no per-key budget.                                                                                                                                                  |
| `ui`                            | Optional `{ "entries": { "panel": { "html": "...", "css": "...", "js": "..." } } }`; at most 6 entries. HTML required; CSS and JS optional.                                                                                                |
| `contributions.mainView`        | Optional `{ "kind": "web", "entry": "main" }`.                                                                                                                                                                                             |
| `contributions.rightPanel`      | Optional `{ "kind": "web", "entry": "panel", "title": "Notes" }` or `{ "kind": "form", "form": { ... }, "title": "Notes" }`. Title optional, ≤40 characters.                                                                               |
| `contributions.sidebarPanel`    | Optional `{ "kind": "web", "entry": "sidebar", "title": "Notes" }`; title optional, ≤40 characters.                                                                                                                                        |

Entry names match `/^[a-z][a-z0-9-]{0,31}$/`. Every referenced entry must exist, and one entry may serve only one slot. Each entry allows HTML ≤128 KiB, CSS ≤64 KiB and JS ≤256 KiB in UTF-8. The complete serialized manifest and the written package file must fit 1 MiB. There is no HTML blacklist; inline event handlers produce a validator warning only.

A form contains optional `markdown` (≤20,000 characters), required `fields` and required `actions` arrays (each ≤16). Fields have `id`, `label` (1–60), `type` (`text` or `textarea`), optional `initialValue` (≤4,000) and optional `help` (≤160). Actions have `id`, `label` (1–120), and `type` (`save` or `compose`); compose also requires a nonempty `prompt` (≤8,000). Field IDs and action IDs must each be unique; every field ID must appear in `state.keys`.

Field, action and state IDs match `/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/`; `constructor` and `prototype` are reserved. No manifest `layout` or split-view field, extra composer/header actions, screenshots, settings fields, select/toggle fields or executable repository configuration are accepted in v2.

## 4. Host API

Use `window.pugport` in your packaged entry JavaScript. Methods return promises and await the handshake automatically. A late `ready` listener may miss that event; call methods directly. Each frame allows at most 16 pending calls, with a 30-second request timeout and a 600 KiB serialized message limit.

| Method                                                                                                | Input and result                                                                                                                                                                                                                                                                                                                         | Permission         |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `host.info()`                                                                                         | `{apiVersion: 2, hostVersion, locale, theme, tokens, slot, layout, conversation: {id, title}, project?: {id, name}}`. Theme is `light` or `dark`; tokens is a string map of optional theme data listed below; the Mod may use or ignore it. `layout` is `workspace` for mainView, `panel` for rightPanel, or `sidebar` for sidebarPanel. | None               |
| `state.get()`                                                                                         | `{revision, values}` for the bound instance.                                                                                                                                                                                                                                                                                             | None               |
| `state.set({values, expectedRevision})`                                                               | Merges declared string keys, validates the complete state, then returns `{revision, values}`. Pass the exact revision you read.                                                                                                                                                                                                          | None               |
| `messages.list({limit?, before?})`                                                                    | Array of up to 200 messages, oldest first within the page. Default limit: 200. `before` is an existing message ID, excluded. Only `id, role, content, createdAt, attachments?: [{name, kind}]` are returned.                                                                                                                             | `chat:read`        |
| `composer.insert({text, mode})`                                                                       | Appends or replaces the real chat draft, opens the workspace chat drawer, and focuses the composer. Mode: `append` or `replace`. Text: at most 16,000 characters. Returns `{}`; never sends.                                                                                                                                             | `composer:draft`   |
| `ui.chat({open})`                                                                                     | Opens or closes the real chat drawer; `open` must be a boolean. Returns `{}`. Only available in a visible workspace mainView; hidden surfaces and companion layouts reject with `E_UNAVAILABLE`.                                                                                                                                         | None               |
| `ui.setDirty(boolean)`                                                                                | Blocks live UI updates while this frame has unsaved input. Clear after saving. Each frame owns its own blocker. Returns `{}`.                                                                                                                                                                                                            | None               |
| `ui.notify(string)`                                                                                   | Shows Mod title and message as plain text. Message: 1-200 characters. At most 3 per Mod ID per 10 seconds across frames in the window. Returns `{}`.                                                                                                                                                                                     | None               |
| `model.run({prompt, saveTo?, format?, fresh?})`                                                       | Starts a model run (section 4b). Returns `{runId}` at once; the answer arrives as a `model` event.                                                                                                                                                                                                                                       | `model:run`        |
| `model.cancel({runId})`                                                                               | Stops a run of this chat. Returns `{}`.                                                                                                                                                                                                                                                                                                  | `model:run`        |
| `voice.status()`                                                                                      | `{provider, available, gptLive: {available, reason?}}`: what a start would use now and why GPT Live cannot start (section 4c).                                                                                                                                                                                                           | `voice:session`    |
| `voice.start({instructions?, provider?, maxMinutes?, maxCostUsd?, voice?, language?, endSilenceMs?})` | Starts a voice session for this frame (section 4c). Returns a handle with `sessionId`, `provider`, `say`, `instruct`, `interrupt`, `stop` and `on`.                                                                                                                                                                                      | `voice:session`    |
| `voice.instruct({sessionId, text})`                                                                   | GPT Live only: steers the model, for example to correct the last sentence now. Returns `{}`; a local session returns `E_INVALID`.                                                                                                                                                                                                        | `voice:session`    |
| `voice.speak({sessionId, text})`                                                                      | Reads up to 4,000 characters aloud; calls queue. Returns `{}`.                                                                                                                                                                                                                                                                           | `voice:session`    |
| `voice.interrupt({sessionId})`                                                                        | Stops playback and keeps listening. Returns `{}`.                                                                                                                                                                                                                                                                                        | `voice:session`    |
| `voice.stop({sessionId})`                                                                             | Ends the session; safe to repeat. Returns `{}`.                                                                                                                                                                                                                                                                                          | `voice:session`    |
| `storage.*`                                                                                           | Mod-owned data (section 4d).                                                                                                                                                                                                                                                                                                             | `data:store`       |
| `connections.*`                                                                                       | Bank connections through Plaid (section 4e).                                                                                                                                                                                                                                                                                             | `connections:read` |
| `files.pick`, `files.readText`, `files.pdfText`                                                       | Statement import (section 4f).                                                                                                                                                                                                                                                                                                           | `files:import`     |

Declaring `chat:read` or `composer:draft` grants it without another prompt or switch. The API does not expose credentials, paths, the full manifest, host DOM, preload, Node or internal objects. Unknown methods, extra fields and invalid values are rejected. State validates both patch and merged values. A write racing removal/replacement is checked at the server mutation boundary: a valid write committed first remains saved; a write arriving after its binding changes fails.

`const unsubscribe = pugport.on(name, data => { ... });` registers a listener; call `unsubscribe()` to remove it. Events only go from host to Mod:

| Event         | Payload                                                                       |
| ------------- | ----------------------------------------------------------------------------- |
| `ready`       | `{}` following a fresh handshake.                                             |
| `state`       | `{revision, values}`. Do not overwrite locally dirty edits.                   |
| `messages`    | `{count, lastId?}`, only with `chat:read`. Read content with `messages.list`. |
| `chat`        | `{open: boolean}` when the workspace drawer changes.                          |
| `run`         | `{running: boolean}`.                                                         |
| `theme`       | `{theme: "light" or "dark", tokens}`.                                         |
| `visibility`  | `{visible: boolean}`; hidden is still mounted.                                |
| `detached`    | `{}`; stop work and assume no further access.                                 |
| `model`       | `{runId, status, text?, error?, saveTo?}` when a run settles (section 4b).    |
| `voice`       | `{sessionId, seq, kind, ...}` during a voice session (section 4c).            |
| `connections` | `{connections}` when a connection's status or sync time changes (section 4e). |

Use [the declaration file](examples/mods/pugport-mod.d.ts) for editor types. Host translation does not enter the frame DOM; use `host.info().locale`. Render messages and values as text, never as `innerHTML`.

### Optional host theme data

`host.info()` and the `theme` event provide `{theme, tokens}`. These are optional data the Mod may use or ignore. No host colors, fonts or styling are required.

| Token                          | Host meaning                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `--bg`                         | The page background                                                                                    |
| `--surface-1`, `--surface-2`   | Raised areas, inputs, a selected row (`--surface-2` is one step darker in light mode, lighter in dark) |
| `--sidebar`                    | A quiet side pane                                                                                      |
| `--hover`                      | Hover background of rows and quiet buttons                                                             |
| `--text`, `--muted`, `--faint` | Body text; secondary text; placeholders and hints                                                      |
| `--border`, `--border-strong`  | Hairlines between areas; input outlines                                                                |
| `--accent`, `--on-accent`      | Accent background and foreground                                                                       |
| `--accent-text`                | Links and selected text in the accent color                                                            |
| `--focus`                      | Focus rings                                                                                            |
| `--danger`                     | Errors and destructive actions                                                                         |
| `--radius-md`, `--radius-lg`   | 8px controls; 12px larger surfaces                                                                     |
| `--font`                       | PugPort's font stack                                                                                   |

PugPort's own font files are not available inside your frame, so `--font` falls back to the system UI font there. Fonts must be bundled as `data:` URLs; images may use `data:` or `blob:` URLs (section 9).

### 4a. Permissions the user approves

| Permission         | What the user approves                                                                                                                                                                          |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model:run`        | The Mod runs models with the user's Connections and saves results to its own state. Usage counts as usual.                                                                                      |
| `voice:session`    | The Mod talks with the user by voice while it is open, through GPT Live on the user's OpenAI API card or on this computer. The host shows when the microphone is on and which provider is live. |
| `connections:read` | The Mod reads the bank accounts, balances, transactions and credit-card statements the user shares with it. It never sees bank passwords, Plaid keys or access tokens.                          |

`data:store` and `files:import` need no approval: storage is the Mod's own, and a file is read only after the user picks it.

**Load** shows these in plain language and asks once. Loading a newer version asks only for permissions the loaded version did not already have; approving it moves every chat to the new version together (section 5). Declining keeps the current version. A permission that is declared but not approved returns `E_PERMISSION`.

### 4b. Model runs

`model.run` starts an ordinary task through PugPort's routing: the same executor checklist as the chat, the same billed-card rules and the same usage records. Each run has **no tools**: no files, shell, web, MCP or project folder. The model answers from your prompt only, which the host marks as coming from your Mod. Runs from one chat share a hidden helper chat, so a follow-up sees earlier runs from this Mod in this chat; pass `fresh: true` to start over. In an incognito chat each run uses a new incognito helper that is removed once the answer is saved.

- `prompt`: 1–20,000 characters. Include everything the model needs; it cannot read the chat unless you pass text from `messages.list`.
- `saveTo`: a declared state key. The host writes the answer there when the run finishes, even if your panel is closed, and only that key changes. If the chat has moved to a newer version of your Mod, the answer goes to the new instance when the key still exists. Your frame then receives the usual `state` event.
- `format: "json"`: the host asks for one JSON value, removes Markdown fences and checks that the text parses. Otherwise the run fails with `E_FORMAT` and nothing is saved.
- At most 2 unfinished runs per chat and 60 runs per chat per hour; more return `E_LIMIT`. Answers over 100,000 characters, or answers that do not fit your state limits, fail with `E_LIMIT`.

The `model` event carries `status` `completed`, `failed` or `cancelled`, the answer `text` when available, and `error` `E_FAILED`, `E_FORMAT`, `E_LIMIT` or `E_CANCELLED`. A panel that was closed may miss the event; use `saveTo` for anything you must keep. A reloaded panel does not receive events for runs that had already settled. Routing chooses the model, so a run can take from a few seconds to a minute.

```js
const { runId } = await pugport.model.run({
  prompt: `Correct this sentence and explain briefly as JSON {"fix","why"}:
${sentence}`,
  saveTo: 'feedback',
  format: 'json',
});
pugport.on('model', (event) => {
  if (event.runId === runId && event.status !== 'completed') showRetry(event.error);
});
```

### 4c. Voice sessions

**One call starts a live voice conversation.** PugPort does everything else: the microphone, playback, the user cutting in, the provider connection and its key, choosing and switching OpenAI cards, billing and limits. Your Mod writes no audio, WebSocket or provider code, and its frame keeps its `microphone 'none'` policy.

```js
const live = await pugport.voice.start({
  provider: 'gpt-live', // require GPT Live; omit to allow the local fallback
  instructions: 'You are a friendly English speaking coach. Correct one important mistake at a time.',
  maxMinutes: 15,
});
live.on('transcript', (t) => t.final && addLine(t.role, t.text)); // learner and coach, turn by turn
live.on('state', (s) => showState(s.state, s.reason)); // listening, hearing, speaking; interrupted, switched
live.on('usage', (u) => showCost(u.seconds, u.costUsd));
live.on('ended', (s) => showEnded(s.reason));
stopButton.onclick = () => live.stop(); // also: live.say(text), live.instruct(text), live.interrupt()
```

`voice.start` resolves to a handle with `sessionId`, `provider`, `say`, `instruct`, `interrupt`, `stop` and `on(kind, listener)`, where `kind` is `state`, `transcript`, `usage`, `error` or `ended`; `on` returns an unsubscribe function. The lower-level `voice.speak/instruct/interrupt/stop({sessionId, ...})` calls and the `voice` event remain available.

#### Providers

| Provider   | How it works                                                                                                                                                                                                                     | Cost                                                                        |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `gpt-live` | OpenAI GPT-Live-1, a full-duplex voice model. It listens while it speaks, so the user can cut in at any moment; the host drops its queued audio at once. The model holds the conversation itself, guided by your `instructions`. | Billed per second of session time, silence included, to an OpenAI API card. |
| `local`    | Speech is recognised on this computer by the voice-input component (Extensions › Components) and `say` uses the system voices. Your Mod replies: send each final transcript to `model.run`, then `say` the answer.               | None.                                                                       |

- `provider: "gpt-live"` **requires** GPT Live. If it cannot start, `voice.start` rejects with `E_UNAVAILABLE` and nothing else is used. Call `voice.status()` first to show why: it returns `{provider, available, gptLive: {available, reason?}}`, where `reason` is `setting` (the user chose Local), `no-card` (no enabled OpenAI API card with a key and `gpt-live-1`), `budget` (every card has less than one minute, $0.05, left), `cooldown` (cards failed to connect in the last two minutes) or `busy` (another GPT Live session is running).
- Without `provider`, GPT Live is used when the user's setting and a card allow it, otherwise `local`. `provider: "local"` always stays on this computer. The user's setting (a voice Mod's details in Extensions › Mods) always wins.
- **Cards.** PugPort picks the enabled OpenAI API card with the most budget left, monthly renewing credit included; cards without a budget come last. Cards with the same key are one budget. When the current card runs low or its connection drops, the next eligible card starts a new GPT Live session seeded with the conversation so far (up to 128 messages and about 20,000 characters, within OpenAI's startup history limits), and you receive `state` with `reason: "switched"`. Speech in flight during the switch is lost; the conversation's words are not. A card that fails to connect rests for two minutes.
- **Limits.** `maxMinutes` (1–30, default 30) and `maxCostUsd` (at least $0.05) cover the whole session across card switches. Reaching one, or running out of cards, ends the session with reason `limit`. A session without `provider: "gpt-live"` continues on `local` after running out of cards, with `reason: "fallback"`. One GPT Live session runs at a time on this computer.
- `voice.start` works only while your surface is visible; one session runs per window. `instructions` (up to 16,000 characters) and `voice` (for example `marin`) configure GPT Live and cannot change after start. `language` (default `en-US`) and `endSilenceMs` (400–3,000, default 900) apply to local sessions.
- `say` asks GPT Live to say your text; it may paraphrase. `interrupt` stops playback at once. `instruct` adds guidance mid-session and may cut the model off: use it for a teacher's immediate correction. On a local session `instruct` returns `E_INVALID`.
- While the session runs, the host shows **Microphone on**, the provider (**GPT Live** or **Local**) and a **Stop** button above your surface. Hiding the Mod, switching chats, removing or updating the Mod, reloading the panel and closing the window all stop it. Five minutes without speech also stop it, and GPT Live ends when the window stops sending audio for 10 seconds.

#### Events

All carry `sessionId` and an increasing `seq`:

| `kind`       | Fields                                                                                                                                                                                                                                       |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `state`      | `state`: `listening`, `hearing` (the user is speaking), `speaking` or `stopped`; `provider`; `reason` on stop (`mod`, `user`, `hidden`, `detached`, `idle`, `error`, `limit`), or `interrupted` (the user cut in), `switched` or `fallback`. |
| `transcript` | `turn`, `role` (`user` or `assistant`), `text`, `final`. Partial text grows within a turn; one final text per turn. Local sessions only report the user.                                                                                     |
| `error`      | `code`: `E_MIC` or `E_RECOGNITION`.                                                                                                                                                                                                          |
| `usage`      | `provider`, `seconds`, `costUsd` (0 on `local`): the session total, growing during GPT Live and once more after stop.                                                                                                                        |

Recordings are not kept by PugPort, and GPT Live sessions use OpenAI's default `store: false`.

### 4d. Mod-owned storage

`state` belongs to one chat and is small. `storage` belongs to the Mod ID on this computer: every chat with any version of the Mod sees the same data, and removing the Mod or deleting a chat keeps it. Use it for ledgers, imported transactions and history.

- Data lives in named `collection`s (`/^[a-z][a-z0-9_-]{0,39}$/`) of string values by `key` (1–200 characters, no control characters). Values are at most 64 KiB; store JSON text.
- `storage.put({collection, items})` upserts up to 500 items. Writing the same value again changes nothing, so retries and repeated imports are safe. A batch that would pass the 200 MiB quota writes nothing and fails with `E_LIMIT`.
- `storage.get({collection, keys})` and `storage.delete({collection, keys})` take up to 500 keys. `storage.list({collection, prefix?, cursor?, limit?})` returns up to 500 items in key order, with a `cursor` while more remain. Prefer sortable keys such as `2026-10-05:tx_abc`.
- `storage.usage()` returns item and byte counts per collection and the quota.

Backup, restore and deleting everything belong to the user: **Extensions › Mods › the installed Mod's details › Mod data**. This row appears only for a Mod declaring `data:store`. Each action applies only to that Mod. A backup is a JSON file for that Mod ID; restoring replaces the Mod's data completely. A Mod cannot delete its whole namespace.

### 4e. Bank connections (Plaid)

The host talks to Plaid. Plaid keys and access tokens stay in a private file on this computer and never reach the frame, the rest of the window or account sync. The user enters keys in the host's **Extensions › Mods › the installed Mod's details › Bank connections › Manage** dialog: Sandbox for test data, Production for real banks. This row appears only for a Mod declaring `connections:read`. If a Mod requests a connection before keys are saved, the host opens **Set up Plaid** with a dashboard link and three steps. Saving continues to the connection step; cancelling before saving discards the draft. The frame receives only `{status:'pending'}`, never keys or Plaid URLs.

- `connections.authorize({provider: 'plaid'})` opens the host's **Connect a bank** dialog, beginning with **Set up Plaid** when keys are missing. The user opens Plaid's own page in the browser and signs in to the bank there. The call returns `{status: 'pending'}` once the host dialog is requested; a `connections` event follows when the connection appears. A connection made from a Mod is shared with that Mod; **Bank connections › Manage** in its details can stop sharing it. One Plaid step runs at a time (`E_LIMIT` otherwise). `E_UNAVAILABLE` means the host or connection service is unavailable, not that keys need setup.
- `connections.reconnect({connectionId})` opens the same dialog in Plaid's update mode when `status` is `reauth_required`.
- `connections.list()` and `connections.status({connectionId})` return `id`, `environment`, `institution`, `status` (`connected`, `syncing`, `reauth_required`, `error`), `lastSyncedAt` (the last successful sync), `lastAttemptAt`, `nextSyncAt` and `error`. A failed sync never removes earlier data.
- `connections.accounts({connectionId})` returns accounts with Plaid's cached balances (`current`, `available`, `limit`, `asOf`). The host makes no billed real-time balance call.
- `connections.transactions({connectionId, cursor?, limit?, accountId?})` is a change feed. Each change has an increasing `seq`, `removed` and the transaction. Amounts use Plaid's sign: positive is money out, such as a card purchase. Keep the returned `cursor` and call again while `hasMore`; upsert into `storage` by transaction `id`. When a pending transaction posts, Plaid removes the pending one and adds a new one whose `pendingTransactionId` names it.
- `connections.liabilities({connectionId})` returns credit-card `lastStatementIssueDate`, `lastStatementBalance`, `minimumPaymentAmount`, `nextPaymentDueDate`, `lastPaymentAmount`, `lastPaymentDate`, `isOverdue` and `aprs` when Plaid reports them. **A field Plaid does not report is absent; the host never estimates it.** Plaid's Liabilities coverage in Canada is limited, so expect missing fields or an empty list for Canadian cards.
- `connections.sync({connectionId})` asks for a sync now.

The host syncs each connection about every 6 hours **while PugPort is open**. It retries failures with growing gaps (5 minutes, doubling, at most 6 hours) and adds an inbox notice when new transactions arrive or the bank needs the user to sign in again. Nothing syncs while PugPort is closed; the next start catches up.

### 4f. Statement import

- `files.pick({accept})` opens the host's file chooser for the listed types (`.csv`, `.txt`, `.ofx`, `.qfx`, `.qif`, `.json`, `.pdf`), at most 30 MB. It returns `{fileId, name, size, type}` or `{cancelled: true}`. Call it from a click handler. The frame never sees a path.
- `files.readText({fileId, offset?})` returns a text file in 256 KiB chunks, with `nextOffset` while more remains.
- `files.pdfText({fileId, fromPage?})` returns `{pageCount, pages: [{page, text}], nextPage?}` from the local document reader (Extensions › Components). Keep the page number with every value you extract so the user can check it. Scanned pages have no text; there is no OCR. Without the component the call fails with `E_UNAVAILABLE`.

Picked files stay in the window for this binding only and are forgotten when the panel reloads.

### Error codes

Promises reject with an Error containing `code` and a fixed public `message`. Branch on the code.

| Code            | Meaning and recovery                                                                                                                    |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `E_INVALID`     | Invalid method, fields, values, undeclared state key, length or pagination ID. Correct the input.                                       |
| `E_PERMISSION`  | Required permission is undeclared or not approved. Publish a new version declaring it if needed.                                        |
| `E_CONFLICT`    | Revision changed. Read current state and reconcile local edits before an explicit retry.                                                |
| `E_UNAVAILABLE` | Detached frame, changed binding, unsupported layout, host failure or timeout. Stop stale work; reload an attached panel if appropriate. |
| `E_LIMIT`       | Oversized message, too many pending requests or notification rate exceeded. Reduce payloads or wait before retrying.                    |

## 5. Saved state and updates

V2 state is a map of string values. Declare all permitted keys in `state.keys` (at most 32); undeclared keys and non-string values are rejected. The UTF-8 size of `JSON.stringify(values)`, including keys and punctuation, must be ≤512 KiB. There are no per-key budgets or Mod settings sheet. Form fields start from their `initialValue` or an empty string; a web-only instance starts with `{}`.

State belongs to a chat and package version. Saves carry the instance's `revision`; a successful save increments it, while a stale revision is rejected so a second window cannot silently overwrite newer state. Hiding does not remove saved state or discard the mounted form's unsaved input. Removal and unloading preserve saved instances. Incognito chat cleanup retains the host's existing privacy rules.

Reattaching the same version restores its instance. When attaching a different version of the same ID without an existing instance, the host copies values from the latest saved instance for keys the new manifest declares, over its initial values. Removed keys are omitted. If that merged state exceeds the new version's limits, only initial values are used. The new instance starts at revision 0; the old one remains intact.

**Updates move chats automatically.** Loading a newer version moves every open chat bound to an older version of the same ID, using the copy rule above. A chat with a turn in progress moves when the turn ends; a chat waiting to switch to another Mod or to remove it is left alone. A version that needs new permissions loads only after the user approves them once (section 4a). Loading an older version never moves chats back. Open panels reload on the new version, so save unsaved input before publishing an update.

## 6. Store image fields and icons

Optional `card` is used in the grid and `cover` in details. Without a card, the host shows the whole cover in the grid over a blurred copy of itself; nothing is cropped.

| Image   | Dimensions                                                 | Decoded byte limit      | Format and other requirements                                              |
| ------- | ---------------------------------------------------------- | ----------------------- | -------------------------------------------------------------------------- |
| `cover` | Positive dimensions; long edge <=1,600; pixels <=1,440,000 | v2: 120 KiB; v1: 48 KiB | Static PNG or WebP; required `alt` of 1-160 characters                     |
| `card`  | 4:3 within 1%; at least 480 x 360; long edge <=1,200       | 60 KiB                  | Static PNG or WebP; required `alt` of 1-160 characters                     |
| `logo`  | Exactly 64 x 64                                            | 8 KiB                   | Static PNG or WebP with alpha metadata; required `alt` of 1-160 characters |

"Decoded bytes" means the image file bytes after base64 decoding, not its uncompressed pixels. Each image is `{src: "data:image/webp;base64,...", alt: "..."}`; external URLs and SVG are rejected. Base64 image bytes also count toward the complete package limit.

The host renders a logo as an alpha mask and supplies its color. The validator checks headers and transparency metadata: PNG grayscale/RGBA alpha and palette PNG with transparency are accepted. WebP must declare alpha (VP8L or VP8X); plain lossy VP8 is not a logo. Image source length is capped at `ceil(maxBytes / 3) * 4 + 23`.

### Icons

Choose one of these 24 host icons: `puzzle`, `notebook-pen`, `book-open`, `code-xml`, `languages`, `list-checks`, `sparkles`, `calendar`, `check-square`, `clipboard-list`, `flask-conical`, `graduation-cap`, `image`, `kanban`, `layers`, `lightbulb`, `map`, `mic`, `music`, `pen-line`, `table`, `target`, `timer`, `wallet`.

The host uses the author's logo when provided, then the selected icon if the logo fails to load, then `puzzle`. These marks inherit the current muted/accent color and light/dark theme. The panel header uses `rightPanel.title` when set, otherwise the package title.

## 7. Validate and package

```sh
npm run mods:validate -- path/to/package.json
npm run mods:pack -- path/to/mod-directory [--dev] [--out path/to/package.json]
```

Use Node 24 or newer. The commands load the shared TypeScript schema through `tsx`. Validation prints the ID, version, schema, byte count and SHA-256; errors name their field paths. Warnings never fail validation.

The author directory contains `manifest.json` (without `ui`), optional `README.md`, and `ui/<entry>.html` plus optional matching `.css`/`.js` files. Artwork must already be embedded as data URLs in `manifest.json`; the packer does not read standalone image files. The packer inlines the entry files, uses README when `readme` is absent, and writes two-space JSON plus a trailing LF. Input files must be regular files, with the entry limits above; README files must fit 20,000 bytes. Unknown filenames inside `ui/` are errors. Output defaults to `dist/mods/<id>-<version>.json` relative to the current directory. All validation, including the formatted output's 1 MiB limit, happens before any output or source version write.

For each edit: **pack `--dev` → import → Load**. `--dev` increases the source manifest's patch version only after a valid package is ready. Loading moves chats on the older version to the new one, and matching saved keys carry over. A newer import removes older stored versions of the same ID only when they are neither loaded nor referenced by a saved instance or a current or queued chat binding. Removing a Mod keeps its saved instance and manifest, so Undo can restore the exact version even after a newer import.

For a remote catalog, put the output under `mods/` and copy the printed SHA-256 of the exact written bytes into its entry. Include only catalog metadata, `path`, and `sha256`; never inline UI, state, readme or contributions. `schemaVersion: 2` and `permissions` must match the package exactly. An example entry (replace the hash with the actual 64-character lowercase hex digest):

```json
{
  "schemaVersion": 2,
  "id": "example.reading-notes",
  "version": "3.0.0",
  "title": "Reading notes",
  "description": "Keep notes on what you read and talk them through with AI.",
  "author": "Example author",
  "category": "Learning",
  "icon": "notebook-pen",
  "permissions": ["chat:read", "composer:draft"],
  "path": "mods/example.reading-notes-3.0.0.json",
  "sha256": "REPLACE_WITH_THE_PACKER_SHA256"
}
```

The catalog envelope remains `{ "schemaVersion": 1, "mods": [...] }` (≤200 entries, ≤16 MiB). Old v1 entries may omit `schemaVersion` and permissions. V1 source downloads retain their 256 KiB transport ceiling and existing manifest validation limits; v2 downloads allow 1 MiB. Metadata must match the package; keep covers/cards/logos identical when included.

## 8. Acceptance checklist

- Pack and validate the exact output, then import, Load and Open it. Confirm Open reuses an attached chat or creates an ordinary one, and sidebar selection respects visibility.
- Check the full workspace, Chat toggle, Ctrl/Cmd+J (also inside the frame), Esc only inside the drawer, keyboard focus, drawer sending, `ui.chat`, `chat` events and `composer.insert`. Confirm the non-modal drawer sits beside the Mod when space allows and overlays without a scrim otherwise; its open state is remembered per chat for this window session.
- Exercise failed-load/reload, save-error and detached behavior. Verify retry does not discard input.
- Save and reattach. Open a second window, provoke `E_CONFLICT`, and reconcile without losing local edits. Check first-pane ownership, pop-out behavior, Hide, Remove and Undo.
- Validate optional image fields, dimensions, byte limits, formats and alt text lengths.
- Check declared permissions, unavailable methods, payload limits, plain-text messages, dirty-state cleanup and frame reload. Use synthetic data for verification.
- Run the targeted layout, bridge, manifest, store, Workspace and example tests. Record commands, counts, OS and unverified behavior. Security acceptance requires running `tests/mod-frame-renderer.test.ts` and `tests/electron-frame-guard.test.ts` and recording the OS and Electron version and receiver observations. Unrun checks are not passes.

## 9. Isolation and capability boundaries

Every Web surface is a `srcdoc` iframe with exactly `sandbox="allow-scripts"` and `referrerPolicy="no-referrer"`, giving it an opaque origin. The host generates a fresh nonce for the document and wraps the shim, author JavaScript and CSS. Author HTML scripts and handlers receive no execution permission. The wrapper disables DNS prefetch and removes resource hints from author markup before inserting it, including nested templates. The shim removes WebRTC constructors from the frame realm. Encoded author strings cannot escape the wrapper with closing tags; there is no manifest HTML blacklist.

The document policy is:

`default-src 'none'; script-src 'nonce-N'; style-src 'nonce-N'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'`

Use `ui/<entry>.js` and `ui/<entry>.css`; inline HTML handlers and styles are unsupported. Bundle dependencies rather than loading external scripts or fonts. Only data/blob images and data fonts are allowed. There is no Mod network permission.

Every load receives a new MessageChannel from the parent, accepted once. Reload, removal and replacement invalidate old capabilities. Requests remain bound to a chat, Mod ID, version and instance; the host rechecks after async work. Methods, arguments, results, events and sizes are validated. Errors use fixed public messages. A frame releases only its own dirty blocker. Failed panels offer Reload without restarting chat.

Electron guards reject Mod navigation except `about:srcdoc` and `about:blank`, webviews, external opening, downloads and device permissions. Trusted main-frame navigation and microphone capture remain available. Voice sessions capture in the trusted host window, never in the Mod frame, and send the frame text only. GPT Live connects from PugPort's backend, which holds the API key; the window exchanges audio with the backend only. Model runs execute in PugPort's task runner with no tools, so a Mod cannot reach files, the network or credentials through them. Window WebRTC policy is only a candidate mitigation; CSP and API exceptions alone do not prove isolation. **This work is not security-accepted until the receiver-based Electron and renderer checks have been run and the OS and Electron version recorded.** Uncovered platforms remain unverified.

## 10. Legacy layouts and migration

V1 packages need no rewrite. The host normalizes their `view` into `contributions.rightPanel.form`, omitting the legacy `layout`. Field IDs become `state.keys`; a compose action adds `composer:draft`. Metadata is preserved. This is a type conversion, so wider v1 title/description/label limits are not revalidated as v2. Stored instances still use v1 state limits (8,000 characters per value and 64,000 serialized characters).

To publish native v2, increment the version, set `schemaVersion: 2`, replace `view` with a web `contributions.mainView` entry, remove `layout`, declare the saved field IDs under `state.keys`, and add `composer:draft` if needed. Render the old form using HTML, CSS and JavaScript. Shorten metadata and labels to the v2 limits, then validate. Keep the ID and useful state key names stable to carry saved values across versions. [The v1 example](examples/mod-manifest.example.json) remains `example.reading-notes@1.0.0`; [the web template](examples/mods/reading-notes/manifest.json) is `3.0.0` and retains `notes`.

V2 `rightPanel` and `sidebarPanel` remain accepted as legacy companion layouts. Moving an existing web entry from `rightPanel` to `mainView` does not require a new schema version: publish a new package version, preserve the ID and state keys, and replace the contribution. `ui.chat` provides conversation access in a visible workspace.

## 11. Review and delivery

Package and validate locally first. Share the JSON and its exact SHA-256 with a reviewer for functional, interface and security checks. Include the commands run and anything not verified. Publishing a catalog is a separately authorized action; import and Load do not publish anything.

The [editor declaration](examples/mods/pugport-mod.d.ts) describes the complete public API. It is not a library; the host supplies `window.pugport`. The [Reading notes manifest](examples/mods/reading-notes/manifest.json), [entry](examples/mods/reading-notes/ui/main.js) and [stylesheet](examples/mods/reading-notes/ui/main.css) form a small working reference.

## 12. Agent quickstart prompt

```text
Build a PugPort workspace Mod using docs/MODS.md and the Reading notes example.
Use schemaVersion 2, my own stable namespaced ID, a new numeric major.minor.patch
version, and a web mainView. Style the Mod however you like.
Host theme tokens and theme events are optional data you may use or ignore.
Keep dirty edits when saves fail or state events arrive. Use ui.chat({open:true}) for discussion;
composer.insert prepares a draft, opens chat and focuses it, but never sends.
Use the chat event when showing drawer state, and host.info().layout when needed.

Declare state keys and only necessary permissions. chat:read reads this chat;
composer:draft prepares drafts. model:run and voice:session need user approval;
use host APIs for model, voice, storage, connections or picked files if needed.
No network, inline handlers, host DOM, Node, credentials or chat:send.

Provide manifest.json without ui, an end-user README.md, ui/<entry>.html/css/js,
and optional images in the manifest.
Follow section 6's exact image limits and the 1 MiB complete package limit.
Preserve existing versions and saved keys. Use --dev only for local iteration.

Run npm run mods:pack -- <dir> and npm run mods:validate -- <output>. Run targeted
checks appropriate to the change and the acceptance checklist; follow the
project's testing rules. Report output path, byte count, exact SHA-256,
verification results. Explain Load, Open, Hide, Remove and Undo.
Do not publish or contact real services without authorization.
```

## 13. Build a Mod in a chat

You can also build a Mod without leaving PugPort. Choose **Extensions › Mods › Create a Mod**, or switch a chat to **Mods author** with the mode chip, and describe the Mod. See [Work modes](WORK-MODES.md#mods-author) for the whole flow.

- The chat gets its own folder in PugPort's data folder, `mods-workspace/<id>`, with this guide's interface sections in `.pugport/MOD-SPEC.md`, the API declaration and the Reading notes example. The folder uses the author layout from section 3. **Folder: … · Change…** in the mode menu points the chat at an empty folder or an existing author layout instead.
- The executor's `mod_load` tool does section 7 for you: it packs the folder, validates it, installs it locally and opens it in the chat. Validation problems come back with their field paths. PugPort runs nothing from the folder, not even a `package.json` build script.
- A version that needs a new approval permission is saved but not installed until you choose **Allow and load** in the chat.
- The Mod bar's **Debug** menu shows the frame's errors and console lines, refused host requests, permissions and the last validation. They also reach the executor's next turn, bounded to 4 KiB and marked as observations, not instructions; `mod_debug` returns the full list.
- The Store marks the result **Local build**. **Export JSON** gives you the packed file for section 11's review; nothing is published.
