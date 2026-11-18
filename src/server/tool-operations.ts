import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { Tally, ToolOperation, ToolOperationKind, ToolOperationStatus } from '../shared/context-trace.ts';
import { safeToolEventText, safeToolName } from '../shared/tool-event-data.ts';
import type { RunEvent } from '../shared/types.ts';
import { partialHistory } from './usage-requests.ts';

/*
 * Tool-operation index: one row per tool call, joined across its start, update and end events by call id.
 * A host bridge event that names the native call it wraps joins that call, so one call counts once; updates
 * never add calls. Only a short summary is kept (name, status, times, command, exit code, paths, result size);
 * full arguments and results stay in the run audit. Writes are batched and idempotent per (run, call).
 */

type Row = Record<string, unknown>;
const object = (value: unknown): Row =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
const string = (value: unknown) => (typeof value === 'string' ? value : '');
const isoTime = (value: unknown): string | null =>
  typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)) ? value : null;
const identifier = (value: unknown) => {
  const id = string(value);
  return id && id.length <= 512 && safeToolEventText(id, 512) === id ? id : '';
};

// 'type' is left out: in shells it also names commands (`type node`), so it is not evidence of a file read.
const readers = new Set(['cat', 'head', 'tail', 'less', 'more', 'get-content', 'gc', 'bat', 'nl']);
const shells = new Set(['bash', 'sh', 'zsh', 'pwsh', 'powershell', 'cmd']);
const wrappers = new Set(['sudo', 'env', 'call', 'time', 'nohup', '&']);

