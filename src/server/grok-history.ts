import { createHash } from 'node:crypto';

export type GrokTimestampKind = 'exact' | 'fallback' | 'unknown';
export type ImportedGrokMessage = {
  line: number;
  role: 'user' | 'assistant';
  content: string;
  /** Stable for the same visible content and occurrence, independent of source line or time. */
  sourceKey: string;
  contentHash: string;
  occurrence: number;
  createdAt?: string;
  /** exact means an observed matching update; fallback is a chronology bound, not a measured wall time. */
  timestampKind: GrokTimestampKind;
};
export type GrokHistoryOptions = {
  updates?: string | Iterable<string>;
  sessionCreatedAt?: string;
  sessionUpdatedAt?: string;
};

type RecordValue = Record<string, unknown>;
type HistoryRow = {
  message: ImportedGrokMessage;
  type: 'user' | 'assistant' | 'tool_result';
  text: string;
  toolIds: string[];
};
type Observation = { order: number; createdAt: string; millis: number };
type UpdateProjection = {
  text: Map<string, Observation[]>;
  toolStarts: Map<string, Observation>;
  toolResults: Map<string, Observation>;
  incompleteLines: number;
};

function record(value: unknown): RecordValue | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : undefined;
}

function visibleText(content: unknown): string {
  if (typeof content === 'string') return content;
  const blocks = Array.isArray(content) ? content : [content];
  return blocks
    .flatMap((value) => {
      const block = record(value);
      return block?.type === 'text' && typeof block.text === 'string' ? [block.text] : [];
    })
    .join('\n');
}

/** Tool metadata can itself contain content blocks; keep private reasoning out of the rendered JSON too. */
function visibleToolData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(visibleToolData).filter((entry) => entry !== undefined);
  const object = record(value);
  if (!object) return value;
  if (['thought', 'thinking', 'reasoning', 'encrypted_content'].includes(String(object.type))) return undefined;
  return Object.fromEntries(
    Object.entries(object)
      .filter(
        ([key]) =>
          !['encrypted_content', 'reasoning', 'reasoning_content', 'thought', 'thoughts', 'thinking'].includes(key),
      )
      .map(([key, entry]) => [key, visibleToolData(entry)])
      .filter(([, entry]) => entry !== undefined),
  );
}

/** Same helper can identify already imported messages, whose native line numbers may have changed after compaction. */
export function grokMessageContentHash(role: 'user' | 'assistant', content: string): string {
  return createHash('sha256')
    .update(JSON.stringify([role, content]))
    .digest('hex');
}

function isoTimestamp(value: unknown, unixSeconds = false): string | undefined {
  if (unixSeconds && (typeof value !== 'number' || !Number.isFinite(value))) return undefined;
  if (!unixSeconds && typeof value !== 'string') return undefined;
  const millis = unixSeconds ? (value as number) * 1000 : Date.parse(value as string);
  if (!Number.isFinite(millis) || Math.abs(millis) > 8.64e15) return undefined;
  return new Date(millis).toISOString();
}

function textKey(role: HistoryRow['type'], content: string): string {
  return JSON.stringify([role, content]);
}

function updateProjection(text: string | Iterable<string>): UpdateProjection {
  const projection: UpdateProjection = {
    text: new Map(),
    toolStarts: new Map(),
    toolResults: new Map(),
    incompleteLines: 0,
  };
  let stream: { role: 'user' | 'assistant'; text: string; observation?: Observation } | undefined;
  const addText = (role: HistoryRow['type'], content: string, observation: Observation) => {
    if (!content.trim()) return;
    const key = textKey(role, content);
    const entries = projection.text.get(key) ?? [];
    entries.push(observation);
    projection.text.set(key, entries);
  };
  const flush = () => {
    if (stream?.observation) addText(stream.role, stream.text, stream.observation);
    stream = undefined;
  };
  let line = -1;
  for (const raw of typeof text === 'string' ? text.split('\n') : text) {
    line++;
    if (!raw.trim()) continue;
    let row: RecordValue | undefined;
    try {
      row = record(JSON.parse(raw));
    } catch {
      projection.incompleteLines++;
      // A missing chunk can change the aggregate text, so do not join across an incomplete record.
      flush();
      continue;
    }
    if (!row || !['session/update', '_x.ai/session/update'].includes(String(row.method))) continue;
    const update = record(record(row.params)?.update);
    if (!update) continue;
    const kind = String(update.sessionUpdate);
    const createdAt = isoTimestamp(row.timestamp, true);
    const observation = createdAt ? { order: line * 3, createdAt, millis: Date.parse(createdAt) } : undefined;
    if (kind === 'user_message_chunk' || kind === 'agent_message_chunk') {
      const role = kind === 'user_message_chunk' ? 'user' : 'assistant';
      const chunk = visibleText(update.content);
      if (!chunk) continue;
      if (stream?.role !== role) flush();
      if (!stream) stream = { role, text: '', observation };
      stream.text += chunk;
      continue;
    }
    if (kind === 'tool_call' || kind === 'tool_call_update') {
      flush();
      if (!observation) continue;
      const id = typeof update.toolCallId === 'string' ? update.toolCallId : undefined;
      const status = String(update.status);
      if (kind === 'tool_call' && id && !projection.toolStarts.has(id))
        projection.toolStarts.set(id, { ...observation, order: observation.order + 1 });
      if (['completed', 'complete', 'failed', 'error', 'cancelled', 'canceled'].includes(status)) {
        const result = { ...observation, order: observation.order + 2 };
        if (id) projection.toolResults.set(id, result);
        const output = visibleText(update.content) || visibleText(update.rawOutput);
        addText('tool_result', output, result);
      }
      continue;
    }
    if (['turn_completed', 'turn_started', 'compaction_checkpoint'].includes(kind)) flush();
    // Thought/reasoning chunks are deliberately ignored, including their timestamps and encrypted payloads.
  }
  flush();
  return projection;
}

