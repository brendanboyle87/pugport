# Account sync (beta)

Apply the files in `migrations/` in order as the database owner in a Supabase project.
Configure `PUGPORT_SUPABASE_URL` and `PUGPORT_SUPABASE_PUBLISHABLE_KEY` (`sb_publishable_...`).
Official builds point at the PugPort project; self-hosters override both variables (empty strings turn sync off). Sync requires a signed-in user and nothing else: there is no recovery code.
Clients use the publishable key plus a user access token; never configure a privileged server key in PugPort.

**Sync is not end-to-end encrypted.** Since `0008_plain_sync.sql`, synced records are plain JSON in
`public.sync_records`. Supabase encrypts the disk, but Supabase and anyone holding this project's database-owner role
can read chats, memories and settings, and can decrypt the Vault secrets described below.

All sync tables use RLS. Clients can select, insert and update their own rows, but cannot delete rows directly.
`push_sync_records` checks the last seen sequence and returns an outcome for each record; `pull_sync_records` pages
by sequence. The quota is set once in `account_sync_quota_bytes()` (50 MiB); the write trigger enforces it even for
direct REST writes. JSON bodies have a 512 KiB limit. Larger records stay queued with `RECORD_TOO_LARGE`; Storage is
deferred.

Secret fields never sit in a record body: the API key of an API card (`api-provider` → `key`), and the pairing token
and account access key of a server node (`server-node` → `token`, `access`; `access` needs
`0009_server_access_secret.sql`). The client sends them separately; the push RPC stores one Supabase Vault secret per
record holding its present fields, mapped in `account_private.record_secrets` (no client grants; never add
`account_private` to the API's exposed schemas). The pull RPC returns them only to the record owner. A body that still
contains `key`/`token`/`access` is rejected with `SECRET_IN_BODY`; any other secret field is rejected with
`INVALID_SECRET`. Each user may hold 500 Vault secrets; the next new one is
rejected with `SECRET_LIMIT`. Deleting a record, the cloud data or the user removes the Vault row. If Vault refuses
that delete, the RPC still succeeds: the secret is overwritten with `{}` and listed in `account_private.orphan_secrets`
for the database owner to delete (the next cloud deletion or capped write retries it). The migration uses only Vault's
public API and does not widen Vault grants.

Before applying `0008` anywhere real, apply `0001`–`0008` on a Supabase test branch and run
`tests/0008_plain_sync_smoke.sql` there in the SQL editor as the migration role. It uses two synthetic users, checks
cross-user isolation, anon and client privileges, Vault create/update/read/delete, the secret cap and
`delete_my_cloud_data()`, prints `PLAIN SYNC SMOKE TEST PASSED`, and rolls everything back. Never run it on production.

`public.sync_accounts` holds one `generation` (uuid) per account. Every push carries it. `delete_my_cloud_data()`
deletes the caller's plain and legacy records, Vault secrets, device rows and account row, so the next sign-in starts
a new generation and stale computers get `CLOUD_DATA_RESET` instead of refilling the emptied cloud. The UI must
confirm this action.

`0009_server_access_secret.sql` changes only `write_secret` and `sync_record_stamp`. Apply it before releasing a build
that sends `access` (until then those pushes fail with `INVALID_SECRET`), and check it on a test branch with
`tests/0009_server_access_secret_smoke.sql` (prints `SERVER ACCESS SMOKE TEST PASSED`, rolls back).

Legacy end-to-end encrypted tables (`records`, `user_keys`, `push_records`) stay until a later cleanup migration. A computer that still
holds the old key imports them once and calls `finish_legacy_migration()`; after that, writes from old builds fail
with `CLIENT_UPGRADE_REQUIRED`, and old builds can no longer create a recovery key. Apply that cleanup only after every
computer runs the new build.

## Desktop Google sign-in

In Google Cloud, configure the OAuth consent screen for your product, then create an OAuth client with
application type **Web application**. Set its Authorized redirect URI to exactly
`https://<PROJECT_REF>.supabase.co/auth/v1/callback`, replacing `<PROJECT_REF>` with your project reference.
If Supabase Auth uses a custom domain, use that domain instead (for example
`https://auth.pugport.com/auth/v1/callback`). For local Supabase development use
`http://127.0.0.1:54321/auth/v1/callback`. The loopback desktop addresses below are Supabase redirect entries,
not the Google OAuth client's callback URI. Add your synthetic testers while the consent screen is in testing.

In Supabase Authentication → Sign In / Providers → Google, enable Google and enter that OAuth client's
client ID and client secret. Keep the client secret in Supabase; never put it in PugPort.
In Authentication → URL Configuration → Redirect URLs, add these entries for the five fixed loopback ports:

```text
http://127.0.0.1:38917/auth/callback
http://127.0.0.1:38918/auth/callback
http://127.0.0.1:38919/auth/callback
http://127.0.0.1:38920/auth/callback
http://127.0.0.1:38921/auth/callback
http://127.0.0.1:38917/auth/callback?state=*
http://127.0.0.1:38918/auth/callback?state=*
http://127.0.0.1:38919/auth/callback?state=*
http://127.0.0.1:38920/auth/callback?state=*
http://127.0.0.1:38921/auth/callback?state=*
```

The app chooses the first available port and carries an unpredictable `state` query parameter in its redirect.
The query variants support self-hosted Auth versions that match the complete redirect against the allowlist;
only the random state value is wildcarded, while the IP, port and path stay fixed. Current
[Supabase Auth redirect validation](https://github.com/supabase/auth/blob/master/internal/utilities/request.go)
also recognizes loopback IPs. Verify the callback on your deployed Auth version during deployment testing.

Packaged builds also support the accepted custom-protocol fallback when all five loopback ports are unavailable
and the operating system confirms that PugPort is the default `pugport` protocol handler. Add these two Supabase
Redirect URL entries for that fallback (they are not Google OAuth client callback URIs):

```text
pugport://auth/callback
pugport://auth/callback?state=*
```

The fallback uses the same one-time PKCE verifier, state validation and five-minute timeout. It returns directly
to the app, so the browser may show an operating-system confirmation instead of the loopback success page.
Development builds and systems without registered protocol support remain loopback-only and report unavailable
callback ports when all five fail. Existing protocol packaging declares the scheme on macOS; Windows registration
and Linux desktop-handler availability must be verified on the installed package. A callback after cancellation,
timeout or application restart cannot resume sign-in.

Configure these two environment variables before starting the desktop app:

```text
PUGPORT_SUPABASE_URL=https://<PROJECT_REF>.supabase.co
PUGPORT_SUPABASE_PUBLISHABLE_KEY=sb_publishable_<YOUR_PUBLISHABLE_KEY>
```

Use your custom Auth project's base URL where applicable. Leaving either variable unconfigured (with the current
empty build defaults) hides Account UI and does not create account files. Main owns PKCE, refresh and encrypted
storage; it sends access tokens (and, until the one-time upgrade, the legacy key) over the existing parent/child IPC channel. Refresh tokens never
enter the backend, preload or renderer. Without OS encryption, credentials stay in memory for this launch only.

Back up the database yourself.
This migration has static local checks; run it and test RLS with two synthetic users before deploying a real project.
