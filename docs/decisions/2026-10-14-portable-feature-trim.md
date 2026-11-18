# Trim features ahead of the macOS port

Date: 2026-10-14
Issue: none; the owner asked for this directly in a local task, without GitHub.
Owner ruling: the task brief plus the corrections from an independent review.
Decision: remove Everything whole-disk search, the Codex desktop "dot" handoff and EmbeddingGemma; hide the Google Workspace / Microsoft 365 connectors and the skill-builder recommendation.
Reason: drop Windows-only and unfinished entries so the macOS port starts from a smaller app.
Scope: local worktree. Slack, AgentConnect, devices, Muse, Grok Bot and Codex cloud are out of scope.
Replaces: none.

- The test-isolation guard is already on the base (`d48b118`): `src/server/platform/under-test.*`, tested by `tests/under-test.test.ts`. Tests use temporary folders and synthetic data and are blocked from real accounts, external network calls and real CLIs. Under test, device peers default to loopback and an ephemeral port, and non-loopback peer hosts are refused.
- The default media workflow `builtin-gemma-fast` (Fast candidate search and local verification) stays and now uses the `legacy` fingerprint engine, keeping the video-sample checks its candidates need. The model-ranking and dense image-text index workflows are removed. Old Gemma workflows still load, run the fingerprint workflow and log a one-line note; old reports render as before.
- Semantic history recall uses only bge-m3. The existing incremental index on start fills gaps; there is no separate rebuild. Users who had only Gemma and no bge-m3 fall back to keyword recall. The search box always searches by keyword.
- File-name search without a folder searches only the project folder and says so in the result. A bare file name in a reply gets a bounded search (1.5 s), so "the search range is too large, give a fuller path" appears more often.
- Connectors are switched off in one place, `connectorsEnabled = false` in `src/shared/connectors.ts`: no service is created, no routes are registered (404), executors get no connector tools, and old tool calls are refused. The connector back end and its data on disk are kept.
- Old dot / unknown external-agent settings are ignored. Old messages keep their text with a neutral label and no retry or handoff actions; the server returns a clear error for actions on them.
- MarkItDown now requires both Python and `.pugport-ready`. Installs from 0.0.30 have no marker and need one reinstall of **Read local office documents**.

## Downloaded components and the Windows service

This change does not delete existing runtimes, indexes or a separately installed Everything, and shows no cleanup prompt. A downloaded Gemma runtime folder (e.g. `.runtime/embeddinggemma`) is no longer used and can be removed by hand.

Old Gemma history vectors (folders named `gemma-*` under `memory-vectors`, on Windows `%LOCALAPPDATA%\ComboRunner\memory-vectors\gemma-*`) and any Gemma vector tables in the media-library SQLite database are no longer read or pruned and can be deleted by hand.

Older versions installed the system service **Everything (ComboRunner)** when whole-disk search was turned on; it still starts with Windows. To uninstall it, open an administrator PowerShell in the app folder that contains the old `.runtime/everything` and run:

```powershell
& '.\.runtime\everything\everything.exe' -instance ComboRunner -exit
& '.\.runtime\everything\everything.exe' -instance ComboRunner -uninstall-service
```

In a packaged build, use the full path of the old `resources/everything/everything.exe` instead. The commands target only PugPort's `ComboRunner` instance and leave a user's own Everything alone. This change does not run them and does not delete `.runtime/everything`.

If `everything.exe` is gone (a packaged upgrade replaces `resources/`), run these commands in an administrator window instead:

```powershell
sc.exe stop "Everything (ComboRunner)"
sc.exe delete "Everything (ComboRunner)"
```

The removed setup bundled Everything; local-tools started it with `-instance ComboRunner` and queried the exact service name `Everything (ComboRunner)`. No automatic cleanup runs in PugPort.
