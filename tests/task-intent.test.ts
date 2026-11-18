import assert from 'node:assert/strict';
import { test } from 'node:test';
import { quotedContent } from '../src/shared/quotes.ts';
import type { ConversationMessage, RunRecord, Workflow } from '../src/shared/types.ts';
import { recoverLegacyQuoteIntent } from '../src/server/task-intent.ts';

function fixture() {
  const workflows = new Map<string, Workflow>();
  const runs = new Map<string, RunRecord>();
  const messages: ConversationMessage[] = [];
  let sequence = 0;
  const stamp = () => new Date(Date.UTC(2026, 9, 6, 0, 0, sequence++)).toISOString();
  function add(content: string, parent?: Workflow, quotes?: ConversationMessage['quotes']): Workflow {
    const id = `w-${workflows.size}`,
      at = stamp();
    const rendered = quotedContent(content, quotes ?? []);
    const workflow: Workflow = {
      id,
      conversationId: 'conversation',
      projectId: 'project',
      userMessageId: `m-${id}`,
      originalIntent: { mode: parent ? 'build' : 'auto', permissionMode: 'workspace-write' },
      input: {
        content: rendered,
        intentText: parent?.input.intentText ?? rendered,
        mode: 'build',
        permissionMode: 'read-only',
        executionPolicy: 'cli-only',
      },
      parentWorkflowId: parent?.id,
      status: 'failed',
      phase: 'execute',
      plan: [
        {
          id: 'step',
          title: '文件检查',
          instruction: '检查文件',
          kind: 'general',
          transport: 'cli',
          dependsOn: [],
          status: 'failed',
          runIds: [`r-${id}`],
        },
      ],
      runIds: [`r-${id}`],
      memoryRevision: 0,
      memoryExcerpt: '',
      createdAt: at,
      updatedAt: at,
    };
    const run: RunRecord = {
      id: `r-${id}`,
      workflowId: id,
      prompt: rendered,
      projectPath: '/synthetic',
      kind: 'general',
      status: 'failed',
      permissionMode: 'read-only',
      route: { runtimeId: 'fixture', model: 'fixture', kind: 'general', reasons: [], warnings: [] },
      startedAt: at,
      endedAt: stamp(),
      output: 'synthetic',
      events: [],
    };
    workflows.set(id, workflow);
    runs.set(run.id, run);
    messages.push({
      id: workflow.userMessageId,
      conversationId: workflow.conversationId,
      workflowId: id,
      role: 'user',
      content,
      quotes,
      createdAt: at,
    });
    return workflow;
  }
  const wrapper = (parent: Workflow) =>
    `继续原任务：${parent.input.content}\n已有步骤状态：\n${parent.plan.map((step) => `${step.title}: ${step.status}`).join('\n')}\n先检查已有产物，接着完成未完成的工作，避免重复外部操作。`;
  const root = add('把重复文件放入回收站。', undefined, [
    { text: '不要删除，先只读检查。', note: '已确认重复的按要求回收。' },
  ]);
  const middle = add(wrapper(root), root);
  const old = add(wrapper(middle), middle);
  // The reported legacy task made three read-only attempts under the same workflow.
  for (let index = 1; index < 3; index++) {
    const id = `${old.runIds[0]}-${index}`;
    runs.set(id, { ...runs.get(old.runIds[0]!)!, id, endedAt: stamp() });
    old.runIds.push(id);
  }
  const sources = { workflow: (id: string) => workflows.get(id), run: (id: string) => runs.get(id), messages };
  const recover = () => recoverLegacyQuoteIntent(old, sources);
  function steer(target: Workflow, content: string, queued = false, quotes?: ConversationMessage['quotes']) {
    const queue = queued ? add(content, undefined, quotes) : undefined;
    const message: ConversationMessage = queue
      ? messages.find((item) => item.id === queue.userMessageId)!
      : {
          id: `steer-${messages.length}`,
          conversationId: target.conversationId,
          workflowId: target.id,
          role: 'user',
          content,
          quotes,
          createdAt: stamp(),
        };
    message.steering = { runId: target.runIds[0]!, status: 'accepted' };
    if (queue) {
      queue.status = 'cancelled';
      queue.followUp = { workflowId: target.id, kind: 'message', at: stamp() };
    } else messages.push(message);
    target.input.content += `\n\n用户中途补充：\n${quotedContent(content, quotes ?? [])}`;
    return { message, queue };
  }
  function rewrap() {
    for (const item of [middle, old]) {
      const content = wrapper(workflows.get(item.parentWorkflowId!)!);
      messages.find((message) => message.id === item.userMessageId)!.content = content;
      item.input.content = content;
    }
  }
  return { workflows, runs, messages, root, middle, old, sources, recover, steer, rewrap, add, wrapper };
}

