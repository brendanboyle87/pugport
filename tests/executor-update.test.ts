import express from 'express';
import { ZodError } from 'zod';
import { rollbackCliRoute } from '../src/server/inbox-routes.ts';
import { listenForFetch } from './helpers/fetch-port.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { ExecutorUpdater, runUpdate } from '../src/server/executor-update.ts';

import { DatabaseSync } from 'node:sqlite';
import { Inbox } from '../src/server/inbox.ts';
import { inboxText } from '../src/shared/inbox.ts';
import type { RuntimeTarget, RuntimeSnapshot } from '../src/shared/types.ts';
import {
  lstatSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  utimesSync,
  renameSync,
  readdirSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Controller } from '../src/server/controller.ts';
import { cursorAdapter } from '../src/server/adapters/cursor.ts';

const card = (id: string, provider: RuntimeTarget['provider'], extra: Partial<RuntimeTarget> = {}) => ({
  target: {
    id,
    provider,
    label: id,
    command: 'unused',
    environment: 'native',
    enabled: true,
    ...extra,
  } as RuntimeTarget,
  snapshot: { id, provider, label: id, installed: true, status: 'ready' } as RuntimeSnapshot,
});
function fixture(cards = [card('a', 'cursor')]) {
  const db = new DatabaseSync(':memory:');
  let now = new Date(2026, 0, 2, 2).getTime();
  const state = {
    active: 0,
    starts: 0,
    capacity: true,
    newest: undefined as number | undefined,
    result: { ok: true, exitCode: 0 as number | null, timedOut: false, tail: 'output' },
    calls: [] as string[],
    events: [] as string[],
    refresh: () => {},
    busy: false,
  };
  const inbox = new Inbox(
    db,
    () => {},
    () => now,
  );
  const host = {
    db,
    inbox,
    dataDir: 'synthetic',
    now: () => now,
    closing: () => false,
    targets: () => cards.map((c) => c.target),
    snapshots: () => cards.map((c) => c.snapshot),
    activeCount: () => state.active,
    foregroundStarts: () => state.starts,
    hasExecutionCapacity: () => state.capacity,
    providerBusy: () => state.busy,
    newestRunStartedAt: () => state.newest,
    markUpdating: (ids: readonly string[], on: boolean) => state.events.push(`${on}:${ids.join(',')}`),
    refresh: async (ids: readonly string[]) => {
      state.events.push(`refresh:${ids.join(',')}`);
      state.refresh();
    },
  };
  const updater = new ExecutorUpdater(host, {
    run: async (t) => {
      state.calls.push(t.id);
      return state.result;
    },
  });
  return {
    db,
    state,
    inbox,
    host,
    updater,
    get now() {
      return now;
    },
    set now(value: number) {
      now = value;
    },
  };
}

test('window, idle and quiet gates', async () => {
  const f = fixture();
  f.now = new Date(2026, 0, 1, 23, 30).getTime();
  assert.equal(f.updater.tick(), undefined);
  f.now = new Date(2026, 0, 2, 2).getTime();
  f.state.active = 1;
  assert.equal(f.updater.tick(), undefined);
  f.state.active = 0;
  f.state.starts = 1;
  assert.equal(f.updater.tick(), undefined);
  f.state.starts = 0;
  f.state.capacity = false;
  assert.equal(f.updater.tick(), undefined);
  f.state.capacity = true;
  f.state.newest = f.now - 10 * 60_000;
  assert.equal(f.updater.tick(), undefined);
  f.state.newest = f.now - 31 * 60_000;
  await f.updater.tick();
  assert.deepEqual(f.state.calls, ['a']);
  f.db.close();
});

test('provider order, shared cards and daily spacing', async () => {
  const f = fixture([
    card('c1', 'grok'),
    card('c2', 'grok'),
    card('c3', 'grok', { enabled: false }),
    card('unsupported', 'claude'),
    card('g', 'grok'),
    card('u', 'cursor'),
  ]);
  await f.updater.tick();
  await f.updater.tick();
  await f.updater.tick();
  assert.deepEqual(f.state.calls, ['u', 'c1']);
  assert.ok(f.state.events.includes('true:c1,c2,c3,g'));
  assert.ok(f.state.events.includes('refresh:c1,c2,c3,g'));
  assert.equal(f.db.prepare('select count(*) as n from executor_update').get()?.n, 2);
  f.now += 23 * 3600_000;
  assert.equal(f.updater.tick(), undefined);
  f.now += 2 * 3600_000;
  await f.updater.tick();
  assert.equal(f.state.calls.length, 3);
  f.db.close();
});

