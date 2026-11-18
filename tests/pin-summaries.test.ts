import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Workspace } from '../src/server/workspace.ts';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import {
  PinSummaryJob,
  PIN_SUMMARY_RETRY_MS,
  parsePinSummary,
  type PinSummaryCandidate,
} from '../src/server/pin-summaries.ts';
import { pinnedMessageCard, pinSummaryExtract } from '../src/shared/pinned-messages.ts';
import { filterSyncValue } from '../src/shared/account-sync.ts';
import type {
  Conversation,
  ConversationMessage,
  MessageInput,
  PinnedMessageSummary,
  Workflow,
} from '../src/shared/types.ts';

const at = '2026-11-04T00:00:00.000Z';
const answer =
  '# 东京三日行程\n\n第一天去浅草和上野，第二天去镰仓看海，第三天在新宿购物。所有交通都用 Suica 卡。\n\n```js\nconsole.log(1)\n```';

test('the extract uses the first heading or sentence and never shows raw Markdown', () => {
  const extract = pinSummaryExtract(answer);
  assert.equal(extract.title, '东京三日行程');
  assert.ok(extract.description.startsWith('第一天去浅草和上野'));
  assert.ok(extract.description.endsWith('…') && Array.from(extract.description).length <= 40);
  assert.doesNotMatch(extract.description, /console|```|#/);
  const latin = pinSummaryExtract(
    'The **database migration** failed because the [index](https://example.test) was missing. Rebuild it first.',
  );
  assert.equal(latin.title, 'The database migration failed because the…');
  assert.ok(Array.from(latin.title).length <= 48);
  assert.match(latin.description, /Rebuild it first/);
  assert.equal(pinSummaryExtract('简短问题').title, '简短问题');
  assert.ok(Array.from(pinSummaryExtract('很'.repeat(60)).title).length <= 16);
  assert.deepEqual(pinSummaryExtract(''), { title: '', description: '' });
});

test('a card shows the extract with a pending note until the summary arrives; incognito is never pending', () => {
  const message = { id: 'm', conversationId: 'c', role: 'assistant', content: answer, createdAt: at } as const;
  const pin = { messageId: 'm', pinnedAt: at };
  assert.deepEqual(pinnedMessageCard(pin, message), { title: '东京三日行程', description: '正在总结…', pending: true });
  assert.equal(pinnedMessageCard(pin, message, true).pending, false);
  assert.match(pinnedMessageCard(pin, message, true).description, /浅草/);
  const summary: PinnedMessageSummary = { title: '东京行程', description: '三天路线与交通', source: 'model', at };
  assert.deepEqual(pinnedMessageCard({ ...pin, summary }, message), {
    title: '东京行程',
    description: '三天路线与交通',
    pending: false,
  });
});

test('model replies are parsed as one-line JSON and anything else is rejected', () => {
  assert.deepEqual(parsePinSummary('```json\n{"title":" 东京\\n行程 ","description":"三天路线"}\n```'), {
    title: '东京 行程',
    description: '三天路线',
  });
  assert.equal(parsePinSummary('Here is a summary'), undefined);
  assert.equal(parsePinSummary('[{"title":"x"}]'), undefined);
  assert.equal(parsePinSummary('{"title":"","description":"x"}'), undefined);
});

test('the job saves a model summary, and a failing route gets one later retry then keeps the extract', async () => {
  const candidate: PinSummaryCandidate = {
    conversationId: 'c',
    messageId: 'm',
    pinnedAt: at,
    role: 'assistant',
    content: answer,
    question: '帮我排东京行程',
  };
  let now = Date.parse(at);
  const saved: PinnedMessageSummary[] = [];
  const prompts: string[] = [];
  let pending = [candidate];
  let lands = true;
  let reply = async (): Promise<string> => '{"title":"东京三日游","description":"每天的路线和交通"}';
  const job = new PinSummaryJob(
    {
      candidates: () => pending,
      run: async (prompt) => {
        prompts.push(prompt);
        return reply();
      },
      save: (_ref, summary) => {
        saved.push(summary);
        if (lands) pending = [];
      },
    },
    () => now,
  );
  await job.flush();
  assert.equal(prompts.length, 1);
  assert.match(prompts[0]!, /untrusted/i);
  assert.match(prompts[0]!, /帮我排东京行程/);
  assert.deepEqual(saved, [
    { title: '东京三日游', description: '每天的路线和交通', source: 'model', at: new Date(now).toISOString() },
  ]);

  pending = [{ ...candidate, messageId: 'other' }];
  // Even a save that never lands must not lead to a third request.
  lands = false;
  saved.length = 0;
  prompts.length = 0;
  reply = async () => {
    throw new Error('route unavailable');
  };
  await job.flush();
  await job.flush();
  assert.equal(prompts.length, 1, 'no immediate retry');
  assert.deepEqual(saved, []);
  now += PIN_SUMMARY_RETRY_MS;
  await job.flush();
  assert.equal(prompts.length, 2, 'one retry later');
  assert.deepEqual(saved, [{ ...pinSummaryExtract(answer), source: 'extract', at: new Date(now).toISOString() }]);
  now += PIN_SUMMARY_RETRY_MS * 10;
  await job.flush();
  assert.equal(prompts.length, 2, 'never a third attempt');
  await job.stop();
});

function fixture() {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'pugport-pin-summary-')));
  const db = new DatabaseSync(join(directory, 'isolated.sqlite'));
  const store = new WorkspaceStore(db, { recoverInterrupted: false });
  const sent: Array<{ conversationId: string; input: MessageInput }> = [];
  const workspace = Object.create(Workspace.prototype) as Workspace;
  let helpers = 0;
  let reply = '{"title":"东京三日游","description":"每天的路线和交通"}';
  Object.assign(workspace, {
    store,
    clock: () => Date.parse(at) + 1000,
    tastes: { list: () => [] },
    folderAvailability: new Map(),
    controller: { broadcast: () => {}, settings: { locale: 'zh-CN' } },
    // Stand-ins for the real chat creation and task queue: the hidden helper path itself is exercised.
    createGeneralConversation: async (title: string, incognito: boolean) => {
      const helper = { id: `helper-${++helpers}`, projectId: 'chat', title, incognito, createdAt: at, updatedAt: at };
      store.save('conversation', helper.id, helper.projectId, helper);
      return helper;
    },
    send: async (conversationId: string, input: MessageInput) => {
      sent.push({ conversationId, input });
      const workflow = {
        id: `run-${sent.length}`,
        conversationId,
        projectId: 'chat',
        status: 'completed',
        finalMessageId: `answer-${sent.length}`,
      } as Workflow;
      store.save('workflow', workflow.id, conversationId, workflow);
      store.save('message', workflow.finalMessageId!, conversationId, {
        id: workflow.finalMessageId,
        conversationId,
        role: 'assistant',
        content: reply,
        createdAt: at,
      });
      return { workflow };
    },
    waitForWorkflow: async (id: string) => store.get<Workflow>('workflow', id),
    cancel: () => {},
  });
  store.save('project', 'p', 'p', { id: 'p', name: 'Synthetic', path: directory, createdAt: at, updatedAt: at });
  const save = (id: string, extra: Partial<Conversation> = {}) =>
    store.save('conversation', id, 'p', { id, projectId: 'p', title: id, createdAt: at, updatedAt: at, ...extra });
  const message = (id: string, conversationId: string, role: 'user' | 'assistant', content: string) =>
    store.save('message', id, conversationId, { id, conversationId, role, content, createdAt: at });
  return {
    workspace,
    store,
    sent,
    save,
    message,
    setReply: (value: string) => (reply = value),
    close() {
      db.close();
      assert.ok(directory.startsWith(realpathSync.native(tmpdir()) + sep));
      assert.ok(basename(directory).startsWith('pugport-pin-summary-'));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('pinning stores a model summary on the pin through the hidden helper, outside the chat, memory and routing training', async () => {
  const f = fixture();
  try {
    f.save('c');
    f.message('q', 'c', 'user', '帮我排东京行程');
    f.message('m', 'c', 'assistant', answer);
    f.workspace.startPinSummaries();
    const job = (f.workspace as unknown as { pinSummaryJob: PinSummaryJob }).pinSummaryJob;
    await job.flush();
    const pinned = f.workspace.pinMessage('c', 'm', { pinned: true });
    assert.equal(pinned.pinnedMessages![0]!.summary, undefined, 'the pin is saved at once; the card shows the extract');
    assert.equal(pinnedMessageCard(pinned.pinnedMessages![0]!, f.store.get('message', 'm')).pending, true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await job.flush();
    const saved = f.store.get<Conversation>('conversation', 'c')!;
    assert.deepEqual(
      { ...saved.pinnedMessages![0]!.summary, at: undefined },
      { title: '东京三日游', description: '每天的路线和交通', source: 'model', at: undefined },
    );
    assert.equal(saved.pinnedMessagesRevision, 2);
    assert.deepEqual(
      (filterSyncValue('conversation', saved as never) as Conversation).pinnedMessages![0]!.summary,
      saved.pinnedMessages![0]!.summary,
      'the summary travels with the pin in account sync',
    );

    assert.equal(f.sent.length, 1);
    const [{ conversationId, input }] = f.sent;
    assert.notEqual(conversationId, 'c');
    assert.deepEqual(f.store.conversationWorkflows('c'), [], 'no task in the pinned conversation');
    assert.match(input.content, /帮我排东京行程/);
    assert.equal(input.untrustedContent, true, 'tool-less');
    assert.equal(input.permissionMode, 'read-only');
    assert.equal(input.suggestedEffort, 'low');
    for (const key of ['runtimeId', 'provider', 'model', 'effort', 'automaticExecutors'])
      assert.equal(Object.hasOwn(input, key), false, `automatic routing: no ${key}`);
    const helper = f.store.get<Conversation>('conversation', conversationId)!;
    assert.equal(helper.memory, 'off', 'never enters memory, which also keeps it out of Laya training');
    assert.ok(helper.archivedAt, 'the helper chat is archived');
    assert.deepEqual(f.store.get('external-conversation', conversationId), {
      dispatched: true,
      caller: 'Pin summaries',
    });
    assert.equal(
      (f.workspace as unknown as { notRecorded(c: Conversation, p: unknown): boolean }).notRecorded(helper, undefined),
      true,
    );
    await job.stop();
  } finally {
    f.close();
  }
});

test('incognito pins keep the extract and never call a model, including old pins without a summary', async () => {
  const f = fixture();
  try {
    f.save('secret', { incognito: true, pinnedMessages: [{ messageId: 'old', pinnedAt: at }] });
    f.message('old', 'secret', 'assistant', '旧的隐身回答。');
    f.message('m', 'secret', 'assistant', answer);
    f.workspace.startPinSummaries();
    const job = (f.workspace as unknown as { pinSummaryJob: PinSummaryJob }).pinSummaryJob;
    const pinned = f.workspace.pinMessage('secret', 'm', { pinned: true });
    assert.deepEqual(
      { ...pinned.pinnedMessages![1]!.summary, at: undefined },
      { ...pinSummaryExtract(answer), source: 'extract', at: undefined },
    );
    assert.equal(pinnedMessageCard(pinned.pinnedMessages![0]!, f.store.get('message', 'old'), true).pending, false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await job.flush();
    assert.equal(f.sent.length, 0);
    assert.equal(f.store.get<Conversation>('conversation', 'secret')!.pinnedMessages![0]!.summary, undefined);
    await job.stop();
  } finally {
    f.close();
  }
});

test('a summary that lands after the pin was removed or re-pinned is dropped', async () => {
  const f = fixture();
  try {
    f.save('c');
    f.message('m', 'c', 'assistant', answer);
    f.setReply('not json');
    f.workspace.pinMessage('c', 'm', { pinned: true });
    f.workspace.startPinSummaries();
    const job = (f.workspace as unknown as { pinSummaryJob: PinSummaryJob }).pinSummaryJob;
    await job.flush();
    assert.equal(f.sent.length, 1);
    assert.equal(f.store.get<Conversation>('conversation', 'c')!.pinnedMessages![0]!.summary, undefined);
    f.workspace.pinMessage('c', 'm', { pinned: false });
    const save = (f.workspace as unknown as { savePinSummary: Workspace['startPinSummaries'] }).savePinSummary.bind(
      f.workspace,
    ) as unknown as (ref: unknown, summary: PinnedMessageSummary) => void;
    save({ conversationId: 'c', messageId: 'm', pinnedAt: at }, { title: 'x', description: '', source: 'model', at });
    assert.equal(f.store.get<Conversation>('conversation', 'c')!.pinnedMessages, undefined);
    await job.stop();
  } finally {
    f.close();
  }
});
