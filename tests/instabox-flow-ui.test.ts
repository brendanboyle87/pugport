import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RemoteServerCards } from '../src/ui/RemoteServers.tsx';
import { findNode, nextTurn, text, uiBundle, uiHarness } from './helpers/ui-harness.ts';
const machine = {
  source: 'instabox' as const,
  machineId: 'm_fixture1',
  name: 'Fixture',
  state: 'running',
  checkedAt: new Date(0).toISOString(),
  spec: { vcpus: 4, memMiB: 8192 },
  autoSuspendAfterSeconds: 1800,
};
const view = { servers: [], file: 'fixture', instabox: { machines: [machine] } };
const cards = (m: any) =>
  renderToStaticMarkup(
    createElement(RemoteServerCards, {
      api: async () => undefined as never,
      notify() {},
      onOpen() {},
      now: 0,
      view: { ...view, instabox: { machines: [m] } },
    }),
  );

test('managed SSH removal stays available with no machines after machines disappear', () => {
  const html = renderToStaticMarkup(
    createElement(RemoteServerCards, {
      api: async () => undefined as never,
      notify() {},
      onOpen() {},
      onRemoveSsh() {},
      now: 0,
      view: { servers: [], file: 'fixture', instabox: { machines: [], sshManaged: true } },
    }),
  );
  assert.match(html, /远程服务器/);
  assert.match(html, /移除 instabox SSH 配置/);
});
test('instabox machines are inside the Remote servers grid without manual configuration', () => {
  const html = cards(machine);
  assert.match(html, /远程服务器/);
  assert.match(html, /Fixture/);
  assert.match(html, /instabox/);
  assert.match(html, /4 vCPU/);
  assert.match(html, /闲置 30 分钟后暂停/);
  assert.doesNotMatch(html, /<h2 translate="no">instabox/);
});
test('instabox metrics show CPU and memory only while running and fresh', () => {
  const live = { online: true, checkedAt: machine.checkedAt, cpuPercent: 40, memoryTotal: 8192, memoryAvailable: 4096 };
  assert.match(cards({ ...machine, live }), /progressbar/);
  assert.doesNotMatch(cards({ ...machine, live }), /data-resource="disk"/);
  for (const patch of [{ state: 'paused' }, { state: 'starting' }, { stale: true }, { pendingAction: 'pause' }])
    assert.doesNotMatch(cards({ ...machine, live, ...patch }), /progressbar/);
});
test('enrollment wakes before enrolling and aborts on wake failure', async () => {
  for (const fail of [false, true]) {
    const calls: string[] = [];
    const h = uiHarness(await uiBundle('src/ui/ServerEnroll.tsx'));
    const props = {
      server: { name: 'Fixture', ssh: 'pugport-instabox-fixture1' },
      machine: { ...machine, state: 'paused', ssh: 'pugport-instabox-fixture1' },
      onClose() {},
      api: async (path: string) => {
        calls.push(path);
        if (path.endsWith('/action') && fail) throw new Error('wake failed');
        return path.endsWith('/enrollments')
          ? { enrollment: { id: 'test', status: 'failed', log: '', stage: 'preflight' } }
          : view;
      },
    };
    const render = () => h.render('ServerEnroll', props);
    render();
    await nextTurn();
    await nextTurn();
    assert.ok(calls.includes('/api/remote-servers/instabox/action'));
    assert.equal(calls.includes('/api/remote-servers/enrollments'), !fail);
    if (!fail)
      assert.ok(
        calls.indexOf('/api/remote-servers/instabox/action') < calls.indexOf('/api/remote-servers/enrollments'),
      );
    h.unmount();
  }
});
test('instabox enrollment automatically prepares SSH and reports removable entries without consent', async () => {
  const calls: string[] = [];
  const h = uiHarness(await uiBundle('src/ui/ServerEnroll.tsx'));
  const props = {
    server: { name: 'Fixture' },
    machine,
    onClose() {},
    api: async (path: string) => {
      calls.push(path);
      return path.endsWith('/enrollments')
        ? { enrollment: { id: 'test', status: 'failed', log: '', stage: 'preflight' } }
        : view;
    },
  };
  h.render('ServerEnroll', props);
  await nextTurn();
  await nextTurn();
  assert.equal(calls[0], '/api/remote-servers/instabox/ssh');
  assert.ok(calls.includes('/api/remote-servers/enrollments'));
  assert.ok(!calls.some((p) => p.includes('consent')));
  const content = text(h.render('ServerEnroll', props));
  assert.match(content, /~\/.ssh\/pugport-instabox.conf/);
  assert.match(content, /~\/.ssh\/config/);
  assert.match(content, /移除 instabox SSH 配置/);
  h.unmount();
});