test('proven three-generation quote downgrade recovers only human text and leaves every audit record unchanged', () => {
  const f = fixture();
  const before = structuredClone([f.old, [...f.workflows], [...f.runs], f.messages]);
  assert.equal(f.recover(), '已确认重复的按要求回收。\n把重复文件放入回收站。');
  assert.deepEqual([f.old, [...f.workflows], [...f.runs], f.messages], before);
});

test('accepted direct and queued interjections are verified by their target run and consumed in delivery order', () => {
  const f = fixture();
  const first = f.steer(f.root, '只处理选定文件夹。');
  const second = f.steer(f.root, '核对后继续。', true, [{ text: '只读，别移动文件。', note: '改为移动到归档目录。' }]);
  assert.equal(second.queue?.status, 'cancelled');
  assert.notEqual(second.message.workflowId, f.root.id);
  second.message.createdAt = new Date(Date.parse(f.root.createdAt) - 1000).toISOString();
  f.rewrap();
  f.messages.reverse(); // Database retrieval and queue creation order do not decide delivery order.
  assert.equal(
    f.recover(),
    '已确认重复的按要求回收。\n把重复文件放入回收站。\n\n只处理选定文件夹。\n\n改为移动到归档目录。\n核对后继续。',
  );
  first.message.steering!.status = 'pending';
  assert.equal(f.recover(), undefined);
});

test('accepted corrections on a continuation are included exactly once', () => {
  const f = fixture();
  f.steer(f.old, '保留文件名，移动到归档目录。');
  assert.equal(f.recover(), '已确认重复的按要求回收。\n把重复文件放入回收站。\n\n保留文件名，移动到归档目录。');
});

test('entry selection, prior readonly choices, stopped tasks and cross-context or cyclic ancestry fail closed', () => {
  const changes: Array<(f: ReturnType<typeof fixture>) => void> = [
    (f) => {
      f.old.originalIntent!.mode = 'auto';
    },
    (f) => {
      f.old.originalIntent!.permissionMode = 'read-only';
    },
    (f) => {
      f.old.input.permissionMode = 'workspace-write';
    },
    (f) => {
      f.old.input.intentText = '普通用户要求';
    },
    (f) => {
      f.root.originalIntent!.mode = 'chat';
    },
    (f) => {
      f.middle.originalIntent!.permissionMode = 'read-only';
    },
    (f) => {
      delete f.root.originalIntent;
    },
    (f) => {
      f.root.stopped = true;
    },
    (f) => {
      f.old.deletedAt = f.old.createdAt;
    },
    (f) => {
      f.middle.delegation = { parentId: 'elsewhere', role: 'worker', requestId: 'request' };
    },
    (f) => {
      f.root.projectId = 'other-project';
    },
    (f) => {
      f.middle.conversationId = 'other-chat';
    },
    (f) => {
      f.workflows.delete(f.middle.id);
    },
    (f) => {
      f.root.parentWorkflowId = f.old.id;
    },
    (f) => {
      f.old.pendingSteer = { workflowId: f.middle.id, runId: f.old.runIds[0]! };
    },
  ];
  for (const change of changes) {
    const f = fixture();
    change(f);
    assert.equal(f.recover(), undefined, change.toString());
  }
});

