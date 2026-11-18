import type { RunRecord } from '../shared/types';

/** Only report protocol-confirmed delivery state; streamed text is not proof that a correction was applied. */
export function SteeringProgress({ run }: { run: RunRecord }) {
  const progress = run.steeringProgress;
  if (!progress) return null;
  const label =
    progress.phase === 'sending'
      ? progress.mode === 'interrupt'
        ? '正在切换到补充消息…'
        : '正在向执行器发送补充…'
      : progress.phase === 'received'
        ? '执行器已接收补充，等待后续输出。'
        : progress.phase === 'resuming'
          ? '已开始处理补充，后续输出会继续显示。'
          : '补充投递失败，请核对当前任务。';
  return (
    <p className="steering-status" role={progress.phase === 'failed' ? 'alert' : 'status'}>
      {label}
    </p>
  );
}
