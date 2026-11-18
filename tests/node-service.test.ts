import { productionPaths } from './helpers/production-paths.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseArgs } from '../src/cli/args.ts';
import { APP_VERSION } from '../src/shared/identity.ts';
import { nodeBackendPort, runNode, type NodeClient, type NodeDeps } from '../src/cli/node.ts';
import {
  launchAgentPath,
  launchAgentPlist,
  ownServiceFile,
  serviceMarker,
  servicePath,
  serviceEnvironment,
  systemdUnit,
  systemdUnitPath,
  systemdWord,
  type NodeServiceSpec,
} from '../src/server/platform/service.ts';
import { fakeFs, fakeHost, recordingRun } from './helpers/fake-host.ts';

const spec: NodeServiceSpec = {
  runtime: '/home/fixture/pugport/.runtime/node',
  script: '/home/fixture/pugport/dist/server/main.js',
  workingDirectory: '/home/fixture/pugport',
  dataDir: '/home/fixture/.local/share/pugport/data',
  path: ['/home/fixture/pugport/.runtime', '/home/fixture/.local/bin', '/usr/local/bin', '/usr/bin', '/bin'],
};

test('the systemd user unit, as written', () => {
  assert.equal(
    systemdUnit(spec),
    `${serviceMarker}
[Unit]
Description=PugPort device node
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/fixture/pugport
ExecStart="/home/fixture/pugport/.runtime/node" "/home/fixture/pugport/dist/server/main.js"
Environment="PUGPORT_ROLE=node"
Environment="COMBORUNNER_DATA_DIR=/home/fixture/.local/share/pugport/data"
Environment="PATH=/home/fixture/pugport/.runtime:/home/fixture/.local/bin:/usr/local/bin:/usr/bin:/bin"
Restart=on-failure
RestartSec=10
# The whole cgroup (backend and every CLI, even detached ones) stops together: no orphaned CLIs on the node.
KillMode=control-group
# Covers the backend's ~40 s graceful shutdown.
TimeoutStopSec=60
SyslogIdentifier=pugport-node

[Install]
WantedBy=default.target
`,
  );
});

/** What systemd would read: every line a comment, a section header or key=value, with known keys per section. */
function checkUnit(text: string) {
  const known: Record<string, string[]> = {
    Unit: ['Description', 'Wants', 'After'],
    Service: [
      'Type',
      'WorkingDirectory',
      'ExecStart',
      'Environment',
      'Restart',
      'RestartSec',
      'KillMode',
      'TimeoutStopSec',
      'SyslogIdentifier',
    ],
    Install: ['WantedBy'],
  };
  let section = '';
  const seen: string[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const header = /^\[(\w+)\]$/.exec(line);
    if (header) {
      section = header[1]!;
      assert.ok(known[section], `unknown section ${section}`);
      continue;
    }
    const pair = /^(\w+)=(.*)$/.exec(line);
    assert.ok(pair, `not key=value: ${line}`);
    assert.ok(known[section]!.includes(pair[1]!), `${pair[1]} in [${section}]`);
    seen.push(pair[1]!);
    if (pair[1] === 'Environment') assert.match(pair[2]!, /^"[A-Z_]+=(?:[^"\\%]|\\\\|\\"|%%)*"$/);
  }
  for (const key of ['ExecStart', 'Restart', 'KillMode', 'TimeoutStopSec', 'WantedBy']) assert.ok(seen.includes(key));
}

