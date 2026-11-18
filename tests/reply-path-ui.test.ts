import assert from 'node:assert/strict';
import test from 'node:test';
import type { Api } from '../src/ui/Workspace.tsx';
import { findNode, nextTurn, uiBundle, uiHarness, type UiNode } from './helpers/ui-harness.ts';

const bundled = uiBundle('src/ui/ReplyPaths.tsx');
type Resolution = { path?: string; paths?: string[]; truncated?: boolean };
type Call = { path: string; body?: unknown };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function pathElement(name: string, relative = false, bases: string[] = []) {
  const attribute = relative ? 'data-relative-path' : 'data-local-path';
  const scope = {
    querySelectorAll: () => bases.map((path) => ({ getAttribute: () => path })),
  };
  const element = {
    getAttribute: (key: string) => (key === attribute ? name : null),
    hasAttribute: (key: string) => key === attribute,
    matches: (selector: string) => selector.includes(`[${attribute}]`),
    closest: (selector: string): unknown => (selector.includes('data-path-scope') ? scope : element),
  };
  return element;
}

async function fixture(
  options: {
    resolve?: (body: unknown) => Promise<Resolution>;
    nativeStatus?: string;
    nativeReveal?: (path: string) => Promise<string>;
    native?: boolean;
    projectPath?: string;
    editorStatus?: string;
  } = {},
) {
  const calls: Call[] = [];
  const revealed: string[] = [];
  const editors: Array<{ editor: string; path: string }> = [];
  const opener = { current: null as null | ((element: unknown, editor: string) => Promise<void>) };
  const notices: Array<{ tone: string; message: string }> = [];
  let selection = '';
  const api: Api = async <T>(path: string, body?: unknown): Promise<T> => {
    calls.push({ path, body: body === undefined ? undefined : JSON.parse(JSON.stringify(body)) });
    if (path === '/api/resolve-path') return (await (options.resolve?.(body) ?? Promise.resolve({ paths: [] }))) as T;
    if (path === '/api/reveal') return { ok: true } as T;
    throw new Error(`Unexpected fixture API: ${path}`);
  };
  const harness = uiHarness(await bundled, {
    window:
      options.native === false
        ? {}
        : {
            comboRunnerDesktop: {
              pickDirectory: async () => null,
              openEditor: async (value: { editor: string; path: string }) => {
                editors.push({ ...value });
                return options.editorStatus ?? 'ok';
              },
              revealPath: async (path: string) => {
                revealed.push(path);
                return options.nativeReveal?.(path) ?? options.nativeStatus ?? 'ok';
              },
            },
          },
    document: { getSelection: () => ({ toString: () => selection }) },
  });
  let projectPath = options.projectPath;
  const render = () =>
    harness.render('ReplyPaths', {
      projectPath,
      api,
      notify: (notice: { tone: string; message: string }) => notices.push({ ...notice }),
      ref: opener,
      children: null,
    });
  let tree = render();
  const scope = () => {
    const node = findNode(tree, (node) => node.props?.className === 'reply-path-scope');
    assert.ok(node);
    return node;
  };
  const fire = async (element: ReturnType<typeof pathElement>, key?: string) => {
    let prevented = false;
    let stopped = false;
    const event = {
      target: element,
      currentTarget: { contains: () => true },
      key,
      preventDefault() {
        prevented = true;
      },
      stopPropagation() {
        stopped = true;
      },
    };
    if (key === undefined) scope().props.onClick(event);
    else scope().props.onKeyDown(event);
    await nextTurn();
    tree = render();
    return { prevented, stopped };
  };
  return {
    calls,
    revealed,
    editors,
    openEditor: async (element: unknown, editor: string) => {
      await opener.current!(element, editor);
      tree = render();
    },
    notices,
    fire,
    select: (value: string) => {
      selection = value;
    },
    node: (check: (node: UiNode) => boolean) => findNode(tree, check),
    refresh: async () => {
      await nextTurn();
      tree = render();
    },
    changeProject: (value: string) => {
      projectPath = value;
      tree = render();
    },
    unmount: () => harness.unmount(),
  };
}

