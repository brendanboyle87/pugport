import assert from 'node:assert/strict';
import test from 'node:test';
import { admit } from '../src/server/external-admission.ts';
import { findNode, nextTurn, text, uiBundle, uiHarness } from './helpers/ui-harness.ts';
const code = uiBundle('src/ui/ChannelAdmissionSettings.tsx');
test('mixed scopes unify in one PUT and reset preserves other classes, sender overrides and unrelated rules', async () => {
  const h = uiHarness(await code);
  let stored: any = {
    version: 1,
    rules: [
      { source: 'github', scope: 'issue', level: 'L4' },
      { source: 'github', scope: 'pr', senderClass: 'owner', level: 'L3' },
      { source: 'github', scope: 'comment', senderId: 'octocat', level: 'L2' },
      { source: 'github', scope: 'ci', level: 'L4' },
    ],
  };
  let writes = 0;
  const props = {
    source: 'github',
    endpoint: '/api/github/admission',
    scopes: h.exports.githubAdmissionScopes,
    showDigest: false,
    users: [{ id: 'octocat', login: 'octocat', avatarUrl: 'data:image/png;base64,synthetic' }],
    notify() {
      assert.fail();
    },
    api: async (_path: string, body: any, method: string) => {
      if (method === 'PUT') {
        writes++;
        stored = JSON.parse(JSON.stringify(body));
      }
      return stored;
    },
  };
  const render = () => h.render('ChannelAdmissionSettings', props);
  render();
  await nextTurn();
  let tree = render();
  const select = () =>
    findNode(tree, (n) => n.type === 'select' && n.props['aria-label'] === 'GitHub 上 @PugPort · 我')!;
  assert.equal(select().props.value, 'mixed');
  assert.match(text(tree), /混合/);
  assert.match(text(tree), /@octocat/);
  const avatar = findNode(tree, (n) => n.type === 'img')!;
  assert.equal(avatar.props.width, 16);
  assert.equal(avatar.props.height, 16);
  select().props.onChange({ target: { value: 'L2' } });
  await nextTurn();
  tree = render();
  assert.equal(writes, 1);
  assert.ok(stored.rules.filter((r: any) => r.senderClass === 'owner').every((r: any) => r.level === 'L2'));
  assert.equal(select().props.value, 'L2');
  assert.deepEqual(
    stored.rules.filter((r: any) => r.senderClass === 'owner').map((r: any) => r.scope),
    ['issue', 'pr', 'comment'],
  );
  const ownerRow = findNode(
    tree,
    (n) => n.props.className === 'channel-admission-row' && !!findNode(n, (c) => c === select()),
  )!;
  findNode(ownerRow, (n) => n.type === 'button')!.props.onClick();
  await nextTurn();
  tree = render();
  assert.equal(writes, 2);
  assert.equal(select().props.value, 'L1');
  assert.equal(
    stored.rules.some((r: any) => r.senderClass === 'owner'),
    false,
  );
  assert.equal(stored.rules.find((r: any) => r.scope === 'issue' && r.senderClass === 'trusted').level, 'L4');
  assert.equal(stored.rules.find((r: any) => r.senderId === 'octocat').level, 'L2');
  assert.equal(stored.rules.find((r: any) => r.scope === 'ci').level, 'L4');
  h.unmount();
});
test('GitHub defaults match admission, writes and resets classes, removes sender rules without digest calls', async () => {
  const h = uiHarness(await code);
  let stored: any = { version: 1, rules: [{ source: 'github', scope: 'comment', senderId: 'synthetic', level: 'L2' }] };
  const calls: any[] = [];
  const props = {
    source: 'github',
    endpoint: '/api/github/admission',
    scopes: h.exports.githubAdmissionScopes,
    showDigest: false,
    notify() {
      assert.fail('unexpected notice');
    },
    api: async (path: string, body: any, method: string) => {
      assert.equal(path, '/api/github/admission');
      calls.push({ path, body, method });
      if (method === 'PUT') stored = JSON.parse(JSON.stringify(body));
      return stored;
    },
  };
  const render = () => h.render('ChannelAdmissionSettings', props);
  render();
  await nextTurn();
  let tree = render();
  assert.equal(
    findNode(tree, (n) => n.props.className === 'channel-admission-row channel-digest'),
    undefined,
  );
  for (const scope of h.exports.githubAdmissionScopes)
    for (const sender of ['owner', 'trusted', 'other', 'bot']) {
      const row = findNode(tree, (n) => n.props.className === 'channel-scope' && text(n).includes(scope.label))!;
      const index = ['owner', 'trusted', 'other', 'bot'].indexOf(sender);
      const selects: any[] = [];
      const visit = (n: any) => {
        if (Array.isArray(n)) n.forEach(visit);
        else if (n?.props) {
          if (n.type === 'select') selects.push(n);
          visit(n.props.children);
        }
      };
      visit(row);
      assert.equal(
        selects[index].props.value,
        admit({
          source: 'github',
          scope: scope.id,
          senderId: 'x',
          senderClass: sender as any,
          ownerRepository: true,
          mentioned: true,
        }).level,
      );
      assert.equal(!!selects[index].props.disabled, sender === 'bot');
    }
  const select = () => findNode(tree, (n) => n.type === 'select' && n.props.value === 'L1')!;
  select().props.onChange({ target: { value: 'L3' } });
  await nextTurn();
  tree = render();
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1).body.rules.at(-1))), {
    source: 'github',
    scope: 'comment',
    senderClass: 'owner',
    level: 'L3',
  });
  assert.deepEqual(
    stored.rules.filter((r: any) => r.senderClass === 'owner').map((r: any) => r.scope),
    ['issue', 'pr', 'comment'],
  );
  findNode(tree, (n) => n.type === 'button' && text(n) === '\u6062\u590d\u9ed8\u8ba4')!.props.onClick();
  await nextTurn();
  tree = render();
  assert.equal(select().props.value, 'L1');
  findNode(tree, (n) => n.type === 'button' && n.props['data-names'])!.props.onClick();
  await nextTurn();
  render();
  assert.deepEqual(stored.rules, []);
  h.unmount();
});
test('disconnected GitHub displays disabled explanation and never reads rules', async () => {
  const h = uiHarness(await uiBundle('src/ui/GitHubConnection.tsx'));
  const calls: string[] = [];
  const props = {
    api: async (path: string) => {
      calls.push(path);
      return { enabled: false, state: 'off' };
    },
    notify() {
      assert.fail();
    },
  };
  h.render('GitHubConnection', props);
  await nextTurn();
  const tree = h.render('GitHubConnection', props);
  assert.equal(tree.props.footer.props['aria-disabled'], 'true');
  assert.deepEqual(calls, ['/api/github']);
  h.unmount();
});
