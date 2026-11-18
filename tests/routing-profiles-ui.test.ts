import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { ComposerSession } from '../src/ui/composer-session.ts';
import { parseRoutingRules } from '../src/shared/routing-parser.ts';
import { routingRuleSetSchema } from '../src/shared/routing-schema.ts';
import { findNode, nextTurn, text, uiBundle, uiHarness } from './helpers/ui-harness.ts';

const profileId = 'a287c93b-32ec-4d1e-b905-7ab19777cf02';
const stamp = '2026-10-25T12:00:00Z';
const rules = { version: 2, text: '', rules: [], unparsed: [], updatedAt: stamp };
const profile = { id: profileId, name: '代码审查', rules };
let workspaceCode: string, settingsCode: string;
before(async () => {
  [workspaceCode, settingsCode] = await Promise.all([
    uiBundle('src/ui/Workspace.tsx'),
    uiBundle('tests/helpers/routing-profiles-fixture.ts'),
  ]);
});
const later = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};
function workspace(api: any, profileId?: string | null, saved = true, projectProfileId?: string) {
  const conversation: any = {
    id: 'chat',
    projectId: 'project',
    title: 'Fixture',
    createdAt: stamp,
    updatedAt: stamp,
    ...(profileId !== undefined ? { routingProfileId: profileId } : {}),
  };
  const session = new ComposerSession();
  const store = new Map<string, string>();
  store.set(
    'comborunner.composer-selection.v2:chat',
    JSON.stringify({ runtimeId: 'claude', model: 'sonnet', effort: 'high' }),
  );
  const h = uiHarness(workspaceCode, {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
    },
  });
  const props: any = {
    api,
    composerSession: session,
    conversation: saved ? conversation : undefined,
    project: {
      id: 'project',
      name: 'Synthetic',
      path: 'C:/Synthetic',
      createdAt: stamp,
      updatedAt: stamp,
      ...(projectProfileId ? { routingProfileId: projectProfileId } : {}),
    },
    state: {
      app: { version: 'fixture' },
      projects: [],
      conversations: saved ? [conversation] : [],
      conversationMessages: [],
      workflows: [],
      runs: [],
      targets: [
        { id: 'claude', provider: 'claude', label: 'Claude', enabled: true, environment: 'native', command: 'fixture' },
      ],
      runtimes: [
        {
          id: 'claude',
          provider: 'claude',
          label: 'Claude',
          installed: true,
          status: 'ready',
          models: [{ id: 'sonnet', label: 'Sonnet', efforts: ['high'] }],
        },
      ],
      approvals: [],
      plugins: [],
      settings: { routingProfiles: [profile] },
    },
    notify() {},
    onConversation() {},
    onAddProject() {},
    onMemory() {},
    onInspect() {},
  };
  const render = () => h.render('ConversationWorkspace', props);
  findNode(render(), (node) => node.props['aria-label'] === '调度选项')!.props.onClick();
  const fields = () => findNode(render(), (node) => node.type?.name === 'WorkspaceExecutionFields')!;
  const input = () => findNode(render(), (node) => node.props.id === 'conversation-input')!;
  const submit = () =>
    findNode(
      render(),
      (node) => node.type === 'form' && node.props.className?.includes('conversation-composer'),
    )!.props.onSubmit({ preventDefault() {} });
  const close = () => {
    h.unmount();
    session.dispose();
  };
  return { h, session, props, conversation, render, fields, input, submit, close };
}

test('composer offers named profiles while preserving direct account selection', () => {
  const h = uiHarness(workspaceCode);
  const tree = h.render('WorkspaceExecutionFields', {
    state: { targets: [], runtimes: [] },
    policy: 'cli-first',
    selection: '',
    model: '',
    routingProfiles: [profile],
    routingProfileId: profile.id,
    onSelection() {},
    onModel() {},
  });
  const picker = findNode(tree, (node) => node.type?.name === 'ChipSelect')!;
  assert.equal(picker.props.value, `routing-profile:${profile.id}`);
  assert.match(JSON.stringify(tree), /代码审查/);
  assert.match(JSON.stringify(tree), /自动/);
  assert.equal(
    findNode(tree, (node) => node.props['ariaLabel'] === '任务模型'),
    undefined,
  );
  h.unmount();
});