test('paths with spaces, quotes, % and $ reach systemd as they are; line breaks are refused', () => {
  assert.equal(systemdWord('/opt/My App/node'), '"/opt/My App/node"');
  assert.equal(systemdWord('/a "b"\\c'), '"/a \\"b\\"\\\\c"');
  assert.equal(systemdWord('/100%/x'), '"/100%%/x"');
  assert.equal(systemdWord('/a/$HOME', true), '"/a/$$HOME"');
  assert.equal(systemdWord('/a/$HOME'), '"/a/$HOME"', 'Environment= does not expand variables');
  const odd = systemdUnit({
    ...spec,
    runtime: '/opt/Pug Port/node',
    workingDirectory: '/opt/Pug Port 100%',
    path: ['/opt/Pug Port', '/usr/bin'],
    env: { PUGPORT_PEER_PORT: '5000' },
  });
  assert.match(odd, /^ExecStart="\/opt\/Pug Port\/node" /m);
  assert.match(odd, /^WorkingDirectory=\/opt\/Pug Port 100%%$/m);
  assert.match(odd, /^Environment="PUGPORT_PEER_PORT=5000"$/m);
  checkUnit(odd);
  checkUnit(systemdUnit({ ...spec, electron: true }));
  assert.match(systemdUnit({ ...spec, electron: true }), /^Environment="ELECTRON_RUN_AS_NODE=1"$/m);
  assert.throws(() => systemdUnit({ ...spec, dataDir: '/a\nExecStartPre=/bin/evil' }), /换行/);
  assert.throws(() => systemdUnit({ ...spec, env: { 'BAD NAME': 'x' } }), /环境变量名/);
  assert.throws(() => systemdUnit({ ...spec, workingDirectory: ' /x' }), /空格/);
  assert.ok(ownServiceFile(systemdUnit(spec)));
  assert.equal(ownServiceFile('[Unit]\nDescription=someone else\n'), false);
});