test('three failures raise one notice, later success resolves it', async () => {
  const f = fixture();
  f.state.result = { ok: false, exitCode: 1, timedOut: false, tail: 'failure' };
  for (let i = 0; i < 4; i++) {
    await f.updater.tick();
    if (i < 2) assert.equal(f.inbox.list().length, 0);
    f.now += 24 * 3600_000;
  }
  const notice = f.inbox.list()[0]!;
  assert.equal(notice.kind, 'executor-update');
  assert.equal(notice.key, 'cursor');
  assert.equal(notice.severity, 'warning');
  assert.equal(notice.title, inboxText.updateTitle.replace('{0}', 'a'));
  assert.equal(notice.details, 'failure');
  assert.equal(notice.action?.kind, 'update-cli');
  assert.equal(notice.count, 2);
  f.state.result.ok = true;
  await f.updater.tick();
  assert.equal(f.inbox.list().length, 0);
  assert.equal(
    JSON.parse((f.db.prepare('select value from executor_update').get() as { value: string }).value).failures,
    0,
  );
  assert.deepEqual(f.state.events.slice(0, 3), ['true:a', 'false:a', 'refresh:a']);
  f.db.close();
});

test('post-update broken ready card raises immediately; preexisting error does not', async () => {
  const c = card('a', 'cursor');
  const f = fixture([c]);
  f.state.refresh = () => {
    c.snapshot.status = 'error';
    c.snapshot.errorDetail = 'broken binary';
    c.snapshot.note = 'runtime-protocol-incompatible';
  };
  await f.updater.tick();
  assert.match(f.inbox.list()[0]!.details!, /broken binary/);
  assert.equal(f.inbox.list()[0]!.body, inboxText.updateBrokeManualBody.replace('{0}', 'a'));
  assert.equal(f.inbox.list()[0]!.action?.kind, 'update-cli');
  f.db.close();
  const e = card('e', 'cursor');
  e.snapshot.status = 'error';
  const g = fixture([e]);
  await g.updater.tick();
  assert.equal(g.inbox.list().length, 0);
  g.db.close();
});

test('single flight and shutdown abort preserve state', async () => {
  const f = fixture();
  let sawAbort = false;
  const updater = new ExecutorUpdater(f.host, {
    run: (_t, signal) =>
      new Promise((resolve) =>
        signal.addEventListener('abort', () => {
          sawAbort = true;
          resolve({ ok: false, exitCode: null, timedOut: false, tail: '' });
        }),
      ),
  });
  const pending = updater.tick();
  assert.equal(updater.tick(), undefined);
  await updater.close();
  await pending;
  assert.equal(sawAbort, true);
  const restarted = new ExecutorUpdater(f.host, {
    run: async () => {
      throw new Error('unexpected retry');
    },
  });
  assert.equal(restarted.tick(), undefined);
  assert.deepEqual(JSON.parse((f.db.prepare('select value from executor_update').get() as { value: string }).value), {
    attemptedAt: f.now,
    failures: 1,
  });
  assert.deepEqual(f.state.events, ['true:a', 'false:a', 'refresh:a']);
  f.db.close();
});

