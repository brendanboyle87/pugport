import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { ConversationPresentationClient, presentationClient } from '../src/ui/conversation-presentations.ts';
import type { Api } from '../src/ui/Workspace.tsx';
import type { AppState, Workflow } from '../src/shared/types.ts';
import { findNode, uiBundle, uiHarness } from './helpers/ui-harness.ts';
import type { ConversationPresentation } from '../src/shared/conversation-presentation.ts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConversationTaskDock } from '../src/ui/ConversationTaskDock.tsx';

const workflow = (id: string, conversationId = 'c'): Workflow => ({
  id,
  conversationId,
  projectId: 'p',
  userMessageId: `m-${id}`,
  input: { content: 'Synthetic task', mode: 'chat', permissionMode: 'read-only', executionPolicy: 'cli-first' },
  status: 'completed',
  phase: 'execute',
  plan: [],
  runIds: [`r-${id}`],
  memoryRevision: 0,
  memoryExcerpt: '',
  createdAt: '2020-01-01T00:00:00Z',
  updatedAt: '2020-01-01T00:00:00Z',
});
const projection = (id: string, revision = '1'): ConversationPresentation => ({
  workflowId: id,
  revision,
  version: 1,
  needsDetail: true,
  items: [],
});

test('only requested visible workflows load, shared callers dedupe and batches cap at 30', async () => {
  const calls: string[] = [];
  const api: Api = async <T>(path: string) => {
    calls.push(path);
    const ids = new URL(path, 'http://synthetic').searchParams.get('workflows')!.split(',');
    return { presentations: Object.fromEntries(ids.map((id) => [id, projection(id)])) } as T;
  };
  const client = presentationClient(api);
  assert.equal(presentationClient(api), client);
  const tasks = Array.from({ length: 80 }, (_, i) => workflow(`w${i}`));
  for (const task of tasks.slice(0, 31)) {
    client.request(task, '1');
    client.request(task, '1');
  }
  await setImmediate();
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.map((path) => new URL(path, 'http://synthetic').searchParams.get('workflows')!.split(',').length),
    [30, 1],
  );
  assert.equal(client.get(tasks[30], '1')?.workflowId, 'w30');
  assert.equal(client.get(tasks[31], '1'), undefined);
  client.request(tasks[0], '1');
  await setImmediate();
  assert.equal(calls.length, 2);
  client.request(tasks[31], '1');
  await setImmediate();
  assert.equal(calls.length, 3, 'showing earlier rows adds only their missing projections');
});

test('late old revisions cannot overwrite current requests and conversations stay separate', async () => {
  const pending: Array<{ path: string; resolve: (value: unknown) => void }> = [];
  const api: Api = <T>(path: string) =>
    new Promise<T>((resolve) => pending.push({ path, resolve: (value) => resolve(value as T) }));
  const client = new ConversationPresentationClient(api);
  const a = workflow('a', 'first'),
    b = workflow('b', 'second');
  let notifications = 0;
  const unsubscribe = client.subscribe(() => notifications++);
  client.request(a, 'old');
  await setImmediate();
  client.request(a, 'new');
  client.request(b, '1');
  pending[0].resolve({ presentations: { a: projection('a', 'old') } });
  await setImmediate();
  assert.equal(client.get(a, 'old'), undefined);
  assert.equal(notifications, 0);
  pending[1].resolve({ presentations: { a: projection('a', 'new') } });
  await setImmediate();
  assert.equal(client.get(a, 'new')?.revision, 'new');
  assert.ok(pending[2].path.startsWith('/api/conversations/second/'));
  unsubscribe();
  pending[2].resolve({ presentations: { b: projection('b') } });
  await setImmediate();
  assert.equal(client.get(b, '1')?.workflowId, 'b');
  assert.equal(notifications, 1);
});

test('failed or mismatched responses retain fallback without a request loop', async () => {
  let calls = 0;
  const api: Api = async <T>() => {
    calls++;
    if (calls === 1) throw new Error('Synthetic offline');
    return { presentations: { a: projection('a', 'stale') } } as T;
  };
  const client = new ConversationPresentationClient(api),
    a = workflow('a');
  client.request(a, '1');
  await setImmediate();
  client.request(a, '1');
  await setImmediate();
  assert.equal(calls, 1);
  assert.equal(client.get(a, '1'), undefined);
  client.request(a, '2');
  await setImmediate();
  assert.equal(calls, 2);
  assert.equal(client.get(a, '2'), undefined);
});