test('the macOS LaunchAgent plist', () => {
  const mac = fakeHost('darwin');
  const plist = launchAgentPlist({ ...spec, runtime: '/Users/fixture/<a&b>/node' }, mac);
  assert.match(plist, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(plist, /<key>Label<\/key>\n\t<string>com\.pugport\.node<\/string>/);
  assert.match(plist, /<string>\/Users\/fixture\/&lt;a&amp;b&gt;\/node<\/string>/);
  assert.match(plist, /<key>PUGPORT_ROLE<\/key>\n\t\t<string>node<\/string>/);
  assert.match(plist, /<key>KeepAlive<\/key>\n\t<dict>\n\t\t<key>SuccessfulExit<\/key>\n\t\t<false\/>/);
  assert.match(plist, /<key>ThrottleInterval<\/key>\n\t<integer>10<\/integer>/);
  assert.match(plist, /<key>ExitTimeOut<\/key>\n\t<integer>60<\/integer>/);
  assert.match(plist, /<key>LimitLoadToSessionType<\/key>\n\t<string>Aqua<\/string>/);
  assert.match(plist, /<string>\/Users\/fixture\/Library\/Logs\/PugPort\/node\.log<\/string>/);
  // An XML comment may not contain "--".
  const comment = /<!--([\s\S]*?)-->/.exec(plist)![1]!;
  assert.ok(!comment.includes('--'));
  assert.ok(ownServiceFile(plist));
  assert.equal(launchAgentPath(mac), '/Users/fixture/Library/LaunchAgents/com.pugport.node.plist');
});

test('where the unit goes and what PATH it gets', () => {
  assert.equal(
    productionPaths(() => systemdUnitPath(fakeHost('linux'))),
    '/home/fixture/.config/systemd/user/pugport-node.service',
  );
  assert.equal(
    productionPaths(() =>
      systemdUnitPath(fakeHost('linux', { tmpdir: '/home/fixture', env: { XDG_CONFIG_HOME: '/cfg' } })),
    ),
    '/cfg/systemd/user/pugport-node.service',
  );
  const linux = fakeHost('linux', {
    tmpdir: '/home/fixture',
    env: { PATH: '/usr/bin:relative:/home/fixture/.local/bin:/odd:dir' },
  });
  const dirs = productionPaths(() => servicePath('/home/fixture/pugport/.runtime/node', linux));
  assert.equal(dirs[0], '/home/fixture/pugport/.runtime');
  assert.ok(dirs.includes('/usr/bin') && dirs.includes('/bin') && dirs.includes('/usr/local/bin'));
  assert.ok(!dirs.includes('relative'));
  assert.equal(new Set(dirs).size, dirs.length);
});

test('pugport node arguments', () => {
  assert.deepEqual(parseArgs(['node']), { kind: 'node', action: 'help' });
  assert.deepEqual(parseArgs(['node', 'install']), { kind: 'node', action: 'install', dryRun: false });
  assert.deepEqual(parseArgs(['node', 'install', '--dry-run']), { kind: 'node', action: 'install', dryRun: true });
  assert.deepEqual(parseArgs(['node', 'pair']), { kind: 'node', action: 'pair' });
  assert.deepEqual(parseArgs(['node', 'status', '--help']), { kind: 'node', action: 'help' });
  assert.deepEqual(parseArgs(['node', 'unpair', 'Alex', '的电脑']), {
    kind: 'node',
    action: 'unpair',
    all: false,
    target: 'Alex 的电脑',
  });
  assert.deepEqual(parseArgs(['node', 'unpair', '--all']), { kind: 'node', action: 'unpair', all: true });
  for (const argv of [
    ['node', 'bogus'],
    ['node', 'install', '--now'],
    ['node', 'pair', 'extra'],
    ['node', 'unpair'],
    ['node', 'unpair', 'x', '--all'],
  ])
    assert.equal(parseArgs(argv).kind, 'error', argv.join(' '));
});

/** A tiny in-memory file system for a fake Linux host. */
function memoryFs(files: Record<string, string> = {}) {
  const store = new Map(Object.entries(files));
  const directories: string[] = [];
  const missing = (file: string) => Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
  const fs = fakeFs({
    existsSync: (file: string) => store.has(file),
    readFileSync: (file: string) => {
      if (!store.has(file)) throw missing(file);
      return store.get(file);
    },
    writeFileSync: (file: string, text: string) => void store.set(file, text),
    mkdirSync: (file: string) => {
      directories.push(file);
    },
    rmSync: (file: string) => void store.delete(file),
  });
  return { fs, store, directories };
}

const unitFile = '/home/fixture/.config/systemd/user/pugport-node.service';
const script = '/home/fixture/pugport/dist/server/main.js';

function deps(options: {
  platform?: 'linux' | 'darwin' | 'win32';
  files?: Record<string, string>;
  reply?: (file: string, args: readonly string[]) => string | Error;
  client?: Partial<NodeClient>;
  interfaces?: NodeJS.Dict<import('node:os').NetworkInterfaceInfo[]>;
  env?: NodeJS.ProcessEnv;
}) {
  const { fs, store, directories } = memoryFs(options.files ?? { [script]: '' });
  const recorded = recordingRun(options.reply);
  const output: string[] = [];
  const errors: string[] = [];
  const value: NodeDeps = {
    host: fakeHost(options.platform ?? 'linux', {
      tmpdir: options.platform === 'darwin' ? '/Users/fixture' : '/home/fixture',
      fs,
      run: recorded.run,
      env: { USER: 'fixture', PATH: '/usr/bin:/bin', ...options.env },
    }),
    client: {
      health: async () => false,
      get: async () => {
        throw new Error('no backend');
      },
      post: async () => {
        throw new Error('no backend');
      },
      delete: async () => {
        throw new Error('no backend');
      },
      ...options.client,
    } as NodeClient,
    root: '/home/fixture/pugport',
    execPath: '/home/fixture/pugport/.runtime/node',
    electron: false,
    nodeVersion: 'v24.9.0',
    interfaces: () => options.interfaces ?? {},
    pause: async () => {},
    out: (text) => output.push(text),
    err: (text) => errors.push(text),
  };
  return { deps: value, store, directories, calls: recorded.calls, output, errors };
}

test('pugport node install writes its own unit, starts it, and lists what the owner still has to do', async () => {
  const f = deps({
    reply: (file, args) =>
      file === 'loginctl' ? 'no\n' : file === 'python3' ? new Error('No module named ensurepip') : '',
  });
  assert.equal(await runNode({ kind: 'node', action: 'install', dryRun: false }, f.deps), 0);
  const unit = f.store.get(unitFile)!;
  assert.ok(ownServiceFile(unit));
  assert.match(
    unit,
    /^ExecStart="\/home\/fixture\/pugport\/\.runtime\/node" "\/home\/fixture\/pugport\/dist\/server\/main\.js"$/m,
  );
  assert.match(unit, /^Environment="COMBORUNNER_DATA_DIR=\/home\/fixture\/\.local\/share\/pugport\/data"$/m);
  assert.deepEqual(
    f.calls.filter((call) => call.file === 'systemctl').map((call) => call.args),
    [
      ['--user', 'daemon-reload'],
      ['--user', 'enable', 'pugport-node.service'],
      ['--user', 'restart', 'pugport-node.service'],
    ],
  );
  const text = f.output.join('');
  assert.match(text, /loginctl enable-linger "\$USER"/);
  assert.match(text, /sudo apt install python3-venv/);
  assert.match(text, /sudo tailscale up/);
  assert.match(text, /ufw allow in on tailscale0 to any port 4318/);
  assert.match(text, /pugport node pair/);
  // Nothing runs through a shell.
  assert.ok(f.calls.every((call) => !['sh', 'bash', '/bin/sh'].includes(call.file)));

  // Linger already on, venv present, Tailscale up: those lines are left out.
  const ready = deps({
    reply: (file) => (file === 'loginctl' ? 'yes\n' : ''),
    interfaces: {
      tailscale0: [{ address: '100.101.102.103', family: 'IPv4', internal: false, netmask: '', mac: '', cidr: null }],
    },
  });
  assert.equal(await runNode({ kind: 'node', action: 'install', dryRun: false }, ready.deps), 0);
  const readyText = ready.output.join('');
  assert.doesNotMatch(readyText, /enable-linger|python3-venv|tailscale up/);
});

const macFile = '/Users/fixture/Library/LaunchAgents/com.pugport.node.plist';
const gone = () =>
  Object.assign(new Error('Could not find service'), { stderr: 'Could not find service com.pugport.node' });

test('Mac install boots out, waits for disappearance, then bootstraps; status and uninstall use launchctl', async () => {
  let prints = 0;
  const f = deps({
    platform: 'darwin',
    reply: (_file, args) => {
      if (args[0] === 'print') return ++prints < 3 ? 'state = running' : gone();
      return '';
    },
  });
  assert.equal(await runNode({ kind: 'node', action: 'install', dryRun: false }, f.deps), 0);
  assert.ok(f.directories.includes('/Users/fixture/Library/Logs/PugPort'));
  assert.deepEqual(
    f.calls.map((call) => [call.file, ...call.args]),
    [
      ['launchctl', 'print', 'gui/501/com.pugport.node'],
      ['launchctl', 'bootout', 'gui/501/com.pugport.node'],
      ['launchctl', 'print', 'gui/501/com.pugport.node'],
      ['launchctl', 'print', 'gui/501/com.pugport.node'],
      ['launchctl', 'bootstrap', 'gui/501', macFile],
    ],
  );
  for (const text of ['pmset -a sleep 0', 'pmset -a autorestart 1', 'Tailscale', '~/Documents'])
    assert.ok(f.output.join('').includes(text));
  const installed = deps({
    platform: 'darwin',
    files: { [macFile]: launchAgentPlist(spec, fakeHost('darwin')) },
    reply: () => 'state = running',
  });
  assert.equal(await runNode({ kind: 'node', action: 'status' }, installed.deps), 0);
  assert.match(installed.output.join(''), /已安装，正在运行/);
  let removing = false;
  installed.deps.host.run = async (_file, args) => {
    installed.calls.push({ file: 'launchctl', args: [...args] });
    if (args[0] === 'bootout') removing = true;
    if (args[0] === 'print' && removing) throw gone();
    return { stdout: '', stderr: '' };
  };
  assert.equal(await runNode({ kind: 'node', action: 'uninstall' }, installed.deps), 0);
  assert.equal(installed.store.has(macFile), false);
  assert.deepEqual(
    installed.calls.slice(-3).map((c) => c.args),
    [
      ['print', 'gui/501/com.pugport.node'],
      ['bootout', 'gui/501/com.pugport.node'],
      ['print', 'gui/501/com.pugport.node'],
    ],
  );
  assert.doesNotMatch(installed.output.join(''), /disable-linger/);
});

test('Mac refuses foreign plist, failed bootout, endless stop, and reports desktop/broken-plist hint', async () => {
  for (const action of ['install', 'uninstall'] as const) {
    const foreign = deps({ platform: 'darwin', files: { [script]: '', [macFile]: '<plist>foreign</plist>' } });
    assert.equal(await runNode({ kind: 'node', action, dryRun: false }, foreign.deps), 1);
    assert.equal(foreign.calls.length, 0);
    assert.equal(foreign.store.get(macFile), '<plist>foreign</plist>');
  }
  for (const mode of ['bootout', 'timeout', 'bootstrap'] as const) {
    const f = deps({
      platform: 'darwin',
      files: { [script]: '', [macFile]: launchAgentPlist(spec) },
      reply: (_file, args) => {
        if (mode === 'bootstrap' && args[0] === 'print') return gone();
        if (args[0] === mode) return new Error('Input/output error; Operation already in progress');
        return 'state = running';
      },
    });
    assert.equal(await runNode({ kind: 'node', action: 'install', dryRun: false }, f.deps), 1);
    assert.match(f.errors.join(''), /登录桌面.*自动登录.*plist/);
    if (mode !== 'bootstrap') assert.ok(!f.calls.some((c) => c.args[0] === 'bootstrap'));
    if (mode === 'timeout') {
      assert.equal(await runNode({ kind: 'node', action: 'uninstall' }, f.deps), 1);
      assert.ok(f.store.has(macFile));
    }
  }
});

test('an unreadable existing service file is never treated as a missing owned file', async () => {
  const f = deps({});
  f.deps.host = {
    ...f.deps.host,
    fs: fakeFs({
      existsSync: () => true,
      readFileSync: () => {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      },
      writeFileSync: () => assert.fail('must not overwrite'),
    }),
  };
  await assert.rejects(runNode({ kind: 'node', action: 'install', dryRun: false }, f.deps), /permission denied/);
  assert.equal(f.calls.length, 0);
});

test('unreadable data directory settings warn for systemd and plist syntax', () => {
  for (const [text, mac] of [
    ['Environment=COMBORUNNER_DATA_DIR=/srv/x', false],
    [' Environment="COMBORUNNER_DATA_DIR=/srv/x"', false],
    ['<key>EnvironmentVariables</key><dict><key>COMBORUNNER_DATA_DIR</key><integer>1</integer></dict>', true],
    ['<key>COMBORUNNER_DATA_DIR</key><integer>1</integer>', true],
  ] as const) {
    const warnings: string[] = [];
    assert.equal(serviceEnvironment(text, mac, (line) => warnings.push(line)).COMBORUNNER_DATA_DIR, undefined);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /COMBORUNNER_DATA_DIR/);
  }
});

