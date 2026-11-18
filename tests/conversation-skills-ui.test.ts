import assert from 'node:assert/strict';
import test from 'node:test';
import { findNode, nextTurn, text, uiBundle, uiHarness } from './helpers/ui-harness.ts';

const code = await uiBundle('src/ui/ConversationPanel.tsx');
const review = {
  kind: 'skill',
  id: 'review',
  name: 'review',
  description: 'Review code. More trigger instructions that stay in the tooltip.',
  enabled: true,
};
const notes = { ...review, id: 'notes', name: 'notes', description: 'Take notes' };
const off = { ...review, id: 'off', name: 'off', enabled: false };
const conversation = { id: 'chat-one', projectId: 'project', title: 'Synthetic', createdAt: '', updatedAt: '' };
const checkbox = (tree: unknown, name: string) => {
  const row = findNode(tree, (node) => node.type === 'li' && text(node).startsWith(name));
  assert.ok(row, 'Missing skill: ' + name);
  return findNode(row, (node) => node.type === 'input')!;
};
function fixture(chat: any = conversation, items: any[] = [review, notes, off], globals: Record<string, unknown> = {}) {
  const h = uiHarness(code, { Error, ...globals }),
    calls: any[] = [],
    notices: any[] = [];
  let fail = false,
    failGet = false,
    delay: Promise<unknown> | undefined;
  const props = {
    conversation: chat,
    notify: (value: unknown) => notices.push(value),
    api: async (path: string, body: any, method: string) => {
      calls.push({ path, body: body && JSON.parse(JSON.stringify(body)), method });
      if (method === 'GET') {
        if (failGet) throw new Error('Synthetic list failure');
        return { items };
      }
      if (fail) throw new Error('Synthetic save failure');
      if (delay) return delay;
      return { ...chat, appliedSkills: body.appliedSkills };
    },
  };
  return {
    h,
    props,
    calls,
    notices,
    fail: (value: boolean) => {
      fail = value;
    },
    failGet: (value: boolean) => {
      failGet = value;
    },
    delay: (value: Promise<unknown>) => {
      delay = value;
    },
  };
}

test('only enabled skills are listed unchecked by default; check saves only the current chat immediately', async () => {
  const f = fixture();
  f.h.render('SkillsTab', f.props);
  await nextTurn();
  let tree = f.h.render('SkillsTab', f.props);
  for (const name of ['review', 'notes']) assert.equal(checkbox(tree, name).props.checked, false);
  assert.equal(
    findNode(tree, (node) => node.type === 'li' && text(node).startsWith('off')),
    undefined,
  );
  assert.match(text(tree), /未勾选的仍可按需调用/);
  assert.equal(
    findNode(tree, (node) => node.type === 'button' && text(node) === '保存'),
    undefined,
  );
  await checkbox(tree, 'review').props.onChange({ target: { checked: true } });
  await nextTurn();
  tree = f.h.render('SkillsTab', f.props);
  assert.equal(checkbox(tree, 'review').props.checked, true);
  assert.equal(checkbox(tree, 'notes').props.checked, false);
  assert.deepEqual(
    f.calls.filter((c) => c.method === 'PATCH'),
    [{ path: '/api/conversations/chat-one/skills', body: { appliedSkills: ['review'] }, method: 'PATCH' }],
  );
  await checkbox(tree, 'review').props.onChange({ target: { checked: false } });
  await nextTurn();
  tree = f.h.render('SkillsTab', f.props);
  assert.equal(checkbox(tree, 'review').props.checked, false);
  assert.deepEqual(f.calls.at(-1).body, { appliedSkills: [] });
  assert.ok(
    f.calls.every(
      (c) => c.path === '/api/extensions?language=zh-CN' || c.path === '/api/conversations/chat-one/skills',
    ),
  );
  f.h.unmount();
});

test('a missing items list renders the empty state without exposing a JavaScript error', async () => {
  const f = fixture();
  const props = { ...f.props, api: async () => ({}) };
  f.h.render('SkillsTab', props);
  await nextTurn();
  const tree = f.h.render('SkillsTab', props);
  assert.doesNotMatch(text(tree), /读取 Skills|Cannot read|技能列表暂时读不到/);
  assert.match(text(tree), /还没有启用的 Skills/);
  f.h.unmount();
});