test('profile selection waits for persistence, preserves draft and removes executor pins from future sends', async () => {
  const pending = later<any>(),
    calls: any[] = [];
  const view = workspace(async (path: string, body: any, method: string) => {
    calls.push({ path, body, method });
    if (path.endsWith('/routing-profile')) return pending.promise;
    if (path.endsWith('/messages'))
      return { message: { id: 'm', conversationId: 'chat', role: 'user', content: body.content, createdAt: stamp } };
    return { messages: [], workflows: [] };
  });
  view.input().props.onChange({ target: { value: 'Keep this question' } });
  view.fields().props.onSelection(`routing-profile:${profile.id}`);
  await nextTurn();
  assert.equal(view.fields().props.disabled, true);
  view.submit();
  assert.equal(
    calls.some((call) => call.path.endsWith('/messages')),
    false,
  );
  pending.resolve({ ...view.conversation, routingProfileId: profile.id });
  await nextTurn();
  assert.equal(view.fields().props.routingProfileId, profile.id);
  assert.equal(view.fields().props.selection, '');
  assert.equal(view.input().props.value, 'Keep this question');
  assert.match(text(findNode(view.render(), (node) => node.props['aria-label'] === '调度选项')), /代码审查/);
  view.submit();
  await nextTurn();
  const sent = calls.find((call) => call.path.endsWith('/messages'))!;
  assert.equal(sent.body.runtimeId, undefined);
  assert.equal(sent.body.model, undefined);
  assert.equal(sent.body.content, 'Keep this question');
  assert.deepEqual(JSON.parse(JSON.stringify(calls.find((call) => call.path.endsWith('/routing-profile')))), {
    path: '/api/conversations/chat/routing-profile',
    body: { profileId },
    method: 'PATCH',
  });
  view.close();
});

test('switching to automatic or a CLI clears only this conversation profile and failures preserve the old selection', async () => {
  const calls: any[] = [];
  let fail = true;
  const view = workspace(async (path: string, body: any, method: string) => {
    calls.push({ path, body, method });
    if (path.endsWith('/routing-profile')) {
      if (fail) throw Error('Synthetic save rejected');
      return { ...view.conversation, routingProfileId: undefined };
    }
    return { messages: [], workflows: [] };
  }, profile.id);
  assert.equal(view.fields().props.selection, '', 'saved CLI pin cannot override the selected profile');
  view.fields().props.onSelection('claude');
  await nextTurn();
  assert.equal(view.fields().props.routingProfileId, profile.id);
  fail = false;
  view.fields().props.onSelection('claude');
  await nextTurn();
  assert.equal(calls.filter((call) => call.path.endsWith('/routing-profile')).length, 2, JSON.stringify(calls));
  assert.equal(view.fields().props.routingProfileId, undefined);
  assert.equal(view.fields().props.selection, 'claude');
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), {
    path: '/api/conversations/chat/routing-profile',
    body: { profileId: null },
    method: 'PATCH',
  });
  view.props.conversation = { ...view.conversation, id: 'other', routingProfileId: undefined };
  assert.equal(view.fields().props.routingProfileId, undefined);
  view.close();
});

