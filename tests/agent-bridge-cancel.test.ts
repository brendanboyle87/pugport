import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { AgentBridge } from '../src/server/agent-bridge.ts';
import type { Controller } from '../src/server/controller.ts';
import type { Workspace } from '../src/server/workspace.ts';

test('a disconnected child question releases its suspended execution immediately without cancelling the whole run', async (t) => {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'pugport-bridge-cancel-')));
  const runAbort = new AbortController(),
    transportAbort = new AbortController();
  let suspended = 0,
    resumed = 0;
  const caller = {
    run: { id: 'child-run', workflowId: 'child', status: 'running' },
    target: { id: 'codex', provider: 'codex' },
    child: true,
    write: false,
    delegate: false,
    recycle: false,
    signal: runAbort.signal,
  };
  const controller = Object.assign(new EventEmitter(), {
    recordRunEvent() {},
    dataDir: join(directory, 'data'),
    agentBridgeCaller: () => caller,
    returnExecution: () => async () => {},
    activeRunFor: () => 'parent-run',
    steerInterrupts: () => true,
    suspendExecution: () => {
      suspended++;
      return async () => {
        resumed++;
      };
    },
  }) as unknown as Controller;
  const workspace = {
    store: {
      get: () => ({
        id: 'child',
        status: 'running',
        delegation: { parentId: 'parent', agent: { label: 'fixture' } },
        runIds: [],
      }),
    },
    queueNotice: () => {},
    // The parent is running, so a notice is queued for its next tool result: delivered.
    notifyRun: async () => true,
    takeNotices: () => [],
  } as unknown as Workspace;
  const bridge = new AgentBridge(workspace, controller, 'unused');
  t.after(async () => {
    runAbort.abort();
    transportAbort.abort();
    await bridge.close();
    controller.removeAllListeners();
    assert.equal(dirname(directory).toLowerCase(), realpathSync.native(tmpdir()).toLowerCase());
    assert.ok(basename(directory).startsWith('pugport-bridge-cancel-'));
    rmSync(directory, { recursive: true, force: true });
  });
  const pending = bridge.handle(
    'Bearer fixture',
    { id: 1, method: 'tools/call', params: { name: 'message_parent', arguments: { text: 'question' } } },
    transportAbort.signal,
  );
  await new Promise((done) => setTimeout(done, 10));
  assert.equal(suspended, 1);
  transportAbort.abort(new Error('fixture disconnected'));
  const response = await Promise.race([
    pending,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('question still waiting')), 1000)),
  ]);
  assert.equal(resumed, 1);
  assert.equal(runAbort.signal.aborted, false);
  const result = (response.body as { result: { isError: boolean; content: Array<{ text: string }> } }).result;
  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /fixture disconnected/);
  // The old question was removed: the same child may ask a fresh question and receive a run cancellation.
  const next = bridge.handle('Bearer fixture', {
    id: 2,
    method: 'tools/call',
    params: { name: 'message_parent', arguments: { text: 'next question' } },
  });
  await new Promise((done) => setTimeout(done, 10));
  assert.equal(suspended, 2);
  runAbort.abort(new Error('fixture run cancelled'));
  await next;
  assert.equal(resumed, 2);
});
