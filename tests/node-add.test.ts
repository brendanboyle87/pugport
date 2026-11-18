import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  runNodeAdd,
  nodeSetupScript,
  preflightScript,
  remoteStatus,
  incomingBundle,
  serviceExists,
  nodeHashes,
  nodeLogTail,
  tunnelPreflightScript,
  heavyJobRunning,
} from '../src/server/node-enroll.ts';
import { parseArgs, type NodeCommand } from '../src/cli/args.ts';
import type { NodeDeps } from '../src/cli/node.ts';
import { fakeHost, fakeFs } from './helpers/fake-host.ts';
import type { RunOptions } from '../src/server/platform/host.ts';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { electronModule } from './helpers/electron-harness.ts';

const commit = 'a'.repeat(40);
const ready = { name: 'ubuntu', peer: { status: 'listening', host: '100.101.102.103', port: 4318 }, running: 0 };
const command: Extract<NodeCommand, { action: 'add' }> = {
  kind: 'node',
  action: 'add',
  target: 'owner@mac-mini',
  now: false,
  dryRun: false,
};

function fixture(
  options: {
    head?: string;
    status?: unknown;
    installed?: boolean;
    fail?: string;
    devices?: unknown[];
    listeningAfter?: number;
    afterStatus?: unknown;
    /** The node's backend never answers after setup; `log` is the end of its log. */
    down?: boolean;
    log?: string;
  } = {},
) {
  const calls: { file: string; args: string[]; options?: RunOptions }[] = [];
  const output: string[] = [],
    errors: string[] = [],
    posts: unknown[] = [],
    removed: string[] = [];
  let statuses = 0;
  const deps: NodeDeps = {
    host: fakeHost('win32', {
      fs: fakeFs({ mkdtempSync: () => 'C:\\temp\\pugport-node-fixture', rmSync: (path: string) => removed.push(path) }),
      run: async (file, args, settings) => {
        calls.push({ file, args: [...args], options: settings });
        let stdout = '';
        if (file === 'git') {
          if (args.includes('--show-toplevel')) stdout = '/repo';
          else if (args.includes('HEAD')) stdout = commit;
        } else if (file === 'ssh') {
          const remote = args.at(-1);
          if (settings?.input === preflightScript && options.fail) throw new Error(options.fail);
          if (remote === remoteStatus) {
            statuses++;
            if (options.status === null && statuses === 1)
              throw Object.assign(new Error('unknown --json'), { code: 2 });
            if (options.down && statuses > 1) throw Object.assign(new Error('not running'), { code: 1 });
            stdout = JSON.stringify(
              statuses === 1
                ? (options.status ?? ready)
                : statuses <= (options.listeningAfter ?? 1)
                  ? { ...ready, peer: { status: 'waiting' } }
                  : (options.afterStatus ?? ready),
            );
          } else if (settings?.input === serviceExists) stdout = options.installed ? 'installed' : '';
          else if (settings?.input === nodeLogTail) stdout = options.log ?? '';
          else if (remote === 'git -C ~/pugport rev-parse HEAD') stdout = options.head ?? commit;
          else if (remote === '~/pugport/bin/pugport node pair --json')
            stdout = JSON.stringify({ code: 'NEVER-PRINT-ME', expiresAt: '2099-01-01T00:00:00Z' });
          if (settings?.input?.includes('git init -q')) settings.onOutput?.('build output\n');
        } else assert.fail(`Unexpected real tool: ${file}`);
        return { stdout, stderr: '' };
      },
    }),
    client: {
      health: async () => true,
      get: async <T>() => ({ devices: options.devices ?? [] }) as T,
      post: async <T>(path: string, body: unknown) => {
        posts.push({ path, body });
        return {} as T;
      },
      delete: async <T>() => ({}) as T,
    },
    root: '/repo',
    execPath: '/node',
    electron: false,
    nodeVersion: 'v24.21.0',
    interfaces: () => ({}),
    pause: async () => {},
    out: (text) => output.push(text),
    err: (text) => errors.push(text),
  };
  return { deps, calls, output, errors, posts, removed };
}

test('node add validates target and name before any SSH; dry run executes nothing', async () => {
  for (const bad of [{ target: '-oProxyCommand=evil' }, { name: 'two words' }, { name: '@bad' }]) {
    const f = fixture();
    assert.equal(await runNodeAdd({ ...command, ...bad }, f.deps), 2);
    assert.equal(f.calls.length, 0);
  }
  const f = fixture();
  assert.equal(await runNodeAdd({ ...command, dryRun: true }, f.deps), 0);
  assert.equal(f.calls.length, 0);
  assert.equal(f.posts.length, 0);
  assert.match(f.output.join(''), /BatchMode=yes/);
  assert.match(f.output.join(''), /git init -q/);
  assert.match(f.output.join(''), /keeps port, features, data directory/);
  assert.deepEqual(parseArgs(['node', 'add', 'mac', '--name', 'mini', '--now']), {
    ...command,
    target: 'mac',
    name: 'mini',
    now: true,
  });
  assert.equal(parseArgs(['node', 'add', '-bad']).kind, 'error');
});