test('a new chat persists the selected profile in the one saved draft conversation', async () => {
  const calls: any[] = [];
  const view = workspace(
    async (path: string, body: any, method: string) => {
      calls.push({ path, body, method });
      if (path === '/api/conversations') return view.conversation;
      if (path.endsWith('/routing-profile')) return { ...view.conversation, routingProfileId: body.profileId };
      return { messages: [], workflows: [] };
    },
    undefined,
    false,
  );
  view.input().props.onChange({ target: { value: 'Unsent draft' } });
  view.fields().props.onSelection(`routing-profile:${profile.id}`);
  await nextTurn();
  assert.equal(calls.filter((call) => call.path === '/api/conversations').length, 1);
  assert.equal(view.fields().props.routingProfileId, profile.id);
  assert.equal(view.input().props.value, 'Unsent draft');
  assert.equal(view.session.getSnapshot().drafts['new:project']?.createdConversation?.routingProfileId, profile.id);
  view.close();
});

test('unavailable profiles fail closed instead of silently sending with automatic rules', async () => {
  const calls: string[] = [];
  const view = workspace(async (path: string) => {
    calls.push(path);
    return { messages: [], workflows: [] };
  }, 'missing-profile');
  view.input().props.onChange({ target: { value: 'Keep this question' } });
  view.submit();
  await nextTurn();
  assert.equal(
    calls.some((path) => path.endsWith('/messages')),
    false,
  );
  assert.equal(view.input().props.value, 'Keep this question');
  assert.match(text(findNode(view.render(), (node) => node.props.role === 'alert')), /方案不可用/);
  view.close();
});

test('composer distinguishes project inheritance, explicit automatic and explicit profile without changing saved settings on read', async () => {
  const calls: any[] = [];
  const view = workspace(
    async (path: string, body: any, method: string) => {
      calls.push({ path, body, method });
      if (path.endsWith('/routing-profile')) {
        const saved = { ...view.conversation };
        if (body.inheritProject) delete saved.routingProfileId;
        else saved.routingProfileId = body.profileId;
        return saved;
      }
      return { messages: [], workflows: [] };
    },
    undefined,
    true,
    profile.id,
  );
  view.input().props.onChange({ target: { value: 'Preserved project draft' } });
  assert.equal(view.fields().props.routingProfileId, profile.id);
  assert.equal(view.fields().props.inheritProjectRouting, true);
  assert.equal(view.fields().props.selection, '');
  assert.match(text(findNode(view.render(), (n) => n.props['aria-label'] === '调度选项')), /项目默认 · 代码审查/);
  assert.equal(calls.filter((c) => c.method === 'PATCH').length, 0);
  view.fields().props.onSelection('');
  await nextTurn();
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1).body)), { profileId: null });
  assert.equal(view.fields().props.routingProfileId, undefined);
  assert.equal(view.fields().props.inheritProjectRouting, false);
  view.fields().props.onSelection('routing-project-default');
  await nextTurn();
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1).body)), { inheritProject: true });
  assert.equal(view.fields().props.routingProfileId, profile.id);
  assert.equal(view.fields().props.inheritProjectRouting, true);
  view.fields().props.onSelection(`routing-profile:${profile.id}`);
  await nextTurn();
  assert.equal(view.fields().props.inheritProjectRouting, false);
  assert.equal(view.fields().props.routingProfileId, profile.id);
  assert.equal(view.input().props.value, 'Preserved project draft');
  assert.equal(
    calls.some((c) => c.path.endsWith('/messages')),
    false,
  );
  view.close();
});

