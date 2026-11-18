import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  copyFileSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createWindowsLauncher } from '../scripts/create-windows-launcher.mjs';

const source = resolve('.');
function fixture(t: { after: (cleanup: () => void) => void }) {
  const temporary = mkdtempSync(join(tmpdir(), 'pugport launcher '));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const root = join(temporary, 'checkout with spaces');
  mkdirSync(join(root, 'launchers'), { recursive: true });
  copyFileSync(join(source, 'launchers', 'Start-PugPort.vbs'), join(root, 'launchers', 'Start-PugPort.vbs'));
  copyFileSync(join(source, 'Start-PugPort.cmd'), join(root, 'Start-PugPort.cmd'));
  return { temporary, root };
}
function runLauncher(root: string) {
  return spawnSync('cscript.exe', ['//nologo', join(root, '.data', 'launchers', 'start-pugport.vbs')], {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  });
}

test(
  'Windows launcher suppresses only exit 1 after at least 60 seconds, including midnight and multiple days',
  {
    skip: process.platform !== 'win32',
  },
  (t) => {
    const { root } = fixture(t);
    const generated = createWindowsLauncher(root);
    const template = readFileSync(generated, 'utf8');
    assert.match(template, /startedAt = Now\s+result = shell.Run/);
    assert.match(template, /If result = 1 And DateDiff\("s", startedAt, Now\) >= 60 Then WScript.Quit 0/);
    assert.equal(/\bTimer\b/.test(template), false);
    for (const [seconds, code, expected] of [
      [59, 1, 1],
      [60, 1, 0],
      [172800, 1, 0],
      [60, 7, 1],
      [172800, 7, 1],
      [1, 0, 0],
    ]) {
      writeFileSync(join(root, 'Start-PugPort.cmd'), `@exit /b ${code}\r\n`);
      // Simulate time across midnight using the real VBScript DateDiff; no wall-clock wait.
      writeFileSync(
        generated,
        template
          .replace('startedAt = Now', `startedAt = DateAdd("s", -${seconds}, #10/14/2026 00:00:30#)`)
          .replace('DateDiff("s", startedAt, Now)', 'DateDiff("s", startedAt, #10/14/2026 00:00:30#)'),
      );
      const result = runLauncher(root);
      assert.equal(result.error, undefined);
      assert.equal(result.status, expected, `${seconds}s, code ${code}: ${result.stdout}${result.stderr}`);
      if (expected) assert.match(result.stdout, new RegExp(`PugPort exited with code ${code}`));
      else assert.equal(result.stdout, '');
    }
  },
);

test('hidden launcher generation is portable and preserves unrelated local launcher files', (t) => {
  const { root } = fixture(t);
  const generated = createWindowsLauncher(root);
  const content = readFileSync(generated, 'utf8');
  assert.equal(content, readFileSync(join(root, 'launchers', 'Start-PugPort.vbs'), 'utf8'));
  assert.ok(content.includes('WScript.ScriptFullName'));
  assert.equal(content.includes(source), false);
  writeFileSync(join(root, '.data', 'launchers', 'custom-launcher.vbs'), 'keep');
  createWindowsLauncher(root);
  assert.equal(readFileSync(join(root, '.data', 'launchers', 'custom-launcher.vbs'), 'utf8'), 'keep');
});

test(
  'hidden Windows startup returns missing-runtime errors with a readable log, without waiting on pause',
  {
    skip: process.platform !== 'win32',
  },
  (t) => {
    const { root } = fixture(t);
    createWindowsLauncher(root);
    const result = runLauncher(root);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /PugPort exited with code 1/);
    assert.match(result.stdout, /last-start\.log/);
    assert.match(readFileSync(join(root, '.data', 'launchers', 'last-start.log'), 'utf8'), /node\.exe is missing/);
  },
);

test(
  'a moved Windows checkout launches from its own path and propagates Electron failures',
  {
    skip: process.platform !== 'win32',
  },
  (t) => {
    const { temporary, root } = fixture(t);
    mkdirSync(join(root, '.runtime'));
    // Reuse the verified runtime without copying a large executable and triggering a fresh antivirus scan.
    try {
      linkSync(process.execPath, join(root, '.runtime', 'node.exe'));
    } catch {
      // A runtime and temporary directory can sit on different volumes.
      copyFileSync(process.execPath, join(root, '.runtime', 'node.exe'));
    }
    mkdirSync(join(root, 'node_modules', 'electron'), { recursive: true });
    mkdirSync(join(root, 'dist', 'electron'), { recursive: true });
    writeFileSync(join(root, 'dist', 'electron', 'main.cjs'), '');
    writeFileSync(
      join(root, 'node_modules', 'electron', 'cli.js'),
      "console.log('fixture launched at ' + process.cwd());",
    );
    createWindowsLauncher(root);
    const moved = join(temporary, 'moved checkout with spaces');
    renameSync(root, moved);
    const success = runLauncher(moved);
    assert.equal(success.error, undefined);
    assert.equal(success.status, 0, success.stdout + success.stderr);
    assert.equal(
      readFileSync(join(moved, '.data', 'launchers', 'last-start.log'), 'utf8').trim(),
      `fixture launched at ${moved}`,
    );

    writeFileSync(
      join(moved, 'node_modules', 'electron', 'cli.js'),
      "console.error('synthetic Electron failure'); process.exit(7);",
    );
    const failure = runLauncher(moved);
    assert.equal(failure.error, undefined);
    assert.equal(failure.status, 1, failure.stdout + failure.stderr);
    assert.match(failure.stdout, /PugPort exited with code 7/);
    assert.match(
      readFileSync(join(moved, '.data', 'launchers', 'last-start.log'), 'utf8'),
      /synthetic Electron failure/,
    );
  },
);
