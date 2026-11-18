import { GitBranch } from 'lucide-react';
import type { TaskJudgment } from '../shared/task-judgment';

export function TaskJudgmentCard({ judgment }: { judgment?: TaskJudgment }) {
  if (!judgment || judgment.source !== 'local' || judgment.reason !== 'manual-selection') return null;
  return (
    <section className="task-judgment" aria-label="执行选择记录">
      <div className="judgment-heading">
        <strong>
          <GitBranch size={13} />
          手动选择 · 直接执行
        </strong>
      </div>
      <p>任务直接交给所选执行器；仍检查额度与文件权限，并携带当前对话上下文。</p>
    </section>
  );
}
