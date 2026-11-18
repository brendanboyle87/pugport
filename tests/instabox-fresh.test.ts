import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InstaboxMonitor } from '../src/server/instabox.ts';
import { InstaboxSsh } from '../src/server/instabox-ssh.ts';
import { fakeHost, fakeTree } from './helpers/fake-host.ts';

test('background SSH guard refreshes a cached running machine before allowing a connection', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pugport-instabox-fresh-'));
  const id = 'm_fixture1';
  await writeFile(
    join(home, 'instabox-ssh.json'),
    JSON.stringify({ allowed: true, entries: { [id]: 'Host fixture' } }),
  );
  let state = 'running';
  const calls: string[][] = [];
  const monitor = new InstaboxMonitor(
    fakeHost('linux', {
      env: { PATH: '/fixture' },
      fs: fakeTree({ '/fixture/instabox': 'exec' }),
      run: (_file, args) => {
        calls.push([...args]);
        assert.deepEqual(args, ['ls', '--json']);
        return { stdout: JSON.stringify([{ id, name: 'Fixture', state }]), stderr: '' };
      },
    }),
    () => 0,
  );
  const ssh = new InstaboxSsh(home, monitor, home, async () => {
    throw new Error('No SSH during guard');
  });
  const server = await ssh.server(id);
  await monitor.view(true);
  assert.equal(calls.length, 1);
  state = 'paused';
  await assert.rejects(ssh.assertReachable(server.ssh), /paused/);
  assert.equal(calls.length, 2);
  state = 'running';
  await ssh.assertReachable(server.ssh);
  assert.equal(calls.length, 3);
});
