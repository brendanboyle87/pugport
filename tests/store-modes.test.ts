import assert from 'node:assert/strict';
import test from 'node:test';
import { compareModVersions, selectStoreModes } from '../src/shared/store-modes.ts';
import type { ConversationModesView, ModeCatalogEntry } from '../src/shared/conversation-modes.ts';
import type { ModeSourceView } from '../src/shared/mode-source.ts';
const mode = (version: string): ModeCatalogEntry => ({
  schemaVersion: 1,
  id: 'fixture.mod',
  version,
  title: version,
  description: 'Synthetic',
  compatible: true,
});
const data = (versions: string[], installed?: string): ConversationModesView => ({
  catalog: versions.map(mode),
  installed: installed ? [{ modeId: 'fixture.mod', version: installed, installedAt: '' }] : [],
});
const source = (versions: string[]) =>
  ({
    config: { enabled: true, repository: 'fixture/mods' },
    revision: 'revision',
    catalog: versions.map(mode),
  }) as ModeSourceView;
test('local old plus remote new selects latest metadata and retains installation', () => {
  const result = selectStoreModes(data(['0.2.1'], '0.2.1'), source(['0.2.14'])).get('fixture.mod')!;
  assert.equal(result.mode.title, '0.2.14');
  assert.equal(result.updateAvailable, true);
  assert.equal(result.local, false);
  assert.equal(result.installation?.version, '0.2.1');
});
test('local newer and equal remote versions retain local routing', () => {
  for (const remote of ['0.3.2', '0.3.12']) {
    const result = selectStoreModes(data(['0.3.12'], '0.3.12'), source([remote])).get('fixture.mod')!;
    assert.equal(result.mode.version, '0.3.12');
    assert.equal(result.local, true);
    assert.equal(result.updateAvailable, false);
  }
});
test('multiple versions collapse by id using numeric comparison', () => {
  const result = selectStoreModes(data(['1.9.9', '2.0.0', '1.10.0'], '1.9.9'), source(['2.0.12', '2.0.2']));
  assert.equal(result.size, 1);
  assert.equal(result.get('fixture.mod')?.mode.version, '2.0.12');
});
test('invalid versions cannot displace a release and remain stable when all are invalid', () => {
  for (const invalid of ['bad', '1.2', '1.2.3-beta', '01.2.3', '-1.2.3', '1.2.3.4']) {
    assert.equal(compareModVersions(invalid, '0.0.0'), -1);
    assert.equal(
      selectStoreModes(data([invalid, '1.0.0']), source([invalid])).get('fixture.mod')?.mode.version,
      '1.0.0',
    );
  }
  assert.equal(compareModVersions('bad', 'worse'), 0);
  assert.equal(compareModVersions('999999999999999999999.0.0', '999999999999999999998.0.0'), 1);
});
test('uninstalled and refreshed catalogs derive status without retaining stale selections', () => {
  const local = data(['0.2.1']);
  assert.equal(selectStoreModes(local, source(['0.2.14'])).get('fixture.mod')?.updateAvailable, false);
  assert.equal(
    selectStoreModes(data(['0.2.1'], '0.2.1'), source(['0.2.14'])).get('fixture.mod')?.updateAvailable,
    true,
  );
  assert.equal(
    selectStoreModes(data(['0.2.1', '0.2.14'], '0.2.14'), source(['0.2.14'])).get('fixture.mod')?.updateAvailable,
    false,
  );
});
