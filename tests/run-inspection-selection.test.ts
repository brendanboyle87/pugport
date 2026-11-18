import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import type { RunRecord } from '../src/shared/types.ts';
import type { RunInspectionState } from '../src/ui/Studio.tsx';
import type { Api } from '../src/ui/Workspace.tsx';

// Studio includes the Vite logo asset. Bundle it in memory; no desktop, server or model is started.
const compiled = await build({
  entryPoints: ['src/ui/Studio.tsx'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  packages: 'external',
  loader: { '.png': 'dataurl', '.css': 'empty' },
});
const inspectionModule = { exports: {} };
runInNewContext(compiled.outputFiles[0]!.text, {
  module: inspectionModule,
  exports: inspectionModule.exports,
  require: createRequire(import.meta.url),
  URL,
  Error,
  console,
  setTimeout,
  clearTimeout,
});
const { requestRunInspection, RunInspectionFallback } =
  inspectionModule.exports as typeof import('../src/ui/Studio.tsx');

function record(id: string): RunRecord {
  return {
    id,
    prompt: 'Inspect files',
    projectPath: 'C:/fixture',
    kind: 'routine',
    status: 'completed',
    route: { runtimeId: 'codex', model: 'fixture', kind: 'routine', reasons: [], warnings: [] },
    startedAt: '2026-10-08T12:00:00Z',
    output: 'done',
    events: [],
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test('loads an explicitly selected omitted run with a local GET and exact ID', async () => {
  const calls: unknown[][] = [],
    changes: RunInspectionState[] = [];
  const run = record('old-parent');
  const api: Api = async <T>(...args: [string, unknown?, string?]) => {
    calls.push(args);
    return run as T;
  };
  await requestRunInspection(api, run.id, (state) => changes.push(structuredClone(state))).promise;
  assert.deepEqual(calls, [['/api/runs/old-parent', undefined, 'GET']]);
  assert.deepEqual(changes, [
    { id: run.id, status: 'loading' },
    { id: run.id, status: 'ready', run },
  ]);
});

test('quick selection switches discard an earlier response even when it arrives last', async () => {
  const first = deferred<RunRecord>(),
    second = deferred<RunRecord>();
  const api: Api = <T>(path: string) => (path.endsWith('/first') ? first.promise : second.promise) as Promise<T>;
  const changes: RunInspectionState[] = [];
  const old = requestRunInspection(api, 'first', (state) => changes.push(structuredClone(state)));
  old.cancel();
  const next = requestRunInspection(api, 'second', (state) => changes.push(structuredClone(state)));
  second.resolve(record('second'));
  await next.promise;
  first.resolve(record('first'));
  await old.promise;
  assert.deepEqual(
    changes.map((state) => [state.id, state.status]),
    [
      ['first', 'loading'],
      ['second', 'loading'],
      ['second', 'ready'],
    ],
  );
});

test('closing or superseding an inspection prevents late failure feedback', async () => {
  const result = deferred<RunRecord>(),
    changes: RunInspectionState[] = [];
  const api: Api = <T>() => result.promise as Promise<T>;
  const request = requestRunInspection(api, 'first', (state) => changes.push(structuredClone(state)));
  request.cancel();
  result.reject(new Error('late error'));
  await request.promise;
  assert.deepEqual(changes, [{ id: 'first', status: 'loading' }]);
});

test('failure is explicit and a fresh retry can return the requested record', async () => {
  let attempts = 0;
  const changes: RunInspectionState[] = [];
  const api: Api = async <T>() => {
    if (!attempts++) throw new Error('Run not found');
    return record('first') as T;
  };
  await requestRunInspection(api, 'first', (state) => changes.push(structuredClone(state))).promise;
  assert.deepEqual(changes.at(-1), { id: 'first', status: 'failed', error: 'Run not found' });
  await requestRunInspection(api, 'first', (state) => changes.push(structuredClone(state))).promise;
  assert.equal(changes.at(-1)?.status, 'ready');
  assert.equal(attempts, 2);
});

test('a mismatched response cannot display another run under the selected ID', async () => {
  const changes: RunInspectionState[] = [];
  const api: Api = async <T>() => record('different-run') as T;
  await requestRunInspection(api, 'wanted', (state) => changes.push(structuredClone(state))).promise;
  assert.equal(changes.at(-1)?.status, 'failed');
  assert.ok(changes.every((state) => state.id === 'wanted'));
  assert.ok(changes.every((state) => state.status !== 'ready'));
});

test('fallback distinguishes loading, failed-with-retry and no selection; stale errors stay hidden', () => {
  const render = (id: string, state?: RunInspectionState) =>
    renderToStaticMarkup(createElement(RunInspectionFallback, { id, state, onRetry() {} }));
  const loading = render('wanted', { id: 'old', status: 'failed', error: 'STALE ERROR' });
  assert.match(loading, /role="status"/);
  assert.match(loading, /正在加载所选执行记录/);
  assert.doesNotMatch(loading, /STALE ERROR|选择一条执行记录/);
  const failure = render('wanted', { id: 'wanted', status: 'failed', error: 'Run not found' });
  assert.match(failure, /role="alert"/);
  assert.match(failure, /执行记录加载失败/);
  assert.match(failure, /Run not found/);
  assert.match(failure, /<button type="button">重试/);
  assert.match(render(''), /选择一条执行记录/);
  assert.match(render('wanted', { id: 'wanted', status: 'failed', error: '' }), /role="alert"/);
});
