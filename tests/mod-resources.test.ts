import assert from 'node:assert/strict';
import test from 'node:test';
import { savedModResources } from '../src/ui/ModResources.tsx';
import type { ConversationModesView } from '../src/shared/conversation-modes.ts';
import type { BankConnectionView, PlaidSettingsView } from '../src/shared/mod-data.ts';

test('saved resource entry appears only for bank resources or nonempty data without a loaded declaring Mod', () => {
  const empty = { catalog: [], installed: [] } as ConversationModesView;
  const mod = { id: 'fixture.finance', version: '1.0.0', permissions: ['connections:read', 'data:store'] };
  const loaded = { catalog: [mod], installed: [{ modeId: mod.id, version: mod.version }] } as ConversationModesView;
  const noKeys: PlaidSettingsView = {
    configured: false,
    environment: 'sandbox',
    sandboxSecret: false,
    productionSecret: false,
  };
  const data = [{ modId: mod.id, items: 1, bytes: 20 }];
  const bank = { id: 'fixture-bank', modIds: [mod.id] } as BankConnectionView & { modIds: string[] };
  assert.deepEqual(savedModResources(empty, noKeys, [], []), { banks: false, mods: [] });
  assert.deepEqual(savedModResources(empty, noKeys, [], [{ ...data[0]!, items: 0, bytes: 0 }]), {
    banks: false,
    mods: [],
  });
  for (const keys of [
    { configured: true },
    { clientIdEnding: '1234' },
    { sandboxSecret: true },
    { productionSecret: true },
  ]) {
    assert.equal(savedModResources(empty, { ...noKeys, ...keys }, [], []).banks, true);
    assert.equal(savedModResources(loaded, { ...noKeys, ...keys }, [], []).banks, false);
  }
  assert.deepEqual(savedModResources(loaded, noKeys, [bank], data), { banks: false, mods: [] });
  for (const modes of [
    empty,
    { ...loaded, installed: [] },
    { ...loaded, catalog: [{ ...loaded.catalog[0]!, permissions: [] }] },
    { ...loaded, installed: [{ modeId: mod.id, version: '2.0.0' }] } as ConversationModesView,
  ])
    assert.deepEqual(savedModResources(modes, noKeys, [bank], data), { banks: true, mods: data });
  assert.equal(savedModResources(loaded, noKeys, [{ ...bank, modIds: ['uninstalled.mod'] }], []).banks, true);
  assert.deepEqual(savedModResources(loaded, noKeys, [], [{ ...data[0]!, modId: 'uninstalled.mod' }]).mods, [
    { ...data[0]!, modId: 'uninstalled.mod' },
  ]);
});
