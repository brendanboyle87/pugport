import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MentionMenu } from '../src/ui/Mentions.tsx';
import type { ExternalAgentView } from '../src/shared/external-agents.ts';
import type { Api } from '../src/ui/Workspace.tsx';
import { nextTurn, uiBundle, uiHarness } from './helpers/ui-harness.ts';

let code: string;
before(async () => {
  code = await uiBundle('src/ui/ExternalAgents.tsx');
});
const agents = [
  { id: 'muse', name: 'Muse', kind: 'web', description: '', enabled: true, available: true },
  { id: 'grok-bot', name: 'Grok Bot', kind: 'handoff', description: '', enabled: true, available: true },
] as ExternalAgentView[];
function picker(api: Api) {
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let id = 0;
  const view = uiHarness(code, {
    setTimeout(fn: () => void, ms: number) {
      timers.set(++id, { fn, ms });
      return id;
    },
    clearTimeout(id: number) {
      timers.delete(id);
    },
  });
  view.exports.Picker = ({ api, open }: { api: Api; open: boolean }) => view.exports.useExternalAgents(api, open);
  return {
    view,
    timers,
    render: (open = true) =>
      view.render('Picker', { api, open }) as unknown as {
        agents: ExternalAgentView[];
        status?: 'loading' | 'retrying' | 'failed';
      },
    remount() {
      view.remount();
    },
    retry() {
      assert.equal(timers.size, 1);
      const [key, timer] = [...timers][0]!;
      assert.equal(timer.ms, 2000);
      timers.delete(key);
      timer.fn();
    },
  };
}

test('the picker hides unadded bots and keeps configured disabled bots discoverable', async () => {
  const p = picker(
    async <T>() =>
      ({
        agents: [
          { ...agents[0], added: false },
          { ...agents[1], added: true, enabled: false, available: false },
        ],
      }) as T,
  );
  p.render();
  await nextTurn();
  assert.deepEqual(
    p.render().agents.map((agent) => agent.id),
    ['grok-bot'],
  );
  p.view.unmount();
});

test('a failed refresh keeps the session cache and retries exactly once', async () => {
  let calls = 0;
  const api: Api = async <T>() => {
    if (++calls === 1) return { agents } as T;
    throw new Error('fixture timeout');
  };
  const p = picker(api);
  p.render(false);
  assert.equal(calls, 0);
  p.render();
  await nextTurn();
  assert.deepEqual(
    p.render().agents.map((a) => a.name),
    ['Muse', 'Grok Bot'],
  );
  p.render(false);
  p.remount();
  assert.deepEqual(
    p.render().agents.map((a) => a.name),
    ['Muse', 'Grok Bot'],
  );
  await nextTurn();
  assert.deepEqual(
    p.render().agents.map((a) => a.name),
    ['Muse', 'Grok Bot'],
  );
  p.retry();
  await nextTurn();
  assert.equal(calls, 3);
  assert.equal(p.timers.size, 0, 'no further retry after the retry fails');
  assert.deepEqual(
    p.render().agents.map((a) => a.name),
    ['Muse', 'Grok Bot'],
  );
  assert.equal(p.render().status, undefined);
  p.view.unmount();
});

test('without a cache, failed loading shows a muted external section and a retry can recover', async () => {
  let calls = 0;
  const p = picker(async <T>() => {
    if (++calls === 1) throw new Error('fixture timeout');
    return { agents } as T;
  });
  p.render();
  await nextTurn();
  const result = p.render();
  assert.equal(result.status, 'retrying');
  const html = renderToStaticMarkup(
    createElement(MentionMenu, {
      items: [],
      active: -1,
      onHover() {},
      onPick() {},
      onCreate() {},
      externalAgentsStatus: result.status,
    }),
  );
  assert.match(html, /role="group" aria-label="外部智能体"/);
  assert.match(html, /class="mention-empty" role="status">外部智能体暂时没加载出来，正在重试…/);
  p.retry();
  await nextTurn();
  assert.equal(calls, 2);
  assert.equal(p.render().status, undefined);
  assert.equal(p.render().agents.length, 2);
  p.view.unmount();
});

test('closing the picker cancels its pending retry', async () => {
  const p = picker(async () => {
    throw new Error('fixture timeout');
  });
  p.render();
  await nextTurn();
  assert.equal(p.timers.size, 1);
  p.render(false);
  assert.equal(p.timers.size, 0);
  p.view.unmount();
});

test('first open is loading; after one failed retry the menu asks to reopen', async () => {
  const p = picker(async () => {
    throw new Error('fixture timeout');
  });
  const menu = (status: ReturnType<typeof p.render>['status']) =>
    renderToStaticMarkup(
      createElement(MentionMenu, {
        items: [],
        active: -1,
        onHover() {},
        onPick() {},
        onCreate() {},
        externalAgentsStatus: status,
      }),
    );
  assert.equal(p.render().status, 'loading');
  assert.match(menu(p.render().status), /正在加载外部智能体…/);
  await nextTurn();
  assert.equal(p.render().status, 'retrying');
  p.retry();
  await nextTurn();
  assert.equal(p.render().status, 'failed');
  assert.match(menu(p.render().status), /关掉再打开 @@ 重试/);
  assert.doesNotMatch(menu(p.render().status), /正在重试/);
  assert.equal(p.timers.size, 0);
  p.render(false);
  assert.equal(p.render().status, 'loading');
  p.view.unmount();
});

test('a successful empty list does not show the unavailable row', async () => {
  const p = picker(async <T>() => ({ agents: [] }) as T);
  p.render();
  await nextTurn();
  assert.equal(p.render().status, undefined);
  assert.equal(p.render().agents.length, 0);
  p.view.unmount();
});
