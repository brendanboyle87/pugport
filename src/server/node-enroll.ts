import type { NodeCommand } from '../cli/args.ts';
import type { NodeDeps } from '../cli/node.ts';
import type { RunOptions } from './platform/host.ts';
import { deviceNameProblem, type DevicesView } from '../shared/devices.ts';
import { parsePeerAddress, formatPeerAddress, resolvePeer, type Lookup } from './devices/peer-client.ts';
import { isTailscaleAddress } from './node/peer-listener.ts';
import { normalizeAgentName } from './agent-names.ts';
import { checkSshForward } from './devices/ssh-tunnel.ts';
import type { RemoteServersView } from '../shared/remote-servers.ts';

export const manualCommand = 'sudo apt install build-essential python3 && loginctl enable-linger $USER';
export const nodeVersion = '24.21.0';
// https://nodejs.org/dist/v24.21.0/SHASUMS256.txt (retrieved 2026-10-20).
export const nodeHashes = {
  'darwin-arm64': 'bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057',
  'darwin-x64': '1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097',
  'linux-x64': '6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff',
  'linux-arm64': '724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5',
};

export const preflightScript = `set -eu
fail() { echo "$*" >&2; exit 1; }
platform=$(uname -sm)
case "$platform" in
  'Darwin arm64'|'Darwin x86_64')
    xcode-select -p >/dev/null 2>&1 || fail 'Install Command Line Tools first: xcode-select --install'
    launchctl print "gui/$(id -u)" >/dev/null 2>&1 || fail 'Log in to the Mac desktop first (auto-login).'
    ;;
  'Linux x86_64'|'Linux aarch64') ;;
  *) fail "Unsupported platform: $platform" ;;
esac
command -v git >/dev/null 2>&1 || fail 'Missing tool: git'
command -v curl >/dev/null 2>&1 || fail 'Missing tool: curl'
command -v tar >/dev/null 2>&1 || fail 'Missing tool: tar'
if command -v sha256sum >/dev/null 2>&1; then :
elif command -v shasum >/dev/null 2>&1; then :
else fail 'Missing SHA-256 tool: sha256sum or shasum -a 256'; fi
case "$platform" in Linux*)
  command -v make >/dev/null 2>&1 || fail 'Missing tool: make; sudo apt install build-essential python3'
  command -v g++ >/dev/null 2>&1 || fail 'Missing tool: g++; sudo apt install build-essential python3'
  command -v python3 >/dev/null 2>&1 || fail 'Missing tool: python3; sudo apt install build-essential python3'
  [ "$(loginctl show-user "$USER" -p Linger --value)" = yes ] || fail 'Run once: loginctl enable-linger "$USER"'
  ;;
esac
`;

export const tunnelPreflightScript = `set -eu
fail() { echo "$*" >&2; exit 1; }
[ "$(uname -s)" = Linux ] || fail 'Linux required'
command -v git >/dev/null 2>&1 || fail 'Missing tool: git'
command -v curl >/dev/null 2>&1 || fail 'Missing tool: curl'
command -v tar >/dev/null 2>&1 || fail 'Missing tool: tar'
command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 || fail 'Missing SHA-256 tool: sha256sum or shasum -a 256'
missing=no
for tool in make g++ python3; do command -v "$tool" >/dev/null 2>&1 || missing=yes; done
linger=$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || :)
can_install=no
if [ "$(id -u)" = 0 ] || sudo -n true >/dev/null 2>&1; then can_install=yes; fi
network=no
if curl -sfI --max-time 5 https://nodejs.org/dist/ >/dev/null && curl -sfI --max-time 5 https://registry.npmjs.org/ >/dev/null; then network=yes; fi
manager=no
if systemctl --user show-environment >/dev/null 2>&1; then manager=yes; fi
printf '{"missing":"%s","linger":"%s","can_install":"%s","network":"%s","manager":"%s","sshd_port":"%s"}\n' "$missing" "$linger" "$can_install" "$network" "$manager" "\${SSH_CONNECTION##* }"
`;
export function heavyJobRunning(line: string): boolean {
  return !/^heavy\s+job\s*:\s*none\s*$/i.test(line.trim());
}

