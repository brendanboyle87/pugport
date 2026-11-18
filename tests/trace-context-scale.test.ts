// Synthetic scale check for Trace › Context on the real storage path: the application's Store and
// WorkspaceStore over one temporary SQLite database, 800 workflows, 10,000 runs, and a few large runs
// (about 10,000 audit events and MB-sized output each). No executor, account, provider or remote service is
// contacted; HTTP stays on 127.0.0.1. The dependencies mirror the wiring in src/server/main.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { Store } from '../src/server/store.ts';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import { RequestLedger } from '../src/server/usage-requests.ts';
import { ToolOperationIndex } from '../src/server/tool-operations.ts';
import { registerTraceContextRoutes, TraceContext } from '../src/server/trace-context.ts';
import { storedUsageRun } from '../src/server/trace-context-records.ts';
import type { Conversation, Provider, RunEvent, RunRecord, Workflow } from '../src/shared/types.ts';

const WORKFLOWS = 800;
const RUNS = 10_000;
const SUBTASKS = 200;
const CONVERSATIONS = 40;
/** One conversation holds many tasks, so a whole-conversation read would be visibly expensive. */
const HEAVY_CONVERSATION = 'chat-heavy';
const HEAVY_WORKFLOWS = 240;
const LARGE_RUNS = 4;
const LARGE_EVENTS = 10_000;
const LARGE_OUTPUT = 2 * 1024 * 1024;
const RETAINED_WINDOW = 400;
const base = Date.UTC(2026, 9, 1);
const at = (ms: number) => new Date(base + ms).toISOString();
const providers: Provider[] = ['pi', 'codex', 'claude', 'cursor', 'grok'];
const mb = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10;
const ms = (value: number) => Math.round(value * 10) / 10;
const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
};

function prompt(seed: number) {
  const memory = 'Synthetic earlier work line about the retry queue. '.repeat(20 + (seed % 40));
  const chat = '此前的对话内容，仅用于合成测试。'.repeat(10 + (seed % 20));
  return [
    '你在用户的工作台中完成任务。',
    '',
    '此前工作的可见记录（可能包含未核验的模型陈述，只作参考）：',
    memory,
    '',
    '此前对话（较长内容仅保留最近片段）：',
    chat,
    '',
    '<原始需求>',
    `Synthetic request ${seed}: make the upload retry idempotent.`,
    '</原始需求>',
  ].join('\n');
}

function usageEvent(runId: string, provider: Provider, time: number, index: number): RunEvent | undefined {
  const tokens = 12_000 + index * 250;
  if (provider === 'pi')
    return {
      type: 'usage',
      at: at(time),
      data: {
        source: 'Pi RPC',
        scope: 'assistant-message',
        cumulative: false,
        eventId: `pi-${runId}-${index}`,
        input: 400,
        cacheRead: tokens,
        cacheWrite: 100,
        output: 120,
        contextWindow: 200000,
      },
    };
  if (provider === 'codex')
    return {
      type: 'usage',
      at: at(time),
      data: {
        eventId: `tokens-${runId}-${index}`,
        scope: 'session-cumulative',
        last: { totalTokens: tokens, inputTokens: tokens - 200, cachedInputTokens: tokens - 1000, outputTokens: 200 },
        modelContextWindow: 272000,
      },
    };
  if (provider === 'cursor')
    return { type: 'status', at: at(time), data: { contextTokens: tokens, contextWindow: 128000 } };
  return undefined;
}

function toolEvents(runId: string, time: number, index: number, output: string): RunEvent[] {
  const id = `${runId}-t${index}`;
  const command = index % 3 === 0 ? `npm test -- --grep case${index}` : undefined;
  return [
    {
      type: 'tool',
      at: at(time),
      data: {
        toolCallId: id,
        tool: command ? 'bash' : index % 3 === 1 ? 'read' : 'edit',
        status: 'inProgress',
        input: command ? { command } : { path: `src/file-${index % 5}.ts` },
      },
    },
    {
      type: 'tool',
      at: at(time + 400),
      data: { toolCallId: id, status: 'completed', output, ...(command ? { exitCode: 0 } : {}) },
    },
  ];
}