test('tunnel preflight and re-pair use only fake SSH and the saved alias', async () => {
  const tunnelCommand = { ...command, target: 'fixture-box', tunnel: true };
  assert.deepEqual(parseArgs(['node', 'add', '--tunnel', 'fixture-box']), tunnelCommand);
  for (const scenario of ['pair', 'paired', 'paired-renamed', 'install', 'no-sudo', 'busy', 'no-forward'] as const) {
    const paired = {
      id: 'd',
      name: 'fixture-box',
      address: '127.0.0.1',
      pairedAt: '',
      tunnel: { ssh: 'fixture-box', remotePort: 4318 },
    };
    const existing =
      scenario === 'paired-renamed'
        ? [
            { ...paired, name: 'custom-name' },
            { ...paired, id: 'other', tunnel: undefined },
          ]
        : scenario === 'paired'
          ? [paired]
          : [];
    const f = fixture({
      afterStatus: { ...ready, peer: { status: 'listening', host: '127.0.0.1', port: 4318 } },
      devices: existing,
    });
    const run = f.deps.host.run;
    f.deps.host.run = async (file, args, options) => {
      if (file === 'ssh' && options?.input === tunnelPreflightScript) {
        f.calls.push({ file, args: [...args], options });
        return {
          stdout: JSON.stringify({
            network: 'yes',
            manager: 'yes',
            missing: scenario === 'install' || scenario === 'no-sudo' ? 'yes' : 'no',
            linger: 'yes',
            can_install: scenario === 'no-sudo' ? 'no' : 'yes',
            sshd_port: '2222',
          }),
          stderr: '',
        };
      }
      if (file === 'ssh' && options?.input?.startsWith('timeout 5 sh -c')) {
        f.calls.push({ file, args: [...args], options });
        return { stdout: scenario === 'busy' ? 'heavy job : active' : 'heavy job : none', stderr: '' };
      }
      return run(file, args, options);
    };
    f.deps.client.get = async <T>(path: string) =>
      (path === '/api/remote-servers'
        ? { servers: [{ name: 'fixture', ssh: 'fixture-box', statusCommand: 'fixture-status' }] }
        : { devices: existing }) as T;
    const forwarded: number[] = [];
    const result = await runNodeAdd(tunnelCommand, {
      ...f.deps,
      forwardCheck: async (_alias, port) => {
        forwarded.push(port);
        return scenario !== 'no-forward';
      },
    });
    assert.equal(
      result,
      scenario === 'no-sudo' || scenario === 'busy' || scenario === 'no-forward' ? 1 : 0,
      scenario + ': ' + f.errors.join(''),
    );
    assert.equal(f.posts.length, scenario === 'pair' || scenario === 'install' ? 1 : 0);
    assert.equal(
      f.calls.some((call) => call.options?.input?.includes('apt-get install -y')),
      scenario === 'install',
    );
    if (scenario === 'install')
      assert.ok(
        f.calls.some(
          (call) =>
            call.options?.input?.includes('apt-get update -q') &&
            call.options.input.includes('DEBIAN_FRONTEND=noninteractive'),
        ),
      );
    if (scenario !== 'busy') assert.deepEqual(forwarded, [2222]);
    if (scenario === 'busy') assert.match(f.errors.join(''), /heavy job/);
    if (scenario === 'no-sudo') assert.match(f.errors.join(''), /sudo apt install/);
    if (scenario === 'pair')
      assert.ok(f.calls.some((call) => call.options?.input?.includes('PUGPORT_PEER_HOST=127.0.0.1')));
  }
  assert.equal(heavyJobRunning('heavy job : none'), false);
  assert.equal(heavyJobRunning('heavy job : active'), true);
  assert.equal(heavyJobRunning(''), true);
});

