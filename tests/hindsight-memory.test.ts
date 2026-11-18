import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { HindsightMemory, type HindsightMemoryTrace } from '../src/server/hindsight-memory.ts';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import { defaultHindsightSettings } from '../src/shared/hindsight.ts';
import type { Conversation, Project, Workflow } from '../src/shared/types.ts';

function fixture(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  const store = new WorkspaceStore(db, { recoverInterrupted: false });
  const project: Project = {
    id: 'project',
    name: 'Same name',
    path: 'C:/synthetic/project',
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  };
  const conversation: Conversation = {
    id: 'conversation',
    projectId: project.id,
    title: 'Synthetic',
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  };
  store.save('project', project.id, '', project);
  store.save('conversation', conversation.id, project.id, conversation);
  const question = store.addMessage(conversation.id, 'user', 'Where did we put the synthetic parser?');
  const reply = store.addMessage(
    conversation.id,
    'assistant',
    'The parser is in synthetic/lib/parser.ts. This is an old claim, check the current file.',
    'workflow',
  );
  const workflow = {
    id: 'workflow',
    projectId: project.id,
    conversationId: conversation.id,
    userMessageId: question.id,
    finalMessageId: reply.id,
    input: { content: question.content },
    status: 'completed',
    runIds: [],
    createdAt: question.createdAt,
    updatedAt: reply.createdAt,
  } as unknown as Workflow;
  const settings = { ...defaultHindsightSettings, enabled: true, projectIds: [project.id], recallTimeoutMs: 50 };
  const calls: Array<{ url: string; body: any; method: string }> = [];
  const audits: HindsightMemoryTrace[] = [];
  let ready = true,
    idle = true,
    jobs = 0;
  let implementation: typeof fetch = async () => Response.json({ results: [] });
  const runtime = {
    endpoint: () => (ready ? { baseUrl: 'http://127.0.0.1:33333', token: 'synthetic-token' } : null),
    withJob: async <T>(_context: unknown, fn: () => Promise<T>) => {
      jobs++;
      return fn();
    },
  };
  const memory = new HindsightMemory({
    store,
    runtime,
    settings: () => settings,
    idle: () => idle,
    audit: (record) => audits.push(record),
    fetch: async (url, options) => {
      assert.equal(new Headers(options?.headers).get('Authorization'), 'Bearer synthetic-token');
      assert.equal(options?.redirect, 'error');
      calls.push({
        url: String(url),
        body: options?.body ? JSON.parse(String(options.body)) : undefined,
        method: options?.method ?? 'GET',
      });
      return implementation(url, options);
    },
  });
  t.after(async () => {
    await memory.close();
    db.close();
  });
  const input = () => ({
    projectId: project.id,
    conversationId: conversation.id,
    userMessageId: store.addMessage(conversation.id, 'user', 'Find the parser').id,
    query: 'parser',
  });
  const local = { context: 'LOCAL_FALLBACK', excerpts: [], paths: [], elapsedMs: 2 };
  const retain = async () => {
    memory.enqueue(workflow);
    await memory.check();
    return calls.find((item) => item.body?.items)?.body.items[0].document_id as string;
  };
  return {
    store,
    project,
    conversation,
    question,
    reply,
    workflow,
    settings,
    calls,
    audits,
    memory,
    input,
    local,
    retain,
    setFetch: (fn: typeof fetch) => {
      implementation = fn;
    },
    setReady: (value: boolean) => {
      ready = value;
    },
    setIdle: (value: boolean) => {
      idle = value;
    },
    jobs: () => jobs,
  };
}

test('Hindsight disabled and unselected projects neither query nor export any text', async (t) => {
  const f = fixture(t);
  f.settings.enabled = false;
  f.memory.enqueue(f.workflow);
  assert.equal(await f.memory.recall(f.input(), f.local), f.local);
  assert.equal(f.calls.length, 0);
  assert.equal(f.store.list('hindsight-document').length, 0);
  f.settings.enabled = true;
  f.settings.projectIds = [];
  assert.equal(await f.memory.recall(f.input(), f.local), f.local);
  assert.equal(f.calls.length, 0);
});