test('Mac bootout error waits up to 70 seconds; disappearance on stdout permits bootstrap', async () => {
  for (const disappears of [true, false]) {
    let prints = 0,
      waited = 0;
    const f = deps({
      platform: 'darwin',
      reply: (_file, args) => {
        if (args[0] === 'bootout') return new Error('36: Operation now in progress');
        if (args[0] === 'print') {
          prints++;
          if (disappears && waited >= 40)
            return Object.assign(new Error('exit 113'), {
              stdout: 'Could not find service com.pugport.node',
              stderr: '',
            });
          return 'state = running';
        }
        return '';
      },
    });
    f.deps.pause = async (ms) => {
      assert.equal(ms, 1000);
      waited++;
    };
    assert.equal(await runNode({ kind: 'node', action: 'install', dryRun: false }, f.deps), disappears ? 0 : 1);
    assert.equal(waited, disappears ? 40 : 70);
    assert.equal(prints, disappears ? 42 : 72);
    assert.equal(
      f.calls.some((c) => c.args[0] === 'bootstrap'),
      disappears,
    );
    if (!disappears) assert.match(f.errors.join(''), /70 秒/);
  }
});

test('service escaping round trips; reinstall and dry-run preserve, override or remove settings', async () => {
  const values = {
    PUGPORT_PORT: '5319',
    PUGPORT_PEER_PORT: '5444',
    PUGPORT_PEER_HOST: '127.0.0.1',
    PUGPORT_NODE_FEATURES: 'images,%"\\&<',
    PUGPORT_PEER_READ_ONLY: '1',
    COMBORUNNER_DATA_DIR: '/odd/%"\\&<',
  };
  for (const mac of [false, true]) {
    const platform = mac ? 'darwin' : 'linux';
    const render = (env: Record<string, string>) => {
      const { COMBORUNNER_DATA_DIR, ...rest } = env;
      const settings = { ...spec, dataDir: COMBORUNNER_DATA_DIR, env: rest };
      return mac ? launchAgentPlist(settings) : systemdUnit(settings);
    };
    const text = render(values);
    const parsed = serviceEnvironment(text, mac, (line) => assert.fail(line));
    for (const [key, value] of Object.entries(values)) assert.equal(parsed[key], value);
    for (const dryRun of [true, false]) {
      const f = deps({
        platform,
        files: { [script]: '', [mac ? macFile : unitFile]: text },
        reply: (_file, args) => (args[0] === 'print' ? gone() : ''),
      });
      if (!mac) f.deps.host.run = async () => ({ stdout: 'yes', stderr: '' });
      assert.equal(await runNode({ kind: 'node', action: 'install', dryRun }, f.deps), 0);
      const kept = serviceEnvironment(
        dryRun ? f.output.join('') : f.store.get(mac ? macFile : unitFile)!,
        mac,
        assert.fail,
      );
      for (const [key, value] of Object.entries(values)) assert.equal(kept[key], value);
      assert.doesNotMatch(f.errors.join(''), /PUGPORT_PEER_ALLOW_WRITE/);
    }
    for (const override of ['', '0']) {
      const f = deps({
        platform,
        files: { [script]: '', [mac ? macFile : unitFile]: text },
        env: Object.fromEntries(Object.keys(values).map((key) => [key, override])),
      });
      assert.equal(await runNode({ kind: 'node', action: 'install', dryRun: true }, f.deps), 0);
      const parsed = serviceEnvironment(f.output.join(''), mac, assert.fail);
      for (const key of Object.keys(values)) assert.equal(parsed[key], override || undefined);
    }
    for (const old of [text, render({})]) {
      const f = deps({
        platform,
        files: { [script]: '', [mac ? macFile : unitFile]: old },
        env: { PUGPORT_PEER_ALLOW_WRITE: '1' },
      });
      await runNode({ kind: 'node', action: 'install', dryRun: true, fromNodeAdd: true }, f.deps);
      assert.equal(serviceEnvironment(f.output.join(''), mac, assert.fail).PUGPORT_PEER_ALLOW_WRITE, undefined);
    }
  }
  const warnings: string[] = [];
  serviceEnvironment('Environment=PUGPORT_PEER_PORT="bad"', false, (line) => warnings.push(line));
  serviceEnvironment(
    '<key>EnvironmentVariables</key><dict><key>PUGPORT_BAD</key><integer>1</integer></dict>',
    true,
    (line) => warnings.push(line),
  );
  assert.equal(warnings.length, 2);
});

