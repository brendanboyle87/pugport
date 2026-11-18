# Account sync core

Account sync copies chats, folders, projects, memories, settings, API cards and paired server nodes between the
your own computers through Supabase. Signing in is enough: there is no recovery code and no key handoff between
devices. Headless and web-only backends do not show a sign-in surface. Constructing `SyncStore` or `SyncEngine`
creates no tables, files, timers, or network traffic. The official defaults in `src/shared/account-sync.ts` point at
the PugPort project; set both variables to override them, or set them to empty strings to turn sync off.

**Sync is not end-to-end encrypted.** Records are plain JSON in `public.sync_records` under row-level security.
Supabase encrypts the disk, but Supabase and anyone holding the project's database-owner role can read synced
content and decrypt the Vault secrets below. See `supabase/README.md` and `supabase/migrations/0008_plain_sync.sql`.

## Desktop integration

`src/electron/account.ts` owns PKCE, the five loopback ports (38917–38921), refresh, and encrypted credential
storage. Only Electron holds the refresh token. On startup it refreshes in the background, so opening chats never
waits for authentication. Without both configured Supabase environment variables the feature stays inert and the UI
is hidden. If all five ports are unavailable, a packaged app registered as the default `pugport` handler can use the
state-checked `pugport://auth/callback` fallback. It enters main directly and never the renderer.

The existing inherited Node parent/child IPC channel carries `AccountMainMessage` and `AccountBackendMessage` from
`src/shared/account-ui.ts`. A session message contains only user ID, email, access token and expiry. There is no
renderer/preload secret API, and `/api/account/internal*` always returns 403, including for authenticated owner
callers. Ordinary local API authentication still guards public account actions.

`GET /api/account` returns an explicitly secret-free view. Public POST actions are sign-in, cancel, sign-out, merge
confirmation and cloud deletion. Merge and deletion must echo the view's nonsecret `sessionId`. A new sign-in replaces
this ID, while token refresh preserves it, so a confirmation left open in another window cannot affect a different
signed-in session.

## Session preparation and generation

`AccountService.prepareSession` calls `remote.account()` (RPC `ensure_sync_account`). It returns the account's
`generation` (a UUID) and whether a legacy encrypted copy still waits for its one-time upgrade.

- Same account as this computer's last sync: resumes automatically, including after its backup expires.
- New computer with nothing to upload: starts the first sync on its own, through the same `enable` path as a
  confirmed merge (the local backup is taken first), whatever the cloud holds. "Nothing to upload" means no eligible
  workspace record (`SyncStore.hasLocalRecords`: chats, messages, folders, projects, memories and server/API mirror
  rows) and no entry in the files the first cycle captures (`AccountSyncFiles.hasLocalEntries`: enrolled server
  nodes, `remote-servers.json` entries and API cards, counted without reading any API key). An unreadable file counts
  as data. Settings are left out: on a first pull without a base, the cloud's settings fields win. While it runs,
  Settings → Account shows the first-sync status; a failure sets `error` to the existing code and retries with
  backoff.
- New computer with local data, another account, or a cloud deletion (a new generation, or this computer just
  deleted the cloud): shows the merge summary (chats, folders, projects and memories on both sides). No union starts
  until explicit confirmation. Account changes additionally require `allowAccountChange: true`. Until it is
  confirmed, the main window shows a notice and a "Merge pending" status in the sidebar, both opening
  the merge section.
- After a successful enable, the workspace record `account-sync-cloud` stores `{ generation }` for this user.

Every push carries the generation, and the server checks it under the same account lock as cloud deletion.
"Delete cloud data" removes the account row, so the next `ensure_sync_account()` starts a new generation. A computer
that had synced sees a different generation, resets its baseline (`local.resetAfterCloudDeletion()`) and stops at the
merge confirmation even when nothing is local, so background computers never silently refill an emptied cloud. A
running engine that pushes with the old generation gets `CLOUD_DATA_RESET`, stops and runs session preparation again.
That is the only reset signal: an empty pull, a push conflict without a cloud row, or a malformed record never resets.
A conflict without a row drops the local base for that record and uploads the queued change as new on the next cycle;
a malformed record fails with `INVALID_RECORD` and retries with backoff.

