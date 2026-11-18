import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Controller } from '../src/server/controller.ts';
import { launchAccountLogin } from '../src/server/native-accounts.ts';
import { currentHost } from '../src/server/platform/host.ts';
import type { AppState, RuntimeTarget } from '../src/shared/types.ts';
import { findNode, nextTurn, uiBundle, uiHarness } from './helpers/ui-harness.ts';

const bundle = uiBundle('src/ui/Executors.tsx');

test(
  'macOS can create and sign in a second Codex account without replacing the first login',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pugport-codex-mac-ui-')));
    const originalHome = process.env.CODEX_HOME;
    const defaultHome = join(root, 'default-codex');
    mkdirSync(defaultHome);
    const originalAuth = JSON.stringify({ token: 'synthetic-original-login' });
    writeFileSync(join(defaultHome, 'auth.json'), originalAuth);
    process.env.CODEX_HOME = defaultHome;
    let controller: Controller | undefined;
    let runner: ChildProcess | undefined;
    let closed: Promise<unknown> | undefined;
    t.after(async () => {
      runner?.kill();
      await closed;
      await controller?.close();
      if (originalHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = originalHome;
      rmSync(root, { recursive: true, force: true });
    });
    const command = join(root, 'synthetic-codex');
    writeFileSync(
      command,
      `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
fs.writeFileSync(path.join(process.env.CODEX_HOME, 'observed.json'), JSON.stringify({
  args: process.argv.slice(2), home: process.env.CODEX_HOME,
  userHome: process.env.HOME, apiKey: process.env.OPENAI_API_KEY,
}));
fs.writeFileSync(path.join(process.env.CODEX_HOME, 'auth.json'), 'synthetic-second-login');
`,
      { mode: 0o700 },
    );
    let launched: RuntimeTarget | undefined;
    controller = new Controller(root, join(root, 'data'), {
      readAccountIdentity: () => undefined,
      nativeLogin: {
        pending: (target) => target.id === launched?.id,
        launch: async (target) => {
          launched = target;
          return launchAccountLogin(target, (file, args) => {
            assert.equal(file, '/usr/bin/open');
            assert.deepEqual(args.slice(0, 2), ['-a', 'Terminal']);
            runner = spawn(args[2]!, [], {
              env: { HOME: root, PATH: process.env.PATH, CODEX_HOME: defaultHome, OPENAI_API_KEY: 'synthetic-key' },
              stdio: 'pipe',
            });
            closed = once(runner, 'close');
            const opener = new EventEmitter() as ChildProcess;
            queueMicrotask(() => opener.emit('close', 0));
            return opener;
          });
        },
      },
    });
    clearInterval(controller.timer);
    const first: RuntimeTarget = {
      id: 'codex-native',
      provider: 'codex',
      label: 'Codex',
      command,
      commandDiscovery: 'fixed',
      environment: 'native',
      enabled: true,
    };
    controller.targets = [first];
    const harness = uiHarness(await bundle);
    t.after(() => harness.unmount());
    const calls: string[] = [];
    const notices: Array<{ message: string }> = [];
    let completed = false;
    let submitted: Promise<unknown> | undefined;
    const props = {
      state: { app: { platform: 'darwin' }, targets: [first], runtimes: [], settings: {} } as unknown as AppState,
      accounts: controller.nativeAccounts(),
      api: (path: string, body: { provider: string; label: string }) => {
        calls.push(path);
        if (path === '/api/accounts') submitted = controller!.addNativeAccount(body.provider, body.label);
        else submitted = controller!.loginNativeAccount(decodeURIComponent(path.split('/')[3]!));
        return submitted;
      },
      notify: (notice: { message: string }) => notices.push(notice),
      reload: async () => {},
      onClose: () => {
        completed = true;
      },
    };
    let tree = harness.render('AddDialog', props);
    findNode(tree, (node) => node.type === 'input' && node.props.maxLength === 60)!.props.onChange({
      target: { value: 'Codex Work' },
    });
    tree = harness.render('AddDialog', props);
    const button = findNode(tree, (node) => node.props.className === 'button primary')!;
    assert.equal(button.props.disabled, false, 'macOS advertises supported login to the real dialog');
    button.props.onClick();
    await submitted;
    await nextTurn();
    await submitted;
    await nextTurn();
    await closed;
    assert.equal(completed, true, notices.map((notice) => notice.message).join('\n'));
    assert.equal(runner!.exitCode, 0);
    assert.deepEqual(calls, ['/api/accounts', `/api/accounts/${launched!.id}/login`]);
    assert.notEqual(launched!.id, first.id);
    assert.equal(launched!.label, 'Codex Work');
    assert.equal(launched!.enabled, false, 'a new account is not dispatched before identity verification');
    const observed = JSON.parse(readFileSync(join(launched!.accountHome!, 'observed.json'), 'utf8'));
    assert.deepEqual(observed.args, [
      '-c',
      'cli_auth_credentials_store="file"',
      '-c',
      'forced_login_method="chatgpt"',
      'login',
      '--device-auth',
    ]);
    assert.equal(observed.home, launched!.accountHome);
    assert.equal(observed.userHome, root);
    assert.equal(observed.apiKey, undefined);
    assert.equal(readFileSync(join(defaultHome, 'auth.json'), 'utf8'), originalAuth);
    assert.equal(readFileSync(join(launched!.accountHome!, 'auth.json'), 'utf8'), 'synthetic-second-login');
  },
);

test('native account choices retain the host login limit and the Windows-only Cursor limit', () => {
  const controller = Object.create(Controller.prototype) as Controller;
  controller.targets = [];
  const host = currentHost();
  const original = Object.getOwnPropertyDescriptor(host, 'platform')!;
  try {
    for (const platform of ['darwin', 'linux'] as const) {
      Object.defineProperty(host, 'platform', { ...original, value: platform });
      const providers = controller.nativeAccounts().providers;
      assert.equal(providers.find((provider) => provider.id === 'codex')!.supported, platform === 'darwin');
      assert.equal(providers.find((provider) => provider.id === 'claude')!.supported, platform === 'darwin');
      if (process.platform !== 'win32')
        assert.equal(providers.find((provider) => provider.id === 'cursor')!.supported, false);
    }
  } finally {
    Object.defineProperty(host, 'platform', original);
  }
});