test('pair and status JSON contain only the machine-readable contract, including node name and active total', async () => {
  const f = deps({
    reply: () => 'a'.repeat(40),
    client: {
      health: async () => true,
      get: async <T>(path: string) => (path.includes('active=1') ? { total: 7 } : nodeStatus) as T,
      post: async <T>() => ({ code: 'SECRET-CODE', expiresAt: '2026-10-20T22:00:00Z', peer: nodeStatus.peer }) as T,
    },
  });
  assert.equal(await runNode({ kind: 'node', action: 'pair', json: true }, f.deps), 0);
  assert.deepEqual(JSON.parse(f.output.pop()!), { code: 'SECRET-CODE', expiresAt: '2026-10-20T22:00:00Z' });
  assert.equal(await runNode({ kind: 'node', action: 'status', json: true }, f.deps), 0);
  assert.deepEqual(JSON.parse(f.output.pop()!), {
    name: nodeStatus.name,
    peer: nodeStatus.peer,
    running: 7,
    version: APP_VERSION,
    commit: 'a'.repeat(40),
  });
  assert.deepEqual(f.calls.at(-1)!.args, ['-C', f.deps.root, 'rev-parse', 'HEAD']);
  f.deps.host.run = async () => {
    throw new Error('not a repo');
  };
  await runNode({ kind: 'node', action: 'status', json: true }, f.deps);
  assert.equal(JSON.parse(f.output.pop()!).commit, null);
  assert.deepEqual(parseArgs(['node', 'pair', '--json']), { kind: 'node', action: 'pair', json: true });
});

