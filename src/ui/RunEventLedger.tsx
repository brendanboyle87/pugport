import { useEffect, useState } from 'react';
import type { RunEvent, RunRecord } from '../shared/types';
import { safeToolEventText, safeToolEventValue } from '../shared/tool-event-data';
import { TrajectoryDetailDialog } from './Trajectory';

const nativeFields = [
  'source',
  'kind',
  'status',
  'phase',
  'tool',
  'nativeTool',
  'title',
  'toolCallId',
  'nativeToolCallId',
  'nativePromptId',
  'nativeEventId',
  'itemId',
  'callId',
  'executor',
  'provider',
  'runtimeId',
  'transport',
  'outputMode',
  'observedPhase',
  'nativeMethod',
  'captureState',
  'observedFields',
  'failureDetail',
  'failureMessage',
  'durationMs',
  'startUnknown',
  'parentToolCallId',
  'partial',
  'resultObserved',
  'malformedErrorFlag',
  'resultMalformed',
  'apiProvider',
  'arguments',
  'input',
  'output',
  'result',
  'command',
  'cwd',
  'exitCode',
  'isError',
  'detail',
  'sessionId',
  'threadId',
  'nativeSessionId',
  'effectiveModel',
  'usage',
  'total',
  'scope',
  'cumulative',
  'baseline',
  'freshSession',
  'decision',
  'reason',
  'executionBlocked',
  'steeringPhase',
  'steeringId',
  'steeringMode',
] as const;
const usageFields = [
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'reasoningOutputTokens',
  'totalTokens',
  'estimatedCostUsd',
];
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** Inspect observed display fields, never serialize a whole native protocol envelope. */
export function diagnosticEvent(
  event: RunEvent,
  index: number,
): {
  sequence?: number;
  legacyPosition?: number;
  at: string;
  type: RunEvent['type'];
  text: string;
  textCharacters?: number;
  data: Record<string, unknown>;
} {
  const data = event.data ?? {};
  const admitted =
    data.source === 'pugport'
      ? data
      : Object.fromEntries(nativeFields.filter((key) => data[key] !== undefined).map((key) => [key, data[key]]));
  const safe = object(safeToolEventValue(admitted));
  if (event.type === 'usage')
    for (const key of usageFields)
      if (typeof data[key] === 'number' && Number.isFinite(data[key])) safe[key] = data[key];
  return {
    ...(event.seq !== undefined ? { sequence: event.seq } : { legacyPosition: index + 1 }),
    at: safeToolEventText(event.at),
    type: event.type,
    // Individual streamed fragments can split a credential. Inspect the redacted
    // contiguous model reply in Trajectory rather than exposing unsafe chunk boundaries.
    ...(event.type === 'text'
      ? { textCharacters: event.text?.length ?? 0, text: '模型文本增量；完整段落见轨迹中的模型回复。' }
      : { text: safeToolEventText(event.text ?? '') }),
    data: safe,
  };
}

const labels: Record<string, string> = {
  status: '状态',
  tool: '工具',
  text: '模型文本',
  usage: '用量',
  session: '会话',
  error: '错误',
  approval: '审批',
  quota: '额度',
};
export function RunEventLedger({
  run,
  onLoadFullAudit,
  loading = false,
}: {
  run: RunRecord;
  onLoadFullAudit: () => void;
  loading?: boolean;
}) {
  const [limit, setLimit] = useState(100);
  const [includeText, setIncludeText] = useState(false);
  const [selected, setSelected] = useState<RunEvent>();
  useEffect(() => {
    setLimit(100);
    setSelected(undefined);
  }, [run.id]);
  const publicEvents = run.events.filter((event) => event.type !== 'reasoning');
  const events = publicEvents.filter((event) => includeText || event.type !== 'text');
  const visible = events.slice(0, limit);
  const selectedIndex = selected ? run.events.indexOf(selected) : -1;
  return (
    <div className="run-event-ledger">
      <div className="run-event-ledger-controls">
        <span>按收到顺序显示原始记录，未合并工具更新或内部步骤。</span>
        <label>
          <input type="checkbox" checked={includeText} onChange={(event) => setIncludeText(event.target.checked)} />{' '}
          包含模型文本增量
        </label>
        <button type="button" className="trajectory-read-more" disabled={loading} onClick={onLoadFullAudit}>
          {loading ? '正在读取…' : '读取完整记录'}
        </button>
      </div>
      <p className="trajectory-note">
        已显示 {visible.length} / {events.length} 条；本地记录 {publicEvents.length}{' '}
        条。序号和时间可与轨迹详情逐项核对。
      </p>
      {run.auditEventsMissing !== undefined && run.auditEventsMissing > 0 ? (
        <p className="trajectory-note">来源记录有 {run.auditEventsMissing} 个序号缺口，不能据此宣称记录完整。</p>
      ) : run.auditEventsMissing === 0 ? (
        <p className="trajectory-note">已读取的本地事件序号连续，无序号缺口。</p>
      ) : run.eventsDropped ? (
        <p className="trajectory-note">当前实时窗口省略过较早事件，请读取完整记录核对。</p>
      ) : null}
      <ol className="event-list">
        {visible.map((event) => {
          const index = run.events.indexOf(event);
          const diagnostic = diagnosticEvent(event, index);
          const name = typeof event.data?.tool === 'string' ? safeToolEventText(event.data.tool, 180) : '';
          return (
            <li key={event.seq ?? `legacy-${index}`} className={`event-${event.type}`}>
              <span className="event-point" />
              <time title={event.at}>
                {event.seq !== undefined ? `#${event.seq}` : `~${index + 1}`} ·{' '}
                {event.at.replace('T', ' ').replace('Z', ' UTC')}
              </time>
              <span className="event-type">{labels[event.type] ?? event.type}</span>
              <div>
                <p>{name || diagnostic.text || event.type}</p>
                <button type="button" className="trajectory-read-more" onClick={() => setSelected(event)}>
                  查看详细记录
                </button>
              </div>
            </li>
          );
        })}
      </ol>
      {visible.length < events.length && (
        <button type="button" className="trajectory-read-more" onClick={() => setLimit((value) => value + 100)}>
          加载后续记录
        </button>
      )}
      {!events.length && <p className="quiet-text no-events">暂无已采集的事件。</p>}
      {selected && (
        <TrajectoryDetailDialog
          title={`原始事件 ${selected.seq !== undefined ? `#${selected.seq}` : `~${selectedIndex + 1}`} · 详细记录`}
          text={JSON.stringify(diagnosticEvent(selected, selectedIndex), null, 2)}
          incomplete={/capture.?truncated/i.test(JSON.stringify(diagnosticEvent(selected, selectedIndex)))}
          onClose={() => setSelected(undefined)}
        />
      )}
    </div>
  );
}