test('Host runner streams stdin from a file or script, forwards live output, and rejects read errors', async () => {
  const received: Buffer[] = [],
    output: string[] = [],
    sources: string[] = [];
  let killed = 0;
  const exec = (
    _file: string,
    _args: string[],
    options: Record<string, unknown>,
    callback: (error: null, out: string, err: string) => void,
  ) => {
    assert.equal(options.windowsHide, true);
    for (const key of ['stdinFile', 'input', 'onOutput']) assert.equal(options[key], undefined);
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => {
        killed++;
      },
    });
    child.stdin.on('data', (chunk: Buffer) => received.push(chunk));
    child.stdin.on('finish', () => {
      callback(null, 'done', '');
      child.emit('close');
    });
    queueMicrotask(() => child.stdout.write('building\n'));
    return child;
  };
  const { currentHost } = await electronModule(
    'src/server/platform/host.ts',
    {},
    {
      mockExec: exec,
      mockRead: (path: string) => {
        sources.push(path);
        return path === 'missing.bundle'
          ? new Readable({
              read() {
                this.destroy(new Error('synthetic read failure'));
              },
            })
          : Readable.from([Buffer.alloc(2 * 1024 * 1024, 65)]);
      },
    },
    {
      './test-process.ts': 'export const execFile=globalThis.mockExec; export const execFileSync=()=>"";',
      'node:fs': 'export const createReadStream=globalThis.mockRead;',
    },
  );
  const host = currentHost();
  assert.equal(
    (await host.run('ssh', ['fixture'], { stdinFile: 'main.bundle', onOutput: (text: string) => output.push(text) }))
      .stdout,
    'done',
  );
  assert.equal(Buffer.concat(received).length, 2 * 1024 * 1024);
  assert.deepEqual(sources, ['main.bundle']);
  assert.equal(output.join(''), 'building\n');
  received.length = 0;
  await host.run('ssh', ['fixture'], { input: 'set -eu\necho fixture\n' });
  assert.equal(Buffer.concat(received).toString(), 'set -eu\necho fixture\n');
  await assert.rejects(host.run('ssh', ['fixture'], { stdinFile: 'missing.bundle' }), /synthetic read failure/);
  assert.equal(killed, 1);
});

test('node add requires main backend and a Git checkout before SSH', async () => {
  for (const reason of ['backend', 'git']) {
    const f = fixture();
    if (reason === 'backend') f.deps.client.health = async () => false;
    else
      f.deps.host.run = async () => {
        throw new Error('not git');
      };
    assert.equal(await runNodeAdd(command, f.deps), 1);
    assert.ok(!f.calls.some((c) => c.file === 'ssh'));
  }
});

test('preflight checks tools separately and fails before any remote Git/transfer on each missing prerequisite', async () => {
  for (const tool of ['git', 'curl', 'tar', 'sha256sum', 'shasum', 'make', 'g++', 'python3'])
    assert.ok(preflightScript.includes(`command -v ${tool} `));
  assert.ok(preflightScript.indexOf('xcode-select -p') < preflightScript.indexOf('command -v git'));
  assert.match(preflightScript, /uname -sm/);
  assert.match(preflightScript, /launchctl print "gui\/\$\(id -u\)"/);
  assert.match(preflightScript, /loginctl show-user "\$USER" -p Linger --value/);
  for (const fail of [
    'Missing tool: git',
    'Missing tool: curl',
    'Missing tool: tar',
    'Missing SHA-256 tool: sha256sum or shasum -a 256',
    'Missing tool: make',
    'Missing tool: g++',
    'Missing tool: python3',
    'xcode-select --install',
    'Log in to the Mac desktop',
    'loginctl enable-linger "$USER"',
  ]) {
    const f = fixture({ fail });
    assert.equal(await runNodeAdd(command, f.deps), 1);
    const ssh = f.calls.filter((c) => c.file === 'ssh');
    assert.equal(ssh.length, 1);
    assert.equal(ssh[0]!.options?.input, preflightScript);
    assert.ok(f.errors.join('').includes(fail));
  }
});

test('running tasks or unknown installed status block updates unless --now', async () => {
  for (const options of [
    { status: { ...ready, running: 2 } },
    { status: null, installed: true },
    { status: { ...ready, running: 'unknown' }, installed: true },
  ]) {
    for (const now of [false, true]) {
      const f = fixture(options);
      assert.equal(await runNodeAdd({ ...command, now }, f.deps), now ? 0 : 1);
      assert.equal(
        f.calls.some((c) => c.options?.input?.includes('git init -q')),
        now,
      );
    }
  }
});