test('absolute reply paths use native reveal without making a resolver or HTTP request', async () => {
  const ui = await fixture();
  assert.deepEqual(await ui.fire(pathElement('D:/fixture/图片/a.jpg')), { prevented: true, stopped: true });
  assert.deepEqual(ui.revealed, ['D:/fixture/图片/a.jpg']);
  assert.deepEqual(ui.calls, []);
  assert.deepEqual(ui.notices, []);
});

test('editor actions reuse relative resolution and retain the editor through ambiguous choices', async () => {
  const paths = ['D:/fixture/a/file.ts', 'D:/fixture/b/file.ts'];
  const ui = await fixture({ projectPath: 'D:/fixture', resolve: async () => ({ paths }) });
  await ui.openEditor(pathElement('file.ts', true, ['D:/fixture/a']), 'cursor');
  assert.deepEqual(ui.editors, []);
  assert.deepEqual(ui.calls, [
    { path: '/api/resolve-path', body: { path: 'file.ts', bases: ['D:/fixture/a'], projectPath: 'D:/fixture' } },
  ]);
  ui.node((node) => node.type === 'button' && node.props.children === paths[1])!.props.onClick();
  await ui.refresh();
  assert.deepEqual(ui.editors, [{ editor: 'cursor', path: paths[1] }]);
  assert.deepEqual(ui.revealed, []);
  await ui.openEditor(pathElement(paths[0]!), 'vscode');
  assert.equal(ui.calls.length, 1, 'absolute paths do not resolve again');
  assert.deepEqual(ui.editors.at(-1), { editor: 'vscode', path: paths[0] });
});

test('failed editor launches report the requested editor by name', async () => {
  for (const [editor, message] of [
    ['vscode', '没找到 VS Code'],
    ['cursor', '没找到 Cursor'],
  ]) {
    const ui = await fixture({ editorStatus: 'failed' });
    await ui.openEditor(pathElement('D:/fixture/file.ts'), editor!);
    assert.deepEqual(ui.notices, [{ tone: 'error', message }]);
  }
});

test('relative reply paths resolve against the project and full paths in the same reply', async () => {
  const ui = await fixture({
    projectPath: 'D:/fixture/project',
    resolve: async () => ({ path: 'D:/fixture/project/正片' }),
  });
  await ui.fire(pathElement('正片', true, ['D:/fixture/project/正文.md', 'D:/fixture/project/图片']));
  assert.deepEqual(ui.calls, [
    {
      path: '/api/resolve-path',
      body: {
        path: '正片',
        bases: ['D:/fixture/project/正文.md', 'D:/fixture/project/图片'],
        projectPath: 'D:/fixture/project',
      },
    },
  ]);
  assert.deepEqual(ui.revealed, ['D:/fixture/project/正片']);
});

test('ambiguous results wait for the user to select a full path', async () => {
  const choices = ['D:/fixture/first/图片', 'D:/fixture/second/图片'];
  const ui = await fixture({ resolve: async () => ({ paths: choices }) });
  await ui.fire(pathElement('图片', true));
  assert.deepEqual(ui.revealed, []);
  assert.ok(ui.node((node) => node.type === 'dialog'));
  const candidate = ui.node((node) => node.type === 'button' && node.props.children === choices[1]);
  assert.ok(candidate);
  candidate.props.onClick();
  await ui.refresh();
  assert.deepEqual(ui.revealed, [choices[1]]);
  assert.equal(
    ui.node((node) => node.type === 'dialog'),
    undefined,
  );
});

test('a truncated search with one candidate still requires selection', async () => {
  const path = 'D:/fixture/partial/图片';
  const ui = await fixture({ resolve: async () => ({ paths: [path], truncated: true }) });
  await ui.fire(pathElement('图片', true));
  assert.deepEqual(ui.revealed, []);
  assert.ok(ui.node((node) => node.type === 'dialog'));
  assert.ok(ui.node((node) => node.type === 'p' && String(node.props.children).includes('部分结果')));
  const candidate = ui.node((node) => node.type === 'button' && node.props.children === path);
  assert.ok(candidate);
  candidate.props.onClick();
  await ui.refresh();
  assert.deepEqual(ui.revealed, [path]);
});

