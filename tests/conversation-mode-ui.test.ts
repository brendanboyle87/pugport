import assert from 'node:assert/strict';
import test from 'node:test';
import { findNode, nextTurn, text, uiBundle, uiHarness } from './helpers/ui-harness.ts';

const hookCode = await uiBundle('src/ui/conversation-mode-session.ts');
const viewCode = await uiBundle('src/ui/ConversationModeView.tsx');
const binding = { instanceId: 'instance-a', modeId: 'fixture.notes', version: '1.0.0' };
const manifest = {
  schemaVersion: 2,
  id: binding.modeId,
  version: binding.version,
  title: 'Fixture notes',
  description: 'Synthetic',
  contributions: {
    rightPanel: {
      kind: 'form',
      form: {
        fields: [{ id: 'note', label: 'Note', type: 'textarea' }],
        actions: [{ id: 'ask', label: 'Compose', type: 'compose', prompt: 'Explain this note' }],
      },
    },
  },
};
const view = {
  binding,
  pending: null,
  installed: true,
  manifest,
  instance: {
    id: binding.instanceId,
    conversationId: 'A',
    modeId: binding.modeId,
    version: binding.version,
    schemaVersion: 1,
    revision: 0,
    state: { note: 'saved' },
    createdAt: '',
    updatedAt: '',
  },
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function hook() {
  const h = uiHarness(hookCode);
  h.exports.Harness = (props: any) => h.exports.useConversationMode(props.api, props.conversation);
  return h;
}

test('ordinary chat has no mode request; opening the selector lazily loads only local catalogue', async () => {
  const h = hook();
  const calls: string[] = [];
  const props = {
    api: async (path: string, _body: unknown, method: string) => {
      assert.equal(method, 'GET');
      calls.push(path);
      return { catalog: [], installed: [] };
    },
    conversation: { id: 'A' },
  };
  let result = h.render('Harness', props) as any;
  await nextTurn();
  assert.deepEqual(calls, []);
  await result.loadCatalog();
  result = h.render('Harness', props);
  assert.deepEqual(calls, ['/api/modes']);
  assert.equal(result.catalog.catalog.length, 0);
  h.unmount();
});

test('optional catalog failures preserve the last valid catalog and never reject or lock the conversation', async () => {
  const h = hook();
  const valid = {
    catalog: [{ ...manifest, compatible: true }],
    installed: [{ modeId: binding.modeId, version: binding.version, installedAt: '' }],
  };
  let response: unknown = valid;
  let networkFailure = false;
  const props = {
    conversation: { id: 'A' },
    api: async (path: string, _body: unknown, method: string) => {
      if (method === 'PUT') return { ...view, binding: null, manifest: null, instance: null };
      assert.equal(path, '/api/modes');
      assert.equal(method, 'GET');
      if (networkFailure) throw new Error('Offline catalog');
      return response;
    },
  };
  let result = h.render('Harness', props) as any;
  await result.loadCatalog();
  result = h.render('Harness', props);
  const saved = result.catalog;
  assert.equal(saved.catalog[0].id, binding.modeId);
  for (const malformed of [
    null,
    [],
    {},
    { conversation: { id: 'A' } },
    { catalog: [], installed: null },
    { catalog: [null], installed: [] },
    { catalog: [], installed: [null] },
    { ...valid, catalog: [{ ...valid.catalog[0], compatible: false }] },
    { ...valid, catalog: [{ ...valid.catalog[0], icon: 'constructor' }] },
    { ...valid, installed: [{ modeId: binding.modeId }] },
  ]) {
    response = malformed;
    await assert.doesNotReject(result.loadCatalog());
    result = h.render('Harness', props);
    assert.equal(result.catalog, saved);
    assert.equal(result.loading, false);
    assert.equal(result.busy, false);
  }
  networkFailure = true;
  await assert.doesNotReject(result.loadCatalog());
  result = h.render('Harness', props);
  assert.equal(result.catalog, saved);
  assert.equal(result.loading, false);
  await assert.doesNotReject(result.select(null));
  result = h.render('Harness', props);
  assert.equal(result.view.binding, null);
  assert.equal(result.busy, false);
  h.unmount();
});

test('a malformed first catalog response leaves ordinary chat empty and a later valid retry recovers', async () => {
  const h = hook();
  let response: unknown = { conversation: { id: 'A' } };
  const props = { conversation: { id: 'A' }, api: async () => response };
  let result = h.render('Harness', props) as any;
  await assert.doesNotReject(result.loadCatalog());
  result = h.render('Harness', props);
  assert.equal(result.catalog, undefined);
  assert.equal(result.view, undefined);
  assert.equal(result.busy, false);
  response = { catalog: [], installed: [] };
  await result.loadCatalog();
  result = h.render('Harness', props);
  assert.equal(result.catalog.catalog.length, 0);
  assert.equal(result.loading, false);
  h.unmount();
});

test('a late mode load cannot replace a newer binding mutation', async () => {
  const old = deferred<any>();
  const h = hook();
  const props = {
    conversation: { id: 'A', modeBinding: binding },
    api: async (_path: string, _body: unknown, method: string) =>
      method === 'PUT' ? { ...view, binding: null, instance: null, manifest: null } : old.promise,
  };
  let result = h.render('Harness', props) as any;
  await result.select(null);
  old.resolve(view);
  await nextTurn();
  result = h.render('Harness', props);
  assert.equal(result.view.binding, null);
  h.unmount();
});

test('mode save keeps its conversation owner and revision even when navigation occurs during the request', async () => {
  const save = deferred<any>();
  const h = hook();
  const writes: any[] = [];
  const api = async (path: string, body: unknown, method: string) => {
    if (method === 'GET') return view;
    writes.push({ path, body });
    return save.promise;
  };
  const props = { api, conversation: { id: 'A', modeBinding: binding } };
  h.render('Harness', props);
  await nextTurn();
  let result = h.render('Harness', props) as any;
  const pending = result.save({ note: 'new' });
  const other = { api, conversation: { id: 'B' } };
  h.render('Harness', other);
  save.resolve({ ...view, instance: { ...view.instance, revision: 1 } });
  await assert.rejects(pending, /会话模式已变化/);
  result = h.render('Harness', other);
  assert.equal(result.view, undefined);
  assert.deepEqual(structuredClone(writes), [
    {
      path: '/api/conversations/A/mode-actions',
      body: { instanceId: binding.instanceId, expectedRevision: 0, action: { type: 'save', values: { note: 'new' } } },
    },
  ]);
  h.unmount();
});

test('compose saves the edited values first, only fills the caller composer and preserves failed input', async () => {
  for (const failure of [false, true]) {
    const h = uiHarness(viewCode);
    const saved: unknown[] = [],
      composed: string[] = [];
    const props = {
      view,
      busy: false,
      onStore() {},
      onSave: async (values: unknown) => {
        saved.push(values);
        if (failure) throw Error('revision-conflict');
      },
      onCompose: (value: string) => composed.push(value),
    };
    let tree = h.render('ModFormView', props);
    findNode(tree, (node) => node.type === 'textarea')!.props.onChange({ target: { value: 'edited' } });
    tree = h.render('ModFormView', props);
    findNode(tree, (node) => node.type === 'button' && text(node) === 'Compose')!.props.onClick();
    await nextTurn();
    tree = h.render('ModFormView', props);
    assert.equal((saved[0] as any).note, 'edited');
    assert.equal(composed.length, failure ? 0 : 1);
    if (!failure) assert.match(composed[0]!, /Explain this note\n\nNote:\nedited/);
    else assert.match(text(tree), /没能完成，请重试/);
    assert.equal(findNode(tree, (node) => node.type === 'textarea')!.props.value, 'edited');
    h.unmount();
  }
});

test('uninstalled mode is readable and can open the store without saving or composing', () => {
  const h = uiHarness(viewCode);
  let saves = 0,
    composes = 0,
    stores = 0;
  const props = {
    view: { ...view, installed: false },
    busy: false,
    onStore() {
      stores++;
    },
    onSave: async () => {
      saves++;
    },
    onCompose: () => composes++,
  };
  const tree = h.render('ModFormView', props);
  assert.match(text(tree), /模式已卸载/);
  assert.equal(findNode(tree, (node) => node.type === 'textarea')!.props.readOnly, true);
  assert.equal(
    findNode(tree, (node) => node.type === 'button' && text(node) === 'Compose'),
    undefined,
  );
  findNode(tree, (node) => node.type === 'form')!.props.onSubmit({ preventDefault() {} });
  assert.equal(saves + composes, 0);
  findNode(tree, (node) => node.type === 'button' && text(node) === '打开 Mods Store')!.props.onClick();
  assert.equal(stores, 1);
  h.unmount();
});

test("a delayed save cannot replace another window's newer mode binding", async () => {
  const h = hook();
  const save = deferred<any>();
  const newer = {
    ...view,
    binding: { ...binding, instanceId: 'instance-b' },
    instance: { ...view.instance, id: 'instance-b' },
  };
  let reads = 0;
  const api = async (_path: string, _body: unknown, method: string) =>
    method === 'GET' ? (++reads === 1 ? view : newer) : save.promise;
  const props = { api, conversation: { id: 'A', modeBinding: binding } };
  h.render('Harness', props);
  await nextTurn();
  const pending = (h.render('Harness', props) as any).save({ note: 'old edit' });
  const changed = { api, conversation: { id: 'A', modeBinding: newer.binding } };
  h.render('Harness', changed);
  await nextTurn();
  save.resolve(view);
  await assert.rejects(pending, /会话模式已变化/);
  assert.equal((h.render('Harness', changed) as any).view.instance.id, 'instance-b');
  h.unmount();
});

test('explicit reload after a revision conflict replaces the stale form values', async () => {
  const h = uiHarness(viewCode);
  const fresh = { ...view, instance: { ...view.instance, revision: 1, state: { note: 'saved in another window' } } };
  const props = {
    view,
    busy: false,
    error: 'revision-conflict',
    onStore() {},
    onSave: async () => {},
    onCompose() {},
    onReload: async () => fresh,
  };
  let tree = h.render('ModFormView', props);
  findNode(tree, (node) => node.type === 'textarea')!.props.onChange({ target: { value: 'stale draft' } });
  tree = h.render('ModFormView', props);
  findNode(tree, (node) => node.type === 'button' && text(node) === '重新读取模式状态')!.props.onClick();
  await nextTurn();
  tree = h.render('ModFormView', { ...props, view: fresh, error: undefined });
  assert.equal(findNode(tree, (node) => node.type === 'textarea')!.props.value, 'saved in another window');
  h.unmount();
});

test('visibility writes only its endpoint and keeps the mode view and unsaved form state untouched', async () => {
  const h = hook();
  const writes: any[] = [];
  const conversation: any = { id: 'A', modeBinding: binding };
  const api = async (path: string, body: any, method: string) => {
    if (method === 'GET') return view;
    writes.push({ path, body, method });
    return { ...conversation, ...(body.hidden ? { modeHidden: true } : {}) };
  };
  const props = { api, conversation };
  h.render('Harness', props);
  await nextTurn();
  let result = h.render('Harness', props) as any;
  const loaded = result.view;
  const hidden = await result.setHidden(true);
  assert.equal(hidden.modeHidden, true);
  result = h.render('Harness', { api, conversation: hidden });
  assert.equal(result.view, loaded);
  assert.equal(Object.hasOwn(result.view, 'hidden'), false, 'conversation is the only visibility source');
  const shown = await result.setHidden(false);
  assert.equal(shown.modeHidden, undefined);
  assert.deepEqual(structuredClone(writes), [
    { path: '/api/conversations/A/mode/visibility', body: { hidden: true }, method: 'PUT' },
    { path: '/api/conversations/A/mode/visibility', body: { hidden: false }, method: 'PUT' },
  ]);
  h.unmount();
});

test('visibility is single flight and a late result remains owned by the original conversation', async () => {
  const h = hook();
  const update = deferred<any>();
  const paths: string[] = [];
  const api = async (path: string, _body: unknown, method: string) => {
    if (method === 'GET') return view;
    paths.push(path);
    return update.promise;
  };
  const props = { api, conversation: { id: 'A', modeBinding: binding } };
  h.render('Harness', props);
  await nextTurn();
  const result = h.render('Harness', props) as any;
  const pending = result.setHidden(true);
  assert.equal((h.render('Harness', props) as any).busy, true);
  await assert.rejects(result.setHidden(false), /请等待模式操作完成/);
  const other = { api, conversation: { id: 'B' } };
  h.render('Harness', other);
  update.resolve({ ...props.conversation, modeHidden: true });
  assert.equal((await pending).id, 'A');
  const current = h.render('Harness', other) as any;
  assert.equal(current.view, undefined);
  assert.equal(current.busy, false);
  assert.deepEqual(paths, ['/api/conversations/A/mode/visibility']);
  h.unmount();
});

test('failed visibility writes release the operation gate and do not replace the loaded Mod', async () => {
  const h = hook();
  let fail = true;
  const conversation = { id: 'A', modeBinding: binding };
  const api = async (_path: string, _body: unknown, method: string) => {
    if (method === 'GET') return view;
    if (fail) throw Error('Synthetic visibility failure');
    return conversation;
  };
  const props = { api, conversation };
  h.render('Harness', props);
  await nextTurn();
  let result = h.render('Harness', props) as any;
  await assert.rejects(result.setHidden(true), /Synthetic visibility failure/);
  result = h.render('Harness', props);
  assert.equal(result.view, view);
  assert.equal(result.busy, false);
  assert.match(result.error, /Synthetic visibility failure/);
  fail = false;
  await result.setHidden(false);
  result = h.render('Harness', props);
  assert.equal(result.error, undefined);
  h.unmount();
});

test('normalized form renders field help and web entries wait for their runtime', () => {
  const h = uiHarness(viewCode);
  const form = manifest.contributions.rightPanel.form;
  const props = {
    view: {
      ...view,
      manifest: {
        ...manifest,
        contributions: {
          rightPanel: { kind: 'form', form: { ...form, fields: [{ ...form.fields[0], help: 'A short reminder' }] } },
        },
      },
    },
    busy: false,
    onSave: async () => {},
    onCompose() {},
    onStore() {},
  };
  assert.ok(
    findNode(h.render('ModFormView', props), (node) => node.type === 'small' && text(node) === 'A short reminder'),
  );
  const webView = {
    ...view,
    manifest: { ...manifest, contributions: { rightPanel: { kind: 'web', entry: 'panel' } } },
  };
  assert.equal(h.render('ModFormView', { ...props, view: webView }), null);
  h.unmount();
});

test('catalog metadata accepts legacy long titles without author and omits covers', () => {
  const h = uiHarness(hookCode);
  const result = h.exports.catalogResponse.safeParse({
    catalog: [
      {
        ...manifest,
        schemaVersion: 1,
        title: 'x'.repeat(100),
        compatible: true,
        cover: { src: 'unused', alt: 'unused' },
      },
    ],
    installed: [],
  });
  assert.equal(result.success, true);
  assert.equal(result.data.catalog[0].title.length, 100);
  assert.equal(result.data.catalog[0].author, undefined);
  assert.equal(result.data.catalog[0].cover, undefined);
  h.unmount();
});

test('form compose keeps additional state keys saved without including them in the draft', async () => {
  const h = uiHarness(viewCode);
  const saved: Record<string, string>[] = [],
    composed: string[] = [];
  const props = {
    view: {
      ...view,
      manifest: { ...manifest, state: { keys: [{ id: 'note' }, { id: 'counter' }] } },
      instance: { ...view.instance, state: { note: 'A note', counter: '4' } },
    },
    busy: false,
    onStore() {},
    onSave: async (values: Record<string, string>) => {
      saved.push(values);
    },
    onCompose: (value: string) => composed.push(value),
  };
  const tree = h.render('ModFormView', props);
  findNode(tree, (node) => node.type === 'button' && text(node) === 'Compose')!.props.onClick();
  await nextTurn();
  assert.deepEqual(structuredClone(saved), [{ note: 'A note', counter: '4' }]);
  assert.deepEqual(composed, ['Explain this note\n\nNote:\nA note']);
  h.unmount();
});

test('Web state writes retain the caller revision instead of silently using the latest view revision', async () => {
  const h = hook();
  const calls: any[] = [];
  const props = {
    conversation: { id: 'A', modeBinding: binding },
    api: async (path: string, body?: unknown) => {
      calls.push({ path, body });
      return structuredClone(view);
    },
  };
  try {
    h.render('Harness', props);
    await nextTurn();
    const result: any = h.render('Harness', props);
    await result.saveState(binding.instanceId, 17, { note: 'Web draft' });
    assert.deepEqual(JSON.parse(JSON.stringify(calls.find((c) => c.path.endsWith('/mode-actions')).body)), {
      instanceId: binding.instanceId,
      expectedRevision: 17,
      action: { type: 'save', values: { note: 'Web draft' } },
    });
  } finally {
    h.unmount();
  }
});

test('three Web slots can read state concurrently without the form mutation lock', async () => {
  const h = hook();
  const reads = [deferred<any>(), deferred<any>(), deferred<any>()];
  let count = 0;
  const props = {
    conversation: { id: 'A', modeBinding: binding },
    api: async () => (count++ === 0 ? view : reads[count - 2]!.promise),
  };
  try {
    h.render('Harness', props);
    await nextTurn();
    const result: any = h.render('Harness', props);
    const pending = [result.readState(), result.readState(), result.readState()];
    assert.equal(count, 4);
    for (const index of [2, 0, 1]) reads[index]!.resolve(structuredClone(view));
    const replies = await Promise.all(pending);
    assert.deepEqual(
      replies.map((value) => value.instance.revision),
      [0, 0, 0],
    );
    assert.equal((h.render('Harness', props) as any).busy, false);
  } finally {
    h.unmount();
  }
});

test('a delayed Web read cannot overwrite a completed sibling save and concurrent writes reach the server', async () => {
  const h = hook();
  const read = deferred<any>(),
    firstWrite = deferred<any>(),
    secondWrite = deferred<any>();
  let reads = 0;
  const writes: any[] = [];
  const props = {
    conversation: { id: 'A', modeBinding: binding },
    api: async (_path: string, body: any, method: string) => {
      if (method === 'GET') return reads++ === 0 ? view : read.promise;
      writes.push(body);
      return writes.length === 1 ? firstWrite.promise : secondWrite.promise;
    },
  };
  try {
    h.render('Harness', props);
    await nextTurn();
    const result: any = h.render('Harness', props);
    const stale = result.readState();
    const one = result.saveState(binding.instanceId, 0, { note: 'first' });
    const two = result.saveState(binding.instanceId, 0, { note: 'second' });
    assert.equal(writes.length, 2);
    assert.deepEqual(
      writes.map((write) => write.expectedRevision),
      [0, 0],
    );
    const fresh = { ...view, instance: { ...view.instance, revision: 1, state: { note: 'first' } } };
    firstWrite.resolve(fresh);
    await one;
    secondWrite.resolve(fresh);
    await two;
    read.resolve(view);
    assert.equal((await stale).instance.revision, 0);
    assert.equal((h.render('Harness', props) as any).view.instance.revision, 1);
    assert.equal((h.render('Harness', props) as any).view.instance.state.note, 'first');
  } finally {
    h.unmount();
  }
});

test('Web sibling write conflict remains the server error and never becomes a client busy error', async () => {
  const h = hook();
  const pending = deferred<any>();
  let writes = 0;
  const props = {
    conversation: { id: 'A', modeBinding: binding },
    api: async (_path: string, _body: unknown, method: string) => {
      if (method === 'GET') return view;
      if (++writes === 1) return pending.promise;
      throw new Error('State revision changed.');
    },
  };
  try {
    h.render('Harness', props);
    await nextTurn();
    const result: any = h.render('Harness', props);
    const first = result.saveState(binding.instanceId, 0, { note: 'first' });
    await assert.rejects(result.saveState(binding.instanceId, 0, { note: 'second' }), /State revision changed/);
    pending.resolve({ ...view, instance: { ...view.instance, revision: 1 } });
    await first;
    assert.equal(writes, 2);
  } finally {
    h.unmount();
  }
});

for (const removed of [true, false]) {
  test(`Web requests reject after binding ${removed ? 'removal' : 'replacement'}`, async () => {
    const h = hook();
    const pending = deferred<any>();
    const changedView = removed
      ? { ...view, binding: null, instance: null, manifest: null }
      : {
          ...view,
          binding: { ...binding, instanceId: 'replacement' },
          instance: { ...view.instance, id: 'replacement' },
        };
    let reads = 0;
    const api = async (_path: string, _body: unknown, method: string) => {
      if (method !== 'GET') return pending.promise;
      return reads++ === 0 ? view : reads === 2 ? pending.promise : changedView;
    };
    const props = { api, conversation: { id: 'A', modeBinding: binding } };
    try {
      h.render('Harness', props);
      await nextTurn();
      const result: any = h.render('Harness', props);
      const read = result.readState();
      const readRejected = assert.rejects(read, /Mod is unavailable/);
      const write = result.saveState(binding.instanceId, 0, { note: 'late' });
      const rejected = assert.rejects(write, /Mod is unavailable/);
      const changed = { api, conversation: { id: 'A', ...(removed ? {} : { modeBinding: changedView.binding }) } };
      h.render('Harness', changed);
      await nextTurn();
      pending.resolve({ ...view, instance: { ...view.instance, revision: 1 } });
      await Promise.all([rejected, readRejected]);
      const current: any = h.render('Harness', changed);
      assert.equal(current.view?.instance?.id, removed ? undefined : 'replacement');
    } finally {
      h.unmount();
    }
  });
}