export const remoteStatus = '~/pugport/bin/pugport node status --json';
export const incomingBundle = 'mkdir -p ~/pugport/.git && cat > ~/pugport/.git/pugport-incoming.bundle';
const clearBundle = 'rm -f ~/pugport/.git/pugport-incoming.bundle';
export const serviceExists = `if [ -f "$HOME/Library/LaunchAgents/com.pugport.node.plist" ] || [ -f "\${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/pugport-node.service" ]; then echo installed; fi`;

/** Only pinned release metadata goes into this script, never SSH targets, names or pairing codes. */
export function nodeSetupScript(version = nodeVersion, hashes: Record<keyof typeof nodeHashes, string> = nodeHashes) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || Object.values(hashes).some((hash) => !/^[0-9a-f]{64}$/.test(hash)))
    throw new Error('Invalid pinned Node release metadata');
  return `set -eu
fail() { echo "$*" >&2; exit 1; }
cd "$HOME/pugport"
git init -q
if [ -f .git/pugport-incoming.bundle ]; then
  git fetch -q .git/pugport-incoming.bundle +HEAD:refs/pugport/incoming
  [ -z "$(git status --porcelain --untracked-files=no)" ] || fail 'Tracked files modified; save changes before updating.'
  git checkout -q --detach refs/pugport/incoming || fail 'Checkout failed; move the existing ~/pugport away first.'
  rm -f .git/pugport-incoming.bundle
  git repack -adq
fi
platform=$(uname -sm)
case "$platform" in
  'Darwin arm64') os=darwin; arch=arm64; sha=${hashes['darwin-arm64']} ;;
  'Darwin x86_64') os=darwin; arch=x64; sha=${hashes['darwin-x64']} ;;
  'Linux x86_64') os=linux; arch=x64; sha=${hashes['linux-x64']} ;;
  'Linux aarch64') os=linux; arch=arm64; sha=${hashes['linux-arm64']} ;;
  *) fail "Unsupported platform: $platform" ;;
esac
if [ "$os" = darwin ]; then
  domain="gui/$(id -u)"
  agent="$domain/com.pugport.node"
  # Detached executor CLIs rely on the backend's graceful shutdown, not launchd containment.
  loaded() {
    if launchctl print "$agent" > .git/pugport-launchctl.txt 2>&1; then return 0; fi
    if grep -Eiq 'could not find (service|domain)|service not found' .git/pugport-launchctl.txt; then return 1; fi
    cat .git/pugport-launchctl.txt >&2
    fail 'Cannot inspect LaunchAgent; log in to the Mac desktop (auto-login). A broken plist can cause the same error.'
  }
  if loaded; then
    launchctl bootout "$agent" || :
    count=0
    while loaded; do
      [ "$count" -lt 70 ] || fail 'LaunchAgent did not stop within 70 seconds.'
      sleep 1
      count=$((count + 1))
    done
  fi
else
  # An installed unit may be activating/auto-restarting even when is-active returns false.
  load_state=$(systemctl --user show pugport-node.service --property=LoadState --value)
  if [ "$load_state" != not-found ]; then systemctl --user stop pugport-node.service; fi
fi
trap 'result=$?; if [ "$result" -ne 0 ]; then echo "Node service is stopped; fix the cause and rerun: pugport node add <target> --now" >&2; fi' EXIT
hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d ' ' -f 1
  else shasum -a 256 "$1" | cut -d ' ' -f 1; fi
}
runtime="$HOME/pugport/.runtime/node-v${version}-$os-$arch"
mkdir -p "$HOME/pugport/.runtime"
if [ "$(readlink "$HOME/pugport/.runtime/node" 2>/dev/null || :)" != "$runtime/bin/node" ] || [ ! -x "$runtime/bin/node" ]; then
  archive="$HOME/pugport/.runtime/node-v${version}-$os-$arch.tar.gz"
  curl --fail --location --retry 3 --output "$archive" "https://nodejs.org/dist/v${version}/node-v${version}-$os-$arch.tar.gz"
  [ "$(hash_file "$archive")" = "$sha" ] || fail 'Node archive SHA-256 mismatch; extraction refused.'
  tar -xzf "$archive" -C "$HOME/pugport/.runtime"
  [ -x "$runtime/bin/node" ] || fail 'Node runtime missing after extraction.'
  [ ! -d "$HOME/pugport/.runtime/node" ] || fail 'Move the existing .runtime/node directory away first; a node executable link is required.'
  ln -sfn "$runtime/bin/node" "$HOME/pugport/.runtime/node"
  rm -f "$archive"
fi
export PATH="$runtime/bin:$PATH"
key="$(hash_file package-lock.json):${version}"
if [ ! -d node_modules ] || [ "$(cat .runtime/lock.key 2>/dev/null || :)" != "$key" ]; then
  ELECTRON_SKIP_BINARY_DOWNLOAD=1 ONNXRUNTIME_NODE_INSTALL=skip npm ci
  printf '%s\\n' "$key" > .runtime/lock.key
fi
node scripts/build.mjs
unset PUGPORT_PEER_ALLOW_WRITE
"$HOME/pugport/bin/pugport" node install --from-node-add
trap - EXIT
`;
}