test('unsupported or ineligible cards never run', async () => {
  const cards = [
    card('g', 'gemini'),
    card('c', 'codex'),
    card('p', 'pi'),
    card('api', 'claude', { gateway: 'api' }),
    card('off', 'claude', { executionDisabledByUser: true }),
    ...(['missing', 'auth-required', 'refreshing'] as const).map((s) => {
      const c = card(s, 'grok');
      c.snapshot.status = s;
      return c;
    }),
  ];
  const f = fixture(cards);
  for (let i = 0; i < 3; i++) {
    await f.updater.tick();
    f.now += 24 * 3600_000;
  }
  assert.equal(f.state.calls.length, 0);
  f.db.close();
});
test('runner captures output, redacts secrets and kills a hanging process tree', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'update-fixture-'));
  t.after(() => {
    const pidFile = join(dir, 'pid.json');
    if (existsSync(pidFile)) {
      for (const id of JSON.parse(readFileSync(pidFile, 'utf8')) as number[]) {
        try {
          process.kill(id);
        } catch {}
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const script = join(dir, 'fixture.mjs');
  writeFileSync(
    script,
    `import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs';
writeFileSync(process.env.FIXTURE_ARGV, JSON.stringify(process.argv.slice(2)));
if (process.env.FIXTURE_MODE === 'ok') { console.log('Updated to 9.9.9'); process.exit(0); }
if (process.env.FIXTURE_MODE === 'fail') { console.error('token=abc Failed'); process.exit(1); }
if (process.env.FIXTURE_MODE === 'hang') { const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)']); writeFileSync(process.env.FIXTURE_PID, JSON.stringify([process.pid,child.pid])); setInterval(()=>{},1000); }`,
  );
  // POSIX resolves only an executable file; a .cmd there never started, so every case failed before the kill check.
  const command = join(dir, process.platform === 'win32' ? 'fixture.cmd' : 'fixture');
  writeFileSync(
    command,
    process.platform === 'win32'
      ? `@"${process.execPath}" "${script}" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
    { mode: 0o755 },
  );
  const target = { ...card('fixture', 'cursor').target, command, args: ['forbidden'], accountId: 'isolated' };
  const argv = join(dir, 'argv.json');
  const pid = join(dir, 'pid.json');

  t.after(() => {
    for (const key of ['FIXTURE_ARGV', 'FIXTURE_PID', 'FIXTURE_MODE']) delete process.env[key];
  });
  process.env.FIXTURE_ARGV = argv;
  process.env.FIXTURE_PID = pid;
  process.env.FIXTURE_MODE = 'ok';
  const ok = await runUpdate(target, new AbortController().signal, dir);
  assert.equal(ok.ok, true);
  assert.equal(ok.exitCode, 0);
  assert.match(ok.tail, /Updated to 9.9.9/);
  assert.deepEqual(JSON.parse(readFileSync(argv, 'utf8')), ['update']);
  process.env.FIXTURE_MODE = 'fail';
  const fail = await runUpdate(target, new AbortController().signal, dir);
  assert.equal(fail.ok, false);
  assert.equal(fail.exitCode, 1);
  assert.doesNotMatch(fail.tail, /abc/);
  process.env.FIXTURE_MODE = 'hang';
  const hang = await runUpdate(target, new AbortController().signal, dir, 10000);
  assert.equal(hang.timedOut, true);
  assert.ok(existsSync(pid), hang.tail);
  for (const id of JSON.parse(readFileSync(pid, 'utf8')) as number[]) {
    let alive = true;
    for (let i = 0; i < 30 && alive; i++) {
      try {
        process.kill(id, 0);
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch {
        alive = false;
      }
    }
    assert.equal(alive, false, `process ${id} survived`);
  }
});

test('controller skips discovery during update and discards in-flight result', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'update-controller-'));
  const controller = new Controller(dir, join(dir, 'data'));
  clearInterval(controller.timer);
  t.after(async () => {
    await controller.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const c = card('fixture', 'cursor');
  c.snapshot = {
    ...c.target,
    installed: true,
    status: 'ready',
    models: [],
    quota: { status: 'unknown', source: 'fixture', observedAt: null, windows: [] },
    capabilities: { execute: true, resume: true, cancel: true, approvals: true },
    refreshedAt: new Date().toISOString(),
  } as RuntimeSnapshot;
  controller.targets = [c.target];
  controller.snapshots = [c.snapshot];
  let calls = 0;
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => (started = resolve));
  const deferred = new Promise<void>((resolve) => (release = resolve));
  let wait = false;
  t.mock.method(cursorAdapter, 'discover', async () => {
    calls++;
    if (wait) {
      started();
      await deferred;
    }
    return c.snapshot;
  });
  controller.markUpdating(['fixture'], true);
  assert.equal(controller.snapshots[0]!.status, 'refreshing');
  assert.equal(controller.snapshots[0]!.note, '\u6b63\u5728\u66f4\u65b0\u547d\u4ee4\u884c');
  await controller.refresh();
  assert.equal(calls, 0);
  controller.markUpdating(['fixture'], false);
  await controller.refresh({ runtimeIds: ['fixture'], fresh: true });
  assert.equal(calls, 1);
  assert.equal(controller.snapshots[0]!.status, 'ready');
  wait = true;
  const pending = controller.refresh({ runtimeIds: ['fixture'], fresh: true });
  await entered;
  controller.markUpdating(['fixture'], true);
  release();
  await pending;
  assert.equal(controller.snapshots[0]!.status, 'refreshing');
  controller.markUpdating(['fixture'], false);
});

test('busy provider cannot start an update', async () => {
  const f = fixture();
  f.state.busy = true;
  assert.equal(f.updater.tick(), undefined);
  assert.deepEqual(f.state.calls, []);
  f.db.close();
});

test('failed update can break a ready card, transient errors cannot', async () => {
  for (const [note, broken] of [
    ['runtime-timeout', false],
    ['network-error', false],
    ['process-closed', false],
    ['request-failed', false],
    ['runtime-protocol-incompatible', true],
  ] as const) {
    const c = card('a', 'cursor');
    const f = fixture([c]);
    f.state.result.ok = false;
    f.state.refresh = () => {
      c.snapshot.status = 'error';
      c.snapshot.note = note;
    };
    await f.updater.tick();
    assert.equal(f.inbox.list().length, broken ? 1 : 0, note);
    f.db.close();
  }
  const c = card('a', 'cursor');
  const f = fixture([c]);
  f.state.result.ok = false;
  f.state.refresh = () => {
    c.snapshot.status = 'missing';
  };
  await f.updater.tick();
  assert.equal(f.inbox.list()[0]?.key, 'cursor:broken');
  f.db.close();
});

test('account checks refuse during update without changing snapshots', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'update-account-'));
  const controller = new Controller(dir, join(dir, 'data'));
  clearInterval(controller.timer);
  t.after(async () => {
    await controller.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const c = card('fixture', 'cursor');
  controller.targets = [c.target];
  controller.snapshots = [c.snapshot];
  controller.markUpdating(['fixture'], true);
  const before = controller.snapshots[0];
  await assert.rejects(
    controller.checkNativeAccount('fixture'),
    /\u6b63\u5728\u66f4\u65b0\u547d\u4ee4\u884c\uff0c\u8bf7\u7a0d\u540e\u68c0\u67e5\u3002/,
  );
  assert.equal(controller.snapshots[0], before);
});

test('broken notice replaces card notices and resolves when reconciled ready', async () => {
  const c = card('a', 'cursor');
  const f = fixture([c]);
  f.inbox.reconcile([c.snapshot], [c.target]);
  f.state.refresh = () => {
    c.snapshot.status = 'missing';
    f.inbox.reconcile([c.snapshot], [c.target]);
  };
  await f.updater.tick();
  assert.deepEqual(
    f.inbox.list().map((n) => [n.kind, n.key]),
    [['executor-update', 'cursor:broken']],
  );
  c.snapshot.status = 'ready';
  f.inbox.reconcile([c.snapshot], [c.target]);
  assert.equal(f.inbox.list().length, 0);
  f.db.close();
});

test('each controller process and login gate blocks its provider', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'update-gates-'));
  const controller = new Controller(dir, join(dir, 'data'));
  clearInterval(controller.timer);
  t.after(async () => {
    await controller.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const c = card('fixture', 'cursor');
  controller.targets = [c.target];
  controller.snapshots = [c.snapshot];
  const internal = controller as unknown as {
    clock: () => number;
    targetRefreshes: Map<string, unknown>;
    discoveryFlights: Map<string, unknown>;
    watchedLogins: Set<string>;
    launchingLogins: Set<string>;
    hasExecutionCapacity: () => boolean;
  };
  internal.clock = () => new Date(2026, 0, 2, 2).getTime();
  internal.hasExecutionCapacity = () => true;
  for (const name of ['targetRefreshes', 'discoveryFlights', 'watchedLogins', 'launchingLogins'] as const) {
    const collection = internal[name];
    if (collection instanceof Map) collection.set('fixture', {});
    else collection.add('fixture');
    assert.equal(controller.executorUpdate.tick(), undefined, name);
    collection.delete('fixture');
  }
});

test('broken provider notice remains until the broken card recovers', async () => {
  const a = card('a', 'cursor');
  const b = card('b', 'cursor');
  const f = fixture([a, b]);
  f.inbox.reconcile([a.snapshot, b.snapshot], [a.target, b.target]);
  f.state.refresh = () => {
    b.snapshot.status = 'missing';
    f.inbox.reconcile([a.snapshot, b.snapshot], [a.target, b.target]);
  };
  await f.updater.tick();
  f.inbox.reconcile([a.snapshot, b.snapshot], [a.target, b.target]);
  assert.equal(f.inbox.list().length, 1);
  b.snapshot.status = 'ready';
  f.inbox.reconcile([a.snapshot, b.snapshot], [a.target, b.target]);
  assert.equal(f.inbox.list().length, 0);
  f.db.close();
});

test('an existing broken notice suppresses later failure notices for the provider', async () => {
  const a = card('a', 'cursor');
  const b = card('b', 'cursor');
  const f = fixture([a, b]);
  f.state.refresh = () => {
    b.snapshot.status = 'missing';
  };
  await f.updater.tick();
  f.state.result.ok = false;
  for (let i = 0; i < 3; i++) {
    f.now += 24 * 3600_000;
    await f.updater.tick();
  }
  assert.deepEqual(
    f.inbox.list().map((n) => n.key),
    ['cursor:broken'],
  );
  f.db.close();
});

async function rollbackFixture(t: import('node:test').TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'grok-rollback-'));
  const c = card('g', 'grok', { command: join(dir, 'grok') });
  c.snapshot.version = '1.0.0';
  const f = fixture([c]);
  writeFileSync(c.target.command, 'broken executable');
  writeFileSync(`${c.target.command}.old`, 'previous executable');
  utimesSync(`${c.target.command}.old`, new Date(f.now), new Date(f.now));
  f.state.refresh = () => {
    c.snapshot.status = 'missing';
  };
  await f.updater.tick();
  assert.equal(f.inbox.list()[0]?.action?.kind, 'rollback-cli');
  f.state.refresh = () => {
    c.snapshot.status = 'ready';
    c.snapshot.version = '0.9.0';
  };
  t.after(() => {
    f.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { ...f, c, dir, clock: f };
}

test('Grok rollback swaps the backup, keeps every file, resolves notice and holds updates for seven days', async (t) => {
  const f = await rollbackFixture(t);
  const before = readdirSync(f.dir).length;
  const result = await f.updater.rollbackCli(f.c.target);
  assert.equal(result.ok, true, result.reason);
  assert.equal(readFileSync(f.c.target.command, 'utf8'), 'previous executable');
  assert.equal(readFileSync(`${f.c.target.command}.broken-${f.clock.now}`, 'utf8'), 'broken executable');
  assert.equal(readdirSync(f.dir).length, before);
  assert.equal(f.inbox.list().length, 0);
  f.clock.now += 6 * 24 * 3600_000;
  assert.equal(f.updater.tick(), undefined);
  assert.deepEqual(f.state.calls, ['g']);
  f.clock.now += 24 * 3600_000;
  await f.updater.tick();
  assert.deepEqual(f.state.calls, ['g', 'g']);
});

test('a changed Grok version ends the rollback hold', async (t) => {
  const f = await rollbackFixture(t);
  assert.equal((await f.updater.rollbackCli(f.c.target)).ok, true);
  f.c.snapshot.version = '1.1.0';
  await f.updater.tick();
  assert.deepEqual(f.state.calls, ['g', 'g']);
});

test('rollback refuses stale or absent backups, Cursor, missing notices and busy providers', async (t) => {
  for (const kind of ['stale', 'missing', 'cursor', 'notice', 'busy', 'active', 'capacity'] as const) {
    await t.test(kind, async (t) => {
      const f = await rollbackFixture(t);
      if (kind === 'stale') {
        const stat = lstatSync(`${f.c.target.command}.old`);
        const row = f.db.prepare('select value from executor_update where provider=?').get('grok') as { value: string };
        f.db.prepare('update executor_update set value=? where provider=?').run(
          JSON.stringify({
            ...JSON.parse(row.value),
            attemptedAt: Math.max(stat.mtimeMs, stat.ctimeMs, stat.birthtimeMs) + 5_000,
          }),
          'grok',
        );
      }
      if (kind === 'missing') renameSync(`${f.c.target.command}.old`, `${f.c.target.command}.saved`);
      if (kind === 'cursor') f.c.target.provider = 'cursor';
      if (kind === 'notice') f.inbox.resolve('executor-update', 'grok:broken');
      if (kind === 'busy') f.state.busy = true;
      if (kind === 'active') f.state.active = 1;
      if (kind === 'capacity') f.state.capacity = false;
      const names = readdirSync(f.dir);
      assert.equal((await f.updater.rollbackCli(f.c.target)).ok, false);
      assert.equal(readFileSync(f.c.target.command, 'utf8'), 'broken executable');
      assert.deepEqual(readdirSync(f.dir), names);
    });
  }
});

test('rollback restores the original executable when the backup rename fails', async (t) => {
  const f = await rollbackFixture(t);
  let renames = 0;
  const updater = new ExecutorUpdater(f.host, {
    rename: (from, to) => {
      if (++renames === 2) throw new Error('synthetic second rename failure');
      renameSync(from, to);
    },
  });
  const result = await updater.rollbackCli(f.c.target);
  assert.equal(result.ok, false);
  assert.equal(renames, 3);
  assert.equal(readFileSync(f.c.target.command, 'utf8'), 'broken executable');
  assert.equal(readFileSync(`${f.c.target.command}.old`, 'utf8'), 'previous executable');
  assert.equal(existsSync(`${f.c.target.command}.broken`), false);
  assert.equal(f.inbox.list()[0]?.key, 'grok:broken');
});

test('rollback refuses a failed hold write before touching files or marking the provider busy', async (t) => {
  const f = await rollbackFixture(t);
  const prepare = f.db.prepare.bind(f.db);
  t.mock.method(f.db, 'prepare', (sql: string) => {
    if (sql.startsWith('UPDATE executor_update')) throw new Error('synthetic database write failure');
    return prepare(sql);
  });
  let renames = 0;
  const updater = new ExecutorUpdater(f.host, {
    rename: () => {
      renames++;
    },
  });
  const events = [...f.state.events];
  const result = await updater.rollbackCli(f.c.target);
  assert.equal(result.ok, false);
  assert.equal(renames, 0);
  assert.deepEqual(f.state.events, events);
  assert.equal(readFileSync(f.c.target.command, 'utf8'), 'broken executable');
  assert.equal(readFileSync(`${f.c.target.command}.old`, 'utf8'), 'previous executable');
  assert.equal(existsSync(`${f.c.target.command}.broken`), false);
});

test('rollback keeps its conservative hold if saving the recovered version fails', async (t) => {
  const f = await rollbackFixture(t);
  const prepare = f.db.prepare.bind(f.db);
  let writes = 0;
  t.mock.method(f.db, 'prepare', (sql: string) => {
    if (sql.startsWith('UPDATE executor_update') && ++writes === 2) throw new Error('synthetic refinement failure');
    return prepare(sql);
  });
  assert.equal((await f.updater.rollbackCli(f.c.target)).ok, true);
  const row = f.db.prepare('select value from executor_update where provider=?').get('grok') as { value: string };
  const entry = JSON.parse(row.value);
  assert.equal(entry.holdUntil, f.clock.now + 7 * 24 * 3600_000);
  assert.equal(entry.holdVersion, undefined);
  assert.equal(f.inbox.list().length, 0);
  f.clock.now += 24 * 3600_000;
  assert.equal(f.updater.tick(), undefined);
  assert.ok(f.state.events.includes('false:g'));
});

test('rollback refuses a symlink backup without moving the executable', async (t) => {
  const f = await rollbackFixture(t);
  const saved = `${f.c.target.command}.saved`;
  renameSync(`${f.c.target.command}.old`, saved);
  try {
    symlinkSync(saved, `${f.c.target.command}.old`, 'file');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      t.skip('Creating file symlinks requires Windows privileges.');
      return;
    }
    throw error;
  }
  assert.equal((await f.updater.rollbackCli(f.c.target)).ok, false);
  assert.equal(readFileSync(f.c.target.command, 'utf8'), 'broken executable');
  assert.equal(readFileSync(saved, 'utf8'), 'previous executable');
  assert.equal(existsSync(`${f.c.target.command}.broken`), false);
});

test('rollback blocks another update while refreshing and keeps its hold after refresh failure', async (t) => {
  const f = await rollbackFixture(t);
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const updater = new ExecutorUpdater({
    ...f.host,
    refresh: async () => {
      await waiting;
      throw new Error('synthetic refresh failure');
    },
  });
  const pending = updater.rollbackCli(f.c.target);
  assert.equal(updater.tick(), undefined);
  assert.equal((await updater.rollbackCli(f.c.target)).ok, false);
  release();
  assert.equal(
    f.inbox.list().some((n) => n.key === 'grok:broken'),
    false,
    'resolved before refresh finishes',
  );
  assert.equal((await pending).ok, true);
  assert.equal(f.inbox.list()[0]?.key, 'grok:rollback-refresh');
  assert.equal(f.inbox.list()[0]?.action, undefined);
  const row = f.db.prepare('select value from executor_update where provider=?').get('grok') as { value: string };
  assert.equal(JSON.parse(row.value).holdUntil, f.clock.now + 7 * 24 * 3600_000);
  f.c.snapshot.version = '0.9.0';
  f.c.snapshot.status = 'ready';
  f.clock.now += 24 * 3600_000;
  assert.equal(
    updater.tick(),
    undefined,
    'a later discovery of the restored version must not lift an unknown-version hold',
  );
});

test('rollback accepts an old executable renamed to .old after the update attempt', async (t) => {
  const f = await rollbackFixture(t);
  const old = `${f.c.target.command}.old`;
  const saved = `${f.c.target.command}.saved`;
  renameSync(old, saved);
  utimesSync(saved, new Date(0), new Date(0));
  const attemptedAt = Date.now();
  f.db
    .prepare('update executor_update set value=? where provider=?')
    .run(JSON.stringify({ attemptedAt, failures: 1 }), 'grok');
  renameSync(saved, old);
  assert.ok(lstatSync(old).mtimeMs < attemptedAt);
  const result = await f.updater.rollbackCli(f.c.target);
  assert.equal(result.ok, true, result.reason);
  assert.equal(readFileSync(f.c.target.command, 'utf8'), 'previous executable');
});

test('rollback can run again at the same timestamp and preserves all broken copies', async (t) => {
  const f = await rollbackFixture(t);
  writeFileSync(`${f.c.target.command}.broken`, 'legacy copy');
  for (let i = 0; i < 2; i++) {
    if (i) {
      renameSync(f.c.target.command, `${f.c.target.command}.old`);
      writeFileSync(f.c.target.command, 'second broken executable');
      f.inbox.raise({
        kind: 'executor-update',
        key: 'grok:broken',
        severity: 'action',
        title: 'Synthetic failure',
        action: { kind: 'rollback-cli', runtimeId: f.c.target.id },
      });
    }
    const result = await f.updater.rollbackCli(f.c.target);
    assert.equal(result.ok, true, result.reason);
    assert.ok(result.reason.includes(`${f.c.target.command}.broken-${f.clock.now + i}`));
  }
  assert.equal(readFileSync(`${f.c.target.command}.broken`, 'utf8'), 'legacy copy');
  assert.equal(readFileSync(`${f.c.target.command}.broken-${f.clock.now}`, 'utf8'), 'broken executable');
  assert.equal(readFileSync(`${f.c.target.command}.broken-${f.clock.now + 1}`, 'utf8'), 'second broken executable');
});

test('rollback HTTP refuses non-Grok and non-notice targets before any file mutation', async (t) => {
  const f = await rollbackFixture(t);
  const cursor = card('cursor', 'cursor', { command: f.c.target.command });
  const other = card('other-grok', 'grok', { command: f.c.target.command });
  const app = express();
  app.use(express.json());
  rollbackCliRoute(app, { targets: [f.c.target, cursor.target, other.target], executorUpdate: f.updater });
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error instanceof ZodError ? 400 : 500).json({ ok: false });
  });
  const server = await listenForFetch(app);
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));
  const request = (body: unknown) =>
    fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/inbox/rollback-cli`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const before = readdirSync(f.dir);
  for (const runtimeId of ['cursor', 'other-grok', 'missing']) {
    const response = await request({ runtimeId });
    assert.equal(response.status, runtimeId === 'missing' ? 404 : 200);
    assert.equal((await response.json()).ok, false);
    assert.deepEqual(readdirSync(f.dir), before);
    assert.equal(readFileSync(f.c.target.command, 'utf8'), 'broken executable');
  }
  assert.equal((await request({ runtimeId: 'g', extra: true })).status, 400);
  f.inbox.resolve('executor-update', 'grok:broken');
  assert.equal((await (await request({ runtimeId: 'g' })).json()).ok, false);
  assert.deepEqual(readdirSync(f.dir), before);
});