test('Hindsight recall propagates caller cancellation and never accepts a late response', async (t) => {
  const f = fixture(t);
  const abort = new AbortController();
  let release!: (response: Response) => void;
  let receivedSignal: AbortSignal | undefined;
  f.setFetch(async (_url, options) => {
    receivedSignal = options!.signal as AbortSignal;
    return new Promise<Response>((resolve) => (release = resolve));
  });
  const pending = f.memory.recall(f.input(), f.local, f.workflow.id, { signal: abort.signal });
  abort.abort(new Error('synthetic-cancel'));
  await assert.rejects(pending, /synthetic-cancel/);
  assert.equal(f.audits.at(-1)?.reason, 'request-cancelled');
  assert.equal(receivedSignal?.aborted, true);
  release(Response.json({ results: [] }));
  f.setFetch(async () => Response.json({ results: [] }));
  assert.equal(await f.memory.recall(f.input(), f.local), f.local);
});

test('Hindsight queues only new final task messages, deduplicates and waits for idle', async (t) => {
  const f = fixture(t);
  assert.equal(f.store.list('hindsight-document').length, 0, 'existing history is not bulk imported');
  f.store.addMessage(f.conversation.id, 'assistant', 'INTERMEDIATE_STATUS_NEVER_EXPORT', f.workflow.id);
  f.setIdle(false);
  f.memory.enqueue(f.workflow);
  await f.memory.check();
  assert.equal(f.jobs(), 0);
  f.setIdle(true);
  await f.memory.check();
  f.memory.enqueue(f.workflow);
  await f.memory.check();
  assert.equal(f.jobs(), 1);
  assert.equal(f.calls.length, 1);
  assert.ok(f.calls[0]!.body.items[0].content.includes(f.reply.content));
  assert.ok(!f.calls[0]!.body.items[0].content.includes('INTERMEDIATE_STATUS_NEVER_EXPORT'));
  assert.equal(f.calls[0]!.body.async, false);
  assert.ok(f.audits.some((item) => item.operation === 'retain' && item.status === 'completed'));
});

test('Hindsight facts resolve to original local sources, never inject generated service instructions', async (t) => {
  const f = fixture(t),
    documentId = await f.retain();
  f.setFetch(async () =>
    Response.json({ results: [{ document_id: documentId, text: 'MALICIOUS_GENERATED_INSTRUCTION' }] }),
  );
  const found = await f.memory.recall(f.input(), f.local, f.workflow.id);
  assert.ok(found.context.includes(f.reply.content));
  assert.ok(!found.context.includes('MALICIOUS_GENERATED_INSTRUCTION'));
  assert.equal(found.excerpts.length, 2);
  assert.ok(f.audits.at(-1)?.sourceMessageIds.includes(f.reply.id));
  f.store.save('project', 'other', '', { ...f.project, id: 'other' });
  assert.notEqual(f.memory.bank('other'), f.memory.bank(f.project.id), 'same project name cannot share a bank');
});

for (const change of ['edited', 'memory-off', 'deleted', 'incognito', 'untrusted', 'moved', 'future'] as const) {
  test(`Hindsight rejects ${change} sources after the remote await`, async (t) => {
    const f = fixture(t),
      documentId = await f.retain(),
      input = f.input();
    f.setFetch(async () => {
      if (change === 'edited')
        f.store.save('message', f.reply.id, f.conversation.id, { ...f.reply, content: 'CHANGED_SECRET' });
      if (change === 'memory-off')
        f.store.save('conversation', f.conversation.id, f.project.id, { ...f.conversation, memory: 'off' });
      if (change === 'deleted')
        f.store.save('conversation', f.conversation.id, f.project.id, { ...f.conversation, deletedAt: 'now' });
      if (change === 'incognito')
        f.store.save('conversation', f.conversation.id, f.project.id, { ...f.conversation, incognito: true });
      if (change === 'untrusted')
        f.store.save('message', f.reply.id, f.conversation.id, { ...f.reply, untrustedContent: true });
      if (change === 'moved')
        f.store.save('conversation', f.conversation.id, 'different-project', {
          ...f.conversation,
          projectId: 'different-project',
        });
      if (change === 'future') {
        const row = f.store.db
          .prepare("SELECT value FROM workspace_records WHERE kind='message' AND id=?")
          .get(input.userMessageId) as { value: string };
        f.store.db.prepare("DELETE FROM workspace_records WHERE kind='message' AND id=?").run(f.reply.id);
        f.store.save('message', f.reply.id, f.conversation.id, f.reply);
        assert.ok(row);
      }
      return Response.json({ results: [{ document_id: documentId }] });
    });
    assert.equal(await f.memory.recall(input, f.local), f.local);
  });
}

