import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from '../src/server/platform/test-process.ts';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { writePrivateConfig } from '../src/server/private-config.ts';

test('private configuration replacement preserves owner-only access and rejects stale writes', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'comborunner-private-config-test-'));
  t.after(() => {
    const absolute = resolve(directory);
    assert.ok(
      absolute.startsWith(resolve(tmpdir()) + sep) && basename(absolute).startsWith('comborunner-private-config-test-'),
    );
    rmSync(absolute, { recursive: true, force: true });
  });
  const file = join(directory, 'providers.json');
  await writePrivateConfig(file, '{"key":"synthetic-one"}', '');
  await writePrivateConfig(file, '{"key":"synthetic-two"}', '{"key":"synthetic-one"}');
  assert.equal(readFileSync(file, 'utf8'), '{"key":"synthetic-two"}');
  if (process.platform === 'win32') {
    const acl = await promisify(execFile)(
      join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe'),
      [file],
      { windowsHide: true },
    );
    assert.ok(!acl.stdout.includes('(I)'), 'Private file must not inherit directory read permissions');
    assert.equal(acl.stdout.match(/:\(F\)/g)?.length, 2, 'Only current user and SYSTEM retain full access');
  } else assert.equal(statSync(file).mode & 0o777, 0o600);
  await assert.rejects(writePrivateConfig(file, 'stale replacement', 'wrong predecessor'), /同时发生变化/);
  assert.equal(readFileSync(file, 'utf8'), '{"key":"synthetic-two"}');
  assert.deepEqual(readdirSync(directory), ['providers.json']);
});