test("pugport node reaches the installed node's own port, never the desktop app's 4317", () => {
  const owned = (port?: string) => {
    const settings: NodeServiceSpec = { ...spec, env: port ? { PUGPORT_PORT: port } : {} };
    return { [unitFile]: systemdUnit(settings), [macFile]: launchAgentPlist(settings, fakeHost('darwin')) };
  };
  for (const platform of ['linux', 'darwin'] as const) {
    const port = (files: Record<string, string>, env: NodeJS.ProcessEnv = {}) =>
      nodeBackendPort(deps({ platform, files, env }).deps.host);
    assert.equal(port({}), 4319, platform);
    assert.equal(port(owned()), 4319);
    assert.equal(port(owned('5319')), 5319);
    assert.equal(port(owned('5319'), { PUGPORT_PORT: '6319' }), 6319);
    // CLIs started by the desktop app inherit its COMBORUNNER_PORT.
    assert.equal(port(owned('5319'), { COMBORUNNER_PORT: '4317' }), 5319);
    assert.equal(port({}, { COMBORUNNER_PORT: '4317' }), 4319);
    assert.equal(port({ [unitFile]: 'Environment="PUGPORT_PORT=4317"', [macFile]: 'someone else' }), 4319);
    assert.equal(port(owned('not a port')), 4319);
  }
});