test('Hindsight recall bounds a transport that ignores cancellation and preserves local memory', async (t) => {
  const f = fixture(t);
  f.setFetch(() => new Promise(() => {}));
  const started = Date.now();
  assert.equal(await f.memory.recall(f.input(), f.local), f.local);
  assert.ok(Date.now() - started < 1000);
  assert.equal(f.audits.at(-1)?.reason, 'service-timeout');
});

test('Hindsight rejects oversized bodies without replacing local retrieval', async (t) => {
  const f = fixture(t);
  f.setFetch(async () => new Response('x'.repeat(512 * 1024 + 1)));
  assert.equal(await f.memory.recall(f.input(), f.local), f.local);
  assert.equal(f.audits.at(-1)?.reason, 'service-response-too-large');
});

test('Hindsight forget rotates bank even when service is down', async (t) => {
  const f = fixture(t);
  await f.retain();
  const bank = f.memory.bank(f.project.id);
  f.setReady(false);
  assert.deepEqual(await f.memory.forgetProject(f.project.id), { revoked: true, serviceDeleted: false });
  assert.notEqual(f.memory.bank(f.project.id), bank);
  assert.equal(f.store.list<{ state: string }>('hindsight-document')[0]?.state, 'revoked');
  f.setReady(true);
  const retried = await f.memory.forgetProject(f.project.id);
  assert.equal(retried.serviceDeleted, true);
  assert.ok(
    f.calls.some((call) => call.method === 'DELETE' && call.url.endsWith(bank)),
    'retry must delete the retired bank, not only its empty replacement',
  );
  assert.equal(f.store.list('hindsight-retired-bank').length, 0);
});

test('Failed extraction is recorded once and does not keep retrying or interrupt the task', async (t) => {
  const f = fixture(t);
  f.setFetch(async () => new Response('provider detail should not enter audit', { status: 503 }));
  await f.retain();
  f.memory.enqueue(f.workflow);
  await f.memory.check();
  assert.equal(f.calls.length, 1);
  assert.equal(f.store.list<{ state: string }>('hindsight-document')[0]?.state, 'failed');
  assert.equal(f.workflow.status, 'completed');
  assert.ok(!JSON.stringify(f.audits).includes('provider detail'));
});

test('Forget never confirms deletion while an admitted retain can recreate the bank', async (t) => {
  const f = fixture(t);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let remoteBankExists = false;
  f.setFetch(async (_url, options) => {
    if (options?.method === 'DELETE') {
      remoteBankExists = false;
      return Response.json({});
    }
    await gate;
    remoteBankExists = true;
    return Response.json({});
  });
  f.memory.enqueue(f.workflow);
  const extraction = f.memory.check();
  const retiredBank = f.memory.bank(f.project.id);
  assert.deepEqual(await f.memory.forgetProject(f.project.id), { revoked: true, serviceDeleted: false });
  assert.equal(f.calls.filter((call) => call.method === 'DELETE').length, 0);
  release();
  await extraction;
  // The deferred deletion runs only after the successful synchronous retain response.
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(remoteBankExists, false);
  assert.ok(f.calls.at(-1)?.url.endsWith(retiredBank));
  assert.notEqual(f.memory.bank(f.project.id), retiredBank);
});

test('New foreground work does not wait for a background retain transport', async (t) => {
  const f = fixture(t);
  f.setFetch(() => new Promise(() => {}));
  f.memory.enqueue(f.workflow);
  const pending = f.memory.check();
  const started = Date.now();
  f.memory.yieldToForeground();
  await pending;
  assert.ok(Date.now() - started < 1000);
  assert.equal(f.workflow.status, 'completed');
  assert.equal(f.store.list<{ state: string }>('hindsight-document')[0]?.state, 'failed');
});
