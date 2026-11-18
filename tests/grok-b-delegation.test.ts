import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Workspace } from '../src/server/workspace.ts';
import { resolveAgent } from '../src/server/agent-names.ts';
import type {
  LegacyConversationRouting as ConversationRouting,
  Delegation,
  MessageInput,
  RuntimeSnapshot,
  RuntimeTarget,
  Workflow,
} from '../src/shared/types.ts';

const targets: RuntimeTarget[] = [
  {
    id: 'grok-native',
    label: 'Grok · 本机',
    provider: 'grok',
    command: 'unused',
    environment: 'native',
    enabled: true,
  },
  { id: 'grok-b', label: 'Grok B', provider: 'grok', command: 'unused', environment: 'native', enabled: true },
];
function fixture(routing?: ConversationRouting) {
  const input: MessageInput = {
    content: 'Strong parent architecture task',
    runtimeId: 'grok-native',
    provider: 'grok',
    model: 'grok-4.7',
    effort: 'xhigh',
    mode: 'build',
    permissionMode: 'workspace-write',
    executionPolicy: 'cli-first',
  };
  const parent = {
    id: 'parent',
    conversationId: 'conversation',
    projectId: 'project',
    status: 'running',
    createdAt: new Date().toISOString(),
    input,
  } as Workflow;
  const captured: MessageInput[] = [];
  const delegations: Delegation[] = [];
  const records = new Map<string, unknown>();
  const snapshots: RuntimeSnapshot[] = targets.map((target) => ({
    ...target,
    installed: true,
    status: 'ready',
    quota: { status: 'unknown', source: 'fixture', observedAt: new Date().toISOString(), windows: [] },
    capabilities: { execute: true, resume: true, cancel: true, approvals: true },
    refreshedAt: new Date().toISOString(),
    models: [{ id: 'grok-4.7-build-fast', label: 'grok-4.7-build-fast', efforts: ['low', 'medium', 'high'] }],
  }));
  const workspace = Object.create(Workspace.prototype) as Workspace;
  Object.assign(workspace, {
    active: new Map([['parent', { abort: new AbortController() }]]),
    controller: { targets, snapshots, settings: {} },
    store: {
      get: (kind: string, id: string) =>
        records.get(`${kind}:${id}`) ??
        (kind === 'workflow'
          ? parent
          : kind === 'conversation'
            ? { id: 'conversation', projectId: 'project', routing }
            : kind === 'project'
              ? { id: 'project', path: 'synthetic', scope: 'project' }
              : undefined),
      conversationWorkflows: () => [parent],
      list: () => [],
      save: (kind: string, id: string, _owner: string, value: unknown) => records.set(`${kind}:${id}`, value),
    },
    requireConversation: () => ({ id: 'conversation', projectId: 'project', routing }),
    send: async (_conversationId: string, childInput: MessageInput, _parent?: string, delegation?: Delegation) => {
      captured.push(childInput);
      if (delegation) delegations.push(delegation);
      return { workflow: { id: 'child', input: childInput } };
    },
  });
  return { workspace, captured, delegations, parent };
}

test('explicit Grok B and its runtime id resolve to one card; a generic Grok chooses its account automatically', () => {
  for (const requestedLabel of ['Grok B', 'GROK-B', 'grok-b'])
    assert.equal(resolveAgent(requestedLabel, targets).runtimeId, 'grok-b');
  assert.equal(resolveAgent('Grok', targets).runtimeId, undefined);
  assert.equal(resolveAgent('Grok · 自动选择账号', targets).runtimeId, undefined);
});

test('a delegated Grok B keeps the requested account without inheriting the parent model or effort', async () => {
  const f = fixture();
  const originalInput = structuredClone(f.parent.input);
  await f.workspace.delegateToAgent('parent', resolveAgent('Grok B', targets), 'Read the source and report defects');
  const child = f.captured[0]!;
  assert.equal(child.runtimeId, 'grok-b');
  assert.equal(child.provider, undefined);
  assert.equal(child.model, undefined);
  assert.equal(child.effort, undefined);
  assert.equal(f.delegations[0]!.suggestedEffort, undefined, 'the parent effort is not passed on as a suggestion');
  assert.equal(child.permissionMode, 'read-only');
  assert.deepEqual(f.parent.input, originalInput);
});

test('a generic Grok delegated task retains provider routing for automatic account balancing', async () => {
  const f = fixture();
  await f.workspace.delegateToAgent('parent', resolveAgent('Grok', targets), 'Summarize measured performance');
  assert.equal(f.captured[0]!.runtimeId, undefined);
  assert.equal(f.captured[0]!.provider, 'grok');
  assert.equal(f.captured[0]!.model, undefined);
  assert.equal(f.captured[0]!.effort, undefined);
});

test('a child account uses its own supported conversation model and effort rule', async () => {
  const f = fixture({
    text: '',
    rules: [
      { topic: 'other', target: { runtimeId: 'grok-b' }, strict: false, model: 'grok-4.7-build-fast', effort: 'low' },
    ],
    chapterAgents: false,
    mask: false,
    updatedAt: '',
  });
  await f.workspace.delegateToAgent('parent', resolveAgent('Grok B', targets), 'Read the source and summarize');
  assert.equal(f.captured[0]!.runtimeId, 'grok-b');
  assert.equal(f.captured[0]!.model, 'grok-4.7-build-fast');
  assert.equal(f.captured[0]!.effort, 'low');
});

test("the caller's child effort replaces its account rule as a target for automatic selection, not a pin", async () => {
  const f = fixture({
    text: '',
    rules: [
      { topic: 'other', target: { runtimeId: 'grok-b' }, strict: false, model: 'grok-4.7-build-fast', effort: 'low' },
    ],
    chapterAgents: false,
    mask: false,
    updatedAt: '',
  });
  const originalInput = structuredClone(f.parent.input);
  await f.workspace.delegateToAgent('parent', resolveAgent('Grok B', targets), 'Read the source and report defects', {
    effort: 'high',
  });
  assert.equal(f.captured[0]!.model, 'grok-4.7-build-fast');
  assert.equal(f.captured[0]!.effort, undefined, 'a calling executor never pins effort like the user does');
  assert.equal(f.delegations[0]!.suggestedEffort, 'high');
  assert.deepEqual(f.parent.input, originalInput);
});

test('strict child redirection uses the target effort rather than the original executor pin', async () => {
  const f = fixture({
    text: '',
    rules: [
      { topic: 'adult', target: { runtimeId: 'grok-b' }, strict: true, model: 'grok-4.7-build-fast', effort: 'low' },
    ],
    chapterAgents: false,
    mask: false,
    updatedAt: '',
  });
  const delegated = await f.workspace.delegateToAgent(
    'parent',
    resolveAgent('Grok · 本机', targets),
    '分类成人内容的文件路径',
    { effort: 'ultra' },
  );
  assert.equal(delegated.redirectedTo, 'Grok B');
  assert.equal(f.captured[0]!.runtimeId, 'grok-b');
  assert.equal(f.captured[0]!.model, 'grok-4.7-build-fast');
  assert.equal(f.captured[0]!.effort, 'low');
  assert.equal(f.delegations[0]!.suggestedEffort, undefined);
});

test('invalid child effort values fail before a child is enqueued', async () => {
  const f = fixture();
  for (const effort of ['', ' ', 'x'.repeat(31), 3, null]) {
    await assert.rejects(
      f.workspace.delegateToAgent('parent', resolveAgent('Grok B', targets), 'Read the synthetic document', {
        effort: effort as string,
      }),
      /推理强度无效/,
    );
  }
  assert.equal(f.captured.length, 0);
});