test('metadata changes invalidate historical entries when no revision map was supplied', async () => {
  let calls = 0;
  const api: Api = async <T>() => {
    calls++;
    return { presentations: { a: projection('a') } } as T;
  };
  const client = new ConversationPresentationClient(api),
    a = workflow('a');
  client.request(a);
  await setImmediate();
  assert.ok(client.get(a));
  const updated = { ...a, updatedAt: '2020-01-02T00:00:00Z' };
  assert.equal(client.get(updated), undefined);
  client.request(updated);
  await setImmediate();
  assert.equal(calls, 2);
});

test('remount retries transient failure once and still coalesces concurrent subscribers', async () => {
  let calls = 0;
  const api: Api = async <T>() => {
    if (++calls === 1) throw new Error('Synthetic offline');
    return { presentations: { a: projection('a') } } as T;
  };
  const client = new ConversationPresentationClient(api),
    a = workflow('a');
  client.request(a, '1', true);
  await setImmediate();
  assert.equal(client.get(a, '1'), undefined);
  client.request(a, '1', true);
  client.request(a, '1', true);
  await setImmediate();
  assert.equal(calls, 2);
  assert.equal(client.get(a, '1')?.revision, '1');
});

test('mounted workflow keeps fallback until compact data arrives, then uses the shared projection', async () => {
  const code = await uiBundle('src/ui/Workspace.tsx');
  const ui = uiHarness(code);
  const task = workflow('visible');
  let resolve!: (value: unknown) => void;
  const calls: string[] = [];
  const api: Api = <T>(path: string) => {
    calls.push(path);
    return new Promise<T>((done) => {
      resolve = (value) => done(value as T);
    });
  };
  const props = {
    workflow: task,
    state: {
      targets: [],
      runtimes: [],
      runs: [],
      workflows: [task],
      settings: {},
      conversationPresentations: {},
      conversationPresentationRevisions: { visible: '1' },
    } as unknown as AppState,
    api,
    notify() {},
    onInspect() {},
  };
  let tree = ui.render('WorkflowTrace', props);
  assert.equal(
    findNode(tree, (node) => node.type?.name === 'ConversationTurn'),
    undefined,
  );
  await setImmediate();
  assert.deepEqual(calls, ['/api/conversations/c/presentations?workflows=visible']);
  resolve({ presentations: { visible: projection('visible') } });
  await setImmediate();
  tree = ui.render('WorkflowTrace', props);
  assert.equal(
    findNode(tree, (node) => node.type?.name === 'ConversationTurn')?.props.projection.workflowId,
    'visible',
  );
  assert.equal(calls.length, 1);
  const liveValue = { ...projection('visible'), tasks: [{ title: 'Current task', status: 'running' as const }] };
  props.state = { ...props.state, conversationPresentations: { visible: liveValue } };
  tree = ui.render('WorkflowTrace', props);
  assert.equal(findNode(tree, (node) => node.type?.name === 'ConversationTurn')?.props.projection, liveValue);
  ui.unmount();
});

test('stats show turns alone until every projection is loaded, and never a dash for calls', () => {
  const tasks = [workflow('a'), workflow('b')];
  const state = { runs: [], conversationPresentations: { a: projection('a') } } as unknown as AppState;
  const partial = renderToStaticMarkup(createElement(ConversationTaskDock, { workflows: tasks, state, stats: true }));
  assert.match(partial, /2 轮</);
  assert.doesNotMatch(partial, /—|次调用/);
  state.conversationPresentations!.b = projection('b');
  const complete = renderToStaticMarkup(createElement(ConversationTaskDock, { workflows: tasks, state, stats: true }));
  assert.doesNotMatch(complete, /—/);
});

test('the context ring explains on hover that it is the context window, not a hit rate', () => {
  const run = {
    id: 'r-a',
    startedAt: '2020-01-01T00:00:00Z',
    route: { runtimeId: 'synthetic', model: 'm' },
    context: { tokens: 143_857, window: 200_000, at: '2020-01-01T00:00:00Z' },
  };
  const state = { runs: [run], conversationPresentations: { a: projection('a') } } as unknown as AppState;
  const html = renderToStaticMarkup(
    createElement(ConversationTaskDock, { workflows: [workflow('a')], state, stats: true }),
  );
  assert.match(html, /title="最近一轮占用的上下文窗口"/);
  assert.match(html, /<span translate="no">72%<\/span>/);
});
