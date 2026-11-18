import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import type { AppState, ConversationMessage, RunRecord, Workflow } from '../src/shared/types.ts';
import { findNode, uiBundle, uiHarness, type UiNode } from './helpers/ui-harness.ts';

const stamp = '2026-10-29T00:00:00.000Z';
const workflow = (id: string, patch: Partial<Workflow> = {}): Workflow => ({
  id,
  conversationId: 'chat',
  projectId: 'project',
  userMessageId: 'user',
  input: { content: 'Synthetic request', mode: 'chat', permissionMode: 'read-only', executionPolicy: 'cli-first' },
  status: 'completed',
  phase: 'summarize',
  plan: [],
  runIds: [],
  memoryRevision: 0,
  memoryExcerpt: '',
  createdAt: stamp,
  updatedAt: stamp,
  ...patch,
});
const message = (id: string, workflowId: string, role: 'user' | 'assistant' = 'assistant'): ConversationMessage => ({
  id,
  conversationId: 'chat',
  workflowId,
  role,
  content: `Synthetic ${id}`,
  createdAt: stamp,
});
let code: string;
before(async () => {
  code = await uiBundle('src/ui/Workspace.tsx');
});

for (const updatesWhileHidden of [false, true]) {
  test(`reply version switch retains ${updatesWhileHidden ? 'stream updates received while hidden' : 'the visible stream'} after completion before the saved reply arrives`, () => {
    const older = workflow('older', { finalMessageId: 'older-reply', supersededBy: 'latest' });
    const latest = workflow('latest', {
      attempt: 2,
      status: 'running',
      phase: 'execute',
      activeStepId: 'reply',
      runIds: ['latest-run'],
      plan: [
        {
          id: 'reply',
          title: 'Synthetic reply',
          instruction: '',
          kind: 'routine',
          transport: 'auto',
          dependsOn: [],
          status: 'running',
          runIds: ['latest-run'],
        },
      ],
    });
    const firstText = 'Synthetic latest reply starts here.';
    const fullText = updatesWhileHidden ? `${firstText} It continues while viewing the older reply.` : firstText;
    const liveRun: RunRecord = {
      id: 'latest-run',
      workflowId: latest.id,
      stepId: 'reply',
      prompt: 'Synthetic request',
      projectPath: 'C:/Synthetic',
      kind: 'routine',
      status: 'running',
      route: { runtimeId: 'synthetic', model: 'synthetic', kind: 'routine', reasons: [], warnings: [] },
      startedAt: stamp,
      output: firstText,
      events: [],
    };
    const props = {
      workflows: [older, latest],
      messages: [message('user', latest.id, 'user'), message('older-reply', older.id)],
      state: {
        workflows: [older, latest],
        targets: [],
        runtimes: [],
        runs: [liveRun],
        settings: {},
      } as unknown as AppState,
      api: async <T>() => ({}) as T,
      notify() {},
      onInspect() {},
    };
    const history = uiHarness(code);
    const mounted = new Map<string, ReturnType<typeof uiHarness>>();
    const mountCounts = new Map<string, number>();
    const render = () => {
      const tree = history.render('ConversationHistory', props);
      const rows = new Map<string, UiNode>();
      findNode(tree, (node) => {
        if (node.type?.name === 'WorkflowTrace') rows.set(node.key!, node);
        return false;
      });
      // Reconcile actual WorkflowTrace hook instances: a removed row loses all its local hooks.
      for (const [key, card] of mounted)
        if (!rows.has(key)) {
          card.unmount();
          mounted.delete(key);
        }
      const replies = new Map<string, string | undefined>();
      for (const [key, node] of rows) {
        let card = mounted.get(key);
        if (!card) {
          card = uiHarness(code);
          mounted.set(key, card);
          mountCounts.set(key, (mountCounts.get(key) ?? 0) + 1);
        }
        const rendered = card.render('WorkflowTrace', node.props);
        const reply = findNode(rendered, (item) => item.props.className?.includes('live-main-reply'));
        replies.set(node.props.workflow.id, findNode(reply, (item) => typeof item.props.text === 'string')?.props.text);
      }
      return { tree, replies };
    };
    try {
      let view = render();
      assert.equal(view.replies.get(latest.id), firstText);
      const previous = findNode(view.tree, (node) => node.type === 'button' && node.props.title === '上一个版本');
      assert.ok(previous);
      previous.props.onClick();
      view = render();
      assert.ok(findNode(view.tree, (node) => node.props.message?.id === 'older-reply'));
      assert.equal(view.replies.has(latest.id), false, 'only the selected version is visible');
      if (updatesWhileHidden) {
        props.state = { ...props.state, runs: [{ ...liveRun, output: fullText }] };
        render();
      }
      props.workflows = [older, { ...latest, status: 'completed', phase: 'summarize', finalMessageId: 'latest-reply' }];
      props.state = {
        ...props.state,
        workflows: props.workflows,
        runs: [{ ...liveRun, status: 'completed', summary: true, output: 'TRIMMED_TAIL', events: [] }],
      };
      view = render();
      const next = findNode(view.tree, (node) => node.type === 'button' && node.props.title === '下一个版本');
      assert.ok(next);
      next.props.onClick();
      view = render();
      assert.equal(mountCounts.get('workflow:latest'), 2, 'the latest row really remounted after version selection');
      assert.equal(
        view.replies.get(latest.id),
        fullText,
        'the untrimmed reply survives the missing saved-message window',
      );
      props.messages = [
        ...props.messages,
        { ...message('latest-reply', latest.id), content: fullText, createdAt: '2026-10-29T00:00:01.000Z' },
      ];
      view = render();
      assert.equal(view.replies.has(latest.id), true, 'the saved reply retains its execution record');
      assert.equal(view.replies.get(latest.id), undefined, 'the execution record no longer renders a live reply');
      assert.equal(
        findNode(view.tree, (node) => node.props.message?.id === 'latest-reply')?.props.message.content,
        fullText,
      );
    } finally {
      for (const card of mounted.values()) card.unmount();
      history.unmount();
    }
  });
}