test('same commit skips bundle; malformed remote SHA is refused; full bundle is streamed from a temp file', async () => {
  for (const head of [commit, 'b'.repeat(40), '', 'bad; rm -rf']) {
    const f = fixture({ head });
    assert.equal(await runNodeAdd(command, f.deps), head.startsWith('bad') ? 1 : 0);
    const bundle = f.calls.find((c) => c.args.includes('bundle'));
    const transfer = f.calls.find((c) => c.args.at(-1) === incomingBundle);
    if (head === commit || head.startsWith('bad')) {
      assert.equal(bundle, undefined);
      assert.equal(transfer, undefined);
    } else {
      assert.deepEqual(bundle!.args, [
        '-C',
        '/repo',
        'bundle',
        'create',
        'C:\\temp\\pugport-node-fixture\\main.bundle',
        'HEAD',
      ]);
      assert.equal(transfer!.options?.stdinFile, bundle!.args[4]);
      assert.equal(transfer!.options?.input, undefined);
      assert.equal(f.removed.length, 1);
    }
    for (const call of f.calls.filter((c) => c.file === 'ssh')) {
      assert.deepEqual(call.args.slice(0, 7), [
        '-T',
        '-o',
        'BatchMode=yes',
        '-o',
        'ConnectTimeout=10',
        '--',
        command.target,
      ]);
      assert.ok(!call.args.includes('-i'));
      assert.ok(!call.args.join(' ').includes('StrictHostKeyChecking=no'));
      assert.ok(!call.args.join(' ').includes('UserKnownHostsFile='));
    }
  }
});

test('same commit clears a leftover bundle before running setup', async () => {
  const f = fixture();
  assert.equal(await runNodeAdd(command, f.deps), 0);
  const clear = f.calls.findIndex(
    (c) => c.file === 'ssh' && c.args.at(-1) === 'rm -f ~/pugport/.git/pugport-incoming.bundle',
  );
  const setup = f.calls.findIndex((c) => c.options?.input === nodeSetupScript());
  assert.ok(clear >= 0 && clear < setup);
});

test('service-exists probe uses sh stdin for fish/tcsh login shells', async () => {
  const f = fixture({ status: null, installed: true });
  assert.equal(await runNodeAdd(command, f.deps), 1);
  const probe = f.calls.find((c) => c.options?.input === serviceExists);
  assert.equal(probe?.args.at(-1), '/bin/sh -s');
  assert.doesNotMatch(f.output.join(''), /is ready/);
});

test('name already used at another normalized address stops before SSH', async () => {
  for (const same of [false, true]) {
    const f = fixture({
      devices: [{ name: 'Mac-mini', address: same ? 'http://100.101.102.103:4318/' : '100.101.102.104' }],
    });
    const requests: string[] = [];
    const get = f.deps.client.get;
    f.deps.client.get = async <T>(path: string) => {
      requests.push(path);
      return get<T>(path);
    };
    assert.equal(
      await runNodeAdd(
        { ...command, target: 'owner@mini.tail.ts.net', name: 'mac-MINI' },
        { ...f.deps, lookup: async () => ['100.101.102.103'] },
      ),
      same ? 0 : 1,
    );
    assert.equal(requests[0], '/api/devices');
    if (!same) {
      assert.ok(!f.calls.some((c) => c.file === 'ssh'));
      assert.match(f.errors.join(''), /mac-MINI/);
    }
  }
});

test('SSH host-key hint only accompanies exit 255; streamed stderr is not repeated', async () => {
  for (const code of [1, 255])
    for (const streamed of [false, true]) {
      const f = fixture();
      const run = f.deps.host.run;
      f.deps.host.run = async (file, args, settings) => {
        if (file === 'ssh' && settings?.input === (streamed ? nodeSetupScript() : preflightScript)) {
          const stderr = 'synthetic step failure\n';
          settings.onOutput?.(stderr);
          throw Object.assign(new Error(`Command failed: ssh\n${stderr}`), { code, stderr });
        }
        return run(file, args, settings);
      };
      assert.equal(await runNodeAdd(command, f.deps), 1);
      const all = [...f.output, ...f.errors].join('');
      assert.equal(all.split('synthetic step failure').length - 1, 1);
      assert.equal(all.includes('SSH login needs'), code === 255);
    }
});

test('pairing backend message passes through while pairing code stays private', async () => {
  for (const message of ['Name conflicts with an executor.', 'bad code NEVER-PRINT-ME']) {
    const f = fixture();
    f.deps.client.post = async () => {
      throw new Error(message);
    };
    assert.equal(await runNodeAdd(command, f.deps), 1);
    assert.ok(f.errors.join('').includes(message.replaceAll('NEVER-PRINT-ME', '[redacted]')));
    assert.doesNotMatch([...f.output, ...f.errors].join(''), /NEVER-PRINT-ME|SSH login needs/);
  }
});

test('already paired final line uses actual device name even with --name', async () => {
  const f = fixture({ devices: [{ name: 'actual-mini', address: ready.peer.host }] });
  assert.equal(await runNodeAdd({ ...command, name: 'ignored-name' }, f.deps), 0);
  assert.match(f.output.at(-1)!, /^actual-mini is ready:/);
  assert.equal(f.posts.length, 0);
});

