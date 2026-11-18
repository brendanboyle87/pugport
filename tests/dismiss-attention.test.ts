import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import { Store } from '../src/server/store.ts';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import { Workspace } from '../src/server/workspace.ts';
import { localApiGuard, ownerApiGuard } from '../src/server/local-api-guard.ts';
import type { Workflow } from '../src/shared/types.ts';

test('dismiss route authenticates, persists only the attention timestamp, broadcasts, and rejects unknown IDs', (t) => {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'pugport-dismiss-attention-')));
  const database = new Store(directory);
  const store = new WorkspaceStore(database.db);
  t.after(() => {
    database.close();
    assert.equal(dirname(directory).toLowerCase(), realpathSync.native(tmpdir()).toLowerCase());
    assert.ok(basename(directory).startsWith('pugport-dismiss-attention-'));
    rmSync(directory, { recursive: true, force: true });
  });
  const workflow = {
    id: 'fixture',
    conversationId: 'chat',
    status: 'failed',
    updatedAt: 'unchanged',
    runIds: ['run'],
    input: { permissionMode: 'read-only' },
  } as Workflow;
  store.save('workflow', workflow.id, workflow.conversationId, workflow);
  let broadcasts = 0;
  const context = {
    store,
    now: () => '2026-10-31T12:00:00Z',
    controller: { broadcast: () => broadcasts++ },
  } as unknown as Workspace;
  const workspace = {
    dismissWorkflowAttention: (id: string) => Workspace.prototype.dismissWorkflowAttention.call(context, id),
  };
  const source = readFileSync(new URL('../src/server/main.ts', import.meta.url), 'utf8');
  const route = source.match(
    /app\.post\('\/api\/workflows\/:id\/dismiss-attention', \(req, res\) => \{[\s\S]*?\n\}\);/,
  )?.[0];
  assert.ok(route);
  assert.ok(source.indexOf('app.use(localApiGuard(') < source.indexOf(route));
  assert.ok(source.indexOf('app.use(ownerApiGuard(') < source.indexOf(route));
  let handler!: Function;
  new Function('app', 'workspace', 'z', route)(
    {
      post: (_path: string, fn: Function) => {
        handler = fn;
      },
    },
    workspace,
    z,
  );
  const guard = localApiGuard('session', new Set(['localhost']), new Set());
  const owner = ownerApiGuard('owner');
  function request(id: string, token?: string, ownerToken?: string, body: unknown = {}) {
    let status = 200,
      result: unknown;
    const req = {
      method: 'POST',
      path: `/api/workflows/${id}/dismiss-attention`,
      params: { id },
      body,
      headers: { host: 'localhost', 'x-agent-token': token, 'x-pugport-owner': ownerToken, 'content-length': '2' },
      is: () => true,
    };
    const res = {
      locals: {},
      setHeader() {},
      status(value: number) {
        status = value;
        return this;
      },
      json(value: unknown) {
        result = value;
        return this;
      },
    };
    guard(req as any, res as any, () => owner(req as any, res as any, () => handler(req, res)));
    return { status, result };
  }
  assert.equal(request('fixture').status, 403);
  assert.equal(request('fixture', 'wrong', 'owner').status, 403);
  assert.equal(request('fixture', 'session').status, 403);
  assert.equal(broadcasts, 0);
  assert.equal(store.get<Workflow>('workflow', 'fixture')?.attentionDismissedAt, undefined);
  assert.throws(() => request('missing', 'session', 'owner'), /工作流不存在/);
  assert.throws(() => request('fixture', 'session', 'owner', { status: 'completed' }));
  assert.equal(request('fixture', 'session', 'owner').status, 200);
  const expected = { ...workflow, attentionDismissedAt: '2026-10-31T12:00:00Z' };
  assert.deepEqual(store.get('workflow', 'fixture'), expected);
  assert.equal(broadcasts, 1);
  request('fixture', 'session', 'owner');
  assert.deepEqual(store.get('workflow', 'fixture'), expected);
  store.save('workflow', 'fixture', 'chat', { ...expected, deletedAt: 'deleted' });
  assert.throws(() => request('fixture', 'session', 'owner'), /工作流不存在/);
});
