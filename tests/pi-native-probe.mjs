// Explicit integration probe: no model request, no project tools and no session persistence.
// Run manually with `.runtime/node.exe tests/pi-native-probe.mjs` after installing Pi.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = process.cwd();
const codemode = process.argv.includes('--codemode');
const built = process.argv.includes('--built');
const home = mkdtempSync(join(tmpdir(), 'pugport-pi-probe-'));
const env = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => /^(path|systemroot|windir|comspec|pathext|temp|tmp)$/i.test(name)),
);
const child = spawn(
  process.execPath,
  [
    join(root, 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'),
    '--mode',
    'rpc',
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates',
    '--no-themes',
    '--no-approve',
    '--no-context-files',
    ...(codemode ? ['--tools', 'read,codemode'] : ['--no-tools']),
    '--no-mcp',
    '--no-session',
    '--extension',
    join(root, built ? 'dist/server/pi-extension.mjs' : 'src/server/pi-extension.mjs'),
  ],
  {
    cwd: home,
    env: {
      ...env,
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, 'roaming'),
      LOCALAPPDATA: join(home, 'local'),
      XDG_CONFIG_HOME: join(home, 'config'),
      XDG_CACHE_HOME: join(home, 'cache'),
      PI_CODING_AGENT_DIR: home,
      ELECTRON_RUN_AS_NODE: '1',
      PI_OFFLINE: '1',
      PI_SKIP_VERSION_CHECK: '1',
      PI_TELEMETRY: '0',
      COMBORUNNER_PI_CODEMODE: codemode ? 'on' : '',
      COMBORUNNER_PI_PERMISSION_MODE: 'read-only',
    },
    stdio: 'pipe',
    windowsHide: true,
  },
);
child.stderr.resume();
child.stdin.on('error', () => {});
let buffer = '',
  counter = 0,
  allowed = true,
  activeNotification;
const pending = new Map();
const response = (packet) => child.stdin.write(`${JSON.stringify(packet)}\n`);
function request(type, fields = {}) {
  return new Promise((resolve, reject) => {
    const id = `probe-${++counter}`;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Pi probe timed out: ${type}`));
    }, 20000);
    pending.set(id, { resolve, reject, timeout });
    response({ type, id, ...fields });
  });
}
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    let packet;
    try {
      packet = JSON.parse(line);
    } catch {
      continue;
    }
    if (packet.type === 'response') {
      const waiter = pending.get(packet.id);
      if (waiter) {
        pending.delete(packet.id);
        clearTimeout(waiter.timeout);
        packet.success
          ? waiter.resolve(packet.data)
          : waiter.reject(new Error(`Pi probe command failed: ${packet.command}`));
      }
    }
    if (packet.type === 'extension_ui_request') {
      if (packet.method === 'confirm') response({ type: 'extension_ui_response', id: packet.id, confirmed: allowed });
      if (
        packet.method === 'notify' &&
        typeof packet.message === 'string' &&
        packet.message.startsWith('studio-permissions-probe:')
      )
        activeNotification?.(packet.message);
    }
  }
});

try {
  assert.equal((await request('get_state')).isStreaming, false);
  assert.deepEqual((await request('get_available_models')).models, []);
  const commands = await request('get_commands');
  assert.ok(
    commands.commands.some((command) => command.name === 'studio-permissions-v1' && command.source === 'extension'),
  );
  assert.equal(
    commands.commands.some((command) => command.name === 'studio-codemode-v1' && command.source === 'extension'),
    codemode,
  );
  for (const decision of [true, false]) {
    allowed = decision;
    let timer;
    const notification = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Pi approval notification timed out')), 12000);
      activeNotification = (message) => {
        clearTimeout(timer);
        resolve(message);
      };
    });
    await request('prompt', { message: '/studio-permissions-v1 probe' });
    assert.equal(
      await notification,
      decision ? 'studio-permissions-probe:approved' : 'studio-permissions-probe:denied',
    );
  }
  console.log(
    JSON.stringify({
      piVersion: JSON.parse(
        readFileSync(join(root, 'node_modules/@earendil-works/pi-coding-agent/package.json'), 'utf8'),
      ).version,
      isolatedStateAndModels: true,
      extensionLoaded: true,
      builtExtension: built,
      mixedCodemodeLoaded: codemode,
      approvalRoundTrip: true,
      denialRoundTrip: true,
      modelRequests: 0,
      projectToolCalls: 0,
    }),
  );
} finally {
  for (const waiter of pending.values()) clearTimeout(waiter.timeout);
  const exited = once(child, 'close');
  child.stdin.end();
  const timeout = setTimeout(() => child.kill(), 3000);
  await exited;
  clearTimeout(timeout);
  rmSync(home, { recursive: true, force: true });
}
