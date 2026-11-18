import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { electronArgs } from './helpers/electron-app.cjs';
import { offscreenElectronEnv } from './helpers/offscreen-electron.cjs';

const electron = createRequire(import.meta.url)('electron') as string;
const report =
  "const { app } = require('electron'); console.log(JSON.stringify([app.getAppPath(), app.name, app.getVersion(), process.argv.slice(2)])); app.exit(0);";

test('a missing or broken Electron app prints its error and exits instead of opening a dialog', (t) => {
  // Electron reports a script's folder by its real path (macOS: /private/var for the /var temporary folder).
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pugport-electron-loader-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const apps: Record<string, string> = {
    'throws.cjs': "throw new Error('synthetic load failure');",
    'later.cjs': "setTimeout(() => { throw new Error('synthetic later failure'); }, 50);",
    'box.cjs': "require('electron').dialog.showErrorBox('Synthetic title', 'synthetic box');",
    'ok.cjs': report,
  };
  for (const [name, source] of Object.entries(apps)) writeFileSync(join(dir, name), source);
  mkdirSync(join(dir, 'folder'));
  writeFileSync(join(dir, 'folder', 'main.cjs'), report);
  writeFileSync(
    join(dir, 'folder', 'package.json'),
    JSON.stringify({ name: 'synthetic-app', productName: 'Synthetic App', version: '1.2.3', main: 'main.cjs' }),
  );
  const plain = { ...process.env };
  delete plain.ELECTRON_RUN_AS_NODE;
  // Most renderer tests preload offscreen-electron.cjs, which sits next to the loader.
  for (const [label, env] of [
    ['plain', plain],
    ['offscreen', offscreenElectronEnv(plain)],
  ] as const) {
    const run = (app: string) =>
      spawnSync(electron, electronArgs(join(dir, app), 'synthetic-arg'), {
        env,
        encoding: 'utf8',
        timeout: 30_000,
        windowsHide: true,
      });
    // A modal box would keep Electron running until the timeout kills it.
    for (const [app, message] of [
      ['missing.cjs', /Cannot find module/],
      ['throws.cjs', /synthetic load failure/],
      ['later.cjs', /synthetic later failure/],
      ['box.cjs', /Synthetic title\nsynthetic box/],
    ] as const) {
      const result = run(app);
      assert.equal(result.signal, null, `${label} ${app} was still running`);
      assert.equal(result.status, 1, `${label} ${app}`);
      assert.match(result.stderr, message, `${label} ${app}`);
    }
    // The app sees the arguments, path, name and version it would get when Electron starts it directly.
    for (const [app, expected] of [
      ['ok.cjs', [dir, 'Electron', ['synthetic-arg']]],
      ['folder', [join(dir, 'folder'), 'Synthetic App', '1.2.3', ['synthetic-arg']]],
    ] as const) {
      const result = run(app);
      assert.equal(result.status, 0, `${label} ${app}: ${result.stderr}`);
      const seen = JSON.parse(result.stdout.trim().split('\n').at(-1)!);
      assert.deepEqual(app === 'ok.cjs' ? [seen[0], seen[1], seen[3]] : seen, expected, `${label} ${app}`);
    }
  }
});

test('tests and scripts start Electron only through the loader', () => {
  const electronPackage = String.raw`require\(\s*'electron'\s*\)|createRequire\([^()]*\)\(\s*'electron'\s*\)`;
  const loader = String.raw`electronArgs\(|\[\s*\$\{JSON\.stringify\(electronLoader\)\}`;
  const files = (folder: string): string[] =>
    readdirSync(folder, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? entry.name === 'node_modules'
          ? []
          : files(join(folder, entry.name))
        : [join(folder, entry.name)],
    );
  const offenders: string[] = [];
  for (const file of [...files('tests'), ...files('scripts')]) {
    if (!/\.(?:[cm]?js|[cm]?tsx?)$/.test(file) || file.endsWith('electron-loader.test.ts')) continue;
    const text = readFileSync(file, 'utf8');
    // In a Node process the Electron package is the binary's path, under whatever name it was given.
    const bound = new RegExp(
      String.raw`(?:const|let|var|import)\s+(\w+)\s*(?:=\s*(?:${electronPackage})|from\s+'electron')`,
      'g',
    );
    const names = ['electron', ...[...text.matchAll(bound)].map((match) => match[1])].join('|');
    const binary = String.raw`(?:${electronPackage}|\$\{JSON\.stringify\((?:${names})\)\}|\b(?:${names})\b)(?:\s+as\s+(?:unknown\s+as\s+)?string)?`;
    // spawn, spawnSync or a promisified execFile given the binary, with arguments not built by electronArgs.
    const call = new RegExp(
      String.raw`\b(?:spawn|spawnSync|execFile|execFileSync)\)?\(\s*${binary}\s*(?:,(?!\s*(?:${loader}))|\))`,
      'g',
    );
    for (const match of text.matchAll(call)) offenders.push(`${file}:${text.slice(0, match.index).split('\n').length}`);
  }
  assert.deepEqual(offenders, [], 'start Electron with electronArgs(app, ...) from tests/helpers/electron-app.cjs');
});
