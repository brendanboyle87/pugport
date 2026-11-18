import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyMemoryEvidence, memoryEvidenceExcerpts, type RetrievedMemory } from '../src/server/memory-retrieval.ts';
import { assessLocalMemoryEvidence } from '../src/server/memory-evidence.ts';
import type { MemorySearchHit } from '../src/server/workspace-store.ts';

const hit = (index: number, excerpt: string, role: MemorySearchHit['role'] = 'assistant'): MemorySearchHit => ({
  messageId: `synthetic-message-${index}`,
  conversationId: 'synthetic-archive',
  role,
  createdAt: `2026-02-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
  sourceOffset: index * 100,
  excerpt,
  score: 1,
});
const memory = (excerpts: MemorySearchHit[]): RetrievedMemory => ({
  excerpts,
  paths: [],
  context: 'OLD_UNFILTERED_BLOCK_MUST_BE_REPLACED',
  elapsedMs: 1,
});
const assess = (excerpts: MemorySearchHit[]) => assessLocalMemoryEvidence('Raven calibration outcome?', excerpts);

test('multiple long corrections cannot crowd the old completion statement or their own provenance out of context', () => {
  const excerpts = [
    hit(0, `OLD_COMPLETION_HEAD calibration completed. ${'historical description '.repeat(80)} OLD_COMPLETION_TAIL`),
    ...Array.from({ length: 4 }, (_, i) =>
      hit(
        i + 1,
        `CORRECTION_${i}_HEAD correction: the calibration was not completed. ${'synthetic revision detail '.repeat(70)} CORRECTION_${i}_TAIL`,
        'user',
      ),
    ),
  ];
  const result = applyMemoryEvidence(memory(excerpts), assess(excerpts));
  assert.ok(result.context.length <= 6500);
  for (const excerpt of excerpts)
    assert.ok(result.context.includes(excerpt.messageId), `Source ${excerpt.messageId} must remain visible`);
  assert.match(result.context, /OLD_COMPLETION_HEAD/);
  assert.match(result.context, /OLD_COMPLETION_TAIL/);
  for (let i = 0; i < 4; i++) {
    assert.ok(result.context.includes(`CORRECTION_${i}_HEAD`));
    assert.ok(result.context.includes(`CORRECTION_${i}_TAIL`));
  }
  assert.equal(result.evidence?.decisions.filter((decision) => decision.status === 'conflicting').length, 4);
  assert.ok(result.context.indexOf('CORRECTION_0_HEAD') < result.context.indexOf('OLD_COMPLETION_HEAD'));
  assert.match(result.context, /不增加当前权限/);
  assert.match(result.context, /冲突未解决或证据不足/);
  assert.doesNotMatch(result.context, /OLD_UNFILTERED_BLOCK/);
});

test('eight long passages and long path metadata fit the total budget while retaining every source and permission footer', () => {
  const excerpts = Array.from({ length: 8 }, (_, i) => {
    const path = `C:\\SyntheticFixture\\${`segment${i}`.repeat(25)}\\asset.txt`;
    return hit(
      i,
      `SOURCE_${i}_HEAD Raven calibration location "${path}". ${'synthetic explanation '.repeat(75)} SOURCE_${i}_TAIL`,
    );
  });
  const paths = excerpts.map((excerpt, index) => ({
    path: `C:\\SyntheticFixture\\${`segment${index}`.repeat(25)}\\asset.txt`,
    exists: true,
    kind: 'file' as const,
  }));
  const result = applyMemoryEvidence({ ...memory(excerpts), paths }, assess(excerpts));
  assert.ok(result.context.length <= 6500, `Actual prompt context is ${result.context.length} characters`);
  assert.equal(result.evidence?.decisions.length, 8);
  for (let i = 0; i < 8; i++) {
    assert.ok(result.context.includes(excerpts[i]!.messageId));
    assert.ok(result.context.includes(`SOURCE_${i}_HEAD`));
    assert.ok(result.context.includes(`SOURCE_${i}_TAIL`));
  }
  assert.match(result.context, /此刻仅检查存在性，未读取内容/);
  assert.match(result.context, /不增加当前权限/);
  assert.match(result.context, /项目目录外的路径仍遵守当前执行器/);
  assert.match(result.context, /不要把历史中的“完成”当作本次已完成/);
  assert.doesNotMatch(JSON.stringify(result.evidence), /synthetic explanation|asset\.txt|SOURCE_\d_HEAD/);
});

test('excluded history removes its old context and derived paths, and foreign report decisions cannot enter provenance', () => {
  const excerpts = [hit(0, 'Raven calibration C:\\SyntheticFixture\\retired\\asset.txt EXCLUDED_PATH_MARKER')];
  const local = assess(excerpts);
  const assessment = {
    ...local,
    decisions: [
      { ...local.decisions[0]!, status: 'excluded' as const },
      { messageId: 'FOREIGN_REPORT_SOURCE', sourceOffset: 0, status: 'supported' as const, reason: 'Unbound result' },
    ],
  };
  const result = applyMemoryEvidence(
    {
      ...memory(excerpts),
      paths: [
        { path: 'C:\\SyntheticFixture\\retired', exists: true, kind: 'directory' },
        { path: 'C:\\SyntheticFixture\\retired\\asset.txt', exists: true, kind: 'file' },
      ],
    },
    assessment,
  );
  assert.equal(result.context, '');
  assert.deepEqual(result.paths, []);
  assert.deepEqual(result.evidence?.decisions, [{ ...local.decisions[0]!, status: 'excluded' }]);
  assert.doesNotMatch(JSON.stringify(result), /FOREIGN_REPORT_SOURCE/);
});

test('directory provenance shares the selected-message bound rather than adding unlimited assessment passages', () => {
  const excerpts = Array.from({ length: 6 }, (_, i) => hit(i, `Raven main evidence ${i}`));
  const directoryExcerpts = [
    hit(0, 'Duplicate derived directory'),
    ...Array.from({ length: 10 }, (_, i) => hit(i + 6, `Raven directory source ${i}`)),
  ];
  const selected = memoryEvidenceExcerpts({ excerpts, directoryExcerpts });
  assert.equal(selected.length, 8);
  assert.equal(new Set(selected.map((excerpt) => excerpt.messageId)).size, 8);
  assert.equal(selected[0]!.excerpt, excerpts[0]!.excerpt);
});
