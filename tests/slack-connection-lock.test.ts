import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { SlackConnectionLock, slackProcessStartTime } from '../src/server/slack-connection-lock.ts';
import { fakeHost } from './helpers/fake-host.ts';

async function directory(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'slack-lock-instance-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

for (const platform of ['linux', 'darwin'] as const)
  test(`same pid has the same identity across time zones on ${platform}`, async (t) => {
    const dir = await directory(t);
    const queries: { file: string; args: readonly string[]; env?: NodeJS.ProcessEnv }[] = [];
    const hosts = ['UTC0', 'EST5'].map((TZ) =>
      fakeHost(platform, {
        env: { TZ, LC_ALL: 'fr_FR.UTF-8' },
        runSync: (file, args, options) => {
          queries.push({ file, args, env: options?.env });
          // A fake ps formats the same process birth instant in its effective time zone.
          return options?.env?.TZ === 'UTC0' ? 'Thu Oct 29 12:00:00 2026\n' : 'Thu Oct 29 07:00:00 2026\n';
        },
      }),
    );
    const identities = hosts.map((host) => slackProcessStartTime(4242, host));
    assert.deepEqual(identities, ['Thu Oct 29 12:00:00 2026', 'Thu Oct 29 12:00:00 2026']);
    const locks = hosts.map(
      (host) =>
        new SlackConnectionLock({
          directory: dir,
          role: 'node',
          pid: 4242,
          isAlive: () => true,
          getProcessStartTime: (pid) => slackProcessStartTime(pid, host),
        }),
    );
    t.after(() => locks.forEach((lock) => lock.release()));
    assert.equal(await locks[0]!.acquire('A0SYNTH', () => {}), true);
    assert.equal(await locks[1]!.acquire('A0SYNTH', () => {}), false, 'different TZ cannot seize a live socket');
    for (const query of queries) {
      assert.equal(query.file, 'ps');
      assert.deepEqual(query.args, ['-o', 'lstart=', '-p', '4242']);
      assert.equal(query.env?.LC_ALL, 'C');
      assert.equal(query.env?.TZ, 'UTC0');
    }
    assert.deepEqual(
      hosts.map((host) => host.env.TZ),
      ['UTC0', 'EST5'],
      'caller environments stay unchanged',
    );
  });

test('a shorter heartbeat stays valid JSON and permits release and re-acquire', async (t) => {
  const dir = await directory(t);
  let now = 1_800_000_000_000;
  const lock = new SlackConnectionLock({
    directory: dir,
    role: 'node',
    now: () => now,
    isAlive: () => true,
    getProcessStartTime: () => 'synthetic-instance-测试',
  });
  t.after(() => lock.release());
  assert.equal(await lock.acquire('A0SYNTH', () => {}), true);
  const name = (await readdir(dir)).find((entry) => entry.endsWith('.lock'))!;
  const path = join(dir, name);
  now = 1;
  assert.equal(lock.heartbeat(), true);
  assert.equal(JSON.parse(await readFile(join(path, 'owner.json'), 'utf8')).heartbeatAt, 1);
  assert.equal(lock.owns(), true);
  lock.release();
  assert.equal((await readdir(dir)).includes(name), false);
  assert.equal(await lock.acquire('A0SYNTH', () => {}), true);
});

for (const age of [0, 90_000, 91_000])
  test(`a corrupt lock aged ${age}ms is recoverable only after the stale window`, async (t) => {
    const dir = await directory(t);
    const now = Date.now();
    const options = {
      directory: dir,
      role: 'node' as const,
      now: () => now,
      isAlive: () => true,
      getProcessStartTime: () => 'synthetic-instance',
    };
    const holder = new SlackConnectionLock(options);
    const peers = [new SlackConnectionLock(options), new SlackConnectionLock(options)];
    t.after(() => [holder, ...peers].forEach((lock) => lock.release()));
    assert.equal(await holder.acquire('A0SYNTH', () => {}), true);
    const path = join(
      dir,
      (await readdir(dir)).find((entry) => entry.endsWith('.lock'))!,
    );
    const file = join(path, 'owner.json');
    const corrupt = `${await readFile(file, 'utf8')}000}`;
    await writeFile(file, corrupt);
    // Stop the old instance without repairing its corrupt on-disk record.
    holder.release();
    await utimes(file, new Date(now - age), new Date(now - age));
    const acquired = await Promise.all(peers.map((peer) => peer.acquire('A0SYNTH', () => {})));
    assert.equal(acquired.filter(Boolean).length, age > 90_000 ? 1 : 0);
    if (age > 90_000) {
      const winner = peers[acquired.indexOf(true)]!;
      assert.equal(winner.owns(), true);
      assert.equal(JSON.parse(await readFile(file, 'utf8')).heartbeatAt, now);
      winner.release();
      assert.equal(await holder.acquire('A0SYNTH', () => {}), true);
    } else {
      assert.equal(await readFile(file, 'utf8'), corrupt, 'recent corruption must fail closed');
    }
  });

for (const identity of ['reused', 'matching', 'unknown', 'legacy'] as const)
  test(`stale heartbeat with a live pid: ${identity} process identity`, async (t) => {
    const dir = await directory(t);
    let now = Date.now();
    const options = {
      directory: dir,
      role: 'node' as const,
      now: () => now,
      isAlive: () => true,
      getProcessStartTime: () => 'original-instance',
    };
    const holder = new SlackConnectionLock(options);
    const peer = new SlackConnectionLock({
      ...options,
      getProcessStartTime: () =>
        identity === 'reused' ? 'new-instance' : identity === 'unknown' ? undefined : 'original-instance',
    });
    t.after(() => {
      holder.release();
      peer.release();
    });
    assert.equal(await holder.acquire('A0SYNTH', () => {}), true);
    const lock = (await readdir(dir)).find((entry) => entry.endsWith('.lock'))!;
    const file = join(dir, lock, 'owner.json');
    const owner = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(owner.processStartedAt, 'original-instance');
    assert.equal(owner.processIdentityFormat, 'utc-v1');
    if (identity === 'legacy') {
      delete owner.processStartedAt;
      await writeFile(file, JSON.stringify(owner));
    }
    assert.equal(await peer.acquire('A0SYNTH', () => {}), false, 'a fresh heartbeat cannot be seized');
    now += 91_000;
    assert.equal(await peer.acquire('A0SYNTH', () => {}), identity === 'reused');
    if (identity === 'reused') {
      assert.equal(holder.heartbeat(), false);
      holder.release();
      assert.equal(peer.owns(), true, 'old owner cannot release the new instance');
      assert.equal(JSON.parse(await readFile(file, 'utf8')).processStartedAt, 'new-instance');
    } else {
      assert.equal(holder.owns(), true, 'no proof of a different instance means no socket seizure');
      assert.equal(holder.heartbeat(), false, 'live stale holder gets a takeover request');
    }
  });

for (const format of ['legacy-local', 'legacy-utc', 'unknown-format'])
  for (const age of [0, 91_000])
    test(`${format} Slack identity with heartbeat age ${age}ms cannot be seized from a live pid`, async (t) => {
      const dir = await directory(t);
      let now = Date.now();
      let live = true;
      const options = {
        directory: dir,
        role: 'node' as const,
        now: () => now,
        isAlive: () => live,
        getProcessStartTime: () => 'Thu Oct 29 12:00:00 2026',
      };
      const holder = new SlackConnectionLock(options);
      const peer = new SlackConnectionLock(options);
      t.after(() => [holder, peer].forEach((lock) => lock.release()));
      assert.equal(await holder.acquire('A0SYNTH', () => {}), true);
      const path = join(
        dir,
        (await readdir(dir)).find((entry) => entry.endsWith('.lock'))!,
      );
      const file = join(path, 'owner.json');
      const owner = JSON.parse(await readFile(file, 'utf8'));
      owner.processStartedAt = format === 'legacy-local' ? 'Thu Oct 29 07:00:00 2026' : 'Wed Oct 28 12:00:00 2026';
      if (format === 'unknown-format') owner.processIdentityFormat = 'future-format';
      else delete owner.processIdentityFormat;
      const record = JSON.stringify(owner);
      await writeFile(file, record);
      now += age;
      assert.equal(await peer.acquire('A0SYNTH', () => {}), false);
      assert.equal(await readFile(file, 'utf8'), record, 'the live legacy record stays untouched');
      assert.equal((await readdir(path)).includes(`takeover-${owner.id}`), age > 90_000);
      live = false;
      assert.equal(await peer.acquire('A0SYNTH', () => {}), true, 'a dead pid is reclaimable in any format');
      holder.release();
      assert.equal(peer.owns(), true);
    });

test('two separate Node processes racing for one lock have exactly one winner', { timeout: 30_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'slack-lock-race-'));
  const children = [0, 1].map(() =>
    fork(new URL('./fixtures/slack-lock-child.ts', import.meta.url), [dir], {
      execPath: process.execPath,
      execArgv: ['--import', 'tsx'],
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    }),
  );
  const exits = children.map((child) => once(child, 'exit'));
  t.after(async () => {
    for (const child of children) if (child.exitCode === null) child.kill();
    await Promise.all(exits);
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  const ready = await Promise.all(children.map((child) => once(child, 'message', { signal: t.signal })));
  assert.deepEqual(
    ready.map(([message]) => message),
    ['ready', 'ready'],
  );
  const results = children.map((child) => once(child, 'message', { signal: t.signal }));
  // Both children wait at this barrier before touching the shared lock directory.
  const startAt = Date.now() + 100;
  for (const child of children) child.send(startAt);
  const acquired = (await Promise.all(results)).map(([message]) => message);
  assert.deepEqual(acquired.sort(), [false, true]);
  assert.equal((await readdir(dir)).filter((entry) => entry.endsWith('.lock')).length, 1);
  for (const child of children) child.send('release');
  assert.deepEqual(
    (await Promise.all(exits)).map(([code]) => code),
    [0, 0],
  );
});