## Secrets

Three fields are secrets: `api-provider` → `key` (the API key file), and `server-node` → `token` (the pairing bearer
token) and `access` (the account's tunnel-only SSH key for an enrolled server, with its host, port, user and pinned
host keys, as one JSON text; see `src/server/devices/managed-access.ts` and
[the ruling](decisions/2026-11-16-account-bound-server-access.md)). `secretFields`, `splitSecrets` and `joinSecrets`
in `src/server/account-sync-remote.ts` move them out of the body before upload and back in after accept, conflict and
pull, so `SyncEngine` always compares full payloads. The push RPC stores a record's present secret fields together in
one Supabase Vault secret; the pull RPC returns it only to the owner. The server rejects a body that still contains
one of the fields (`SECRET_IN_BODY`). `access` needs migration `0009`; older clients ignore it and never see it in a
body, so their sync keeps working. A push from an older client carries only `token` and so drops `access` from the
Vault secret; the next computer with its own SSH alias sets the key up again.

On each computer, API keys stay in the secrets folder files. Pairing tokens and access keys stay in `devices.json` in
the secrets folder; a tunnel writes the access key and its `known_hosts` to `server-access/<device id>/` there
(owner-only, Windows ACL as for other secrets) and removes them with the device. The SQLite mirror rows of `server-node` and
`api-provider` are sealed with a random per-computer key, `account-sync-seal.key` in the secrets folder
(`readLocalSealKey`), passed to the engine as `sealKey`. It never leaves the computer. Remote-server record IDs are
`HMAC(accountId, kind + name)`: the same on every computer of one account. A one-time local purge (marker
`account-sync-local`/`format` = `{ v: 2 }`) drops mirror rows written by the end-to-end encrypted build; the files
stay the source of truth and are captured again on the next cycle.

## One-time legacy upgrade

Accounts that synced before plain sync still have encrypted `records` and a `user_keys` row. Until the upgrade is
done, `ensure_sync_account()` reports `legacy_pending` with the old key's ID.

- A computer whose Electron vault still holds that key (handed over with `account-key`) shows `upgrading` and runs
  `migrateLegacyCloud` (`src/server/account-sync-legacy.ts`): it reads every legacy row, decrypts and validates it,
  and imports the seven core kinds into `sync_records` with their original owner, tombstone flag and device ID,
  without `observedSeq`. Conflicts with an equal body count as imported, so reruns are idempotent. The three
  extension kinds are recaptured from local files instead. It then calls `finish_legacy_migration`, imports any
  legacy write that raced the mark, and asks Electron to forget the old key (`account-persist-key` without `key`).
  A decrypt or validation failure shows `UPGRADE_FAILED` and retries with backoff; plain rows stay untouched.
- A computer without the key shows `waiting-upgrade` and checks again every 60 seconds; it starts syncing as soon as
  the other computer finished. If that computer is gone, "Delete cloud data" removes old and new cloud copies and
  starts over from this computer.
- After the mark, writes from old builds fail with `CLIENT_UPGRADE_REQUIRED` and their queues stay local. Old builds
  can no longer create a recovery key once the account has a `sync_accounts` row.

Plain sequence numbers share `account_sync_seq` with legacy rows, so a computer that synced in the legacy era keeps
its local baseline and cursor; its first plain pull downloads the whole plain table once and merges each record
against the old base.

## Devices, sign-out and deletion

Device metadata contains only Codex, Claude, Grok and Cursor provider names. It is refreshed every minute to update
the other-device list and missing-login checklist. No CLI credentials enter sync. Sign-out stops scheduling and clears
in-memory secrets; Electron removes the stored refresh token and uses local-scope logout.

After UI confirmation, cloud deletion drains active sync writes, calls `delete_my_cloud_data()` (plain records, their
Vault secrets, legacy records, devices, the legacy key and the account row) and keeps local chats. An interrupted
confirmed deletion keeps a per-user local intent and retries the idempotent RPC with backoff, including after that user
signs in again. Until success, uploads stay stopped and the baseline stays intact; an empty cloud response never
substitutes for deletion acknowledgement.