/** An ordinary run: a prompt, 12 tool calls and 8 reported requests. */
function events(runId: string, provider: Provider, seed: number, text: string): RunEvent[] {
  const list: RunEvent[] = [
    {
      type: 'status',
      at: at(seed),
      data: {
        source: 'pugport',
        kind: 'execution-context',
        detail: { prompt: text, transport: provider === 'pi' ? 'api' : 'cli' },
      },
    },
  ];
  for (let index = 0; index < 12; index++)
    list.push(...toolEvents(runId, seed + index * 1000, index, 'ok '.repeat(50)));
  for (let index = 0; index < 8; index++) {
    const event = usageEvent(runId, provider, seed + index * 1500, index);
    if (event) list.push(event);
  }
  return list.map((event, index) => ({ ...event, seq: index + 1 }));
}

/** A long run: about 10,000 events, mostly reply text, with 1,500 tool calls and 300 reported requests. */
function largeEvents(runId: string, provider: Provider, seed: number, text: string): RunEvent[] {
  const list: RunEvent[] = [
    {
      type: 'status',
      at: at(seed),
      data: { source: 'pugport', kind: 'execution-context', detail: { prompt: text, transport: 'cli' } },
    },
  ];
  const toolOutput = 'Synthetic tool output line. '.repeat(40);
  const delta = 'Synthetic reply text for the long run. '.repeat(8);
  let tool = 0,
    request = 0;
  for (let index = 1; list.length < LARGE_EVENTS; index++) {
    const time = seed + index * 50;
    if (index % 6 === 0 && tool < 1500) list.push(...toolEvents(runId, time, tool++, toolOutput));
    else if (index % 30 === 5 && request < 300) {
      const event = usageEvent(runId, provider, time, request++);
      if (event) list.push(event);
    } else list.push({ type: 'text', at: at(time), data: { delta } } as RunEvent);
  }
  return list.slice(0, LARGE_EVENTS).map((event, index) => ({ ...event, seq: index + 1 }));
}