test('pair waits for listening and sends exact body; code is absent from all output', async () => {
  const f = fixture({ listeningAfter: 3 });
  assert.equal(await runNodeAdd({ ...command, name: 'Mac-mini' }, f.deps), 0);
  const pair = f.calls.findIndex((c) => c.args.at(-1) === '~/pugport/bin/pugport node pair --json');
  assert.equal(f.calls.slice(0, pair).filter((c) => c.args.at(-1) === remoteStatus).length, 4);
  assert.deepEqual(f.posts, [
    { path: '/api/devices', body: { address: '100.101.102.103', code: 'NEVER-PRINT-ME', name: 'Mac-mini' } },
  ]);
  assert.doesNotMatch([...f.output, ...f.errors].join(''), /NEVER-PRINT-ME/);
  assert.match(f.output.join(''), /Mac-mini is ready: PugPort a{40} on 100.101.102.103:4318/);
});

test('listener timeout and non-Tailscale address prevent pairing; backend errors never expose the code', async () => {
  for (const options of [
    { listeningAfter: 100 },
    { afterStatus: { ...ready, peer: { ...ready.peer, host: '192.168.1.2' } } },
    { afterStatus: { ...ready, peer: { ...ready.peer, port: 99999 } } },
  ]) {
    const f = fixture(options);
    assert.equal(await runNodeAdd(command, f.deps), 1);
    assert.equal(f.posts.length, 0);
  }
  const f = fixture();
  f.deps.client.post = async () => {
    throw new Error('bad code NEVER-PRINT-ME');
  };
  assert.equal(await runNodeAdd(command, f.deps), 1);
  assert.doesNotMatch([...f.output, ...f.errors].join(''), /NEVER-PRINT-ME/);
});

test('node add names the real reason the node is not ready, and blames Tailscale only when it is', async () => {
  const log = '/Users/owner/Library/Logs/PugPort/node.log';
  const cases = [
    {
      options: { down: true, log: `Last lines of ${log}:\nEADDRINUSE: 127.0.0.1:4319 is already in use` },
      reason: /127\.0\.0\.1 port is in use[\s\S]*PUGPORT_PORT=<free port>[\s\S]*node\.log:\nEADDRINUSE/,
    },
    {
      options: { down: true, log: `Last lines of ${log}:\nError: synthetic crash` },
      reason: /did not answer within 60 seconds; its service is stopped or keeps restarting\.\n[\s\S]*synthetic crash/,
    },
    {
      // An older run's bare code and the peer listener's own EADDRINUSE are not the backend's port.
      options: {
        down: true,
        log: `Last lines of ${log}:\nEADDRINUSE\n[peer] cannot listen on 100.64.0.5:4318 (EADDRINUSE); retrying\nError: x`,
      },
      reason: /keeps restarting\.\n/,
    },
    { options: { down: true }, reason: /keeps restarting\.\n$/ },
    {
      options: { afterStatus: { ...ready, peer: { status: 'error', port: 4318, error: 'EADDRINUSE' } } },
      reason: /peer listener cannot listen on port 4318 \(EADDRINUSE\); set PUGPORT_PEER_PORT/,
    },
    { options: { listeningAfter: 100 }, reason: /check Tailscale on the node/ },
  ];
  for (const { options, reason } of cases) {
    const f = fixture(options);
    assert.equal(await runNodeAdd(command, f.deps), 1);
    const text = f.errors.join('');
    assert.match(text, reason);
    if (!reason.source.includes('Tailscale')) assert.doesNotMatch(text, /Tailscale/);
    assert.equal(f.posts.length, 0);
    // The log is read only when the backend never answered.
    assert.equal(
      f.calls.some((call) => call.options?.input === nodeLogTail),
      'down' in options,
    );
  }
});

test('address normalization detects existing device and MagicDNS; same hostname at another IP must pair', async () => {
  for (const address of [
    '100.101.102.103:4318',
    'http://100.101.102.103/',
    'Ubuntu.TAIL123.TS.NET.:4318',
    '100.101.102.104',
  ]) {
    const f = fixture({ devices: [{ name: 'ubuntu', address }] });
    assert.equal(await runNodeAdd(command, { ...f.deps, lookup: async () => ['100.101.102.103'] }), 0);
    assert.equal(f.posts.length, address.endsWith('.104') ? 1 : 0);
  }
});

