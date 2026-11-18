import type { BackgroundTask } from './types.ts';

export type DesktopActivity = {
  running: number;
  localRunning?: number;
  localTitle?: string;
  localPhase?: string;
};

/** Include local work without exposing a filename, folder or search prompt in the OS title. */
export function localActivity(tasks: readonly BackgroundTask[]): {
  localRunning: number;
  localTitle?: string;
  localPhase?: string;
} {
  const active = tasks.filter((task) => task.state !== 'paused');
  if (!active.length) return { localRunning: 0 };
  const first = active.find((task) => task.kind === 'media-analysis') ?? active[0]!;
  const localTitle = first.kind === 'media-analysis' ? '本地媒体比对' : '后台找图';
  const localPhase = first.steps?.find((step) => step.state === 'running')?.label;
  return { localRunning: active.length, localTitle, ...(localPhase ? { localPhase } : {}) };
}

export function activityTone(activity: DesktopActivity): 'agent' | 'local' | 'idle' {
  return activity.running > 0 ? 'agent' : (activity.localRunning ?? 0) > 0 ? 'local' : 'idle';
}

export function activityLabel(activity: DesktopActivity, translate = (text: string) => text): string {
  const parts: string[] = [];
  if (activity.running > 0) parts.push(translate(`${activity.running} 个 Agent 运行中`));
  if ((activity.localRunning ?? 0) > 0) {
    const title = activity.localTitle || '本地任务';
    parts.push(
      translate((activity.localRunning ?? 0) > 1 ? `${translate(title)}等 ${activity.localRunning} 个本地任务` : title),
    );
  }
  return parts.join(' · ') || translate('空闲');
}
