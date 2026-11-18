import assert from 'node:assert/strict';
import test from 'node:test';
import english from '../src/shared/i18n/en.json' with { type: 'json' };
import { createTranslator } from '../src/shared/i18n/index.ts';
import type { RuntimeTarget } from '../src/shared/types.ts';
import { ComposerSession, emptyDraft, pickDraftMention } from '../src/ui/composer-session.ts';
import { freeChainMentionId } from '../src/shared/participants.ts';
import { mentionItems } from '../src/ui/Mentions.tsx';
import { findNode, nextTurn, text, uiBundle, uiHarness } from './helpers/ui-harness.ts';

const stamp = '2026-10-27T12:00:00Z';
const conversation = { id: 'fixture', projectId: 'project', title: 'Fixture', createdAt: stamp, updatedAt: stamp };
const state = {
  app: { name: 'Fixture', version: 'test', platform: 'win32', dataDir: 'fixture' },
  projects: [],
  conversations: [conversation],
  runs: [],
  workflows: [],
  conversationMessages: [],
  targets: [],
  runtimes: [],
  approvals: [],
  plugins: [],
  settings: { toolApprovalMode: 'auto', executionPolicy: 'cli-first', routeGoal: 'balanced', saveMoney: true },
};

test('routing settings retain three working goals and drop the old saving switch', async () => {
  const calls: unknown[] = [];
  const h = uiHarness(await uiBundle('src/ui/App.tsx'));
  const props = {
    state,
    category: 'routing',
    api: async (path: string, body: unknown, method: string) => {
      calls.push(JSON.parse(JSON.stringify({ path, body, method })));
    },
    reload: async () => {},
    notify() {},
  };
  const render = () => h.render('SettingsPage', props);
  assert.doesNotMatch(text(render()), /省钱/);
  const light = findNode(render(), (node) => node.props.role === 'radio' && text(node).startsWith('轻量'))!;
  assert.equal(
    createTranslator(english)(text(findNode(light, (node) => node.type === 'small'))),
    'Prefer light or free models for simple tasks.',
  );
  for (const [goal, label] of [
    ['save', '轻量'],
    ['balanced', '均衡'],
    ['quality', '质量'],
  ]) {
    const button = () => findNode(render(), (node) => node.props.role === 'radio' && text(node).startsWith(label!))!;
    assert.ok(button());
    button().props.onClick();
    await nextTurn();
    assert.equal(button().props['aria-checked'], true);
    assert.deepEqual(calls.at(-1), { path: '/api/settings', body: { routeGoal: goal }, method: 'PATCH' });
  }
  h.unmount();
});

test('composer ignores legacy saving values while explicit free relay remains independently reachable', async () => {
  const code = await uiBundle('src/ui/Workspace.tsx');
  const free = {
    id: 'synthetic-free',
    provider: 'pi',
    label: 'Synthetic free source',
    command: 'unused',
    environment: 'native',
    enabled: true,
    apiProvider: 'ollama',
  } as RuntimeTarget;
  const mention = mentionItems([], [], [], [], [free]).find((item) => item.id === freeChainMentionId);
  assert.ok(mention);
  for (const freeChain of [false, true]) {
    const session = new ComposerSession();
    const bodies: Record<string, unknown>[] = [];
    const h = uiHarness(code, {
      localStorage: {
        getItem: (key: string) =>
          key === 'comborunner.composer-selection.v2:fixture' ? JSON.stringify({ saveMoney: true }) : null,
        setItem() {},
      },
    });
    const props = {
      state,
      conversation,
      composerSession: session,
      api: async (path: string, body?: Record<string, unknown>) => {
        if (path.endsWith('/messages') && body) {
          bodies.push(body);
          return { message: { id: 'sent', conversationId: 'fixture', role: 'user', content: body.content } };
        }
        return { messages: [] };
      },
      notify() {},
      onConversation() {},
      onAddProject() {},
      onMemory() {},
      onInspect() {},
    };
    const render = () => h.render('ConversationWorkspace', props);
    findNode(render(), (node) => node.props['aria-label'] === '调度选项')!.props.onClick();
    assert.doesNotMatch(text(render()), /省钱/);
    session.changeDraft('conversation:fixture', () =>
      freeChain
        ? pickDraftMention(emptyDraft(), mention, '@免费 Say hello')
        : { ...emptyDraft(), content: 'Say hello' },
    );
    findNode(
      render(),
      (node) => node.type === 'form' && node.props.className.includes('conversation-composer'),
    )!.props.onSubmit({ preventDefault() {} });
    await nextTurn();
    assert.equal(bodies.length, 1);
    assert.equal('saveMoney' in bodies[0]!, false);
    assert.equal(bodies[0]!.freeChain === true, freeChain);
    h.unmount();
    session.dispose();
  }
});