Pulled pages and push-conflict merges call `onApplied` after commit. The desktop adapter advances
`workspace_revision`, so the existing workspace revision cache rebuilds, then reloads the synced settings into the
controller and broadcasts state. The shared allowlist includes `appearanceTheme`, `appearanceAccent` and `locale`;
the renderer applies these preferences live through the existing theme and locale APIs.

## Library use

```ts
const config = readSyncConfig();
const remote = new PostgrestSyncRemote(config, user.id, () => currentAccessToken);
const local = new SyncStore(workspace.store, dataDirectory);
const engine = new SyncEngine({
  local,
  remote,
  deviceId: persistentDeviceId,
  config,
  sealKey: await readLocalSealKey(secretsDirectory()),
  onStatus: (status) => publishStatus(status),
});
const { generation } = await remote.account();
await engine.enable({ userId: user.id, generation });
await engine.upsertDevice({ name: deviceName, platform: process.platform, cli_providers: ['codex', 'claude'] });
```

Imports are from `src/server/account-sync.ts`, `account-sync-store.ts`, `account-sync-remote.ts`,
`account-sync-crypto.ts`, and `src/shared/account-sync.ts`. Use one engine and one initialized `WorkspaceStore` per
database. Stop and drain the engine before closing the database; draining also waits for an in-flight activation.
The access-token callback runs for every request. The transport checks its JWT subject against the bound user ID;
Supabase verifies the signature. It never refreshes tokens. On `AUTH_REQUIRED`, Electron supplies a fresh token.
Create a new transport/engine for another user. An account change returns `error: ACCOUNT_CHANGE_REQUIRES_CONSENT`
until the UI obtains explicit merge consent and passes `allowAccountChange: true`.

Human markers bind to author content and provenance, excluding mutable execution metadata; a marker arriving before
its message waits locally. Every pull page is validated before any part of it commits.

## Lifecycle and local data

`status` and `onStatus` expose `off`, `syncing`, `idle`, `offline`, or `error: <CODE>`. `enable()` contains failures.
It takes an asynchronous SQLite backup before the first account snapshot; `local.backupPath` exposes the retained
backup. Incognito conversations and their messages are removed from each backup. Backups expire 14 days after the
first successful sync following their creation. It then installs the lazy outbox migration and starts polling.
Database writes remain local. Triggers only queue eligible records while the account is enabled. On desktop backend
startup AccountService disables old sync triggers until a fresh session enables them. Opening another WorkspaceStore
does not change sync state. Reactivation compares only rows changed since the disabled mark and detects deleted rows
with a SQL anti-join.

The scheduler waits about three seconds after writes stop, batches at most 100 records, holds active assistant
replies, and polls every 60 seconds (five minutes when inactive). `setActive(true)` requests a foreground pull.
`syncNow()` serializes a manual flush and contains errors. Retry delays double from one second to five minutes.
Quota and oversized-record errors retain the row and allow incoming changes to continue. `stop()` cancels scheduling
and clears the engine's in-memory seal key; it keeps local data and the queue.

Only the shared settings allowlist syncs. Projects preserve local paths/trust/MCP choices on download. Git matching
reads the literal origin URL from local Git config, without executing Git, includes or helpers; missing origins keep
projects separate. Chat-scope projects and normalized folder names merge automatically. Purged conversations enter
the receiving device's recycle bin. Their messages and provenance remain recoverable; re-enabling sync does not upload
retained purge data again. Local title history is stored as `sync-title-history`. Conflict notices use the existing
`systemNotice` message structure and remain local.

## Verification boundary

Tests use synthetic SQLite databases, an in-memory remote (`MemorySyncRemote`, with a Vault stand-in, generations and
a simulated legacy copy) and injected fetch responses. No real accounts or network are required. SQL gets static
RLS/grant checks; actual PostgreSQL migration, RLS, Vault and concurrency behavior still needs a disposable Supabase
branch before `0008` is applied. Records above the 512 KiB limit stay queued with `RECORD_TOO_LARGE`. Attachment bytes
and Storage remain deferred. Actual Google/Supabase login, OS keyrings, multi-device deployment and light/dark desktop
appearance still require acceptance on the intended systems.
