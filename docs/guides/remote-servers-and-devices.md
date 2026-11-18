# Remote servers and devices

PugPort can dispatch work to your other computers in two ways:

- **Devices (`@@`)** — Linux or macOS computers on your Tailscale network running `pugport node`.
- **Remote servers (`@@@`)** — rented Linux servers listed in `remote-servers.json`, connected on demand through an SSH tunnel from the **Usage** page or the `@@@` menu.

## Device nodes (`pugport node …`)

A device node is a headless PugPort service that runs in the background on a **Linux** or **macOS** machine (`x64` or `arm64`):

- On **Linux**, `pugport node install` writes a user systemd unit at `~/.config/systemd/user/pugport-node.service`.
- On **macOS**, `pugport node install` writes a LaunchAgent at `~/Library/LaunchAgents/com.pugport.node.plist`.
- Local CLI commands on that machine talk to `127.0.0.1:4319` (`PUGPORT_PORT`), while peer requests from your main desktop listen only on the machine's Tailscale interface (`100.x.x.x`) on port `4318` (`PUGPORT_PEER_PORT`).

### Option 1: One-command setup over SSH

From your main desktop computer (with PugPort running), enroll a Linux or macOS machine over SSH:

```sh
pugport node add user@host --name "Laptop"
```

The local PugPort installation must be a Git checkout. Add `--now` to force an update even if the node has running tasks, or `--dry-run` to print the SSH commands without running them.

### Option 2: Manual install and pairing on the device

On the Linux or macOS device itself:

```sh
npm ci
npm run build
./dist/bin/pugport node install
./dist/bin/pugport node pair
```

`pugport node pair` prints the device's Tailscale address (`100.x.x.x`) and a one-time pairing code valid for a few minutes. On your main desktop computer, open **Settings** → **Devices**, click **Add device**, and enter the Tailscale address and pairing code.

Other node commands on the device:

- `pugport node status [--json]` — shows the node name, peer address, running state, version and commit.
- `pugport node unpair <name>` or `pugport node unpair --all` — revokes the pairing with your desktop.
- `pugport node uninstall` — stops and removes the background service.

By default, paired devices can run both read-only and writable tasks (using `~/PugPort-Workspace` when no folder is specified). Set `PUGPORT_PEER_READ_ONLY=1` in the node's service environment if you want the device to refuse writable tasks. In **Settings** → **Devices**, you can also choose **Which PugPort runs Slack** so your Slack bot stays online on an always-on device node when your main desktop is asleep.

## Connecting a remote server from the Usage page

List your rented Linux servers in `<dataDir>/remote-servers.json`. Only `name` is required; add `ssh` (a Host alias from your `~/.ssh/config`) to enable live status checks and one-click connection:

```json
{
  "servers": [
    {
      "name": "gpu-box",
      "provider": "Example Cloud",
      "region": "us-east",
      "spec": "8 vCPU · 32 GB",
      "purpose": "Training & builds",
      "expiresOn": "2026-11-30",
      "credit": "$120 left",
      "ssh": "gpu-box",
      "services": ["docker.service"],
      "statusCommand": "echo heavy job: none"
    }
  ]
}
```

Servers appear under **Remote servers** on **Usage & connections** → **Usage**, sorted by soonest expiry (`expiresOn` within 14 days is highlighted). While the page is open, PugPort polls each server with an `ssh` alias at most once every **3 minutes** using batch-mode SSH key login to read CPU, memory, root disk usage, `services` and `statusCommand` without installing anything on the server.

### What the Connect flow installs

When run as root or with passwordless sudo, Connect also installs `build-essential` and `python3` with `apt-get` and enables user linger.

To connect a server as an agent node, click **Connect** on its card under **Usage & connections** → **Usage** → **Remote servers** (or pick the unconnected server from the `@@@` menu in chat, or run `pugport node add --tunnel <alias>`):

1. **Checks the server (`preflight`)** — verifies Linux (`x86_64` or `aarch64`), `git`, `curl`, `tar`, `sha256sum`/`shasum`, outbound HTTPS to `nodejs.org` and `registry.npmjs.org`, SSH local port forwarding (`-L`), `make`/`g++`/`python3` for native SQLite modules, and systemd user `linger`. If `statusCommand` reports a running heavy job (anything without `heavy job: none`), setup stops so it doesn't disturb your job. If build tools or user linger are missing and passwordless `sudo` isn't enabled, the dialog pauses and gives you the exact command to copy and run on the server:
   ```sh
   sudo apt install build-essential python3 && loginctl enable-linger $USER
   ```
2. **Transfers PugPort (`bundle`)** — packs the current committed `HEAD` into a `git bundle` and clones it into `~/pugport` on the server.
3. **Installs runtime and dependencies (`runtime`, `dependencies`)** — downloads the official Node.js `24.21.0` archive into `~/pugport/.runtime`, verifies its pinned SHA-256 checksum, runs `npm ci` (skipping Electron and local ONNX Runtime downloads), and builds `dist/`.
4. **Starts a loopback-only service and pairs over an SSH tunnel (`service`, `pairing`)** — installs `~/.config/systemd/user/pugport-node.service` with `PUGPORT_PEER_HOST=127.0.0.1` on port `4318`.

