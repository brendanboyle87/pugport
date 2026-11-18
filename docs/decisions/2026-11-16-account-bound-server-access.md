# Account-bound server access

Date: 2026-11-16
Owner ruling: given directly to the agent session that planned this work; no issue or public comment was created.

Decision: wherever PugPort is installed, signing in to the owner's account must be enough to use the connected
servers, with no per-computer SSH setup. Each enrolled server gets a PugPort-made SSH key of its own that can only
forward to the node's port. The key syncs with the server-node record as an account secret (Supabase Vault, next to
the pairing token). This applies to Windows and macOS alike.

Reason: a freshly signed-in computer already had the server-node record and its pairing token, but not the SSH alias,
user and key, which live only in each computer's own `~/.ssh`. It showed "This computer has no SSH configuration" and could not reach
any server. The owner accepted the added risk as equivalent to the pairing token that already syncs, because the key
cannot open a shell.

Scope:

- The key's `authorized_keys` line is
  `restrict,port-forwarding,permitopen="127.0.0.1:<node port>",permitlisten="127.0.0.1:<node port>",command="false"`.
  A local test against OpenSSH 10.5 showed that without the forced command the key could still run commands, and
  that `permitlisten` is needed to stop `-R` listeners; `permitopen` also refuses Unix-socket forwards. Every other
  forward, PTY, shell, command and subsystem request is refused.
- The key is set up once, by any computer whose own SSH alias reaches the server, after enrollment or as a one-time
  upgrade of an already-paired server. The host keys come from that trusted SSH session; the tunnel accepts only
  them (`StrictHostKeyChecking=yes`, no user SSH config). Servers reached through a jump host or proxy command are
  not upgraded.
- Installing, updating or uninstalling the node and disconnecting still need a computer with full SSH. On a computer
  with only account access, PugPort says so and changes nothing. Disconnecting removes the server's PugPort key lines
  and the synced secret.
- The remote server card reads CPU, memory, disk and services from the node (`GET /peer/v1/status`, behind the
  pairing token). A `statusCommand` is a shell command, so it still runs only over the owner's own SSH.
- The key and its connection details are one secret text (`access`). They are not in the record body, because older
  clients reject a server-node body with unknown fields, which would stop their whole account sync. Migration `0009`
  must be applied before a client that sends `access` is released.

Replaces: none. Extends [2026-10-20 device-node trust](2026-10-20-device-node-trust.md) to how computers reach a node;
it does not change what a paired computer may do there.