test(
  'local POSIX setup script: synthetic repo, HOME, tarball and tools only',
  { skip: process.platform === 'win32' ? 'Windows: no supported POSIX sh/ln/readlink platform' : false },
  async (t) => {
    let tar: string, git: string;
    try {
      const platform = execFileSync('/bin/sh', ['-c', 'uname -s'], { encoding: 'utf8' }).trim();
      if (/MINGW|MSYS|CYGWIN/.test(platform)) {
        t.skip('Requires non-MINGW POSIX uname');
        return;
      }
      tar = execFileSync('/bin/sh', ['-c', 'command -v tar'], { encoding: 'utf8' }).trim();
      git = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    } catch {
      t.skip('No usable POSIX sh, tar or Git');
      return;
    }
    const folder = mkdtempSync(join(tmpdir(), 'pugport-script-'));
    const quote = (text: string) => `'${text.replace(/'/g, "'\\''")}'`;
    try {
      execFileSync('/bin/sh', [
        '-c',
        `ln -s target ${quote(join(folder, 'link'))}; test "$(readlink ${quote(join(folder, 'link'))})" = target`,
      ]);
    } catch {
      rmSync(folder, { recursive: true, force: true });
      t.skip('ln -s/readlink unavailable');
      return;
    }
    try {
      for (const scenario of [
        'first-and-second',
        'rewritten-main',
        'untracked',
        'tracked',
        'wrong-sha',
        'npm-failure',
        'download-failure',
        'build-failure',
        'install-failure',
        'mac-stop',
        'mac-timeout',
      ] as const) {
        await t.test(scenario, () => {
          const base = join(folder, scenario),
            home = join(base, 'home'),
            repo = join(home, 'pugport'),
            source = join(base, 'source'),
            tools = join(base, 'tools'),
            calls = join(base, 'calls');
          for (const path of [repo, source, tools]) mkdirSync(path, { recursive: true });
          const env = {
            ...process.env,
            HOME: home,
            USER: 'fixture',
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_NOSYSTEM: '1',
            PATH: `${tools}:/usr/bin:/bin`,
            PUGPORT_PEER_ALLOW_WRITE: '1',
          };
          const runGit = (args: string[], cwd = source) =>
            execFileSync(git, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
          const executable = (file: string, body: string) =>
            writeFileSync(file, `#!/bin/sh\nset -eu\n${body}\n`, { mode: 0o755 });
          const mac = scenario.startsWith('mac-');
          executable(join(tools, 'uname'), `echo "${mac ? 'Darwin' : 'Linux'} x86_64"`);
          executable(join(tools, 'sleep'), ':');
          executable(
            join(tools, 'launchctl'),
            `
echo "launchctl $*" >> ${quote(calls)}
if [ "$1" = bootout ]; then echo '36: Operation now in progress' >&2; exit 36; fi
count=$(cat ${quote(join(base, 'prints'))} 2>/dev/null || echo 0)
count=$((count + 1)); echo "$count" > ${quote(join(base, 'prints'))}
if [ "$count" -ge 42 ] && [ ${scenario === 'mac-stop' ? 'yes' : 'no'} = yes ]; then echo 'Could not find service'; exit 113; fi`,
          );
          executable(
            join(tools, 'systemctl'),
            `echo "systemctl $*" >> ${quote(calls)}; if [ "$2" = is-active ]; then exit 3; fi`,
          );
          executable(join(tools, 'tar'), `echo tar >> ${quote(calls)}; exec ${quote(tar)} "$@"`);
          const version = '99.0.1';
          const payload = join(base, 'payload'),
            runtimeName = `node-v${version}-${mac ? 'darwin' : 'linux'}-x64`;
          mkdirSync(join(payload, runtimeName, 'bin'), { recursive: true });
          executable(
            join(payload, runtimeName, 'bin', 'node'),
            `echo "node $*" >> ${quote(calls)}\n${scenario === 'build-failure' ? 'exit 8' : ':'}`,
          );
          executable(
            join(payload, runtimeName, 'bin', 'npm'),
            `echo "npm $* electron=$ELECTRON_SKIP_BINARY_DOWNLOAD onnx=$ONNXRUNTIME_NODE_INSTALL" >> ${quote(calls)}\n${scenario === 'npm-failure' ? 'exit 7' : 'mkdir -p node_modules'}`,
          );
          const archive = join(base, 'fake.tar.gz');
          execFileSync(tar, ['-czf', archive, '-C', payload, runtimeName]);
          const hash = createHash('sha256').update(readFileSync(archive)).digest('hex');
          executable(
            join(tools, 'curl'),
            `echo curl >> ${quote(calls)}\n${scenario === 'download-failure' ? 'exit 9' : ':'}\nwhile [ "$1" != --output ]; do shift; done\ncp ${quote(archive)} "$2"`,
          );
          executable(join(tools, 'git'), `echo "git $*" >> ${quote(calls)}; exec ${quote(git)} "$@"`);
          runGit(['init', '-q', '-b', 'main']);
          runGit(['config', 'user.email', 'fixture@example.invalid']);
          runGit(['config', 'user.name', 'Fixture']);
          mkdirSync(join(source, 'bin'));
          executable(
            join(source, 'bin', 'pugport'),
            `echo "pugport $* write=\${PUGPORT_PEER_ALLOW_WRITE-unset}" >> ${quote(calls)}\n${scenario === 'install-failure' ? 'exit 10' : ':'}`,
          );
          writeFileSync(join(source, 'package-lock.json'), '{}\n');
          runGit(['add', '.']);
          runGit(['commit', '-qm', 'initial']);
          mkdirSync(join(repo, '.git'));
          const send = () => runGit(['bundle', 'create', join(repo, '.git', 'pugport-incoming.bundle'), 'HEAD']);
          send();
          if (scenario === 'tracked' || scenario === 'untracked' || scenario === 'rewritten-main') {
            runGit(['init', '-q'], repo);
            runGit(['fetch', '-q', join(repo, '.git', 'pugport-incoming.bundle'), '+HEAD:refs/pugport/incoming'], repo);
            runGit(['checkout', '-q', '--detach', 'refs/pugport/incoming'], repo);
            if (scenario === 'tracked') writeFileSync(join(repo, 'package-lock.json'), 'modified\n');
            if (scenario === 'untracked') writeFileSync(join(repo, 'keep-me'), 'untracked\n');
            if (scenario === 'rewritten-main') {
              writeFileSync(join(source, 'package-lock.json'), '{"rewritten":true}\n');
              runGit(['add', '.']);
              runGit(['commit', '--amend', '-qm', 'rewritten']);
              send();
            }
          }
          const selectedHash = scenario === 'wrong-sha' ? '0'.repeat(64) : hash;
          const script = nodeSetupScript(
            version,
            Object.fromEntries(Object.keys(nodeHashes).map((key) => [key, selectedHash])) as typeof nodeHashes,
          );
          const execute = () =>
            execFileSync('/bin/sh', ['-s'], {
              cwd: base,
              env,
              input: script,
              encoding: 'utf8',
              timeout: 30_000,
              stdio: ['pipe', 'pipe', 'pipe'],
            });
          if (
            [
              'tracked',
              'wrong-sha',
              'npm-failure',
              'download-failure',
              'build-failure',
              'install-failure',
              'mac-timeout',
            ].includes(scenario)
          ) {
            assert.throws(execute, (error: unknown) => {
              const stderr = (error as { stderr: string }).stderr;
              assert.match(
                stderr,
                scenario === 'tracked'
                  ? /Tracked files modified/
                  : scenario === 'wrong-sha'
                    ? /SHA-256 mismatch/
                    : scenario === 'mac-timeout'
                      ? /did not stop within 70 seconds/
                      : /service is stopped.*pugport node add <target> --now/,
              );
              if (scenario !== 'tracked' && scenario !== 'mac-timeout')
                assert.match(stderr, /service is stopped.*pugport node add <target> --now/);
              return true;
            });
            assert.equal(
              existsSync(join(repo, '.runtime', 'lock.key')),
              scenario === 'build-failure' || scenario === 'install-failure',
            );
            const text = readFileSync(calls, 'utf8');
            if (['tracked', 'wrong-sha', 'download-failure', 'mac-timeout'].includes(scenario))
              assert.doesNotMatch(text, /^tar$|^npm /m);
            if (scenario === 'mac-timeout') assert.equal((text.match(/launchctl print/g) ?? []).length, 72);
            return;
          }
          execute();
          let text = readFileSync(calls, 'utf8');
          assert.match(
            text,
            /curl\ntar\nnpm ci electron=1 onnx=skip\nnode scripts\/build.mjs\npugport node install --from-node-add write=unset/,
          );
          if (scenario === 'mac-stop') assert.equal((text.match(/launchctl print/g) ?? []).length, 42);
          assert.equal(
            execFileSync('/bin/sh', ['-c', `readlink ${quote(join(repo, '.runtime', 'node'))}`], {
              encoding: 'utf8',
            }).trim(),
            join(repo, '.runtime', runtimeName, 'bin', 'node'),
          );
          if (scenario === 'untracked') assert.equal(readFileSync(join(repo, 'keep-me'), 'utf8'), 'untracked\n');
          if (scenario === 'rewritten-main')
            assert.equal(runGit(['rev-parse', 'HEAD'], repo), runGit(['rev-parse', 'HEAD']));
          if (scenario === 'first-and-second') {
            writeFileSync(calls, '');
            execute();
            text = readFileSync(calls, 'utf8');
            assert.doesNotMatch(text, /git fetch|git checkout|curl|^tar$|npm ci/m);
            assert.match(text, /node scripts\/build.mjs/);
          }
        });
      }
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  },
);

test('setup pins all architectures, stops service before install/build, forces incoming ref, and never enables writes', () => {
  const script = nodeSetupScript();
  for (const hash of Object.values(nodeHashes)) assert.ok(script.includes(hash));
  assert.ok(script.indexOf('systemctl --user stop') < script.indexOf('npm ci'));
  assert.ok(script.indexOf('launchctl bootout') < script.indexOf('tar -xzf'));
  assert.match(script, /load_state=\$\(systemctl --user show pugport-node.service --property=LoadState --value\)/);
  assert.match(script, /if \[ "\$load_state" != not-found \]; then systemctl --user stop/);
  assert.match(script, /\[ "\$\(hash_file "\$archive"\)" = "\$sha" \] \|\| fail/);
  assert.ok(script.indexOf('SHA-256 mismatch') < script.indexOf('tar -xzf'));
  assert.match(script, /git init -q\nif \[ -f .git\/pugport-incoming.bundle/);
  assert.match(script, /\+HEAD:refs\/pugport\/incoming/);
  assert.match(script, /--untracked-files=no/);
  assert.match(script, /ln -sfn "\$runtime\/bin\/node"/);
  assert.match(script, /ELECTRON_SKIP_BINARY_DOWNLOAD=1 ONNXRUNTIME_NODE_INSTALL=skip npm ci/);
  assert.ok(script.indexOf('npm ci') < script.indexOf('> .runtime/lock.key'));
  assert.match(script, /unset PUGPORT_PEER_ALLOW_WRITE\n.*node install --from-node-add/);
  assert.throws(() => nodeSetupScript('24;bad'), /Invalid/);
});

test('setup keeps polling after bootout errors and arms stopped-service guidance through install', () => {
  const script = nodeSetupScript();
  assert.match(script, /launchctl bootout "\$agent" \|\| :\n    count=0\n    while loaded; do/);
  assert.match(script, /\[ "\$count" -lt 70 \] \|\| fail/);
  const trap = script.indexOf("trap 'result=$?");
  assert.ok(trap > script.indexOf('systemctl --user stop'));
  assert.match(
    script,
    /trap 'result=\$\?; if \[ "\$result" -ne 0 \]; then echo "Node service is stopped; fix the cause and rerun: pugport node add <target> --now" >&2; fi' EXIT/,
  );
  for (const step of ['curl --fail', 'npm ci', 'node scripts/build.mjs', 'node install --from-node-add'])
    assert.ok(trap < script.indexOf(step));
  assert.ok(script.indexOf('trap - EXIT') > script.indexOf('node install --from-node-add'));
  assert.doesNotMatch(preflightScript, /printf|echo.*\$HOME/);
});

test('shared tunnel enrollment reports actual stages and stops at preflight failure', async () => {
  for (const fail of [false, true]) {
    const f = fixture({ afterStatus: { ...ready, peer: { status: 'listening', host: '127.0.0.1', port: 4318 } } });
    const run = f.deps.host.run;
    f.deps.host.run = async (file, args, options) => {
      if (file === 'ssh' && options?.input === tunnelPreflightScript) {
        if (fail) throw new Error('synthetic preflight failure');
        return {
          stdout: JSON.stringify({
            network: 'yes',
            manager: 'yes',
            missing: 'no',
            linger: 'yes',
            can_install: 'yes',
            sshd_port: '22',
          }),
          stderr: '',
        };
      }
      if (file === 'ssh' && options?.input?.includes('git init -q')) {
        assert.match(options.input, /echo PUGPORT_ENROLL_DEPENDENCIES/);
        assert.match(options.input, /echo PUGPORT_ENROLL_SERVICE\nunset PUGPORT_PEER_ALLOW_WRITE/);
        options.onOutput?.('PUGPORT_ENROLL_DEPENDENCIES\nPUGPORT_ENROLL_SERVICE\n');
      }
      return run(file, args, options);
    };
    const get = f.deps.client.get;
    f.deps.client.get = async <T>(path: string) =>
      path === '/api/remote-servers' ? ({ servers: [] } as T) : get<T>(path);
    const stages: string[] = [];
    const result = await runNodeAdd(
      { ...command, target: 'fake-box', tunnel: true },
      {
        ...f.deps,
        forwardCheck: async () => true,
        progress: (stage) => stages.push(stage),
      },
    );
    assert.equal(result, fail ? 1 : 0);
    assert.deepEqual(
      stages,
      fail ? ['preflight'] : ['preflight', 'bundle', 'runtime', 'dependencies', 'service', 'pairing', 'done'],
    );
    if (fail) assert.match(f.errors.join(''), /synthetic preflight failure/);
  }
});