test('unproven generated wrappers and missing, stale or non-user origins cannot restore writes', () => {
  const changes: Array<(f: ReturnType<typeof fixture>) => void> = [
    (f) => {
      f.middle.input.content += '\n未知补充';
    },
    (f) => {
      f.messages.find((m) => m.id === f.middle.userMessageId)!.content += '\n用户另加了请求';
    },
    (f) => {
      f.root.plan[0]!.status = 'completed';
    },
    (f) => {
      f.messages.splice(
        f.messages.findIndex((m) => m.id === f.root.userMessageId),
        1,
      );
    },
    (f) => {
      f.messages.find((m) => m.id === f.root.userMessageId)!.role = 'assistant';
    },
    (f) => {
      f.messages.find((m) => m.id === f.root.userMessageId)!.workflowId = f.middle.id;
    },
    (f) => {
      f.messages.find((m) => m.id === f.root.userMessageId)!.content = '不是原始用户要求';
    },
    (f) => {
      f.runs.delete(f.old.runIds.at(-1)!);
    },
    (f) => {
      f.runs.get(f.old.runIds.at(-1)!)!.permissionMode = 'workspace-write';
    },
    (f) => {
      delete f.runs.get(f.old.runIds.at(-1)!)!.endedAt;
    },
    (f) => {
      f.runs.get(f.old.runIds.at(-1)!)!.workflowId = f.middle.id;
    },
    (f) => {
      f.runs.get(f.old.runIds.at(-1)!)!.status = 'running';
    },
  ];
  for (const change of changes) {
    const f = fixture();
    change(f);
    assert.equal(f.recover(), undefined, change.toString());
  }
});

test('unconfirmed, omitted, forged or differently authorized steering never restores writes', () => {
  const changes: Array<
    (f: ReturnType<typeof fixture>, value: ReturnType<ReturnType<typeof fixture>['steer']>) => void
  > = [
    (_f, { message }) => {
      message.steering!.status = 'failed';
    },
    (_f, { message }) => {
      message.steering!.status = 'pending';
    },
    (f, { message }) => {
      f.runs.delete(message.steering!.runId);
    },
    (_f, { message }) => {
      message.content = '未送达的替换';
    },
    (_f, { queue }) => {
      delete queue!.followUp;
    },
    (_f, { queue }) => {
      queue!.originalIntent!.permissionMode = 'read-only';
    },
    (_f, { queue }) => {
      queue!.stopped = true;
    },
    (f, { queue }) => {
      f.workflows.delete(queue!.id);
    },
    (f, { message }) => {
      f.messages.splice(f.messages.indexOf(message), 1);
    },
  ];
  for (const change of changes) {
    const f = fixture(),
      value = f.steer(f.old, '先整理第一批。', true);
    change(f, value);
    assert.equal(f.recover(), undefined, change.toString());
  }
  const f = fixture();
  f.steer(f.old, '先整理第一批。');
  f.old.input.content = f.wrapper(f.middle); // Delivery receipt without the appended input is incomplete.
  assert.equal(f.recover(), undefined);
});

test('real user prohibitions in root notes, interjections or later conversation messages remain authoritative', () => {
  for (const content of ['不要改动文件。', '先只读检查。', '停止', 'Stop']) {
    const f = fixture();
    f.add(content);
    assert.equal(f.recover(), undefined, content);
  }
  const rootNote = fixture();
  rootNote.messages.find((m) => m.id === rootNote.root.userMessageId)!.quotes![0]!.note = '不要改动文件。';
  assert.equal(rootNote.recover(), undefined);
  const interjection = fixture();
  interjection.steer(interjection.old, '不要改动文件。');
  assert.equal(interjection.recover(), undefined);
  const composer = fixture();
  composer.add('继续看下一批。').originalIntent!.permissionMode = 'read-only';
  assert.equal(composer.recover(), undefined);
});

test('more than thirty-two ancestors and quote-like plain text without real quote records fail closed', () => {
  const f = fixture();
  let last = f.old;
  for (let index = 0; index < 30; index++) last = f.add(f.wrapper(last), last);
  assert.equal(recoverLegacyQuoteIntent(last, f.sources), undefined);
  const plain = fixture();
  const message = plain.messages.find((m) => m.id === plain.root.userMessageId)!;
  message.content = plain.root.input.content;
  delete message.quotes;
  assert.equal(plain.recover(), undefined);
});
