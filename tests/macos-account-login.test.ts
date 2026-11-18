import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createNativeAccount, launchAccountLogin, nativeAccountLoginPending } from '../src/server/native-accounts.ts';
import type { RuntimeTarget } from '../src/shared/types.ts';

async function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pugport-mac-login-'中文-$()-")));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = join(root, 'default');
  t.after(() => {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const command = join(root, "login's cli");
  writeFileSync(
    command,
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const home = process.env.CLAUDE_CONFIG_DIR;
fs.writeFileSync(path.join(home, 'observed.json'), JSON.stringify({
  args: process.argv.slice(2),
  env: process.env,
  state: JSON.parse(fs.readFileSync(path.join(home, '.comborunner-login.json'), 'utf8')),
}));
const timer = setInterval(() => {
  if (fs.existsSync(path.join(home, 'release'))) { clearInterval(timer); process.exit(0); }
}, 20);
`,
    { mode: 0o700 },
  );
  const base: RuntimeTarget = {
    id: 'claude-native',
    provider: 'claude',
    label: 'Claude fixture',
    command,
    args: [],
    environment: 'native',
    enabled: true,
  };
  return { root, target: await createNativeAccount(root, base, 'Synthetic account') };
}

const mac = { skip: process.platform !== 'darwin' };

test(
  'macOS login runs the official arguments in an isolated terminal environment and tracks its real lifetime',
  mac,
  async (t) => {
    const { target, root } = await fixture(t);
    let runner: ChildProcess | undefined;
    let closed: Promise<unknown> | undefined;
    let file = '';
    let script = '';
    const before = JSON.stringify(process.env);
    t.after(async () => {
      runner?.kill('SIGHUP');
      await closed;
    });
    const result = await launchAccountLogin(target, (command, args, options) => {
      assert.equal(command, '/usr/bin/open');
      assert.deepEqual(args.slice(0, 2), ['-a', 'Terminal']);
      assert.equal(options.cwd, target.accountHome);
      assert.equal(options.shell, false);
      file = args[2]!;
      assert.equal(statSync(file).mode & 0o777, 0o700);
      script = readFileSync(file, 'utf8');
      const child = new EventEmitter() as ChildProcess;
      runner = spawn(file, [], {
        cwd: root,
        env: {
          HOME: root,
          PATH: process.env.PATH,
          USER: 'synthetic-user',
          ANTHROPIC_API_KEY: 'synthetic-terminal-key',
          CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-terminal-token',
          CLAUDE_SECURESTORAGE_CONFIG_DIR: 'another-keychain-slot',
          CLAUDE_CONFIG_DIR: 'another-profile',
          GROK_HOME: 'another-grok-profile',
          GOOGLE_APPLICATION_CREDENTIALS: 'another-google-profile',
          NODE_OPTIONS: '--require=/synthetic/missing.cjs',
          HTTPS_PROXY: 'http://synthetic-proxy.invalid',
        },
        stdio: 'pipe',
      });
      closed = once(runner, 'close');
      queueMicrotask(() => child.emit('close', 0));
      return child;
    });
    assert.deepEqual(result, { opened: true });
    assert.equal(nativeAccountLoginPending(target), true);
    await assert.rejects(
      launchAccountLogin(target, () => {
        throw new Error('duplicate launch');
      }),
      /登录仍在进行/,
    );
    writeFileSync(join(target.accountHome!, 'release'), '');
    await closed;
    assert.equal(runner!.exitCode, 0);
    const observed = JSON.parse(readFileSync(join(target.accountHome!, 'observed.json'), 'utf8'));
    assert.deepEqual(observed.args, ['auth', 'login', '--claudeai']);
    assert.equal(observed.env.CLAUDE_CONFIG_DIR, target.accountHome);
    assert.equal(observed.env.HOME, root);
    assert.equal(observed.env.HTTPS_PROXY, 'http://synthetic-proxy.invalid');
    for (const key of [
      'ANTHROPIC_API_KEY',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_SECURESTORAGE_CONFIG_DIR',
      'GROK_HOME',
      'GOOGLE_APPLICATION_CREDENTIALS',
      'NODE_OPTIONS',
      'ELECTRON_RUN_AS_NODE',
    ])
      assert.equal(observed.env[key], undefined, key);
    assert.equal(observed.state.phase, 'running');
    assert.equal(observed.state.pid, runner!.pid);
    assert.notEqual(observed.state.pid, process.pid);
    const state = JSON.parse(readFileSync(join(target.accountHome!, '.comborunner-login.json'), 'utf8'));
    assert.equal(state.phase, 'finished');
    assert.equal(nativeAccountLoginPending(target), false);
    assert.equal(existsSync(file), false);
    assert.equal(script.includes('synthetic-terminal-key'), false);
    assert.equal(script.includes('synthetic-terminal-token'), false);
    assert.ok(JSON.stringify(process.env) === before, 'the parent environment remains unchanged');
  },
);

test('macOS terminal launch errors remove the exact pending lock and allow retry', mac, async (t) => {
  const { target } = await fixture(t);
  for (const mode of ['error', 'close', 'throw']) {
    let file = '';
    await assert.rejects(
      launchAccountLogin(target, (_command, args) => {
        file = args[2]!;
        if (mode === 'throw') throw new Error('synthetic-secret');
        const child = new EventEmitter() as ChildProcess;
        queueMicrotask(() =>
          mode === 'error' ? child.emit('error', new Error('synthetic-secret')) : child.emit('close', 1),
        );
        return child;
      }),
      { message: '无法打开独立账号登录终端。' },
    );
    assert.equal(existsSync(file), false);
    assert.equal(existsSync(join(target.accountHome!, '.comborunner-login.json')), false);
    assert.equal(nativeAccountLoginPending(target), false);
  }
});

test('macOS wrapper refuses a replaced login nonce and leaves the new lock intact', mac, async (t) => {
  const { target, root } = await fixture(t);
  const marker = join(target.accountHome!, '.comborunner-login.json');
  let closed: Promise<unknown> | undefined;
  let runner: ChildProcess | undefined;
  const replacement = '11111111-1111-4111-8111-111111111111';
  await assert.rejects(
    launchAccountLogin(target, (_command, args) => {
      const state = JSON.parse(readFileSync(marker, 'utf8'));
      writeFileSync(marker, JSON.stringify({ ...state, nonce: replacement }));
      runner = spawn(args[2]!, [], { cwd: root, env: { HOME: root, PATH: process.env.PATH }, stdio: 'pipe' });
      closed = once(runner, 'close');
      const child = new EventEmitter() as ChildProcess;
      runner.once('close', () => child.emit('close', 1));
      return child;
    }),
    /无法打开独立账号登录终端/,
  );
  await closed;
  assert.equal(runner!.exitCode, 1);
  assert.equal(existsSync(join(target.accountHome!, 'observed.json')), false);
  assert.equal(JSON.parse(readFileSync(marker, 'utf8')).nonce, replacement);
});

test('macOS login keeps a live terminal locked when the opener reports failure', mac, async (t) => {
  const { target } = await fixture(t);
  const marker = join(target.accountHome!, '.comborunner-login.json');
  await assert.rejects(
    launchAccountLogin(target, () => {
      const state = JSON.parse(readFileSync(marker, 'utf8'));
      writeFileSync(marker, JSON.stringify({ ...state, phase: 'running', pid: process.pid }));
      const child = new EventEmitter() as ChildProcess;
      queueMicrotask(() => child.emit('close', 1));
      return child;
    }),
    /无法打开独立账号登录终端/,
  );
  assert.equal(nativeAccountLoginPending(target), true);
  assert.equal(existsSync(marker), true);
});
