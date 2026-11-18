import type { MemoryEvidenceReport } from '../shared/memory-evidence.ts';

const labels = {
  context: '上下文',
  supported: '支持',
  partial: '部分支持',
  conflicting: '冲突',
  'needs-current-check': '需当前核实',
  excluded: '已排除',
} as const;

/** Display only classification and provenance; model scores and private reasoning are not rendered. */
export function MemoryEvidenceCard({
  report,
  onJumpMessage,
  sourceMessageIds,
}: {
  report?: MemoryEvidenceReport;
  onJumpMessage?: (messageId: string) => void;
  sourceMessageIds?: ReadonlySet<string>;
}) {
  // Nothing was screened: a row of zeros tells the owner nothing.
  if (!report || report.source !== 'local' || report.status === 'fallback' || report.status === 'empty') return null;
  const count = (status: keyof typeof labels) => report.decisions.filter((item) => item.status === status).length;
  return (
    <details className="memory-evidence">
      <summary>
        历史证据筛选 · 本地筛选 · 支持 {count('supported')} · 部分支持 {count('partial')} · 冲突 {count('conflicting')}{' '}
        · 需当前核实 {count('needs-current-check')}
      </summary>
      <p className="quiet-text">历史证据分类仅供参考；当前文件与状态仍需核实。</p>
      <p className="quiet-text">
        请求 {report.requestCount} 次 · 缓存 {report.cachedCount} 条 · {report.elapsedMs} ms
      </p>
      {report.decisions.length > 0 && (
        <details>
          <summary>查看来源与分类 · {report.decisions.length} 条</summary>
          <ul>
            {report.decisions.map((decision, index) => (
              <li key={`${decision.messageId}:${decision.sourceOffset}:${index}`}>
                {onJumpMessage && sourceMessageIds?.has(decision.messageId) ? (
                  <button type="button" className="text-button" onClick={() => onJumpMessage(decision.messageId)}>
                    来源消息 {index + 1}
                  </button>
                ) : (
                  <span>
                    来源消息 {index + 1} · <code>{decision.messageId}</code>
                  </span>
                )}
                {' · '}
                {labels[decision.status]}
              </li>
            ))}
          </ul>
        </details>
      )}
    </details>
  );
}