test('an initial skills failure shows friendly copy and retry reloads the list', async () => {
  const f = fixture();
  f.failGet(true);
  f.h.render('SkillsTab', f.props);
  await nextTurn();
  let tree = f.h.render('SkillsTab', f.props);
  assert.match(text(tree), /技能列表暂时读不到/);
  assert.doesNotMatch(text(tree), /Synthetic list failure/);
  f.failGet(false);
  findNode(tree, (node) => node.type === 'button' && text(node) === '重试')!.props.onClick();
  tree = f.h.render('SkillsTab', f.props);
  assert.match(text(tree), /读取 Skills/);
  await nextTurn();
  assert.ok(checkbox(f.h.render('SkillsTab', f.props), 'review'));
  assert.equal(f.calls.length, 2);
  f.h.unmount();
});

test('one chat reloads its own preferences while a different chat defaults to unchecked', async () => {
  const saved = fixture({ ...conversation, appliedSkills: ['review'] });
  saved.h.render('SkillsTab', saved.props);
  await nextTurn();
  assert.equal(checkbox(saved.h.render('SkillsTab', saved.props), 'review').props.checked, true);
  saved.h.unmount();
  const other = fixture({ ...conversation, id: 'chat-two' });
  other.h.render('SkillsTab', other.props);
  await nextTurn();
  assert.equal(checkbox(other.h.render('SkillsTab', other.props), 'review').props.checked, false);
  assert.equal(other.calls.length, 1);
  other.h.unmount();
});

test('save failures undo the tick and allow retry without changing enabled skills or legacy restrictions', async () => {
  const f = fixture({ ...conversation, skills: ['review'], appliedSkills: [] });
  f.h.render('SkillsTab', f.props);
  await nextTurn();
  let tree = f.h.render('SkillsTab', f.props);
  assert.equal(checkbox(tree, 'notes').props.disabled, true);
  f.fail(true);
  checkbox(tree, 'review').props.onChange({ target: { checked: true } });
  await nextTurn();
  tree = f.h.render('SkillsTab', f.props);
  assert.equal(checkbox(tree, 'review').props.checked, false);
  assert.equal(f.notices[0].message, 'Synthetic save failure');
  f.fail(false);
  checkbox(tree, 'review').props.onChange({ target: { checked: true } });
  await nextTurn();
  assert.equal(checkbox(f.h.render('SkillsTab', f.props), 'review').props.checked, true);
  assert.ok(
    f.calls.filter((c) => c.method === 'PATCH').every((c) => Object.keys(c.body).join(',') === 'appliedSkills'),
  );
  f.h.unmount();
});

test('a pending save blocks repeated clicks and an unmounted chat ignores its delayed error', async () => {
  const f = fixture();
  let reject!: (error: Error) => void;
  f.delay(
    new Promise((_done, fail) => {
      reject = fail;
    }),
  );
  f.h.render('SkillsTab', f.props);
  await nextTurn();
  const change = checkbox(f.h.render('SkillsTab', f.props), 'review').props.onChange;
  change({ target: { checked: true } });
  change({ target: { checked: true } });
  assert.equal(f.calls.filter((c) => c.method === 'PATCH').length, 1);
  assert.equal(checkbox(f.h.render('SkillsTab', f.props), 'notes').props.disabled, true);
  f.h.unmount();
  reject(new Error('Late failure'));
  await nextTurn();
  assert.deepEqual(f.notices, []);
});

test('hidden disabled preferences are retained and uninstalled stale names do not block another edit', async () => {
  const f = fixture({ ...conversation, appliedSkills: ['off', 'uninstalled'] });
  f.h.render('SkillsTab', f.props);
  await nextTurn();
  const tree = f.h.render('SkillsTab', f.props);
  assert.equal(
    findNode(tree, (node) => node.type === 'li' && text(node).startsWith('off')),
    undefined,
  );
  checkbox(tree, 'review').props.onChange({ target: { checked: true } });
  await nextTurn();
  assert.deepEqual(f.calls.at(-1).body, { appliedSkills: ['off', 'review'] });
  f.h.unmount();
});

