import type { MediaAnalysisResume, MediaEvidence, MediaStep } from './media-analysis.ts';

export type MediaExecution = {
  requestedEngine: 'auto' | 'gemma' | 'legacy';
  actualEngine?: 'gemma' | 'legacy';
  modelId?: string;
  topK: number;
  videoSampleSeconds: number;
  retrievalMode?: 'adaptive' | 'full-index';
  ioConcurrency?: number;
  backend?: 'cpu' | 'gpu';
};

/** The selected engine is not proof that it actually ran; labels follow the persisted actual engine. */
export function mediaDisplaySteps(
  steps: MediaStep[],
  execution?: MediaExecution,
  resume?: MediaAnalysisResume,
): MediaStep[] {
  return steps.map((step) => {
    if (step.key === 'scan' && resume)
      return { ...step, label: '核对已保存的文件清单', note: `已保存 ${resume.savedFingerprints} 份指纹记录` };
    if (step.key === 'coarse')
      return {
        ...step,
        label:
          execution?.retrievalMode === 'adaptive'
            ? '本地指纹预筛（视频抽 6 帧）'
            : execution?.actualEngine === 'gemma'
              ? `建立 EmbeddingGemma 图文索引（视频约每 ${execution.videoSampleSeconds} 秒取样）`
              : execution?.actualEngine === 'legacy'
                ? '原有指纹筛选（视频抽 6 帧）'
                : '准备本地图文检索',
      };
    if (step.key === 'pairs' && execution?.retrievalMode === 'adaptive')
      return {
        ...step,
        label:
          execution.actualEngine === 'gemma'
            ? '筛选疑似组合（EmbeddingGemma 辅助排序）'
            : `筛选疑似组合（每文件最多 ${execution.topK} 个）`,
      };
    if (step.key === 'pairs' && execution?.actualEngine === 'gemma')
      return { ...step, label: `向量筛选相似候选（每文件最多 ${execution.topK} 个）` };
    return { ...step };
  });
}

export function mediaEngineTitle(execution?: MediaExecution): string {
  const hardware = execution?.backend === 'gpu' ? '（GPU）' : execution?.backend === 'cpu' ? '（CPU）' : '';
  if (execution?.retrievalMode === 'adaptive')
    return execution.actualEngine === 'gemma'
      ? `本地媒体比对 · 指纹 + EmbeddingGemma${hardware}`
      : '本地媒体比对 · 快速预筛';
  return execution?.actualEngine === 'gemma'
    ? `本地媒体比对 · EmbeddingGemma${hardware}`
    : execution?.actualEngine === 'legacy'
      ? '本地媒体比对 · 原有指纹'
      : '本地媒体比对';
}

/** Describe the sampled evidence without upgrading it to a complete-content or deletion proof. */
export function mediaEvidenceTitle(evidence: MediaEvidence): string {
  if (evidence.visual?.sampledContainment?.kind === 'sampled-contained') return '短片整段抽样匹配';
  return {
    'exact-bytes': '逐字节相同',
    'image-candidate': '相似图片候选',
    'sampled-full-span': '整段抽样一致',
    'partial-overlap': '部分画面重叠',
  }[evidence.classification];
}

export function mediaEvidenceSampleLabel(evidence: MediaEvidence): string | undefined {
  const visual = evidence.visual;
  if (!visual) return undefined;
  const containment = visual.sampledContainment;
  if (containment?.kind === 'sampled-contained')
    return `${containment.contained === 'a' ? '第一份' : '第二份'}短片 ${containment.matchedSamples}/${containment.plannedSamples} 个采样位置匹配；尚未核验采样之间的画面、音轨、字幕和实际画质。`;
  return `${visual.matches}/${visual.fineCheck?.planned ?? visual.samplesA} 个采样位置匹配；采样命中率不代表完整内容覆盖率。`;
}

/** Compatibility scalar; live jobs use ProgressEstimateTracker's recent-window ranges. */
export function mediaRemainingSeconds(step: MediaStep, elapsedSeconds: number, progressed: number): number | undefined {
  if (
    step.state !== 'running' ||
    !step.total ||
    elapsedSeconds < 60 ||
    progressed < 20 ||
    step.done / step.total < 0.03
  )
    return undefined;
  return Math.max(0, Math.round(((step.total - step.done) * elapsedSeconds) / progressed));
}
