import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultComposerSelection, loadComposerSelection, saveComposerSelection } from '../src/ui/composer-memory.ts';

function withStorage(run: (store: Map<string, string>) => void) {
  const store = new Map<string, string>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    },
  });
  try {
    run(store);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
}

test('a pinned executor and effort come back on the next start with a pinned or automatic model', () => {
  withStorage(() => {
    const pinned = {
      ...defaultComposerSelection,
      runtimeId: 'grok-b',
      model: 'grok-4.7',
      effort: 'high',
      mode: 'chat' as const,
    };
    saveComposerSelection('a', pinned);
    // Executor, model and effort come back; the task type starts as automatic again.
    assert.deepEqual(
      loadComposerSelection('a', (id) => id === 'grok-b'),
      { ...pinned, mode: 'auto' },
    );
    saveComposerSelection('a', { ...pinned, model: '' });
    assert.deepEqual(
      loadComposerSelection('a', (id) => id === 'grok-b'),
      { ...pinned, model: '', mode: 'auto' },
    );
  });
});

test('an executor that no longer exists falls back to automatic scheduling but keeps other preferences', () => {
  withStorage(() => {
    saveComposerSelection('a', {
      ...defaultComposerSelection,
      runtimeId: 'removed',
      model: 'm',
      effort: 'x',
      policy: 'cli-only',
    });
    assert.deepEqual(
      loadComposerSelection('a', () => false),
      { ...defaultComposerSelection, policy: 'cli-only' },
    );
  });
});

test('missing or corrupt storage yields the defaults', () => {
  withStorage((store) => {
    assert.deepEqual(
      loadComposerSelection('a', () => true),
      defaultComposerSelection,
    );
    store.set('comborunner.composer-selection.v1', '{not json');
    assert.deepEqual(
      loadComposerSelection('a', () => true),
      defaultComposerSelection,
    );
    store.set('comborunner.composer-selection.v1', JSON.stringify({ mode: 'bogus', permission: 'root' }));
    assert.deepEqual(
      loadComposerSelection('a', () => true),
      defaultComposerSelection,
    );
  });
});

test('all overrides are isolated by conversation and a new conversation starts automatic, writable and CLI-first', () => {
  withStorage(() => {
    const pinned = {
      ...defaultComposerSelection,
      runtimeId: 'mock',
      model: 'm',
      effort: 'high',
      permission: 'read-only' as const,
      policy: 'api-only' as const,
      review: true,
    };
    saveComposerSelection('a', pinned);
    assert.deepEqual(
      loadComposerSelection('a', () => true),
      pinned,
    );
    assert.deepEqual(
      loadComposerSelection('b', () => true),
      defaultComposerSelection,
    );
    assert.deepEqual(
      loadComposerSelection(undefined, () => true),
      defaultComposerSelection,
    );
    assert.deepEqual(
      loadComposerSelection('just-created', () => true, new Date(Date.now() + 1000).toISOString()),
      defaultComposerSelection,
    );
    saveComposerSelection('b', { ...defaultComposerSelection, policy: 'cli-only' });
    assert.deepEqual(
      loadComposerSelection('a', () => true),
      pinned,
    );
  });
});

test('legacy device overrides migrate only to the open existing conversation and retain the old snapshot', () => {
  withStorage((store) => {
    const legacy = {
      ...defaultComposerSelection,
      runtimeId: 'mock',
      model: 'm',
      effort: 'high',
      permission: 'read-only' as const,
      policy: 'api-only' as const,
      review: true,
    };
    const raw = JSON.stringify(legacy);
    store.set('comborunner.composer-selection.v1', raw);
    assert.deepEqual(
      loadComposerSelection('fresh-id', () => true, new Date(Date.now() + 1000).toISOString()),
      defaultComposerSelection,
    );
    assert.deepEqual(
      loadComposerSelection(undefined, () => true),
      defaultComposerSelection,
    );
    assert.deepEqual(
      loadComposerSelection('open', () => true),
      legacy,
    );
    assert.deepEqual(
      loadComposerSelection('other', () => true),
      defaultComposerSelection,
    );
    assert.deepEqual(
      loadComposerSelection('open', () => true),
      legacy,
    );
    assert.equal(store.get('comborunner.composer-selection.v1'), raw);
    assert.equal(store.get('comborunner.composer-selection.v1.owner'), 'open');
  });
});

test('saved conversation choices take precedence over legacy choices, and newly created conversations cannot claim them', () => {
  withStorage((store) => {
    store.set('comborunner.composer-selection.v1', JSON.stringify({ ...defaultComposerSelection, policy: 'api-only' }));
    saveComposerSelection('created', defaultComposerSelection);
    assert.deepEqual(
      loadComposerSelection('created', () => true),
      defaultComposerSelection,
    );
    assert.equal(loadComposerSelection('old', () => true).policy, 'api-only');
  });
});

test('legacy save-money overrides are ignored and disappear when composer choices are saved', () => {
  withStorage((store) => {
    for (const saveMoney of [true, false]) {
      const key = `comborunner.composer-selection.v2:legacy-${saveMoney}`;
      store.set(key, JSON.stringify({ ...defaultComposerSelection, saveMoney, policy: 'cli-only' }));
      const selection = loadComposerSelection(`legacy-${saveMoney}`, () => true);
      assert.deepEqual(selection, { ...defaultComposerSelection, policy: 'cli-only' });
      assert.equal('saveMoney' in selection, false);
      saveComposerSelection(`legacy-${saveMoney}`, selection);
      assert.equal('saveMoney' in JSON.parse(store.get(key)!), false);
    }
  });
});
