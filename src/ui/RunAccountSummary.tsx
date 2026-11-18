import type { CSSProperties } from 'react';
import type { RunRecord } from '../shared/types';

const note: CSSProperties = { color: 'var(--muted)', fontSize: 12, lineHeight: 1.8 };
const relayReasons: Record<NonNullable<RunRecord['relay']>['reason'], string> = {
  quota: '原账号额度受限',
  authentication: '原账号认证被拒绝',
  content: '原执行器未处理这类内容',
  technical: '原执行器出现技术故障',
  selection: '执行器已切换',
};

export function RunAccountSummary({ run, fromLabel }: { run: RunRecord; fromLabel?: string }) {
  if (!run.account && !run.relay && !run.toolless) return null;
  return (
    <div aria-label="执行账号与接力" style={{ ...note, padding: '10px 0', overflowWrap: 'anywhere' }}>
      {run.toolless && (
        <p>
          <strong>纯聊天（不读文件）</strong>
          ：任务里有别人写的消息，执行器没有任何文件、搜索、命令、网页或扩展工具，只根据收到的文字回答。
        </p>
      )}
      {run.account && (
        <p>
          <strong>使用账号：{run.account.label}</strong>
        </p>
      )}
      {run.relay?.notice && (
        <p>
          <strong>{run.relay.notice}</strong>
        </p>
      )}
      {run.relay && (
        <p>
          账号接力：{fromLabel || run.relay.fromRuntimeId} → {run.account?.label || run.route.runtimeId} ·{' '}
          {relayReasons[run.relay.reason] ?? '原因未报告'} ·{' '}
          <span title={run.relay.fromRunId}>来源任务 {run.relay.fromRunId.slice(0, 8)}</span>
        </p>
      )}
    </div>
  );
}
