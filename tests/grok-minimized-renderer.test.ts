import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, realpath, readFile, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import electron from 'electron';
import { waitForElectronCpu } from './helpers/electron-cpu.ts';
import { electronArgs, electronLoader } from './helpers/electron-app.cjs';

if (process.env.PUGPORT_VISIBLE_TESTS !== '1') {
  test.skip('visible Grok minimize/focus test: requires PUGPORT_VISIBLE_TESTS=1; creates real windows');
} else
  for (const [run, scenario] of (['restore', 'restore', 'restore', 'switched', 'background'] as const).entries()) {
    test(
      `main minimizes synthetic Grok and respects PugPort focus: ${scenario} (run ${run + 1})`,
      { skip: process.platform !== 'win32', timeout: 150_000 },
      async (t) => {
        const directory = await realpath(await mkdtemp(join(tmpdir(), 'pugport-minimized-')));
        t.after(async () => {
          assert.equal(dirname(directory).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
          assert.ok(basename(directory).startsWith('pugport-minimized-'));
          await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        });
        await copyFile('tests/helpers/grok-minimized-app.cjs', join(directory, 'child.cjs'));
        const main = join(directory, 'main.cjs');
        await build({
          stdin: {
            resolveDir: process.cwd(),
            loader: 'ts',
            contents: `
import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { startGrokBot } from './src/electron/grok-bot-launch.ts';
import { fakeHost, fakeTree } from './tests/helpers/fake-host.ts';
import { waitForElectronCpu } from './tests/helpers/electron-cpu.ts';
app.setPath('userData', join(__dirname, 'parent-profile'));
app.disableHardwareAcceleration();
setTimeout(() => app.exit(1), 120000);
app.whenReady().then(async () => {
  try {
    const scenario = ${JSON.stringify(scenario)};
    const window = new BrowserWindow({ width: 420, height: 240, webPreferences: { sandbox: true } });
    const other = new BrowserWindow({ show: false, width: 320, height: 200, webPreferences: { sandbox: true } });
    window.webContents.session.webRequest.onBeforeRequest((details, done) => done({ cancel: !details.url.startsWith('data:') }));
    await window.loadURL('data:text/html,<title>Synthetic PugPort focus</title>');
    window.show();
    window.setAlwaysOnTop(true);
    window.focus();
    window.setAlwaysOnTop(false);
    await sleep(500);
    assert.equal(window.isFocused(), true, 'previous window must be focused first');
    const executable = 'C:\\\\Synthetic\\\\Programs\\\\Grok Bot\\\\Grok Bot.exe';
    const host = fakeHost('win32', {
      env: { ...process.env, LOCALAPPDATA: 'C:\\\\Synthetic', ELECTRON_RUN_AS_NODE: '1', PUGPORT_SYNTHETIC: '1' },
      fs: fakeTree({ [executable]: 'file' }),
    });
    await waitForElectronCpu();
    const focusOther = () => { other.show(); other.setAlwaysOnTop(true); other.focus(); other.setAlwaysOnTop(false); };
    if (scenario === 'background') focusOther();
    const focusedHandle = window.isFocused() ? window.getNativeWindowHandle() : undefined;
    if (scenario !== 'background') assert.ok(focusedHandle, 'PugPort must still be focused at launch');
    await startGrokBot(host, (command, args, options) => {
      // Substitute only the app executable and entry; use the production PowerShell unchanged.
      const child = command === executable
        ? spawn(${JSON.stringify(electron)}, [${JSON.stringify(electronLoader)}, join(__dirname, 'child.cjs'), scenario === 'restore' ? '0' : '3500'], { ...options, env: { ...options.env, PUGPORT_VISIBLE_TESTS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
        : spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
      child.stderr?.on('data', (data) => console.error(data.toString()));
      return child;
    }, focusedHandle);
    if (scenario === 'switched') { await sleep(500); focusOther(); }
    const deadline = Date.now() + 35000;
    while (!existsSync(join(__dirname, 'child.json'))) {
      assert.ok(Date.now() < deadline, 'synthetic child did not report');
      await sleep(100);
    }
    const result = { ...JSON.parse(readFileSync(join(__dirname, 'child.json'), 'utf8')),
      previousFocused: window.isFocused() };
    writeFileSync(join(__dirname, 'result.json'), JSON.stringify(result), 'utf8');
    assert.deepEqual(result, { minimized: true, focused: false,
      inheritedNodeMode: null, inheritedPugPort: null, previousFocused: scenario === 'restore' });
    if (scenario !== 'restore') assert.equal(other.isFocused(), true, 'keep the window the user selected');
    await sleep(1500);
    console.log('PASS: minimized=true previousFocused=' + window.isFocused() + ' scenario=' + scenario);
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});`,
          },
          outfile: main,
          bundle: true,
          platform: 'node',
          format: 'cjs',
          packages: 'external',
        });
        const env: NodeJS.ProcessEnv = { ...process.env, PUGPORT_UNDER_TEST: '1' };
        delete env.ELECTRON_RUN_AS_NODE;
        await waitForElectronCpu();
        const result = await promisify(execFile)(electron as unknown as string, electronArgs(main), {
          env,
          windowsHide: true,
          timeout: 125_000,
        }).catch((error) => {
          console.error(error.stdout);
          throw error;
        });
        assert.match(result.stdout, /PASS: minimized=true/);
        console.log(result.stdout.trim());
        assert.equal(JSON.parse(await readFile(join(directory, 'result.json'), 'utf8')).minimized, true);
      },
    );
  }
