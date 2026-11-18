import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { writePrivateConfig } from '../private-config.ts';
import { currentHost, type Host } from '../platform/host.ts';

/*
 * Account-bound server access: a PugPort-made SSH key per enrolled server that can only forward to the node's own
 * port. It travels with the account (as a secret of the server-node record), so any signed-in computer reaches the
 * node without its own ~/.ssh setup. Installing, removing or updating the node still needs the owner's own SSH.
 */

const hostKeyPattern =
  /^(?:ssh-ed25519|ecdsa-sha2-nistp(?:256|384|521)|ssh-rsa|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]+={0,3}$/;
const privateKeyPattern =
  /^-----BEGIN OPENSSH PRIVATE KEY-----\n[A-Za-z0-9+/=\n]+\n-----END OPENSSH PRIVATE KEY-----\n$/;
const port = z.number().int().min(1).max(65535);

export const managedAccessSchema = z
  .object({
    version: z.literal(1),
    /** Where this computer's SSH reached the server when the key was installed (`ssh -G` HostName and Port). */
    host: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.:-]{0,252}$/),
    port,
    user: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,31}$/),
    /** The server's own host keys, read over the owner's trusted SSH session: the only keys the tunnel accepts. */
    hostKeys: z.array(z.string().max(2000).regex(hostKeyPattern)).min(1).max(8),
    /** The one port the key may open, as written in its authorized_keys line. */
    nodePort: port,
    key: z.string().max(4000).regex(privateKeyPattern),
  })
  .strict();
export type ManagedAccess = z.infer<typeof managedAccessSchema>;