function recoverTimestamps(rows: HistoryRow[], updates: UpdateProjection, options: GrokHistoryOptions): void {
  let upperOrder = Infinity;
  let upperMillis = Infinity;
  const used = new Set<number>();
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index]!;
    const toolMap = row.type === 'tool_result' ? updates.toolResults : updates.toolStarts;
    const tools = row.toolIds.flatMap((id) => {
      const observation = toolMap.get(id);
      return observation ? [observation] : [];
    });
    // Native assistant rows can contain several calls. The first observed call dates that row.
    const candidates = tools.length
      ? [tools.reduce((first, current) => (current.order < first.order ? current : first))]
      : (updates.text.get(textKey(row.type, row.text)) ?? []);
    let matched: Observation | undefined;
    for (let candidateIndex = candidates.length - 1; candidateIndex >= 0; candidateIndex--) {
      const candidate = candidates[candidateIndex]!;
      if (candidate.order < upperOrder && candidate.millis <= upperMillis && !used.has(candidate.order)) {
        matched = candidate;
        break;
      }
    }
    if (!matched) continue;
    row.message.createdAt = matched.createdAt;
    row.message.timestampKind = 'exact';
    upperOrder = matched.order;
    upperMillis = matched.millis;
    used.add(matched.order);
  }
  const sessionStart = isoTimestamp(options.sessionCreatedAt);
  const sessionEnd = isoTimestamp(options.sessionUpdatedAt);
  const firstExact = rows.find((row) => row.message.timestampKind === 'exact')?.message.createdAt;
  let priorBound = sessionStart ?? firstExact ?? sessionEnd;
  if (priorBound && firstExact && Date.parse(priorBound) > Date.parse(firstExact)) priorBound = firstExact;
  for (const row of rows) {
    if (row.message.timestampKind === 'exact') {
      priorBound = row.message.createdAt;
    } else if (priorBound) {
      // Reuse a real adjacent/session bound. Do not fabricate per-line wall times or millisecond offsets.
      row.message.createdAt = priorBound;
      row.message.timestampKind = 'fallback';
    }
  }
}

/** Conversation projection only; the importer separately archives every source byte. */
export function grokHistoryMessages(
  text: string | Iterable<string>,
  options: GrokHistoryOptions = {},
): { messages: ImportedGrokMessage[]; incompleteLines: number; incompleteUpdateLines: number } {
  const rows: HistoryRow[] = [];
  const occurrences = new Map<string, number>();
  let incompleteLines = 0;
  let line = -1;
  for (const raw of typeof text === 'string' ? text.split('\n') : text) {
    line++;
    if (!raw.trim()) continue;
    let row: RecordValue | undefined;
    try {
      row = record(JSON.parse(raw));
    } catch {
      incompleteLines++;
      continue;
    }
    if (!row || row.synthetic_reason) continue;
    if (!['user', 'assistant', 'tool_result'].includes(String(row.type))) continue;
    const content = visibleText(row.content);
    const toolCalls = Array.isArray(row.tool_calls) ? (visibleToolData(row.tool_calls) as unknown[]) : [];
    const tools = toolCalls.length
      ? '\n\n工具调用（历史记录，未执行）：\n```json\n' + JSON.stringify(toolCalls, null, 2) + '\n```'
      : '';
    if (!content.trim() && !tools) continue;
    const role = row.type === 'user' ? 'user' : 'assistant';
    const rendered = (row.type === 'tool_result' ? '工具结果（历史记录）：\n\n' : '') + content + tools;
    const contentHash = grokMessageContentHash(role, rendered);
    const occurrence = occurrences.get(contentHash) ?? 0;
    occurrences.set(contentHash, occurrence + 1);
    rows.push({
      message: {
        line,
        role,
        content: rendered,
        contentHash,
        occurrence,
        sourceKey: `${contentHash}:${occurrence}`,
        timestampKind: 'unknown',
      },
      type: row.type as HistoryRow['type'],
      text: content,
      toolIds:
        row.type === 'tool_result'
          ? typeof row.tool_call_id === 'string'
            ? [row.tool_call_id]
            : []
          : toolCalls.flatMap((call) => {
              const id = record(call)?.id;
              return typeof id === 'string' ? [id] : [];
            }),
    });
  }
  const updates = updateProjection(options.updates ?? '');
  recoverTimestamps(rows, updates, options);
  return { messages: rows.map((row) => row.message), incompleteLines, incompleteUpdateLines: updates.incompleteLines };
}