### Loopback-only listener and SSH tunnel

A connected remote server node **listens only on `127.0.0.1` on the server itself** — it never opens a port on a public network interface or Tailscale. When your desktop checks the server or sends it a task, PugPort opens an on-demand local SSH tunnel (`ssh -N -T -n -L 127.0.0.1:<localPort>:127.0.0.1:4318 <alias>`) and routes all peer requests through that tunnel. Because any local user account on that server can reach `127.0.0.1:4318`, only connect servers whose local OS users you trust.

### Account access: other computers without SSH setup

After connecting, a computer whose own SSH alias reaches the server adds one more line to the node user's `~/.ssh/authorized_keys` in the background, marked `pugport-access:<node id>`:

```text
restrict,port-forwarding,permitopen="127.0.0.1:4318",permitlisten="127.0.0.1:4318",command="false" ssh-ed25519 … pugport-access:…
```

The key can only forward to the node's port: shells, commands, PTYs and every other forward are refused. PugPort checks that the key alone reaches the node, then keeps it with the pairing; account sync carries it, as a secret beside the pairing token, to every computer signed in to the same account. Those computers open the tunnel with that key and the server's own host keys only (`ssh -F none -i <key> -o StrictHostKeyChecking=yes …`), ignoring their `~/.ssh` entirely, and read live status from the node instead of over a shell. Servers connected before this feature are upgraded the same way, once, by any computer that can reach them over SSH. A server reached through a jump host or proxy command is not upgraded.

What still needs a computer with its own SSH alias: `statusCommand` (it is a shell command), installing or updating the node, and **Disconnect**. On a computer with account access only, Disconnect says so and changes nothing.

### Signing in to CLIs on the server and Recheck (`Check again`)

Right after connecting, if no AI CLI is signed in on the server yet, the dialog shows **Connected, but no CLI is signed in on the server yet** along with a copyable `ssh <alias>` command:

1. Open a terminal on your computer, SSH into the server (`ssh <alias>`), and install or sign in to the CLIs you want that server to use (for example `claude`, `codex`, `grok` or `cursor-agent`).
2. Back in PugPort, click **Check again** in the Connect dialog. PugPort opens the SSH tunnel if needed, re-queries the node's `/peer/v1/info` and `/peer/v1/runtimes` endpoints, and lists the ready executors and models on that server.

### Disconnecting a server

Click **Disconnect** on the server card under **Usage & connections** → **Usage** → **Remote servers**:

- PugPort removes the local pairing, closes the SSH tunnel, removes the account access key line from `authorized_keys`, and stops and removes `pugport-node.service` on the server. The synced pairing and its access key are deleted from your account too.
- Check **Also delete PugPort from the server** (`~/pugport` and `~/.local/share/pugport`) before confirming if you want to remove the program and data directory too.
- If the SSH cleanup step fails after the local pairing is removed (for example while the server is offline), the card keeps a **Retry uninstall** button with your same deletion choice.

## Using `@@` and `@@@`, and transferring files

### Calling a device or server

- In chat, type `@@<device-name>` for a paired Tailscale device or `@@@<server-name>` for an SSH-connected remote server.
- When you send a message directly to a device or server, it runs the task on its own executors using its own usage limits.
- When a local coordinator agent delegates a subtask to a device or server (for example when you mention multiple participants in one message), the remote subtask is restricted to **read-only** (`write=false`) because the remote machine doesn't share your local project filesystem.

### Sending files to a device or server

You can send files to a paired device or connected server by attaching them to your chat message, passing `files` in MCP `dispatch_task`, or clicking **Send files…** in **Settings** → **Devices**:

- **Limits** — up to **16 files** per task, **2 GiB** per file, and **4 GiB** total. Protected system and application folders are refused.
- **Where they land** — the remote node checks that at least 2 GiB of disk space will remain free, saves the files under `~/PugPort/Received/from-<YourComputerName>/`, and appends their local paths to the task prompt under `Files sent to this computer:`.

### Files sent back to your desktop

When a task running on a device or remote server produces files you asked for, the remote agent outputs a marker line for each file:

```text
PUGPORT_SEND_FILE: /absolute/path/to/file
```

When the remote task finishes:

- Your desktop checks that the path is outside protected system/credential folders and within the 16-file / 2 GiB per-file / 4 GiB total limits (and that at least 2 GiB of free disk space remains on your desktop).
- PugPort downloads each file automatically into `Downloads/PugPort/<device-or-server-name>/` on your computer and appends `Received from <name>: <local-path>` to the assistant's reply. (Tasks marked as untrusted third-party content never transfer files back.)
