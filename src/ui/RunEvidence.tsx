import { currentLocale } from './i18n';
import type { RunRecord } from '../shared/types';
import { projectRunEvidence } from '../shared/run-evidence';

export function RunEvidence({ run }: { run: RunRecord }) {
  if (!run.endedAt && !run.verification) return null;
  const evidence = projectRunEvidence(run);
  const reported =
    evidence.reported === 'reported'
      ? '执行器报告已完成'
      : evidence.reported === 'failed'
        ? '执行器报告仍有未完成事项'
        : '执行器未提供完成报告';
  const checked =
    evidence.verification === 'verified'
      ? '该检查已通过'
      : evidence.verification === 'failed'
        ? '检查未通过'
        : evidence.verification === 'skipped'
          ? '检查已跳过'
          : evidence.verification === 'cancelled'
            ? '检查已取消'
            : run.verification?.status === 'passed'
              ? '检查通过，版本未确认'
              : '尚未验证';
  const receipt = evidence.receipt;
  return (
    <details className="run-evidence">
      <summary>完成依据 · {checked}</summary>
      <div className="run-evidence-body">
        <p>{reported}</p>
        {run.verification?.status === 'passed' && evidence.verification !== 'verified' && (
          <p>检查曾通过，文件版本尚未确认。</p>
        )}
        {receipt?.snapshot && (
          <p>
            检查对应的文件版本 <code title={receipt.snapshot}>{receipt.snapshot.slice(0, 12)}</code>
          </p>
        )}
        {receipt?.checkedAt && (
          <p>
            检查时间：
            <time dateTime={receipt.checkedAt}>{new Date(receipt.checkedAt).toLocaleString(currentLocale())}</time>
          </p>
        )}
        {receipt?.reused && <p>已复用相同文件版本的检查结果。</p>}
        {evidence.verification === 'verified' && <p>这项检查通过，不代表所有功能都已经验证。</p>}
      </div>
    </details>
  );
}