const unquote = (token: string) => token.replace(/^(["'])([\s\S]*)\1$/, '$2');
const tokens = (segment: string) => segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];

/** Splits a command line into segments at && || ; | and newlines, leaving quoted text intact. */
function segments(command: string): string[] {
  const result: string[] = [];
  let current = '',
    quote = '';
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    if (quote) {
      if (char === quote) quote = '';
      current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      current += char;
    } else if (char === ';' || char === '|' || char === '\n' || (char === '&' && command[index + 1] === '&')) {
      if (char === '&' || (char === '|' && command[index + 1] === '|')) index++;
      result.push(current);
      current = '';
    } else current += char;
  }
  result.push(current);
  return result.map((item) => item.trim()).filter(Boolean);
}

/** First program a shell command runs: `cd x && npm test` → npm; `bash -lc "rg foo"` → rg. Null when unclear. */
export function commandProgram(command: string, depth = 0): string | null {
  for (const segment of segments(command)) {
    const parts = tokens(segment);
    let index = 0;
    while (index < parts.length && (/^\w+=/.test(parts[index]!) || wrappers.has(parts[index]!.toLowerCase()))) index++;
    const raw = parts[index];
    if (!raw) continue;
    const name = unquote(raw)
      .split(/[\\/]/)
      .at(-1)!
      .replace(/\.(exe|cmd|bat|ps1|sh)$/i, '')
      .toLowerCase();
    if (!name || name === 'cd' || name === 'set-location' || name === 'export' || name === 'set') continue;
    if (shells.has(name) && depth < 2) {
      const flag = parts.findIndex((part, position) => position > index && /^(-\w*c|-command|\/c)$/i.test(part));
      if (flag >= 0 && parts[flag + 1]) return commandProgram(unquote(parts.slice(flag + 1).join(' ')), depth + 1);
    }
    return /^[\w.+-]{1,60}$/.test(name) ? name : null;
  }
  return null;
}

function kindOf(name: string, command: string | null): ToolOperationKind {
  const value = name.toLowerCase().replace(/^(?:mcp__\w+__|pugport__|functions\.)/, '');
  if (/web|fetch|url|browser|http/.test(value)) return 'web';
  if (
    command ||
    /^(?:bash|shell|powershell|pwsh|exec|terminal|commandexecution|local_shell|run_terminal_cmd)/.test(value)
  )
    return 'command';
  if (/write|edit|patch|replace|create_file|filechange|notebookedit|str_replace/.test(value)) return 'write';
  if (/grep|glob|find|search|^ls$|list_dir|list_files|codebase/.test(value)) return 'search';
  if (/read|^view|^open|^cat$/.test(value)) return 'read';
  if (/delegate|^task$|agent|subagent/.test(value)) return 'delegate';
  return 'other';
}

function statusOf(data: Row): ToolOperationStatus {
  if (data.isError === true || (typeof data.exitCode === 'number' && data.exitCode !== 0)) return 'failed';
  const phase = string(data.status || data.phase).toLowerCase();
  if (/fail|error|denied|rejected|cancel/.test(phase)) return 'failed';
  if (/complete|finish|success|done|succeeded/.test(phase)) return 'completed';
  if (/start|progress|running|pending|begin|update/.test(phase)) return 'running';
  return 'unknown';
}

const pathKeys = ['path', 'file_path', 'filePath', 'file', 'target_file', 'notebook_path', 'filename', 'target'];
function pathsOf(input: Row, program: string | null, command: string | null): string[] {
  const found: string[] = [];
  const push = (value: unknown) => {
    const path = string(value).trim();
    if (path && path.length <= 400 && !/[\r\n]/.test(path) && !found.includes(path) && found.length < 20)
      found.push(safeToolEventText(path, 400));
  };
  for (const key of pathKeys) push(input[key]);
  if (Array.isArray(input.paths)) input.paths.forEach(push);
  const changes = input.changes;
  if (Array.isArray(changes)) for (const change of changes) push(object(change).path);
  else if (changes && typeof changes === 'object') Object.keys(changes).forEach(push);
  if (command && program && readers.has(program)) {
    const parts = tokens(segments(command)[0] ?? '');
    const at = parts.findIndex((part) =>
      unquote(part)
        .toLowerCase()
        .replace(/\.exe$/, '')
        .endsWith(program),
    );
    for (const part of parts.slice(at + 1)) if (!part.startsWith('-')) push(unquote(part));
  }
  return found;
}

const resultSize = (value: unknown): number | null => {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value.length;
  try {
    return Math.min(JSON.stringify(value).length, 4 * 1024 * 1024);
  } catch {
    return null;
  }
};

function commandOf(data: Row, input: Row): string | null {
  const raw = data.command ?? input.command ?? input.cmd;
  const value = Array.isArray(raw) ? raw.filter((part) => typeof part === 'string').join(' ') : string(raw);
  return value.trim() ? safeToolEventText(value.trim(), 300) : null;
}

type RunState = { next: number; ops: Map<string, ToolOperation> };

export class ToolOperationIndex {
  private readonly runs = new Map<string, RunState>();
  private readonly dirty = new Map<string, ToolOperation>();
  private liveMarks: string[] = [];
  private readonly marked = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  private readonly upsert: StatementSync;
  private readonly mark: StatementSync;
  private readonly markBackfill: StatementSync;
  private readonly read: StatementSync;
  constructor(
    readonly db: DatabaseSync,
    private readonly options: { flushDelayMs?: number; batchSize?: number } = {},
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS tool_operations (run_id TEXT NOT NULL, call_key TEXT NOT NULL,
        ordinal INTEGER NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, program TEXT, status TEXT NOT NULL,
        started_at TEXT, ended_at TEXT, result_chars INTEGER, value TEXT NOT NULL, PRIMARY KEY(run_id,call_key));
      CREATE INDEX IF NOT EXISTS tool_operations_order ON tool_operations(run_id,ordinal);
      CREATE TABLE IF NOT EXISTS tool_operation_runs (run_id TEXT PRIMARY KEY, source TEXT NOT NULL, updated_at TEXT NOT NULL);`);
    this.upsert = db.prepare(`INSERT INTO tool_operations(run_id,call_key,ordinal,name,kind,program,status,started_at,
        ended_at,result_chars,value) VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(run_id,call_key) DO UPDATE SET name=excluded.name,kind=excluded.kind,program=excluded.program,
        status=excluded.status,started_at=excluded.started_at,ended_at=excluded.ended_at,
        result_chars=excluded.result_chars,value=excluded.value`);
    this.mark = db.prepare(
      'INSERT INTO tool_operation_runs(run_id,source,updated_at) VALUES(?,?,?) ON CONFLICT(run_id) DO NOTHING',
    );
    this.markBackfill = db.prepare(`INSERT INTO tool_operation_runs(run_id,source,updated_at) VALUES(?,?,?)
      ON CONFLICT(run_id) DO UPDATE SET source=excluded.source,updated_at=excluded.updated_at
      WHERE tool_operation_runs.source='${partialHistory}'`);
    this.read = db.prepare('SELECT ordinal,value FROM tool_operations WHERE run_id=? AND call_key=?');
  }

  private state(runId: string): RunState {
    let state = this.runs.get(runId);
    if (!state) {
      // Unwritten calls of an evicted run must be on disk before they can be found again.
      if (this.dirty.size) this.flush();
      const row = this.db
        .prepare('SELECT COALESCE(MAX(ordinal),0) AS last FROM tool_operations WHERE run_id=?')
        .get(runId) as { last: number };
      state = { next: row.last + 1, ops: new Map() };
      if (this.runs.size >= 64) this.runs.delete(this.runs.keys().next().value!);
      this.runs.set(runId, state);
    } else {
      // Keep recently used runs at the end of the eviction order.
      this.runs.delete(runId);
      this.runs.set(runId, state);
    }
    return state;
  }

  private merge(runId: string, event: RunEvent): ToolOperation | undefined {
    if (event.type !== 'tool') return undefined;
    const data = event.data ?? {};
    const application = data.source === 'pugport';
    const linked = application ? identifier(data.nativeToolCallId) : '';
    const id = identifier(data.toolCallId) || identifier(data.itemId) || identifier(data.callId);
    const state = this.state(runId);
    const key = linked ? `native:${linked}` : id ? `${application ? 'pugport' : 'native'}:${id}` : '';
    let op = key ? state.ops.get(key) : undefined;
    if (!op && key) {
      const stored = this.read.get(runId, key) as { ordinal: number; value: string } | undefined;
      if (stored) op = JSON.parse(stored.value) as ToolOperation;
    }
    const at = isoTime(event.at);
    const input = object(data.arguments ?? data.input ?? data.args);
    const args = Object.keys(object(input.tool_input)).length ? object(input.tool_input) : input;
    const status = statusOf(data);
    if (!op) {
      op = {
        runId,
        callId: key || `observed:${state.next}`,
        ordinal: state.next++,
        name: 'tool',
        kind: 'other',
        status: 'unknown',
        source: application && !linked ? 'pugport' : 'native',
        parentCallId: null,
        startedAt: null,
        endedAt: null,
        command: null,
        program: null,
        exitCode: null,
        paths: [],
        resultChars: null,
        updates: 0,
        coverage: key ? 'start-only' : 'unpaired',
      };
    }
    op.updates++;
    const name = safeToolName(data);
    if (name && (op.name === 'tool' || !application)) op.name = name;
    else if (op.name === 'tool' && /^[\w./:-]{1,60}$/.test(string(data.kind))) op.name = string(data.kind);
    const parent = identifier(data.parentToolCallId);
    if (parent) op.parentCallId = parent;
    const command = commandOf(data, args);
    if (command && !op.command) {
      op.command = command;
      op.program = commandProgram(command);
    }
    if (typeof data.exitCode === 'number' && Number.isFinite(data.exitCode)) op.exitCode = data.exitCode;
    else {
      const exit = object(data.output ?? data.result).exitCode;
      if (typeof exit === 'number' && Number.isFinite(exit)) op.exitCode = exit;
    }
    for (const path of pathsOf(args, op.program, op.command))
      if (!op.paths.includes(path) && op.paths.length < 20) op.paths.push(path);
    const size = resultSize(data.output ?? data.result);
    if (size !== null)
      op.resultChars = ['delta', 'progress'].includes(string(data.outputMode)) ? (op.resultChars ?? 0) + size : size;
    if (status === 'running') {
      if (at && (!op.startedAt || at < op.startedAt)) op.startedAt = at;
      if (op.status === 'unknown') op.status = 'running';
    } else if (status === 'completed' || status === 'failed') {
      if (at && (!op.endedAt || at > op.endedAt)) op.endedAt = at;
      // A failure is never erased by a replayed success.
      if (op.status !== 'failed') op.status = status;
    } else if (op.updates === 1 && at) op.startedAt = at;
    op.kind = kindOf(op.name, op.command);
    op.coverage = !key ? 'unpaired' : op.startedAt && op.endedAt ? 'paired' : op.endedAt ? 'end-only' : 'start-only';
    if (key) {
      state.ops.set(key, op);
      if (state.ops.size > 4000) state.ops.delete(state.ops.keys().next().value!);
    }
    this.dirty.set(`${runId}\u0000${op.callId}`, op);
    return op;
  }

  /** Called for every live adapter event; non-tool events are ignored. */
  observe(runId: string, event: RunEvent): ToolOperation | undefined {
    if (event.type !== 'tool') return undefined;
    // A diagnostic index must never break the run that feeds it.
    try {
      if (!this.marked.has(runId)) {
        this.marked.add(runId);
        if (this.marked.size > 4096) this.marked.clear();
        this.liveMarks.push(runId);
      }
      const op = this.merge(runId, event);
      if (this.dirty.size >= (this.options.batchSize ?? 64)) this.safeFlush();
      else {
        this.timer ??= setTimeout(() => this.safeFlush(), this.options.flushDelayMs ?? 500);
        this.timer.unref?.();
      }
      return op;
    } catch (error) {
      console.warn(`Tool-operation index skipped an event: ${(error as Error).message}`);
      return undefined;
    }
  }

  /** Timer flushes must never take down the process: a failed batch is reported and dropped. */
  private safeFlush() {
    try {
      this.flush();
    } catch (error) {
      console.warn(`Tool-operation index flush failed: ${(error as Error).message}`);
    }
  }

  flush(): number {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const rows = [...this.dirty.values()];
    const marks = this.liveMarks;
    if (!rows.length && !marks.length) return 0;
    this.dirty.clear();
    this.liveMarks = [];
    const now = new Date().toISOString();
    this.db.exec('SAVEPOINT tool_operations_flush');
    try {
      for (const runId of marks) this.mark.run(runId, 'live', now);
      for (const op of rows)
        this.upsert.run(
          op.runId,
          op.callId,
          op.ordinal,
          op.name,
          op.kind,
          op.program,
          op.status,
          op.startedAt,
          op.endedAt,
          op.resultChars,
          JSON.stringify(op),
        );
      this.db.exec('RELEASE tool_operations_flush');
    } catch (error) {
      this.db.exec('ROLLBACK TO tool_operations_flush; RELEASE tool_operations_flush');
      throw error;
    }
    return rows.length;
  }

  indexed(runId: string): string | undefined {
    this.flush();
    return (
      this.db.prepare('SELECT source FROM tool_operation_runs WHERE run_id=?').get(runId) as
        { source: string } | undefined
    )?.source;
  }

  /** Rebuild from the tool events a stored run still has; partial=true keeps it open for the next chunk. */
  backfill(runId: string, events: readonly RunEvent[], options: { partial?: boolean } = {}): number {
    const current = this.indexed(runId);
    if (current && current !== partialHistory) return 0;
    let seen = 0;
    this.db.exec('SAVEPOINT tool_operations_backfill');
    try {
      for (const event of events)
        if (event.type === 'tool') {
          this.merge(runId, event);
          seen++;
        }
      this.markBackfill.run(runId, options.partial ? partialHistory : 'retained-events', new Date().toISOString());
      this.flush();
      this.db.exec('RELEASE tool_operations_backfill');
    } catch (error) {
      this.db.exec('ROLLBACK TO tool_operations_backfill; RELEASE tool_operations_backfill');
      throw error;
    }
    this.runs.delete(runId);
    return seen;
  }

  summary(runId: string): { count: number; resultChars: number } {
    this.flush();
    const row = this.db
      .prepare('SELECT COUNT(*) AS count, COALESCE(SUM(result_chars),0) AS chars FROM tool_operations WHERE run_id=?')
      .get(runId) as { count: number; chars: number };
    return { count: row.count, resultChars: row.chars };
  }

  page(runId: string, offset = 0, limit = 50): { total: number; items: ToolOperation[] } {
    this.flush();
    const total = this.summary(runId).count;
    const rows = this.db
      .prepare('SELECT value FROM tool_operations WHERE run_id=? ORDER BY ordinal LIMIT ? OFFSET ?')
      .all(runId, limit, offset) as { value: string }[];
    return { total, items: rows.map((row) => JSON.parse(row.value) as ToolOperation) };
  }

  /** Top tools and programs, plus files read (from tool arguments) and edited (from write calls). */
  aggregates(runId: string): {
    topTools: Tally[];
    topCommands: Tally[];
    commandCount: number;
    filesRead: Tally[];
    filesEdited: string[];
  } {
    this.flush();
    const tally = (sql: string) =>
      (this.db.prepare(sql).all(runId) as { name: string; count: number }[]).map((row) => ({
        name: row.name,
        count: row.count,
      }));
    const topTools = tally(
      'SELECT name, COUNT(*) AS count FROM tool_operations WHERE run_id=? GROUP BY name ORDER BY count DESC, name LIMIT 6',
    );
    const topCommands = tally(
      `SELECT program AS name, COUNT(*) AS count FROM tool_operations WHERE run_id=? AND program IS NOT NULL
       GROUP BY program ORDER BY count DESC, program LIMIT 6`,
    );
    const commandCount = (
      this.db.prepare("SELECT COUNT(*) AS count FROM tool_operations WHERE run_id=? AND kind='command'").get(runId) as {
        count: number;
      }
    ).count;
    const read = new Map<string, number>();
    const edited: string[] = [];
    const rows = this.db
      .prepare(
        `SELECT kind, program, value FROM tool_operations WHERE run_id=?
         AND (kind IN ('read','write') OR program IN (${[...readers].map(() => '?').join(',')}))
         ORDER BY ordinal LIMIT 5000`,
      )
      .all(runId, ...readers) as { kind: ToolOperationKind; program: string | null; value: string }[];
    for (const row of rows) {
      const op = JSON.parse(row.value) as ToolOperation;
      if (row.kind === 'write') {
        for (const path of op.paths) if (!edited.includes(path) && edited.length < 50) edited.push(path);
      } else for (const path of op.paths) read.set(path, (read.get(path) ?? 0) + 1);
    }
    const filesRead = [...read.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, 12);
    return { topTools, topCommands, commandCount, filesRead, filesEdited: edited };
  }
}
