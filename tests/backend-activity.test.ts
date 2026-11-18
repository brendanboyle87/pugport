import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BackendActivity, EventLoopLag, backendActivity, trackBusy } from '../src/server/backend-activity.ts';
import { memoryJobs, track } from '../src/server/memory-telemetry.ts';

test('stale jobs expire once after ten minutes, including persisted and recent stacks', (t) => {
  let now = 0;
  const lines: string[] = [];
  const activity = new BackendActivity(
    () => now,
    (line) => lines.push(line),
  );
  const directory = mkdtempSync(join(tmpdir(), 'pugport-stale-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  activity.configure(directory);
  activity.begin('old', 'embedding-model-unload');
  activity.begin('short', 'short');
  now = 100;
  activity.end('short');
  now = 600_000;
  assert.deepEqual(activity.stack(), ['embedding-model-unload']);
  now++;
  assert.deepEqual(activity.stack(), []);
  assert.deepEqual(activity.lagStack(), ['short']);
  activity.end('old');
  assert.deepEqual(activity.stack(), []);
  assert.deepEqual(lines, ['[busy] dropped stale embedding-model-unload']);
  assert.deepEqual(JSON.parse(readFileSync(join(directory, 'logs/backend-busy.json'), 'utf8')), { idle: true });
});

test('synchronous breadcrumb records start, nested stack, out-of-order end and idle', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'pugport-busy-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const activity = new BackendActivity();
  activity.configure(directory);
  const read = () => JSON.parse(readFileSync(join(directory, 'logs/backend-busy.json'), 'utf8'));
  activity.begin('1', 'outer');
  assert.equal(read().name, 'outer');
  assert.equal(read().pid, process.pid);
  assert.ok(Number.isFinite(Date.parse(read().startedAt)));
  activity.begin('2', 'inner');
  assert.deepEqual(
    read().stack.map((job: { name: string }) => job.name),
    ['outer', 'inner'],
  );
  activity.end('2');
  assert.equal(read().name, 'outer');
  activity.begin('3', 'concurrent');
  activity.end('1');
  assert.deepEqual(
    read().stack.map((job: { name: string }) => job.name),
    ['concurrent'],
  );
  activity.end('3');
  activity.end('3');
  assert.deepEqual(read(), { idle: true });
});

test('lag logger observes drift, completed synchronous work and the 30 second rate limit', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let now = 0;
  const lines: string[] = [];
  const activity = new BackendActivity(() => now);
  const lag = new EventLoopLag(
    activity,
    (line) => lines.push(line),
    () => now,
  );
  lag.start();
  t.after(() => lag.close());
  activity.begin('1', 'outer');
  activity.begin('2', 'inner');
  now = 4001;
  t.mock.timers.tick(1000);
  assert.deepEqual(lines, ['[lag] 3001ms during ["outer","inner"]']);
  now += 4000;
  t.mock.timers.tick(1000);
  assert.equal(lines.length, 1);
  activity.end('2');
  now = 34_001;
  t.mock.timers.tick(1000);
  assert.equal(lines.length, 2);
  activity.end('1');
  now += 1000;
  t.mock.timers.tick(1000);
  assert.equal(lines.length, 2);
  activity.begin('3', 'sync-job');
  activity.begin('4', 'sync-inner');
  now += 100;
  activity.end('4');
  activity.end('3');
  now += 30_000;
  t.mock.timers.tick(1000);
  assert.match(lines[2]!, /sync-job.*sync-inner/);
  lag.close();
  now += 40_000;
  t.mock.timers.tick(1000);
  assert.equal(lines.length, 3);
});

test('all track labels share the breadcrumb with nested heavy steps', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'pugport-tracked-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  backendActivity.configure(directory);
  const read = () => JSON.parse(readFileSync(join(directory, 'logs/backend-busy.json'), 'utf8'));
  for (const name of memoryJobs) {
    const end = track(name);
    assert.equal(read().name, name);
    const inner = trackBusy('task-outcome-confirmation');
    assert.deepEqual(
      read().stack.map((job: { name: string }) => job.name),
      [name, 'task-outcome-confirmation'],
    );
    inner();
    end();
    assert.deepEqual(read(), { idle: true });
  }
});

test('short queue polls do not replace a completed slow job in lag attribution', () => {
  let now = 0;
  const activity = new BackendActivity(() => now);
  activity.begin('slow', 'slow-job');
  now = 100;
  activity.end('slow');
  activity.begin('poll', 'workspace-queue');
  now += 99;
  activity.end('poll');
  assert.deepEqual(activity.lagStack(), ['slow-job']);
  assert.deepEqual(activity.lagStack(), []);
});

test('unchanged stack content does not rewrite the breadcrumb', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'pugport-busy-dedup-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const activity = new BackendActivity(() => 0);
  activity.configure(directory);
  const file = join(directory, 'logs/backend-busy.json');
  for (const active of [false, true]) {
    if (active) activity.begin('job', 'same-job');
    utimesSync(file, new Date(0), new Date(0));
    const modified = statSync(file).mtimeMs;
    activity.discard('missing');
    if (active) activity.begin('job', 'same-job');
    assert.equal(statSync(file).mtimeMs, modified);
  }
});