test("pugport node install refuses the desktop app's data folder and writes nothing", async () => {
  for (const platform of ['linux', 'darwin'] as const) {
    const mac = platform === 'darwin';
    const desktop = mac
      ? '/Users/fixture/Library/Application Support/ComboRunner/data'
      : '/home/fixture/.config/ComboRunner/data';
    const old = mac
      ? launchAgentPlist({ ...spec, dataDir: desktop }, fakeHost('darwin'))
      : systemdUnit({ ...spec, dataDir: desktop });
    // From the environment, or kept from the installed service.
    const cases: [Record<string, string>, NodeJS.ProcessEnv][] = [
      [{ [script]: '' }, { COMBORUNNER_DATA_DIR: desktop }],
      [{ [script]: '', [mac ? macFile : unitFile]: old }, {}],
    ];
    for (const [files, env] of cases) {
      const f = deps({ platform, files, env });
      const before = new Map(f.store);
      assert.equal(await runNode({ kind: 'node', action: 'install', dryRun: false }, f.deps), 1);
      assert.match(f.errors.join(''), /桌面版 PugPort 的数据目录/);
      assert.deepEqual(f.store, before);
      assert.deepEqual(f.calls, []);
    }
  }
});

test('pugport node install: dry run writes nothing, a foreign unit is left alone, other systems are told plainly', async () => {
  const dry = deps({ env: { PUGPORT_NODE_FEATURES: 'images', PUGPORT_PEER_PORT: '5000', PUGPORT_PEER_HOST: 'x' } });
  assert.equal(await runNode({ kind: 'node', action: 'install', dryRun: true }, dry.deps), 0);
  assert.equal(dry.store.has(unitFile), false);
  assert.equal(dry.calls.length, 0);
  assert.match(dry.output.join(''), /会写入 \/home\/fixture\/\.config\/systemd\/user\/pugport-node\.service/);
  // Node settings given when installing are kept; nothing else from the shell is.
  assert.match(dry.output.join(''), /^Environment="PUGPORT_NODE_FEATURES=images"$/m);
  assert.match(dry.output.join(''), /^Environment="PUGPORT_PEER_PORT=5000"$/m);
  assert.match(dry.output.join(''), /^Environment="PUGPORT_PEER_HOST=x"$/m);

  const foreign = deps({ files: { [script]: '', [unitFile]: '[Unit]\nDescription=mine\n' } });
  assert.equal(await runNode({ kind: 'node', action: 'install', dryRun: false }, foreign.deps), 1);
  assert.equal(foreign.store.get(unitFile), '[Unit]\nDescription=mine\n');
  assert.match(foreign.errors.join(''), /不是 pugport 写的/);

  const unbuilt = deps({ files: {} });
  assert.equal(await runNode({ kind: 'node', action: 'install', dryRun: false }, unbuilt.deps), 1);
  assert.match(unbuilt.errors.join(''), /还没构建/);

  for (const platform of ['win32'] as const) {
    const other = deps({ platform });
    assert.equal(await runNode({ kind: 'node', action: 'install', dryRun: false }, other.deps), 1);
    assert.match(other.errors.join(''), /只支持 Linux/);
  }

  const failing = deps({
    reply: (file) =>
      file === 'systemctl' ? Object.assign(new Error('x'), { stderr: 'Failed to connect to bus\n' }) : '',
  });
  assert.equal(await runNode({ kind: 'node', action: 'install', dryRun: false }, failing.deps), 1);
  assert.match(failing.errors.join(''), /Failed to connect to bus/);
});