test('Trace › Context stays bounded on the real store with 800 workflows, 10,000 runs and large runs', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pugport-trace-context-scale-'));
  const report: Record<string, unknown> = {
    path: 'Store + WorkspaceStore (application classes) over one SQLite file; deps mirror src/server/main.ts',
    workflows: WORKFLOWS,
    runs: RUNS,
    subtasks: SUBTASKS,
    conversations: CONVERSATIONS + 1,
    heavyConversationWorkflows: HEAVY_WORKFLOWS,
    largeRuns: { count: LARGE_RUNS, auditEvents: LARGE_EVENTS, outputBytes: LARGE_OUTPUT, retained: RETAINED_WINDOW },
  };
  const memoryStart = process.memoryUsage();
  let server: import('node:http').Server | undefined;
  let store: Store | undefined;
  try {
    store = new Store(directory);
    const workspaceStore = new WorkspaceStore(store.db, { recoverInterrupted: false });
    const providerOf = new Map<string, Provider>();
    const seedStart = performance.now();
    store.db.exec('BEGIN');
    const audit = store.db.prepare('INSERT INTO run_audit_events(run_id,seq,value) VALUES(?,?,?)');
    workspaceStore.save('project', 'project', 'project', { id: 'project', name: 'Synthetic', path: '/synthetic' });
    for (const id of [...Array(CONVERSATIONS)].map((_, index) => `chat-${index}`).concat(HEAVY_CONVERSATION))
      workspaceStore.save('conversation', id, 'project', {
        id,
        projectId: 'project',
        title: `Synthetic ${id}`,
        createdAt: at(0),
        updatedAt: at(0),
      } as Partial<Conversation>);
    const conversationOf = (index: number) =>
      index < HEAVY_WORKFLOWS ? HEAVY_CONVERSATION : `chat-${index % CONVERSATIONS}`;
    const large: string[] = [];
    const largeCounts = new Map<string, { requests: number; tools: number }>();
    let runIndex = 0;
    for (let index = 0; index < WORKFLOWS; index++) {
      const id = `wf-${index}`;
      const subtask = index >= WORKFLOWS - SUBTASKS;
      // Sub-tasks hang under the first tasks, which live in the heavy conversation.
      const parentIndex = subtask ? index - (WORKFLOWS - SUBTASKS) : undefined;
      const conversationId = parentIndex === undefined ? conversationOf(index) : conversationOf(parentIndex);
      const count = Math.floor(RUNS / WORKFLOWS) + (index < RUNS % WORKFLOWS ? 1 : 0);
      const runIds: string[] = [];
      for (let attempt = 0; attempt < count; attempt++) {
        const runId = `run-${runIndex}`;
        // The first attempts of wf-7 are the large runs, so the measured ladder includes them.
        const isLarge = index === 7 && attempt < LARGE_RUNS;
        const provider = isLarge ? (['pi', 'codex', 'claude', 'pi'] as Provider[])[attempt]! : providers[runIndex % 5]!;
        const seed = runIndex * 60_000;
        const text = prompt(runIndex);
        const list = isLarge ? largeEvents(runId, provider, seed, text) : events(runId, provider, seed, text);
        const record: RunRecord = {
          id: runId,
          workflowId: id,
          prompt: text,
          projectPath: '/synthetic',
          kind: 'routine',
          status: 'completed',
          route: {
            runtimeId: `${provider}-card`,
            model: 'synthetic',
            kind: 'routine',
            reasons: ['Synthetic'],
            warnings: [],
          },
          startedAt: at(seed),
          endedAt: at(seed + 50_000),
          output: isLarge ? 'Synthetic long reply. '.repeat(LARGE_OUTPUT / 22) : 'Synthetic reply. '.repeat(30),
          // The record keeps a bounded window; the audit table keeps every event, as the controller does.
          events: list.slice(-RETAINED_WINDOW),
          eventsDropped: Math.max(0, list.length - RETAINED_WINDOW),
          auditVersion: 1,
          executionKind: provider === 'pi' ? 'api' : 'cli',
          ...(provider === 'claude' ? { context: { tokens: 30_000, window: 200_000, at: at(seed + 40_000) } } : {}),
        };
        store.saveRun(record);
        for (const event of list) audit.run(runId, event.seq!, JSON.stringify(event));
        providerOf.set(runId, provider);
        if (isLarge) {
          large.push(runId);
          largeCounts.set(runId, {
            requests: list.filter((event) => event.type === 'usage').length,
            tools: list.filter((event) => event.type === 'tool' && event.data?.status === 'inProgress').length,
          });
        }
        runIds.push(runId);
        runIndex++;
      }
      workspaceStore.save('workflow', id, conversationId, {
        id,
        conversationId,
        projectId: 'project',
        userMessageId: `${id}-m`,
        input: {
          content: `Synthetic task ${index}. ${'Context for the synthetic task. '.repeat(60)}`,
          mode: 'auto',
          permissionMode: 'read-only',
          executionPolicy: 'cli-first',
        },
        status: 'completed',
        phase: 'summarize',
        plan: [],
        runIds,
        memoryRevision: 1,
        memoryExcerpt: 'Synthetic memory excerpt. '.repeat(80),
        createdAt: at(index * 1000),
        updatedAt: at(index * 1000 + 1),
        ...(parentIndex !== undefined
          ? {
              createdAt: at(parentIndex * 1000 + 500),
              delegation: {
                parentId: `wf-${parentIndex}`,
                role: 'worker',
                requestId: `r-${index}`,
                agent: { label: `Sub-task ${index}` },
              },
            }
          : {}),
      } as Workflow);
    }
    store.db.exec('COMMIT');
    report.seedMs = ms(performance.now() - seedStart);
    report.databaseMb = mb(
      (
        store.db
          .prepare('SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()')
          .get() as {
          bytes: number;
        }
      ).bytes,
    );

    const requests = new RequestLedger(store.db);
    const tools = new ToolOperationIndex(store.db);
    const trace = new TraceContext({
      db: store.db,
      workflow: (id) => workspaceStore.get<Workflow>('workflow', id),
      delegatedWorkflows: (conversationId, parentId) => workspaceStore.delegatedWorkflows(conversationId, parentId),
      // Same checks as Workspace.requireConversation: the conversation and its project must exist.
      requireConversation: (id) => {
        const conversation = workspaceStore.get<Conversation>('conversation', id);
        if (!conversation || conversation.deletedAt) throw new Error('会话不存在或已删除。');
        if (!workspaceStore.get('project', conversation.projectId)) throw new Error('项目不存在。');
      },
      run: (id) => store!.storedRun(id),
      runSummary: (id) => store!.storedRunSummary(id),
      isActive: () => false,
      runUsage: (id) => storedUsageRun(store!.db, id),
      executorLabel: (run) => run.route.runtimeId,
      provider: (run) => providerOf.get(run.id),
      requests,
      tools,
    });

    // What replaced the whole-conversation read: the sub-tasks are selected in SQL.
    const timed = <T>(run: () => T) => {
      const started = performance.now();
      const value = run();
      return { value, ms: performance.now() - started };
    };
    const whole = timed(() =>
      workspaceStore.conversationWorkflows(HEAVY_CONVERSATION).filter((item) => item.delegation?.parentId === 'wf-7'),
    );
    const delegated = timed(() => workspaceStore.delegatedWorkflows(HEAVY_CONVERSATION, 'wf-7'));
    assert.deepEqual(
      delegated.value.map((item) => item.id),
      whole.value.map((item) => item.id),
    );
    report.subtaskLookup = {
      heavyConversationWorkflows: HEAVY_WORKFLOWS,
      subtasksFound: delegated.value.length,
      wholeConversationParseMs: ms(whole.ms),
      sqlDelegatedMs: ms(delegated.ms),
    };

    // Live ingest: 100 runs' events through the batched observers, as the controller's emit hook calls them.
    const live = [...Array(100)].map((_, index) => `live-${index}`);
    let observed = 0;
    const ingestStart = performance.now();
    for (const [index, runId] of live.entries()) {
      const provider = providers[index % providers.length]!;
      for (const event of events(runId, provider, index * 60_000, '')) {
        requests.observe({ id: runId, route: { model: 'synthetic' } as RunRecord['route'] }, provider, event);
        tools.observe(runId, event);
        observed++;
      }
    }
    requests.flush();
    tools.flush();
    const ingestMs = performance.now() - ingestStart;
    report.liveIngest = {
      events: observed,
      totalMs: ms(ingestMs),
      perEventMicroseconds: Math.round((ingestMs * 1000) / observed),
    };

    // HTTP on loopback measures real response bytes.
    const app = express();
    registerTraceContextRoutes(app, () => trace);
    server = await new Promise((resolveServer) => {
      const listening = app.listen(0, '127.0.0.1', () => resolveServer(listening));
    });
    const port = (server!.address() as AddressInfo).port;
    const get = async (path: string) => {
      const started = performance.now();
      const response = await fetch(`http://127.0.0.1:${port}${path}`);
      const body = await response.text();
      assert.equal(response.status, 200, body.slice(0, 200));
      return { ms: performance.now() - started, bytes: Buffer.byteLength(body), json: JSON.parse(body) };
    };

    // wf-7 holds the four large runs and has one sub-task; its first read rebuilds their indexes.
    const parent = 'wf-7';
    const cold = await get(`/api/workflows/${parent}/context`);
    const warm = await get(`/api/workflows/${parent}/context`);
    const polls: number[] = [];
    for (let index = 0; index < 20; index++) polls.push((await get(`/api/workflows/${parent}/context`)).ms);
    const parentWorkflow = workspaceStore.get<Workflow>('workflow', parent)!;
    const child = workspaceStore.get<Workflow>('workflow', `wf-${7 + WORKFLOWS - SUBTASKS}`)!;
    assert.equal(cold.json.total, parentWorkflow.runIds.length + child.runIds.length);
    assert.ok(
      cold.json.runs.some((row: { depth: number }) => row.depth === 1),
      'sub-task runs are nested in the ladder',
    );
    const largeRow = cold.json.runs.find((row: { runId: string }) => row.runId === large[0]);
    const expected = largeCounts.get(large[0]!)!;
    assert.ok(expected.requests > 200 && expected.tools > 1000);
    assert.equal(largeRow.requests.count, expected.requests, 'every request of the large run was rebuilt');
    assert.equal(largeRow.tools.count, expected.tools);
    assert.equal(largeRow.partialHistory, false);
    const largeDetailCold = await get(`/api/runs/${large[0]}/context`);
    const largeDetailWarm = await get(`/api/runs/${large[0]}/context`);
    assert.equal(largeDetailCold.json.tools.total, expected.tools);
    assert.equal(largeDetailCold.json.tools.items.length, 50, 'tool rows are paged');
    assert.equal(largeDetailCold.json.requests.items.length, 200, 'request rows are paged');
    const lastRequests = await get(`/api/runs/${large[0]}/context?requestOffset=200&requestLimit=200`);
    assert.equal(lastRequests.json.requests.items.length, expected.requests - 200);

    // An ordinary run in another workflow: detail is read once on a cold cache.
    const ordinary = await get(`/api/workflows/wf-41/context`);
    const selected = ordinary.json.runs.find((row: { provider: string }) => row.provider === 'pi').runId;
    const detailCold = await get(`/api/runs/${selected}/context`);
    const detailWarm = await get(`/api/runs/${selected}/context`);
    assert.equal(detailCold.json.requests.items.length, 8);
    assert.equal(detailCold.json.tools.total, 12);
    const paged = await get(`/api/workflows/${parent}/context?offset=10&limit=10`);
    assert.equal(paged.json.runs.length, 10);

    const sweepCold: number[] = [],
      sweepWarm: number[] = [],
      sweepBytes: number[] = [];
    for (let index = 0; index < 50; index++) {
      const id = `wf-${(index * 13 + 40) % (WORKFLOWS - SUBTASKS)}`;
      const first = await get(`/api/workflows/${id}/context`);
      const second = await get(`/api/workflows/${id}/context`);
      sweepCold.push(first.ms);
      sweepWarm.push(second.ms);
      sweepBytes.push(first.bytes);
    }
    const memoryEnd = process.memoryUsage();
    Object.assign(report, {
      ladderWithLargeRuns: {
        rows: cold.json.total,
        coldMs: ms(cold.ms),
        warmMs: ms(warm.ms),
        pollP50Ms: ms(percentile(polls, 50)),
        pollP95Ms: ms(percentile(polls, 95)),
        bytes: cold.bytes,
        pagedTenRowsBytes: paged.bytes,
      },
      largeRunDetail: {
        coldMs: ms(largeDetailCold.ms),
        warmMs: ms(largeDetailWarm.ms),
        bytes: largeDetailCold.bytes,
        note: "The cold ladder read already rebuilt this run's indexes from 10,000 audit events; that cost is in ladderWithLargeRuns.coldMs.",
      },
      ordinaryDetail: { coldMs: ms(detailCold.ms), warmMs: ms(detailWarm.ms), bytes: detailCold.bytes },
      sweep50Workflows: {
        coldP50Ms: ms(percentile(sweepCold, 50)),
        coldP95Ms: ms(percentile(sweepCold, 95)),
        warmP50Ms: ms(percentile(sweepWarm, 50)),
        warmP95Ms: ms(percentile(sweepWarm, 95)),
        maxBytes: Math.max(...sweepBytes),
      },
      memory: {
        rssStartMb: mb(memoryStart.rss),
        rssEndMb: mb(memoryEnd.rss),
        heapUsedStartMb: mb(memoryStart.heapUsed),
        heapUsedEndMb: mb(memoryEnd.heapUsed),
        note: 'RSS includes the seeding of the whole synthetic database in this process.',
      },
      tables: Object.fromEntries(
        ['usage_requests', 'tool_operations', 'run_context_parts'].map((table) => [
          table,
          (store!.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
        ]),
      ),
      node: process.version,
      platform: process.platform,
    });
    console.log(JSON.stringify(report, null, 2));
    if (process.env.TRACE_CONTEXT_SCALE_REPORT) {
      const out = resolve(process.env.TRACE_CONTEXT_SCALE_REPORT);
      mkdirSync(resolve(out, '..'), { recursive: true });
      writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
    }
    // Generous bounds: they catch whole-table scans, per-poll rebuilds or unbounded payloads, not machine speed.
    assert.ok(warm.ms < 500, `warm ladder ${warm.ms} ms`);
    assert.ok(percentile(polls, 95) < 500, `ladder poll p95 ${percentile(polls, 95)} ms`);
    assert.ok(largeDetailWarm.ms < 500, `warm large detail ${largeDetailWarm.ms} ms`);
    assert.ok(detailWarm.ms < 500, `warm detail ${detailWarm.ms} ms`);
    assert.ok(cold.bytes < 256 * 1024, `ladder ${cold.bytes} bytes`);
    assert.ok(largeDetailCold.bytes < 256 * 1024, `large detail ${largeDetailCold.bytes} bytes`);
    assert.ok(detailCold.bytes < 256 * 1024, `detail ${detailCold.bytes} bytes`);
  } finally {
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
    store?.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