/** Shown when the node's backend never answers: the end of its log (launchd file on a Mac, journald on Linux). */
export const nodeLogTail = `log="$HOME/Library/Logs/PugPort/node.log"
if [ -f "$log" ]; then echo "Last lines of $log:"; tail -n 12 "$log"
else echo 'Last lines of journalctl --user -u pugport-node:'; journalctl --user -u pugport-node -n 12 --no-pager -o cat 2>&1 || :; fi
`;

type RemoteStatus = {
  name: string;
  peer: { status: string; host?: string; port: number; error?: string };
  running: number;
};
const shaPattern = /^[0-9a-f]{40,64}$/;
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type EnrollStage = 'preflight' | 'bundle' | 'runtime' | 'dependencies' | 'service' | 'pairing' | 'done';

export async function runNodeAdd(
  command: Extract<NodeCommand, { action: 'add' }>,
  deps: NodeDeps & {
    lookup?: Lookup;
    forwardCheck?: (alias: string, sshdPort: number) => Promise<boolean>;
    progress?: (stage: EnrollStage) => void;
  },
): Promise<number> {
  const { host, out, err } = deps;
  if (!command.target || command.target.startsWith('-') || /[\0\r\n]/.test(command.target)) {
    err('SSH target must not start with - or contain control characters.\n');
    return 2;
  }
  if (command.tunnel && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(command.target)) {
    err('Invalid SSH alias.\n');
    return 2;
  }
  const tunnelName = command.tunnel ? (command.name ?? command.target) : command.name;
  const nameProblem = tunnelName !== undefined ? deviceNameProblem(tunnelName) : undefined;
  if (nameProblem) {
    err(`${nameProblem}\n`);
    return 2;
  }
  const sshArgs = ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '--', command.target];
  const ssh = async (remote: string, options: RunOptions = {}) => {
    try {
      return await host.run('ssh', [...sshArgs, remote], { timeout: 90_000, maxBuffer: 32 * 1024 * 1024, ...options });
    } catch (error) {
      const failure = error as { code?: number; message?: string; stderr?: string };
      // Streamed stderr (also embedded in execFile's message) has already been shown.
      const message = options.onOutput
        ? 'Remote setup failed.'
        : remote.endsWith('pair --json')
          ? 'Cannot read node pairing response.'
          : failure.stderr?.trim() || failure.message || 'SSH step failed.';
      throw new Error(
        message +
          (failure.code === 255
            ? `\nSSH login needs a trusted host key and key login: run \`ssh ${command.target}\` once yourself first / set up key login.`
            : ''),
      );
    }
  };
  if (command.dryRun) {
    for (const remote of [
      '/bin/sh -s',
      remoteStatus,
      '/bin/sh -s',
      'git -C ~/pugport rev-parse HEAD',
      incomingBundle,
      clearBundle,
      '/bin/sh -s',
      remoteStatus,
      '~/pugport/bin/pugport node pair --json',
    ])
      out(`${['ssh', ...sshArgs, remote].map((word) => JSON.stringify(word)).join(' ')}\n`);
    out(
      `Preflight via stdin:\n${command.tunnel ? tunnelPreflightScript : preflightScript}\nService check via stdin:\n${serviceExists}\nSetup via stdin:\n${nodeSetupScript()}\nIf the node never answers, its log via stdin:\n${nodeLogTail}\n`,
    );
    out('Plan: send committed HEAD using git bundle create <temporary-file> HEAD, unless HEAD matches.\n');
    out(
      'The node install reads its owned service file and keeps port, features, data directory and existing allow-write; shell allow-write is ignored. Kept values require SSH and cannot be read in a dry run.\n',
    );
    return 0;
  }
  try {
    deps.progress?.('preflight');
    if (!(await deps.client.health())) throw new Error('Main PugPort must be running. Open it first.');
    const normalize = async (text: string) => {
      const parsed = parsePeerAddress(text);
      if (!parsed) return undefined;
      return resolvePeer(parsed, deps.lookup)
        .then(formatPeerAddress)
        .catch(() => undefined);
    };
    if (tunnelName !== undefined) {
      const devices = await deps.client.get<DevicesView>('/api/devices');
      const alreadyPaired = command.tunnel && devices.devices.some((device) => device.tunnel?.ssh === command.target);
      const named = alreadyPaired
        ? []
        : devices.devices.filter((device) => normalizeAgentName(device.name) === normalizeAgentName(tunnelName));
      if (named.length) {
        const target = command.tunnel
          ? undefined
          : await normalize(command.target.slice(command.target.lastIndexOf('@') + 1));
        for (const device of named) {
          if (command.tunnel && device.tunnel?.ssh === command.target) continue;
          if (!target || (await normalize(device.address)) !== target)
            throw new Error(`Device name "${tunnelName}" is already used by ${device.address}; choose another --name.`);
        }
      }
    }
    const git = (args: string[]) => host.run('git', ['-C', deps.root, ...args], { timeout: 120_000 });
    await git(['rev-parse', '--show-toplevel']).catch(() => {
      throw new Error('appRoot() must be a Git checkout.');
    });
    const commit = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    if (!shaPattern.test(commit)) throw new Error('Invalid local HEAD commit.');
    const dirty = (await git(['status', '--porcelain'])).stdout.trim();
    if (dirty) err('Warning: this checkout has uncommitted changes; sending committed HEAD only.\n');
    out(`Using local HEAD: ${commit}\nChecking node prerequisites…\n`);
    if (command.tunnel) {
      const result = JSON.parse((await ssh('/bin/sh -s', { input: tunnelPreflightScript })).stdout) as Record<
        string,
        string
      >;
      if (result.network !== 'yes') throw new Error('Server cannot reach nodejs.org or registry.npmjs.org.');
      const servers = await deps.client.get<RemoteServersView>('/api/remote-servers');
      const configured = servers.servers.find((server) => server.ssh === command.target);
      if (configured?.statusCommand) {
        const quoted = configured.statusCommand.replaceAll("'", "'\\''");
        const line = (
          await ssh('/bin/sh -s', { input: `timeout 5 sh -c '${quoted}' </dev/null | head -n1\n` })
        ).stdout.trim();
        if (heavyJobRunning(line))
          throw new Error(
            `Server is running a heavy job: ${line || '(status command printed nothing)'}. Wait for it to finish.`,
          );
      }
      if (!(await (deps.forwardCheck ?? checkSshForward)(command.target, Number(result.sshd_port))))
        throw new Error('SSH port forwarding is unavailable.');
      if (result.missing === 'yes' || result.linger !== 'yes') {
        if (result.can_install !== 'yes') throw new Error('Run on the server: ' + manualCommand);
        out('Installing missing prerequisites and enabling linger when needed.\n');
        const install = [
          'set -eu',
          'if [ "$(id -u)" = 0 ]; then elevate=""; else elevate="sudo -n"; fi',
          ...(result.missing === 'yes'
            ? [
                '$elevate apt-get update -q',
                '$elevate env DEBIAN_FRONTEND=noninteractive apt-get install -y build-essential python3',
              ]
            : []),
          ...(result.linger !== 'yes' ? ['$elevate loginctl enable-linger "$USER"'] : []),
        ].join('\n');
        await ssh('/bin/sh -s', { input: install });
      }
      if (result.manager !== 'yes') {
        const check = await ssh('systemctl --user show-environment >/dev/null && printf yes');
        if (check.stdout.trim() !== 'yes') throw new Error('The server user systemd manager is unavailable.');
      }
    } else await ssh('/bin/sh -s', { input: preflightScript });
    let before: RemoteStatus | undefined;
    try {
      before = JSON.parse((await ssh(remoteStatus)).stdout) as RemoteStatus;
    } catch {
      /* Old nodes do not support JSON. */
    }
    const knownCount = before && Number.isSafeInteger(before.running) && before.running >= 0;
    if (!command.now) {
      if (knownCount && before!.running > 0)
        throw new Error('Node has running tasks; wait or use --now (stops the service).');
      if (!knownCount && (await ssh('/bin/sh -s', { input: serviceExists })).stdout.trim())
        throw new Error('Installed node task count is unknown; use --now to update.');
    }
    deps.progress?.('bundle');
    let head: string;
    try {
      head = (await ssh('git -C ~/pugport rev-parse HEAD')).stdout.trim();
    } catch {
      head = '';
    }
    if (head && !shaPattern.test(head)) throw new Error('Invalid node HEAD: expected a hex commit SHA.');
    if (head !== commit) {
      out('Transferring committed HEAD…\n');
      const folder = host.fs.mkdtempSync(host.path.join(host.tmpdir, 'pugport-node-'));
      const bundle = host.path.join(folder, 'main.bundle');
      try {
        await git(['bundle', 'create', bundle, 'HEAD']);
        await ssh(incomingBundle, { stdinFile: bundle, timeout: 600_000 });
      } finally {
        host.fs.rmSync(folder, { recursive: true, force: true });
      }
    } else {
      // A previously interrupted transfer must not roll a matching node back to a stale bundle.
      await ssh(clearBundle);
      out('Node already has this commit; skipping transfer.\n');
    }
    out('Installing runtime, dependencies and service…\n');
    const setup = command.tunnel
      ? nodeSetupScript().replace(
          '"$HOME/pugport/bin/pugport" node install --from-node-add',
          'PUGPORT_PEER_HOST=127.0.0.1 "$HOME/pugport/bin/pugport" node install --from-node-add',
        )
      : nodeSetupScript();
    deps.progress?.('runtime');
    const stagedSetup = deps.progress
      ? setup
          .replace(
            'key="$(hash_file package-lock.json)',
            'echo PUGPORT_ENROLL_DEPENDENCIES\nkey="$(hash_file package-lock.json)',
          )
          .replace('unset PUGPORT_PEER_ALLOW_WRITE', 'echo PUGPORT_ENROLL_SERVICE\nunset PUGPORT_PEER_ALLOW_WRITE')
      : setup;
    let pending = '';
    const onOutput = deps.progress
      ? (chunk: string) => {
          pending += chunk;
          const lines = pending.split('\n');
          pending = lines.pop() ?? '';
          for (const line of lines) {
            if (line === 'PUGPORT_ENROLL_DEPENDENCIES') deps.progress?.('dependencies');
            else if (line === 'PUGPORT_ENROLL_SERVICE') deps.progress?.('service');
            else out(line + '\n');
          }
        }
      : out;
    try {
      await ssh('/bin/sh -s', { input: stagedSetup, timeout: 1_800_000, onOutput });
    } finally {
      if (pending) out(pending);
    }
    let status: RemoteStatus | undefined;
    // The last answer from the node's backend, listening or not.
    let answered: RemoteStatus | undefined;
    const deadline = Date.now() + 60_000;
    for (let attempt = 0; attempt <= 30 && Date.now() < deadline; attempt++) {
      try {
        status = answered = JSON.parse(
          (await ssh(remoteStatus, { timeout: Math.max(1, deadline - Date.now()) })).stdout,
        ) as RemoteStatus;
      } catch {
        status = undefined;
      }
      if (status?.peer?.status === 'listening' && status.peer.host) break;
      status = undefined;
      if (attempt < 30) await (deps.pause ?? pause)(2000);
    }
    if (!status?.peer?.host) {
      if (answered?.peer?.status === 'error')
        throw new Error(
          `Node peer listener cannot listen on port ${answered.peer.port} (${answered.peer.error ?? 'error'}); set PUGPORT_PEER_PORT on the node.`,
        );
      if (answered) throw new Error('Peer listener not ready after 60 seconds; check Tailscale on the node.');
      const log = (await ssh('/bin/sh -s', { input: nodeLogTail }).catch(() => undefined))?.stdout.trim();
      throw new Error(
        // Only the backend's own line: the Mac log keeps older runs, and the peer listener logs EADDRINUSE too.
        (/EADDRINUSE: 127\.0\.0\.1:/.test(log ?? '')
          ? 'Node backend cannot start: its 127.0.0.1 port is in use. Quit the other program, or on the node run PUGPORT_PORT=<free port> ~/pugport/bin/pugport node install.'
          : 'Node backend did not answer within 60 seconds; its service is stopped or keeps restarting.') +
          (log ? `\n${log}` : ''),
      );
    }
    deps.progress?.('pairing');
    if (command.tunnel) {
      if (status.peer.host !== '127.0.0.1') throw new Error('Node must listen on 127.0.0.1.');
      const devices = await deps.client.get<DevicesView>('/api/devices');
      const paired = devices.devices.find((device) => device.tunnel?.ssh === command.target);
      if (!paired) {
        const response = await ssh('~/pugport/bin/pugport node pair --json');
        let pair: { code: string; expiresAt: string };
        try {
          pair = JSON.parse(response.stdout) as typeof pair;
          if (typeof pair?.code !== 'string' || !pair.code || !Number.isFinite(Date.parse(pair.expiresAt)))
            throw new Error();
        } catch {
          throw new Error('Invalid pairing response');
        }
        try {
          await deps.client.post('/api/devices', {
            address: '127.0.0.1',
            code: pair.code,
            name: tunnelName,
            tunnel: { ssh: command.target, remotePort: status.peer.port },
          });
        } catch (error) {
          throw new Error(
            (error instanceof Error ? error.message : 'Pairing failed.').replaceAll(pair.code, '[redacted]'),
          );
        }
      }
      out(
        `${paired?.name ?? tunnelName} connected. Sign in on the server with claude login or codex login, then use @@@${paired?.name ?? tunnelName}.\n`,
      );
      deps.progress?.('done');
      return 0;
    }
    if (!isTailscaleAddress(status.peer.host)) throw new Error('Node must report a Tailscale IP address.');
    const parsedAddress = parsePeerAddress(formatPeerAddress({ host: status.peer.host, port: status.peer.port }));
    if (!parsedAddress) throw new Error('Invalid node peer address or port.');
    const address = formatPeerAddress(parsedAddress);
    const devices = await deps.client.get<DevicesView>('/api/devices');
    const normalized = await Promise.all(devices.devices.map((device) => normalize(device.address)));
    const paired = devices.devices.find((_device, index) => normalized[index] === address);
    if (paired) out(`Already paired: ${paired.name} (node ${status.name}).\n`);
    else {
      out('Pairing node…\n');
      const response = await ssh('~/pugport/bin/pugport node pair --json');
      let pair: { code: string; expiresAt: string };
      try {
        pair = JSON.parse(response.stdout) as typeof pair;
        if (typeof pair?.code !== 'string' || !pair.code || !Number.isFinite(Date.parse(pair.expiresAt)))
          throw new Error('Invalid pairing response');
      } catch {
        throw new Error('Invalid pairing response');
      }
      try {
        await deps.client.post('/api/devices', {
          address,
          code: pair.code,
          ...(command.name !== undefined ? { name: command.name } : {}),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Pairing failed.';
        throw new Error(message.replaceAll(pair.code, '[redacted]'));
      }
    }
    out(
      `${paired?.name ?? command.name ?? status.name} is ready: PugPort ${commit} on ${status.peer.host}:${status.peer.port}.\n`,
    );
    return 0;
  } catch (error) {
    err(`${error instanceof Error ? error.message : 'Node setup failed.'}\n`);
    return 1;
  }
}