for (const alias of ['pugport-instabox-newbox', undefined]) {
  test(`completed enrollment uses paired SSH alias or omits missing command: ${alias}`, async () => {
    const h = uiHarness(await uiBundle('src/ui/ServerEnroll.tsx'));
    const props = {
      server: { name: 'Fixture' },
      machine,
      onClose() {},
      api: async (path: string) =>
        path.endsWith('/enrollments')
          ? {
              enrollment: {
                id: 'test',
                status: 'completed',
                stage: 'done',
                log: '',
                device: { executors: [], ...(alias ? { tunnel: { ssh: alias } } : {}) },
              },
            }
          : view,
    };
    h.render('ServerEnroll', props);
    await nextTurn();
    await nextTurn();
    const command = findNode(h.render('ServerEnroll', props), (node) => node.type === 'code');
    assert.equal(command?.props.children, alias ? `ssh ${alias}` : undefined);
    h.unmount();
  });
}

for (const outcome of ['ok', 'fail', 'scope', 'ordinary', 'running', 'starting', 'stopped']) {
  test(`composer instabox send: ${outcome}`, async () => {
    const code = await uiBundle('src/ui/Workspace.tsx');
    const stamp = machine.checkedAt;
    const conversation = { id: 'a', projectId: 'project', title: 'a', createdAt: stamp, updatedAt: stamp };
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
      settings: { toolApprovalMode: 'auto', executionPolicy: 'cli-first' },
    };
    const device = {
      id: 'fixture-device',
      name: 'Fixture',
      address: 'fixture',
      tunnel: { ssh: outcome === 'ordinary' ? 'ordinary-box' : 'pugport-instabox-fixture1', remotePort: 1234 },
      online: true,
    };
    const calls: string[] = [];
    const sends: string[] = [];
    const notices: any[] = [];
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const h = uiHarness(code);
    const props = {
      state,
      conversation,
      notify(notice: any) {
        notices.push(notice);
      },
      onConversation() {},
      onAddProject() {},
      onMemory() {},
      onInspect() {},
      api: async (path: string, body: any) => {
        calls.push(path);
        if (path === '/api/devices') return { devices: [device] };
        if (path.startsWith('/api/remote-servers?') || path === '/api/remote-servers')
          return {
            ...view,
            instabox: {
              machines: [
                {
                  ...machine,
                  state: ['running', 'starting', 'stopped'].includes(outcome) ? outcome : 'paused',
                  ssh: device.tunnel.ssh,
                },
              ],
            },
          };
        if (path.endsWith('/instabox/action')) {
          await new Promise<void>((a, b) => {
            resolve = a;
            reject = b;
          });
          return view;
        }
        if (path.endsWith('/messages') && body) {
          sends.push(path);
          return { message: { id: 'm1', conversationId: 'a', role: 'user', content: body.content, createdAt: stamp } };
        }
        return { messages: [] };
      },
    };
    const render = () => h.render('ConversationWorkspace', props);
    const input = () => findNode(render(), (n) => n.type === 'textarea' && n.props.id === 'conversation-input')!;
    input().props.onChange({ target: { value: '@@@', selectionStart: 3 } });
    await nextTurn();
    render();
    await nextTurn();
    const menu = findNode(render(), (n) => n.type?.name === 'MentionMenu')!;
    const item = menu.props.items.find((i: any) => i.kind === 'device');
    if (['starting', 'stopped'].includes(outcome)) {
      assert.notEqual(item.description, '已暂停 · 发送时唤醒');
      h.unmount();
      return;
    }
    menu.props.onPick(item);
    assert.equal(calls.filter((p) => p.endsWith('/instabox/action')).length, 0);
    const before = input().props.value;
    const submit = () =>
      findNode(
        render(),
        (n) => n.type === 'form' && n.props.className.includes('conversation-composer'),
      )!.props.onSubmit({ preventDefault() {} });
    calls.length = 0;
    submit();
    await nextTurn();
    if (['ordinary', 'running'].includes(outcome)) {
      await nextTurn();
      assert.equal(calls.filter((p) => p.endsWith('/instabox/action')).length, 0);
      if (outcome === 'ordinary') assert.equal(calls.filter((p) => p.includes('remote-servers')).length, 0);
      assert.equal(sends.length, 1);
      h.unmount();
      return;
    }
    submit();
    assert.ok(notices.some((n) => /正在唤醒/.test(n.message)));
    assert.equal(calls.filter((p) => p.endsWith('/instabox/action')).length, 1);
    if (outcome === 'scope') {
      props.conversation = { ...conversation, id: 'b' };
      render();
    }
    if (outcome === 'fail') reject(new Error('wake failed'));
    else resolve();
    await nextTurn();
    await nextTurn();
    assert.equal(sends.length, outcome === 'ok' ? 1 : 0);
    if (outcome === 'fail') assert.equal(input().props.value, before);
    assert.equal(calls.filter((p) => p.endsWith('/instabox/action')).length, 1);
    h.unmount();
  });
}