test('selecting reply text suppresses path clicks and Enter or Space can activate a focused path', async () => {
  const ui = await fixture();
  const target = pathElement('D:/fixture/图片');
  ui.select('Selected path text');
  assert.deepEqual(await ui.fire(target), { prevented: false, stopped: false });
  assert.deepEqual(ui.revealed, []);
  ui.select('');
  assert.deepEqual(await ui.fire(target, 'Enter'), { prevented: true, stopped: true });
  assert.deepEqual(await ui.fire(target, ' '), { prevented: true, stopped: true });
  assert.deepEqual(await ui.fire(target, 'Escape'), { prevented: false, stopped: false });
  assert.deepEqual(ui.revealed, ['D:/fixture/图片', 'D:/fixture/图片']);
});

test('out-of-order resolution never opens the superseded path', async () => {
  const first = deferred<Resolution>();
  const second = deferred<Resolution>();
  let count = 0;
  const ui = await fixture({ resolve: () => (++count === 1 ? first.promise : second.promise) });
  await ui.fire(pathElement('旧目录', true));
  await ui.fire(pathElement('新目录', true));
  second.resolve({ path: 'D:/fixture/new' });
  await ui.refresh();
  first.resolve({ path: 'D:/fixture/old' });
  await ui.refresh();
  assert.deepEqual(ui.revealed, ['D:/fixture/new']);
  assert.deepEqual(ui.notices, []);
});

test('changing project or unmounting ignores pending resolution and errors', async () => {
  const stale = deferred<Resolution>();
  const ui = await fixture({ projectPath: 'D:/fixture/old', resolve: () => stale.promise });
  await ui.fire(pathElement('图片', true));
  ui.changeProject('D:/fixture/new');
  stale.resolve({ path: 'D:/fixture/old/图片' });
  await ui.refresh();
  assert.deepEqual(ui.revealed, []);

  const pending = deferred<Resolution>();
  const unmounted = await fixture({ resolve: () => pending.promise });
  await unmounted.fire(pathElement('图片', true));
  unmounted.unmount();
  pending.resolve({ path: 'D:/fixture/never-open' });
  await nextTurn();
  assert.deepEqual(unmounted.revealed, []);
  assert.deepEqual(unmounted.notices, []);

  const rejected = deferred<Resolution>();
  const failure = await fixture({ resolve: () => rejected.promise });
  await failure.fire(pathElement('图片', true));
  failure.unmount();
  rejected.reject(new Error('stale failure'));
  await nextTurn();
  assert.deepEqual(failure.notices, []);
});

test('missing native paths report the failure without opening or trying another path', async () => {
  const ui = await fixture({ nativeStatus: 'missing' });
  await ui.fire(pathElement('D:/fixture/missing.jpg'));
  assert.equal(ui.notices.length, 1);
  assert.equal(ui.notices[0]?.tone, 'error');
  assert.match(ui.notices[0]!.message, /找不到.*D:\/fixture\/missing.jpg/);
  assert.deepEqual(ui.calls, []);
});

test('when Electron is unavailable the shared reveal API is used', async () => {
  const ui = await fixture({ native: false });
  await ui.fire(pathElement('D:/fixture/图片'));
  assert.deepEqual(ui.revealed, []);
  assert.deepEqual(ui.calls, [{ path: '/api/reveal', body: { path: 'D:/fixture/图片' } }]);
  assert.deepEqual(ui.notices, []);
});

test('candidate reveal reports an active failure but ignores the same failure after unmount', async () => {
  const path = 'D:/fixture/selected/图片';
  for (const unmountBeforeFailure of [false, true]) {
    const pending = deferred<string>();
    const ui = await fixture({
      resolve: async () => ({ paths: [path], truncated: true }),
      nativeReveal: () => pending.promise,
    });
    await ui.fire(pathElement('图片', true));
    const candidate = ui.node((node) => node.type === 'button' && node.props.children === path);
    assert.ok(candidate);
    candidate.props.onClick();
    assert.deepEqual(ui.revealed, [path]);
    if (unmountBeforeFailure) ui.unmount();
    pending.reject(new Error('fixture native reveal failed'));
    await nextTurn();
    if (unmountBeforeFailure) assert.deepEqual(ui.notices, []);
    else {
      assert.equal(ui.notices.length, 1);
      assert.equal(ui.notices[0]?.tone, 'error');
      assert.match(ui.notices[0]!.message, /fixture native reveal failed/);
    }
  }
});
