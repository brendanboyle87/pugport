import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { test, type TestContext } from 'node:test';
import { indexMemory, prewarmMemory, ProjectVectors } from '../src/server/memory-vectors.ts';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import { Controller } from '../src/server/controller.ts';
import { Workspace } from '../src/server/workspace.ts';
import type { MessageInput } from '../src/shared/types.ts';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'pugport-memory-prewarm-'));
  t.mock.property(process, 'env', {
    ...process.env,
    PUGPORT_RUNTIME_DIR: join(root, '.runtime'),
    COMBORUNNER_MEMORY_DIR: join(root, 'memory'),
    COMBORUNNER_MEMORY_VECTORS_DIR: join(root, 'vectors'),
    COMBORUNNER_MEMORY_BACKGROUND: '0',
  });
  t.after(() => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}
function model(root: string) {
  const directory = join(root, '.runtime', 'memory-search');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'model.onnx'), 'synthetic metadata only; never loaded');
  writeFileSync(join(directory, 'tokenizer.json'), '{}');
}
async function vectors(projectId: string) {
  const saved = await ProjectVectors.open(projectId);
  saved.replace([{ messageId: 'synthetic-old-message', offset: 0, hash: 'synthetic' }], [new Int8Array(1024)]);
  await saved.save();
}

test('prewarm requires an installed search model and persisted project vectors', async (t) => {
  const root = fixture(t);
  let calls = 0;
  const options = {
    warmLegacy: async () => {
      calls++;
    },
  };
  await vectors('saved');
  await prewarmMemory(root, 'saved', options);
  assert.equal(calls, 0, 'search unavailable');
  model(root);
  await prewarmMemory(root, 'empty', options);
  assert.equal(calls, 0, 'no persisted vectors');
  await prewarmMemory(root, 'saved', options);
  assert.equal(calls, 1);
});

test('message bursts coalesce pending and completed warmups and failures permit a later retry', async (t) => {
  const root = fixture(t);
  model(root);
  await vectors('saved');
  let calls = 0;
  let finish!: () => void;
  let started!: () => void;
  const start = new Promise<void>((resolve) => {
    started = resolve;
  });
  const warmLegacy = async () => {
    calls++;
    await new Promise<void>((done) => {
      finish = done;
      started();
    });
  };
  const first = prewarmMemory(root, 'saved', { warmLegacy, now: 1000 });
  const second = prewarmMemory(root, 'saved', { warmLegacy, now: 4000 });
  await start;
  assert.equal(calls, 1);
  finish();
  await Promise.all([first, second]);
  await prewarmMemory(root, 'saved', { warmLegacy, now: 1500 });
  assert.equal(calls, 1);
  await prewarmMemory(root, 'saved', {
    now: 5000,
    warmLegacy: async () => {
      calls++;
      throw new Error('synthetic');
    },
  });
  await prewarmMemory(root, 'saved', {
    now: 7000,
    warmLegacy: async () => {
      calls++;
    },
  });
  assert.equal(calls, 3);
  t.diagnostic(JSON.stringify({ burstMessages: 3, burstWarmups: 1, retriesAfterFailure: 1 }));
});

test('an unusable vector directory cannot throw synchronously from prewarm', async (t) => {
  const root = fixture(t);
  model(root);
  writeFileSync(join(root, 'vectors'), 'synthetic file blocks directory creation');
  let pending!: Promise<void>;
  assert.doesNotThrow(() => {
    pending = prewarmMemory(root, 'saved', {
      warmLegacy: async () => {
        throw new Error('must not load');
      },
    });
  });
  await pending;
});