test('profile editor saves a named locally parsed rule set and keeps failed edits', async () => {
  const h = uiHarness(settingsCode),
    calls: any[] = [],
    notices: any[] = [];
  let fail = true;
  const props: any = {
    state: { settings: { routingProfiles: [] }, targets: [], runtimes: [] },
    api: async (path: string, body: any, method: string) => {
      calls.push({ path, body, method });
      if (fail) throw Error('Synthetic failure');
      return { profiles: [{ id: path.split('/').at(-1), ...body }] };
    },
    reload: async () => {},
    notify: (notice: any) => notices.push(notice),
  };
  const render = () => h.render('RoutingProfilesSettings', props);
  findNode(render(), (node) => node.type === 'button' && text(node) === '新建路由方案')!.props.onClick();
  findNode(render(), (node) => node.props['aria-label'] === '路由方案名称')!.props.onChange({
    target: { value: ' 日常快答 ' },
  });
  const parsed = parseRoutingRules('其余内容使用 Claude', [{ id: 'claude', provider: 'claude', label: 'Claude' }]);
  findNode(render(), (node) => node.type?.name === 'RoutingRulesEditor')!.props.onChange(parsed);
  findNode(render(), (node) => node.type?.name === 'RoutingRulesEditor')!.props.onSave(parsed);
  await nextTurn();
  assert.equal(findNode(render(), (node) => node.props['aria-label'] === '路由方案名称')!.props.value, ' 日常快答 ');
  assert.match(notices.at(-1).message, /Synthetic failure/);
  fail = false;
  findNode(render(), (node) => node.type?.name === 'RoutingRulesEditor')!.props.onSave(parsed);
  await nextTurn();
  assert.equal(calls.at(-1).method, 'PUT');
  assert.equal(calls.at(-1).body.name, '日常快答');
  assert.equal(calls.at(-1).body.rules.rules[0].candidates[0].provider, 'claude');
  assert.equal(routingRuleSetSchema.safeParse(calls.at(-1).body.rules).success, true);
  assert.equal('chapterAgents' in calls.at(-1).body.rules, false);
  assert.equal('mask' in calls.at(-1).body.rules, false);
  assert.match(text(render()), /日常快答/);
  assert.equal(
    findNode(render(), (node) => node.props['aria-label'] === '编辑路由方案'),
    undefined,
  );
  h.unmount();
});

test('profile deletion requires confirmation and a server rejection keeps the profile listed', async () => {
  const h = uiHarness(settingsCode),
    calls: any[] = [],
    notices: any[] = [];
  const props = {
    state: { settings: { routingProfiles: [profile] }, targets: [], runtimes: [] },
    api: async (...args: any[]) => {
      calls.push(args);
      throw Error('This profile is in use');
    },
    reload: async () => {},
    notify: (notice: any) => notices.push(notice),
  };
  const render = () => h.render('RoutingProfilesSettings', props);
  const remove = () => findNode(render(), (node) => node.props['aria-label'] === `删除路由方案 ${profile.name}`)!;
  remove().props.onClick();
  assert.equal(calls.length, 0);
  const confirmations = h.exports.confirmationStore;
  confirmations.resolve(confirmations.snapshot().id, false);
  await nextTurn();
  assert.equal(calls.length, 0);
  remove().props.onClick();
  confirmations.resolve(confirmations.snapshot().id, true);
  await nextTurn();
  assert.equal(calls.length, 1);
  assert.match(notices.at(-1).message, /in use/);
  assert.ok(remove());
  h.unmount();
});

test('deleting another saved profile preserves an unsaved profile draft', async () => {
  const h = uiHarness(settingsCode);
  const props = {
    state: { settings: { routingProfiles: [profile] }, targets: [], runtimes: [] },
    api: async () => ({ profiles: [] }),
    reload: async () => {},
    notify() {},
  };
  const render = () => h.render('RoutingProfilesSettings', props);
  findNode(render(), (node) => node.type === 'button' && text(node) === '新建路由方案')!.props.onClick();
  findNode(render(), (node) => node.props['aria-label'] === '路由方案名称')!.props.onChange({
    target: { value: '尚未保存的名称' },
  });
  findNode(render(), (node) => node.props['aria-label'] === `删除路由方案 ${profile.name}`)!.props.onClick();
  const confirmations = h.exports.confirmationStore;
  confirmations.resolve(confirmations.snapshot().id, true);
  await nextTurn();
  assert.equal(
    findNode(render(), (node) => node.props['aria-label'] === '路由方案名称')!.props.value,
    '尚未保存的名称',
  );
  h.unmount();
});
