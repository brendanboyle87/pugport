import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { safeToolEventText } from '../shared/tool-event-data.ts';
import type { Conversation, RunRecord, Workflow } from '../shared/types.ts';
import { buildHandoffNote, type HandoffMeasured } from './handoff-note.ts';
import type { LaneEvent } from './lane-events.ts';

export type LaneGithubFacts = {
  pushedSha?: string;
  pr?: { number: number; url?: string; repository?: string };
  prSource?: 'audit' | 'monitor';
  merged?: { number: number; method?: string };
};
export function laneGithubFacts(
  runs: RunRecord[],
  jobs: Array<{ pullRequest?: { repository: string; number: number } }>,
): LaneGithubFacts {
  const selected = new Map<string, { phase: string; data: Record<string, unknown> }>();
  for (const run of runs)
    for (const event of run.events ?? []) {
      const data = event.data;
      if (
        data?.source !== 'pugport' ||
        data.kind !== 'github-write' ||
        !['push', 'open', 'merge'].includes(String(data.op)) ||
        !['readback', 'executed'].includes(String(data.phase))
      )
        continue;
      const key = String(data.op),
        phase = String(data.phase),
        previous = selected.get(key);
      if (phase === 'readback' || previous?.phase !== 'readback') selected.set(key, { phase, data });
    }
  const push = selected.get('push')?.data,
    open = selected.get('open')?.data,
    merge = selected.get('merge')?.data;
  const monitor = jobs.find((job) => job.pullRequest)?.pullRequest;
  return {
    ...(typeof push?.sha === 'string' ? { pushedSha: push.sha } : {}),
    ...(typeof open?.number === 'number'
      ? {
          pr: {
            number: open.number,
            ...(typeof open.url === 'string' ? { url: open.url } : {}),
            ...(typeof open.repository === 'string' ? { repository: open.repository } : {}),
          },
        }
      : monitor
        ? { pr: monitor }
        : {}),
    ...(typeof open?.number === 'number'
      ? { prSource: 'audit' as const }
      : monitor
        ? { prSource: 'monitor' as const }
        : {}),
    ...(typeof merge?.number === 'number'
      ? { merged: { number: merge.number, ...(typeof merge.method === 'string' ? { method: merge.method } : {}) } }
      : {}),
  };
}
export type LaneHandoverInput = {
  lane: Conversation;
  workflow: Workflow;
  runs: RunRecord[];
  measured?: HandoffMeasured;
  github: LaneGithubFacts;
  events: LaneEvent[];
  resultPath?: string;
  projectPath: string;
  now: string;
};
export function buildLaneHandover(input: LaneHandoverInput): string {
  const { lane, workflow, runs, measured, github, events } = input;
  const safe = (value: unknown) => safeToolEventText(String(value ?? '无记录'), 1000).replace(/[\r\n]+/g, ' ');
  const checks = runs.flatMap((run) =>
    run.verification
      ? [
          `${safe(run.verification.command)} ${run.verification.status}（退出码 ${run.verification.exitCode ?? '无记录'}）`,
        ]
      : [],
  );
  const outcome = runs
    .map((run) => run.taskOutcome)
    .filter((value) => value && ['partial', 'blocked'].includes(value.status))
    .map((value) => safe(value?.summary));
  const heading = [
    `# 工作线交接单：${safe(lane.title)}`,
    `生成：${safe(input.now)} · 工作线 ${safe(lane.id)} · 本轮 ${safe(workflow.id)} · 结果：${safe(workflow.status)}`,
    `分支：${safe(workflow.executionWorkspace?.branch ?? lane.lane?.branch)} · 基线：${safe((measured?.startHead ?? lane.lane?.baseCommit)?.slice(0, 7))} · 当前 HEAD：${safe(measured?.head?.slice(0, 7))} · 未提交文件：${safe(measured?.statusTotal)}`,
    `PR：${github.pr ? `#${github.pr.number} ${safe(github.pr.url)} ${safe(github.pr.repository)}` : '无记录'} · 已推送：${safe(github.pushedSha)} · 已合并：${github.merged ? `#${github.merged.number} ${safe(github.merged.method)}` : '无记录'} · issue：无记录`,
    `跑过的检查：${checks.join('；') || '无记录'}`,
    `未决问题及下一步（自述，未核验）：${outcome.join('；') || '无记录'}`,
    `本轮结果全文：${safe(input.resultPath)}`,
    `最近事件：${events.map((event) => `${safe(event.at)} ${safe(event.type)} ${safe(event.reason ?? event.status ?? '')}`).join('；') || '无记录'}`,
    measured?.unavailable ? `实测状态：${safe(measured.unavailable)}` : '',
    '---',
    buildHandoffNote({
      request: workflow.input.content ?? '',
      reason: '工作线结算',
      runs,
      measured,
      projectPath: input.projectPath,
      omit: { recent: true, output: true, pointers: true },
    }),
  ]
    .filter(Boolean)
    .join('\n');
  const bytes = Buffer.from(heading);
  return bytes.length <= 8192
    ? heading
    : bytes
        .subarray(0, 8189)
        .toString('utf8')
        .replace(/\uFFFD$/, '') + '…';
}
export function writeLaneHandover(dataDir: string | undefined, laneId: string, text: string): string | undefined {
  if (!dataDir || !/^[\w-]{1,80}$/.test(laneId)) return undefined;
  try {
    const dir = join(dataDir, 'member-results', laneId);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'handover.md');
    writeFileSync(path, text);
    return path;
  } catch {
    return undefined;
  }
}
