import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseLearningReport,
  readLearningReport,
  groupLearningEntries,
  deleteRetainedEtl,
} from '../src/server/sandbox/learning-report.ts';
import { LearningStore } from '../src/server/sandbox/learning-store.ts';
import { desktopPermissionChange } from '../src/server/permission-change.ts';
import type { Workspace } from '../src/server/workspace.ts';

test('learning confirmation shows only added grants and caps its list at twenty', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sandbox-confirm-test-'));
  try {
    const store = new LearningStore(directory);
    const report = parseLearningReport({
      denials: Array.from({ length: 24 }, (_, i) => ({
        resource: `C:/synthetic/${i}`,
        resourceType: i === 1 ? 'network' : 'file',
        accessType: ['Read', 'Connect', 'Write', 'Execute'][i % 4],
      })),
    });
    store.record({ provider: 'pi', observedAt: 'synthetic', groups: [], ...report });
    await store.adopt('pi', [report.entries[0].id]);
    const workspace = { controller: { sandboxLearning: store } } as unknown as Workspace;
    const description = await desktopPermissionChange(
      workspace,
      {
        kind: 'sandbox-adopt',
        provider: 'pi',
        ids: report.entries.map((entry) => entry.id),
      },
      false,
    );
    assert.equal(description.split('\n').length, 23);
    assert.ok(!description.includes('C:/synthetic/0（'));
    assert.match(description, /C:\/synthetic\/1（网络）/);
    assert.match(description, /C:\/synthetic\/2（写）/);
    assert.match(description, /C:\/synthetic\/3（执行）/);
    assert.match(description, /C:\/synthetic\/4（读）/);
    assert.ok(description.endsWith('另有 3 项'));
    assert.equal(
      await desktopPermissionChange(
        workspace,
        {
          kind: 'sandbox-adopt',
          provider: 'pi',
          ids: [report.entries[0].id],
        },
        false,
      ),
      '',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('learning rows are validated, deduplicated by resource/access, capped and grouped', () => {
  const rows = [
    { resource: 'C:\\Tools\\one', resourceType: 'File', accessType: 'Read', pid: 42 },
    { resource: 'C:\\Tools\\one', resourceType: 'File', accessType: 'Read', pid: 43 },
    { resource: 'C:\\Tools\\one', resourceType: 'File', accessType: 'Write' },
    { resource: 'C:\\Tools\\two', resourceType: 'File', accessType: 'Execute' },
    { resource: '192.0.2.1:443', resourceType: 'Network', accessType: 'Connect' },
    { resource: null },
  ];
  const report = parseLearningReport({ denials: rows });
  assert.equal(report.entries.length, 4);
  assert.ok(!JSON.stringify(report).includes('pid'));
  const groups = groupLearningEntries(report.entries);
  assert.deepEqual([groups[0].label, groups[0].read, groups[0].write, groups[0].execute], ['C:\\Tools', 1, 1, 1]);
  assert.equal(groups[1].label, '192.0.2.1:443');
  assert.deepEqual(
    [parseLearningReport({ denials: rows }, 2).entries.length, parseLearningReport({ denials: rows }, 2).truncated],
    [2, true],
  );
  const large = parseLearningReport({
    denials: Array.from({ length: 10002 }, (_, i) => ({
      resource: `C:\\test\\${i}`,
      accessType: 'Read',
      resourceType: 'File',
    })),
  });
  assert.equal(large.entries.length, 10000);
  assert.equal(large.truncated, true);
});
test('read reports, remove retained ETL even on parse failure, and persist only checked observed entries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sandbox-report-test-'));
  try {
    const row = { resource: '192.0.2.1:443', resourceType: 'network', accessType: 'connect' };
    await writeFile(join(directory, 'denials.json'), JSON.stringify({ denials: [row] }));
    await writeFile(join(directory, 'retained.etl'), 'synthetic');
    const report = await readLearningReport(directory, 'pi');
    await assert.rejects(access(join(directory, 'retained.etl')));
    const store = new LearningStore(directory);
    store.record(report);
    store.record(report);
    assert.equal(store.list()[0].entries.length, 1);
    await assert.rejects(store.adopt('../escape', [report.entries[0].id]));
    await assert.rejects(store.adopt('pi', ['unobserved']));
    assert.deepEqual(await store.adopt('pi', [report.entries[0].id]), { adopted: 1 });
    const saved = JSON.parse(await readFile(join(directory, 'sandbox', 'policies', 'pi.json'), 'utf8'));
    assert.deepEqual(saved.entries, report.entries);
    await writeFile(join(directory, 'denials.json'), '{');
    await writeFile(join(directory, 'failed.etl'), 'synthetic');
    await assert.rejects(readLearningReport(directory, 'pi'));
    await assert.rejects(access(join(directory, 'failed.etl')));
    const etl = join(directory, 'metadata.etl');
    await writeFile(etl, 'synthetic');
    await deleteRetainedEtl({ captureDenialsError: { message: 'fixture', etlPath: etl } });
    await assert.rejects(access(etl));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('HTTP learning adoption only keeps or removes existing grants and rechecks at the commit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sandbox-narrowing-test-'));
  try {
    const store = new LearningStore(directory);
    const report = parseLearningReport({
      denials: [
        { resource: 'C:/synthetic/one', resourceType: 'file', accessType: 'read' },
        { resource: 'C:/synthetic/two', resourceType: 'file', accessType: 'write' },
      ],
    });
    store.record({ provider: 'pi', observedAt: 'synthetic', groups: [], ...report });
    const ids = report.entries.map((entry) => entry.id);
    assert.throws(() => store.assertAdoptNarrowing('pi', ids), { status: 403 });
    await store.adopt('pi', ids);
    store.assertAdoptNarrowing('pi', ids);
    await store.adopt('pi', [ids[0]], true);
    assert.throws(() => store.assertAdoptNarrowing('pi', ids), { status: 403 });
    await assert.rejects(store.adopt('pi', ids, true), { status: 403 });
    const saved = JSON.parse(await readFile(join(directory, 'sandbox', 'policies', 'pi.json'), 'utf8'));
    assert.deepEqual(
      saved.entries.map((entry: { id: string }) => entry.id),
      [ids[0]],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('stale and invalid learning selections show an actionable error', () => {
  const store = new LearningStore('synthetic-unused');
  for (const [provider, ids] of [
    ['invalid', []],
    ['pi', []],
    ['pi', ['stale']],
  ] as const) {
    assert.throws(() => store.selection(provider, [...ids]), { message: '学习记录已变化，请刷新后重试。' });
  }
});
