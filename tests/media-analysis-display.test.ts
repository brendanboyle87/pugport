import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mediaDisplaySteps,
  mediaEngineTitle,
  mediaRemainingSeconds,
  mediaEvidenceTitle,
  mediaEvidenceSampleLabel,
  type MediaExecution,
} from '../src/server/media-analysis-display.ts';
import type { MediaEvidence, MediaStep } from '../src/server/media-analysis.ts';

const steps: MediaStep[] = [
  {
    key: 'coarse',
    label: '粗筛：每个文件算指纹（视频抽 6 帧）',
    state: 'running',
    done: 2,
    total: 12958,
    note: '向量复用 0，本次计算 39',
  },
  { key: 'pairs', label: '找出可能重复的组合', state: 'pending', done: 0, total: null },
];
const selected: MediaExecution = { requestedEngine: 'gemma', topK: 8, videoSampleSeconds: 10 };

test('selecting Gemma before it starts does not claim that the model is running', () => {
  assert.equal(mediaEngineTitle(selected), '本地媒体比对');
  assert.equal(mediaDisplaySteps(steps, selected)[0].label, '准备本地图文检索');
});

test('actual Gemma displays its real interval and candidate count without old six-frame labels', () => {
  const execution = { ...selected, actualEngine: 'gemma' as const, modelId: 'fixture-model' };
  const result = mediaDisplaySteps(steps, execution);
  assert.match(mediaEngineTitle(execution), /EmbeddingGemma/);
  assert.match(result[0].label, /10 秒/);
  assert.doesNotMatch(result[0].label, /6 帧|原有指纹/);
  assert.match(result[1].label, /8 个/);
  assert.equal(result[0].done, 2);
  assert.equal(result[0].note, steps[0].note);
  assert.match(steps[0].label, /6 帧/, 'presentation does not mutate saved progress');
});

test('Gemma fallback displays the actual legacy engine instead of the requested model', () => {
  const execution = { ...selected, actualEngine: 'legacy' as const };
  assert.match(mediaEngineTitle(execution), /原有指纹/);
  assert.match(mediaDisplaySteps(steps, execution)[0].label, /原有指纹.*6 帧/);
});

test('adaptive progress distinguishes cheap fingerprints from actual model assistance', () => {
  const execution = { ...selected, retrievalMode: 'adaptive' as const, actualEngine: 'legacy' as const };
  assert.match(mediaDisplaySteps(steps, execution)[0].label, /本地指纹预筛/);
  assert.doesNotMatch(mediaEngineTitle(execution), /EmbeddingGemma/);
  const assisted = { ...execution, actualEngine: 'gemma' as const };
  assert.match(mediaDisplaySteps(steps, assisted)[1].label, /EmbeddingGemma 辅助排序/);
  assert.match(mediaDisplaySteps(steps, assisted)[0].label, /本地指纹预筛/);
});

test('old report hardware labels never infer a backend from selection', () => {
  assert.doesNotMatch(mediaEngineTitle(selected), /CPU|GPU/);
  assert.match(mediaEngineTitle({ ...selected, actualEngine: 'gemma', backend: 'gpu' }), /GPU/);
  assert.match(mediaEngineTitle({ ...selected, actualEngine: 'gemma', backend: 'cpu' }), /CPU/);
  assert.doesNotMatch(mediaEngineTitle({ ...selected, actualEngine: 'legacy', backend: 'gpu' }), /GPU/);
});

test('indexing a few long files never extrapolates a hundreds-of-hours estimate for a mixed drive', () => {
  assert.equal(mediaRemainingSeconds({ ...steps[0], done: 5 }, 930, 5), undefined);
  assert.equal(mediaRemainingSeconds({ ...steps[0], done: 5000 }, 600, 5000), 955);
  const compare: MediaStep = { key: 'compare', label: '核验', state: 'running', done: 100, total: 1000 };
  assert.equal(mediaRemainingSeconds(compare, 10, 100), undefined);
  assert.equal(mediaRemainingSeconds(compare, 60, 5), undefined);
  assert.equal(mediaRemainingSeconds(compare, 60, 100), 540);
});

test('resumed inventory is labelled as a fresh checklist check, separate from saved fingerprint records', () => {
  const scan: MediaStep = { key: 'scan', label: '列出文件', state: 'running', done: 100, total: null };
  const resumed = mediaDisplaySteps([scan], selected, {
    savedFiles: 12948,
    savedFingerprints: 2376,
    checkedFiles: 100,
    checkingFiles: true,
  })[0]!;
  assert.equal(resumed.label, '核对已保存的文件清单');
  assert.equal(resumed.done, 100, 'saved totals do not pretend the current inventory was validated');
  assert.equal(resumed.note, '已保存 2376 份指纹记录');
  assert.equal(mediaDisplaySteps([scan], selected)[0]!.label, '列出文件');
  assert.equal(scan.label, '列出文件', 'presentation does not mutate checkpoint steps');
});

test('contained short-clip samples have their own label without changing legacy classification or deletion flags', () => {
  const evidence: MediaEvidence = {
    a: 'fixture-short.mp4',
    b: 'fixture-long.mp4',
    classification: 'partial-overlap',
    deleteEligible: false,
    explanation: 'fixture',
    observedAt: '2026-10-08T00:00:00Z',
    stamps: [
      { size: 1, mtimeMs: 1, ctimeMs: 1, ino: 1 },
      { size: 2, mtimeMs: 1, ctimeMs: 1, ino: 2 },
    ],
    visual: {
      matches: 12,
      samplesA: 12,
      samplesB: 12,
      matchedFractionA: 1,
      matchedFractionB: 1,
      offsetSeconds: 30,
      spanA: [0, 10],
      spanB: [30, 40],
      positions: [],
      coverage: 'partial-overlap',
      sampledContainment: {
        kind: 'sampled-contained',
        contained: 'a',
        container: 'b',
        containedSpan: [0, 10],
        containerSpan: [30, 40],
        matchedSamples: 12,
        plannedSamples: 12,
        unverified: ['between-sample-frames', 'audio', 'subtitles', 'quality'],
      },
    },
  };
  assert.equal(mediaEvidenceTitle(evidence), '短片整段抽样匹配');
  assert.match(mediaEvidenceSampleLabel(evidence)!, /第一份短片 12\/12/);
  assert.match(mediaEvidenceSampleLabel(evidence)!, /尚未核验.*音轨.*实际画质/);
  assert.equal(evidence.classification, 'partial-overlap');
  assert.equal(evidence.deleteEligible, false);
  const legacy = { ...evidence, visual: { ...evidence.visual!, sampledContainment: undefined } };
  assert.equal(mediaEvidenceTitle(legacy), '部分画面重叠');
  assert.match(mediaEvidenceSampleLabel(legacy)!, /不代表完整内容覆盖率/);
});