test('fallback is the first sentence, original description stays in tooltip and outside the toggle label', async () => {
  const f = fixture(conversation, [review, { ...notes, sync: { sources: [], removedAt: 'yesterday' } }]);
  f.h.render('SkillsTab', f.props);
  await nextTurn();
  const tree = f.h.render('SkillsTab', f.props);
  const row = findNode(tree, (node) => node.type === 'li')!;
  assert.equal(text(findNode(row, (node) => node.type === 'small')), 'Review code.');
  assert.equal(findNode(row, (node) => node.type === 'small')!.props.title, review.description);
  assert.equal(text(findNode(row, (node) => node.type === 'label')), 'review');
  assert.equal(
    findNode(tree, (node) => node.type === 'li' && text(node).startsWith('notes')),
    undefined,
  );
  f.h.unmount();
});

test('search matches names, current-language summaries and category labels locally', async () => {
  const f = fixture(conversation, [
    review,
    {
      ...notes,
      summaries: { 'zh-CN': { hash: 'synthetic', language: 'zh-CN', category: 'writing', summary: '整理会议记录' } },
    },
  ]);
  f.h.render('SkillsTab', f.props);
  await nextTurn();
  let tree = f.h.render('SkillsTab', f.props);
  for (const query of ['NOTES', '会议', '写作']) {
    findNode(tree, (node) => node.props.type === 'search')!.props.onChange({ target: { value: query } });
    tree = f.h.render('SkillsTab', f.props);
    assert.equal(text(findNode(tree, (node) => node.type === 'li')), 'notes整理会议记录');
  }
  findNode(tree, (node) => node.props.type === 'search')!.props.onChange({ target: { value: 'unmatched' } });
  tree = f.h.render('SkillsTab', f.props);
  assert.match(text(tree), /没有匹配的 Skills/);
  assert.equal(f.calls.length, 1);
  f.h.unmount();
});

test('collapse all and each group persist per window and survive unavailable storage', async () => {
  const saved = new Map<string, string>();
  const globals = {
    sessionStorage: { getItem: () => 'synthetic-window', setItem() {} },
    localStorage: {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => saved.set(key, value),
    },
  };
  const f = fixture(conversation, [review, notes], globals);
  f.h.render('SkillsTab', f.props);
  await nextTurn();
  let tree = f.h.render('SkillsTab', f.props);
  findNode(tree, (node) => node.type === 'button' && text(node) === '全部折叠')!.props.onClick();
  tree = f.h.render('SkillsTab', f.props);
  assert.equal(
    findNode(tree, (node) => node.type === 'li'),
    undefined,
  );
  assert.equal(findNode(tree, (node) => node.props['aria-expanded'] !== undefined)!.props['aria-expanded'], false);
  f.h.remount();
  f.h.render('SkillsTab', f.props);
  await nextTurn();
  tree = f.h.render('SkillsTab', f.props);
  assert.equal(
    findNode(tree, (node) => node.type === 'li'),
    undefined,
  );
  findNode(tree, (node) => node.type === 'button' && text(node) === '全部展开')!.props.onClick();
  tree = f.h.render('SkillsTab', f.props);
  assert.ok(findNode(tree, (node) => node.type === 'li'));
  findNode(tree, (node) => node.props['aria-expanded'] !== undefined)!.props.onClick();
  tree = f.h.render('SkillsTab', f.props);
  assert.equal(
    findNode(tree, (node) => node.type === 'li'),
    undefined,
  );
  assert.ok(saved.has('pugport.skills.collapsed.synthetic-window'));
  f.h.unmount();
  const otherWindow = fixture(conversation, [review], {
    ...globals,
    sessionStorage: { getItem: () => 'another-window', setItem() {} },
  });
  otherWindow.h.render('SkillsTab', otherWindow.props);
  await nextTurn();
  assert.ok(checkbox(otherWindow.h.render('SkillsTab', otherWindow.props), 'review'));
  otherWindow.h.unmount();
  const broken = fixture(conversation, [review], {
    sessionStorage: {
      getItem() {
        throw new Error('Unavailable');
      },
    },
  });
  broken.h.render('SkillsTab', broken.props);
  await nextTurn();
  assert.ok(checkbox(broken.h.render('SkillsTab', broken.props), 'review'));
  broken.h.unmount();
  const blockedLocal = fixture(conversation, [review], {
    sessionStorage: globals.sessionStorage,
    localStorage: {
      getItem() {
        throw new Error('Unavailable');
      },
      setItem() {
        throw new Error('Unavailable');
      },
    },
  });
  blockedLocal.h.render('SkillsTab', blockedLocal.props);
  await nextTurn();
  const blockedTree = blockedLocal.h.render('SkillsTab', blockedLocal.props);
  findNode(blockedTree, (node) => node.type === 'button' && text(node) === '全部折叠')!.props.onClick();
  assert.equal(
    findNode(blockedLocal.h.render('SkillsTab', blockedLocal.props), (node) => node.type === 'li'),
    undefined,
  );
  blockedLocal.h.unmount();
});