for (const backing of ['memory', 'file'] as const)
  test(`an expired BGE indexing budget still reconciles and preserves reusable late cached vectors (${backing})`, async (t) => {
    let db: DatabaseSync;
    t.after(() => db?.close());
    const root = fixture(t);
    model(root);
    const content = 'known late historical passage';
    const saved = await ProjectVectors.open('budget-project');
    saved.replace(
      [{ messageId: 'known-late', offset: 0, hash: createHash('sha1').update(content).digest('hex').slice(0, 16) }],
      [new Int8Array(1024).fill(7)],
    );
    await saved.save();
    const project = {
      id: 'budget-project',
      name: 'Synthetic budget project',
      path: root,
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    };
    db = new DatabaseSync(backing === 'memory' ? ':memory:' : join(root, 'studio.sqlite'));
    db.exec('CREATE TABLE workspace_records(kind TEXT,id TEXT,owner TEXT,updated_at TEXT,value TEXT)');
    const insert = db.prepare('INSERT INTO workspace_records VALUES (?,?,?,?,?)');
    const add = (kind: string, id: string, owner: string, value: unknown) =>
      insert.run(kind, id, owner, '2026-01-01', JSON.stringify(value));
    add('project', project.id, '', project);
    add('conversation', 'conversation', project.id, { id: 'conversation' });
    for (let i = 0; i < 320; i++)
      add('message', `new-early-${i}`, 'conversation', { role: 'user', content: `new early history ${i}` });
    add('message', 'known-late', 'conversation', { role: 'user', content });
    const store = new WorkspaceStore(db, { initialize: false, recoverInterrupted: false });
    assert.equal(await indexMemory(root, store, 'budget-project', { until: Date.now() - 1 }), 320);
    assert.deepEqual(
      (await ProjectVectors.open('budget-project')).items.map((item) => item.messageId),
      ['known-late'],
    );
    assert.deepEqual((await ProjectVectors.open('budget-project')).vectors[0], new Int8Array(1024).fill(7));
  });

test('workspace warms on actual user sends without waiting, and skips broadcasts and internal/device/untrusted sends', async (t) => {
  let workspace!: Workspace;
  let controller!: Controller;
  let finish!: () => void;
  t.after(async () => {
    finish?.();
    await workspace?.close();
    await controller?.close();
  });
  const root = fixture(t);
  controller = new Controller(root, join(root, 'data'), { readAccountIdentity: () => 'synthetic' });
  clearInterval(controller.timer);
  let calls = 0;
  workspace = new Workspace(controller, {
    autoTick: false,
    prewarmMemory: () => {
      calls++;
      if (calls === 2) throw new Error('synthetic synchronous prewarm failure');
      return new Promise<void>((done) => {
        finish = done;
      });
    },
  });
  const project = { id: randomUUID(), name: 'Synthetic', path: root, createdAt: '2026-01-01', updatedAt: '2026-01-01' };
  workspace.store.save('project', project.id, '', project);
  const conversation = workspace.createConversation(project.id);
  const input: MessageInput = {
    content: 'Explain synthetic history',
    mode: 'chat',
    permissionMode: 'read-only',
    executionPolicy: 'cli-first',
    queue: true,
  };
  const arrival = { incomingUserMessage: true };
  await workspace.send(conversation.id, input, undefined, undefined, arrival);
  assert.equal(calls, 1, 'send did not wait for warmup');
  for (let poll = 0; poll < 3; poll++) {
    controller.broadcast();
    workspace.state();
  }
  assert.equal(calls, 1, 'broadcast/status never warms');
  await workspace.send(conversation.id, input);
  assert.equal(calls, 1, 'tool-generated new tasks never warm');
  await workspace.send(conversation.id, { ...input, deviceId: 'synthetic-device' }, undefined, undefined, arrival);
  await workspace.send(conversation.id, input, 'synthetic-missing-parent', undefined, arrival).catch(() => {});
  await workspace
    .send(
      conversation.id,
      input,
      undefined,
      {
        parentId: 'synthetic-missing-parent',
        requestId: 'generated',
        role: 'worker',
      },
      arrival,
    )
    .catch(() => {});
  await workspace
    .send(
      conversation.id,
      { ...input, externalRequest: { thirdParty: true } } as MessageInput,
      undefined,
      undefined,
      arrival,
    )
    .catch(() => {});
  const result = await workspace.send(conversation.id, input, undefined, undefined, arrival);
  assert.equal(result.message.content, input.content, 'synchronous prewarm failure still accepts the message');
  assert.equal(calls, 2);
  await workspace.send(conversation.id, { ...input, untrustedContent: true }, undefined, undefined, arrival);
  await workspace.send(conversation.id, input, undefined, undefined, arrival);
  assert.equal(calls, 2, 'internal messages and tool-less conversations never warm');
});