const nodeStatus = {
  role: 'node',
  name: 'ubuntu-box',
  peer: { port: 4318, status: 'listening', host: '100.101.102.103' },
  peers: [{ id: '6f9619ff-8b86-4d11-b42d-00c04fc964ff', name: 'Desk', pairedAt: '2026-10-11T08:00:00Z' }],
  slackHost: false,
  allowWrite: false,
  execPath: '/Users/fixture/pugport/.runtime/node-v24-fixture/bin/node',
};

test('pugport node pair prints the code and the address to type on the desktop', async () => {
  const posted: string[] = [];
  const f = deps({
    client: {
      health: async () => true,
      get: async <T>() => nodeStatus as T,
      post: async <T>(path: string) => {
        posted.push(path);
        return {
          code: 'ABCD-EFGH',
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          peer: nodeStatus.peer,
        } as T;
      },
    },
  });
  assert.equal(await runNode({ kind: 'node', action: 'pair' }, f.deps), 0);
  assert.deepEqual(posted, ['/api/node/pairing']);
  const text = f.output.join('');
  assert.match(text, /配对码：ABCD-EFGH（10 分钟内有效，只能用一次）/);
  assert.match(text, /地址：100\.101\.102\.103:4318/);

  const down = deps({});
  assert.equal(await runNode({ kind: 'node', action: 'pair' }, down.deps), 1);
  assert.match(down.errors.join(''), /没有在运行/);
  const desktop = deps({ client: { health: async () => true, get: async <T>() => ({ role: 'desktop' }) as T } });
  assert.equal(await runNode({ kind: 'node', action: 'pair' }, desktop.deps), 1);
  assert.match(desktop.errors.join(''), /不是设备节点/);
});

test('pugport node status, unpair and uninstall', async () => {
  const unit = systemdUnit(spec);
  const deleted: string[] = [];
  const f = deps({
    files: { [script]: '', [unitFile]: unit },
    reply: (file, args) => (file === 'systemctl' && args.includes('is-active') ? 'active\n' : ''),
    client: {
      health: async () => true,
      get: async <T>() => nodeStatus as T,
      delete: async <T>(path: string) => {
        deleted.push(path);
        return nodeStatus as T;
      },
    },
  });
  assert.equal(await runNode({ kind: 'node', action: 'status' }, f.deps), 0);
  const text = f.output.join('');
  assert.match(text, /服务：已安装，正在运行/);
  assert.match(text, /对外地址：100\.101\.102\.103:4318（只接受 Tailscale）/);
  assert.match(text, /已配对 1 台电脑：Desk/);
  assert.ok(text.includes(`Node 可执行文件：${nodeStatus.execPath}`));

  assert.equal(await runNode({ kind: 'node', action: 'unpair', all: false, target: 'desk' }, f.deps), 0);
  assert.deepEqual(deleted, ['/api/node/peers/6f9619ff-8b86-4d11-b42d-00c04fc964ff']);
  assert.equal(await runNode({ kind: 'node', action: 'unpair', all: false, target: 'Laptop' }, f.deps), 1);
  assert.match(f.errors.join(''), /没有叫“Laptop”/);
  assert.equal(await runNode({ kind: 'node', action: 'unpair', all: true }, f.deps), 0);
  assert.equal(deleted.at(-1), '/api/node/peers');

  assert.equal(await runNode({ kind: 'node', action: 'uninstall' }, f.deps), 0);
  assert.equal(f.store.has(unitFile), false);
  assert.ok(
    f.calls.some(
      (call) => call.file === 'systemctl' && call.args.join(' ') === '--user disable --now pugport-node.service',
    ),
  );
  assert.match(f.output.join(''), /数据还在 \/home\/fixture\/\.local\/share\/pugport\/data/);

  const foreign = deps({ files: { [unitFile]: '[Unit]\n' } });
  assert.equal(await runNode({ kind: 'node', action: 'uninstall' }, foreign.deps), 1);
  assert.equal(foreign.store.get(unitFile), '[Unit]\n');
  assert.ok(!foreign.calls.some((call) => call.file === 'systemctl'));

  const waiting = deps({
    client: {
      health: async () => true,
      get: async <T>() => ({ ...nodeStatus, peer: { port: 4318, status: 'waiting' }, peers: [] }) as T,
    },
  });
  assert.equal(await runNode({ kind: 'node', action: 'status' }, waiting.deps), 0);
  assert.match(waiting.output.join(''), /正在等 Tailscale 地址/);
  assert.match(waiting.output.join(''), /服务：没有安装/);
});