test('poll refreshes metadata for current language, retains rows on failure and stops on unmount', async () => {
  let poll!: () => void;
  let clears = 0;
  const f = fixture(conversation, [review], {
    setInterval: (fn: () => void, ms: number) => {
      assert.equal(ms, 5000);
      poll = fn;
      return 7;
    },
    clearInterval: (id: number) => {
      assert.equal(id, 7);
      clears++;
    },
    localStorage: { getItem: () => 'en', setItem() {} },
  });
  f.h.render('SkillsTab', f.props);
  await nextTurn();
  assert.equal(f.calls[0].path, '/api/extensions?language=en');
  f.failGet(true);
  poll();
  await nextTurn();
  assert.equal(f.calls.length, 2);
  assert.ok(checkbox(f.h.render('SkillsTab', f.props), 'review'));
  f.failGet(false);
  poll();
  await nextTurn();
  assert.equal(f.calls.length, 3);
  f.h.unmount();
  assert.equal(clears, 1);
});

test('a failed pending save uses newer confirmed choices instead of erasing another panel update', async () => {
  const f = fixture();
  let reject!: (error: Error) => void;
  f.delay(
    new Promise((_done, fail) => {
      reject = fail;
    }),
  );
  f.h.render('SkillsTab', f.props);
  await nextTurn();
  checkbox(f.h.render('SkillsTab', f.props), 'review').props.onChange({ target: { checked: true } });
  const updated = { ...f.props, conversation: { ...conversation, appliedSkills: ['notes'] } };
  f.h.render('SkillsTab', updated);
  reject(new Error('Synthetic conflict'));
  await nextTurn();
  let tree = f.h.render('SkillsTab', updated);
  assert.equal(checkbox(tree, 'notes').props.checked, true);
  assert.equal(checkbox(tree, 'review').props.checked, false);
  f.delay(Promise.resolve({ ...updated.conversation, appliedSkills: ['notes', 'review'] }));
  checkbox(tree, 'review').props.onChange({ target: { checked: true } });
  await nextTurn();
  assert.deepEqual(f.calls.at(-1).body, { appliedSkills: ['notes', 'review'] });
  f.h.unmount();
});

test('an older successful response cannot replace a newer confirmed selection', async () => {
  const f = fixture();
  let resolve!: (value: unknown) => void;
  f.delay(
    new Promise((done) => {
      resolve = done;
    }),
  );
  f.h.render('SkillsTab', f.props);
  await nextTurn();
  checkbox(f.h.render('SkillsTab', f.props), 'review').props.onChange({ target: { checked: true } });
  const updated = {
    ...f.props,
    conversation: { ...conversation, appliedSkills: ['notes'], updatedAt: '2026-10-24T12:00:02Z' },
  };
  f.h.render('SkillsTab', updated);
  resolve({ ...conversation, appliedSkills: ['review'], updatedAt: '2026-10-24T12:00:01Z' });
  await nextTurn();
  const tree = f.h.render('SkillsTab', updated);
  assert.equal(checkbox(tree, 'notes').props.checked, true);
  assert.equal(checkbox(tree, 'review').props.checked, false);
  f.h.unmount();
});