/** A stored or synced value that this build cannot use (damaged, or from a newer format) counts as no access. */
export function readManagedAccess(text: string | undefined): ManagedAccess | undefined {
  if (!text) return undefined;
  try {
    const parsed = managedAccessSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
export const encodeManagedAccess = (access: ManagedAccess) => JSON.stringify(managedAccessSchema.parse(access));

// ---- The key pair (OpenSSH's own unencrypted openssh-key-v1 format, readable by every OpenSSH client).

const uint32 = (value: number) => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
};
const sshString = (data: Buffer | string) => {
  const bytes = typeof data === 'string' ? Buffer.from(data) : data;
  return Buffer.concat([uint32(bytes.length), bytes]);
};

export function generateAccessKey(comment: string): { privateKey: string; publicKey: string } {
  const pair = generateKeyPairSync('ed25519');
  const pub = Buffer.from(pair.publicKey.export({ format: 'jwk' }).x!, 'base64url');
  const seed = Buffer.from(pair.privateKey.export({ format: 'jwk' }).d!, 'base64url');
  const blob = Buffer.concat([sshString('ssh-ed25519'), sshString(pub)]);
  const check = randomBytes(4);
  const secretKey = Buffer.concat([seed, pub]);
  const section = Buffer.concat([
    check,
    check,
    sshString('ssh-ed25519'),
    sshString(pub),
    sshString(secretKey),
    sshString(comment),
  ]);
  const padding = Buffer.from(Array.from({ length: (8 - (section.length % 8)) % 8 }, (_, i) => i + 1));
  const secret = Buffer.concat([section, padding]);
  const body = Buffer.concat([
    Buffer.from('openssh-key-v1\0'),
    sshString('none'),
    sshString('none'),
    sshString(''),
    uint32(1),
    sshString(blob),
    sshString(secret),
  ]);
  const text = body
    .toString('base64')
    .match(/.{1,70}/g)!
    .join('\n');
  for (const bytes of [seed, secretKey, section, secret, body]) bytes.fill(0);
  return {
    privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${text}\n-----END OPENSSH PRIVATE KEY-----\n`,
    publicKey: `ssh-ed25519 ${blob.toString('base64')}`,
  };
}

// ---- The authorized_keys line and the scripts that add or remove it over the owner's own SSH.

const markerPrefix = 'pugport-access:';
export const accessMarker = (nodeId: string) => `${markerPrefix}${z.string().uuid().parse(nodeId)}`;

/**
 * Forwarding to the node port only. permitopen also refuses Unix sockets (-L to a socket path), permitlisten pins
 * -R to the node's own (taken) port, and the forced command answers any shell or command request with `false`.
 */
export function authorizedKeyLine(publicKey: string, nodePort: number, nodeId: string): string {
  if (!/^ssh-ed25519 [A-Za-z0-9+/]+={0,3}$/.test(publicKey)) throw new Error('Invalid access key.');
  const target = `127.0.0.1:${port.parse(nodePort)}`;
  return `restrict,port-forwarding,permitopen="${target}",permitlisten="${target}",command="false" ${publicKey} ${accessMarker(nodeId)}`;
}

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

const checkedLine = (line: string) => {
  if (/[\0\r\n']/.test(line) || !line.includes(` ${markerPrefix}`)) throw new Error('Invalid access line.');
  return line;
};

/**
 * Shell lines (for a `set -e` script) that drop this server user's PugPort access lines: one exact line, or all of
 * them. Every other line stays as it was; a failed read stops the script before the file is replaced.
 */
export function removeAccessLines(line?: string): string[] {
  const keep =
    line === undefined
      ? `awk ${quote(`index($NF, "${markerPrefix}") != 1`)} "$pugport_keys"`
      : `pugport_line=${quote(checkedLine(line))} awk '$0 != ENVIRON["pugport_line"]' "$pugport_keys"`;
  return [
    'pugport_keys="$HOME/.ssh/authorized_keys"',
    `if [ -f "$pugport_keys" ] && [ ! -L "$pugport_keys" ] && grep -q ${quote(` ${markerPrefix}`)} "$pugport_keys"; then`,
    '  pugport_tmp="$HOME/.ssh/.authorized_keys.pugport.$$"',
    `  ${keep} > "$pugport_tmp"`,
    '  chmod 600 "$pugport_tmp"',
    '  mv -f "$pugport_tmp" "$pugport_keys"',
    'fi',
  ];
}
export const removeAccessScript = (line?: string) =>
  ['set -eu', 'umask 077', ...removeAccessLines(line), 'exit 0', ''].join('\n');

/**
 * Adds the line once (running it again changes nothing; other keys are never touched) and prints the login user
 * and the server's host keys, which arrive over the owner's already trusted SSH session.
 */
export function installAccessScript(line: string): string {
  return [
    'set -eu',
    'umask 077',
    `line=${quote(checkedLine(line))}`,
    'file="$HOME/.ssh/authorized_keys"',
    'mkdir -p "$HOME/.ssh"',
    `[ ! -L "$file" ] || { echo 'authorized_keys is a symbolic link; PugPort does not edit it.' >&2; exit 3; }`,
    '[ -e "$file" ] || : > "$file"',
    `[ -w "$file" ] || { echo 'authorized_keys is not writable by this user.' >&2; exit 3; }`,
    'if ! grep -qxF -- "$line" "$file"; then',
    // Only appended: the owner's own lines are never rewritten. A last line without newline is ended first.
    '  [ -z "$(tail -c 1 "$file")" ] || echo >> "$file"',
    `  printf '%s\\n' "$line" >> "$file"`,
    'fi',
    'echo "user $(id -un)"',
    'for f in /etc/ssh/ssh_host_*_key.pub; do',
    '  if [ -r "$f" ]; then echo "hostkey $(cat "$f")"; fi',
    'done',
    'exit 0',
    '',
  ].join('\n');
}

export function parseInstallOutput(output: string): { user?: string; hostKeys: string[] } {
  let user: string | undefined;
  const hostKeys: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const [key, ...words] = line.trim().split(/\s+/);
    if (key === 'user' && words[0]) user = words[0];
    if (key === 'hostkey' && words.length >= 2) {
      const value = `${words[0]} ${words[1]}`;
      if (hostKeyPattern.test(value) && !hostKeys.includes(value)) hostKeys.push(value);
    }
  }
  return { ...(user ? { user } : {}), hostKeys: hostKeys.slice(0, 8) };
}

/** `ssh -G <alias>` output: where the alias really goes. A jump host or proxy command cannot be reproduced. */
export function parseSshConfig(output: string): { host: string; port: number; proxied: boolean } | undefined {
  const values = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const [key, ...rest] = line.trim().split(/\s+/);
    if (key && !values.has(key.toLowerCase())) values.set(key.toLowerCase(), rest.join(' '));
  }
  const host = values.get('hostname');
  const portNumber = Number(values.get('port') ?? '22');
  if (!host || !Number.isInteger(portNumber)) return undefined;
  const set = (name: string) => !!values.get(name) && values.get(name)!.toLowerCase() !== 'none';
  return { host, port: portNumber, proxied: set('proxyjump') || set('proxycommand') };
}

// ---- The tunnel with the managed key: nothing from the user's own SSH setup takes part.

export type ManagedRoute = {
  /** Shown in errors. */
  label: string;
  host: string;
  port: number;
  user: string;
  keyFile: string;
  knownHostsFile: string;
};
const hostKeyAlias = 'pugport-access';

/** A file path as an ssh -o value: quoted, with forward slashes on Windows; %, $ and quotes cannot be expressed. */
function optionPath(path: string) {
  if (/["%$\0\r\n]/.test(path)) throw new Error('The PugPort data folder path cannot be passed to ssh.');
  return `"${/^[A-Za-z]:\\/.test(path) ? path.replaceAll('\\', '/') : path}"`;
}

export function managedSshArgs(route: ManagedRoute): string[] {
  const knownHosts = optionPath(route.knownHostsFile);
  optionPath(route.keyFile);
  return [
    // No user or system config: an alias, Include, Match exec or ProxyCommand there cannot change this connection.
    '-F',
    'none',
    '-i',
    route.keyFile,
    '-p',
    String(port.parse(route.port)),
    '-l',
    managedAccessSchema.shape.user.parse(route.user),
    ...[
      'IdentitiesOnly=yes',
      'IdentityAgent=none',
      'PasswordAuthentication=no',
      'KbdInteractiveAuthentication=no',
      'StrictHostKeyChecking=yes',
      `UserKnownHostsFile=${knownHosts}`,
      `GlobalKnownHostsFile=${knownHosts}`,
      `HostKeyAlias=${hostKeyAlias}`,
      'CheckHostIP=no',
    ].flatMap((setting) => ['-o', setting]),
  ];
}

export const knownHostsText = (access: Pick<ManagedAccess, 'hostKeys'>) =>
  access.hostKeys.map((key) => `${hostKeyAlias} ${key}\n`).join('');

/**
 * The key and known_hosts files ssh needs, one owner-only folder per device under the secrets folder. They are
 * written from the stored record when a tunnel opens and removed with the device.
 */
export class ManagedKeyFiles {
  private writes = new Map<string, Promise<unknown>>();
  constructor(
    private readonly directory: string,
    private readonly helperTimeoutMs?: number,
  ) {}
  private folder(id: string) {
    return join(this.directory, z.string().uuid().parse(id));
  }
  private async write(file: string, contents: string) {
    let current = '';
    try {
      current = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (current !== contents) await writePrivateConfig(file, contents, current, this.helperTimeoutMs);
  }
  private queue<T>(id: string, work: () => Promise<T>): Promise<T> {
    const next = (this.writes.get(id) ?? Promise.resolve()).catch(() => {}).then(work);
    this.writes.set(id, next);
    const settled = () => {
      if (this.writes.get(id) === next) this.writes.delete(id);
    };
    next.then(settled, settled);
    return next;
  }
  route(id: string, label: string, access: ManagedAccess): Promise<ManagedRoute> {
    return this.queue(id, async () => {
      const folder = this.folder(id);
      const keyFile = join(folder, 'key');
      const knownHostsFile = join(folder, 'known_hosts');
      await this.write(keyFile, access.key);
      await this.write(knownHostsFile, knownHostsText(access));
      return { label, host: access.host, port: access.port, user: access.user, keyFile, knownHostsFile };
    });
  }
  remove(id: string): Promise<void> {
    return this.queue(id, () => rm(this.folder(id), { recursive: true, force: true }));
  }
  /** Drops folders of devices this computer no longer has (removed here or by another computer's sync). */
  async prune(keep: string[]): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch {
      return;
    }
    await Promise.all(
      names
        .filter((name) => z.string().uuid().safeParse(name).success && !keep.includes(name))
        .map((name) => this.remove(name).catch(() => {})),
    );
  }
}

/** The owner's own ssh client and config, as the one-time upgrade uses it: key login only, no prompts. */
export const ownSsh = (host: Pick<Host, 'run'> = currentHost()) => ({
  config: async (alias: string) => (await host.run('ssh', ['-G', '--', alias], { timeout: 10_000 })).stdout,
  run: async (alias: string, script: string) =>
    (
      await host.run('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '--', alias, '/bin/sh -s'], {
        input: script,
        timeout: 60_000,
      })
    ).stdout,
});
