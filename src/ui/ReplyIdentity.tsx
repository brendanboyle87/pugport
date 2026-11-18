import type { ReplyExecutionIdentity } from '../shared/types';
import { effortName } from '../shared/effort';
import { shownName } from './i18n';

/** Reply provenance is saved with the message; live account/model picks never change this label. */
export function ReplyIdentity({ identity }: { identity?: ReplyExecutionIdentity }) {
  if (!identity?.automatic) return null;
  if (identity.kind === 'system') return <small className="reply-identity">PugPort 系统提示</small>;
  if (!identity.runs.length) return <small className="reply-identity">执行信息未记录</small>;
  const unique = [
    ...new Map(
      identity.runs.map((run) => [
        JSON.stringify([run.runtimeId, run.accountLabel, run.model, run.effort, run.confirmed]),
        run,
      ]),
    ).values(),
  ];
  return (
    <small className="reply-identity" aria-label="本条回复使用的执行器、模型和强度">
      {unique.map((run) => (
        <span
          key={run.runId}
          title={run.confirmed ? '配置由执行器报告；未报告的项目单独标注' : '启动配置；执行器未报告最终模型或强度'}
        >
          <span translate="no">{run.accountLabel ? shownName(run.accountLabel) : run.runtimeId}</span> · {run.model} ·{' '}
          {run.effort ? effortName(run.effort) : '强度未报告'}
          {!run.confirmed && <span className="reply-identity-source">（启动配置）</span>}
        </span>
      ))}
    </small>
  );
}
