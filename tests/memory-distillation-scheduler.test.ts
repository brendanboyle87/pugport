import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { MemoryDistillationScheduler } from '../src/server/project-memory-scheduler.ts';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import type { Controller } from '../src/server/controller.ts';
import type { AutoNoteItem, Project, RunInput, RunRecord, RuntimeSnapshot, Workflow } from '../src/shared/types.ts';
import { distillationInput, type DistillationStats } from '../src/server/memory-distillation.ts';

const now = Date.parse('2026-10-12T12:00:00Z');
const iso = (offset = 0) => new Date(now + offset).toISOString();
const note =
  'add facts verified 有测试。 | p0\nadd decisions inferred 保留接口。 | p1\nadd pitfalls verified 检查边界。 | p2';
const renderedNote =
  'facts:\n- [verified] 有测试。 (p0)\ndecisions:\n- [inferred] 保留接口。 (p1)\npitfalls:\n- [verified] 检查边界。 (p2)';

function fixture(t: TestContext, timeoutMs = 1000) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE runs (id TEXT PRIMARY KEY, started_at TEXT, value TEXT)');
  const store = new WorkspaceStore(db);
  const runs = new Map<string, RunRecord>();
  const calls: RunInput[] = [];
  let idle = true,
    output = note,
    hanging = false,
    cancelled = 0;
  const snapshot: RuntimeSnapshot = {
    id: 'synthetic',
    provider: 'grok',
    label: 'Grok',
    environment: 'native',
    installed: true,
    status: 'ready',
    models: [{ id: 'mock', label: 'Mock', efforts: [] }],
    quota: {
      status: 'known',
      source: 'fixture',
      observedAt: iso(),
      windows: [{ id: 'week', label: 'Week', usedPercent: 10, resetsAt: iso(3600000), durationMinutes: 10080 }],
    },
    capabilities: { execute: true, resume: true, cancel: true, approvals: true, toolless: true },
    refreshedAt: iso(),
  };
  const controller = {
    settings: { memoryDistillation: { enabled: true }, reservePercent: 10, maxQuotaAgeSeconds: 180 },
    snapshots: [snapshot],
    targets: [
      { id: 'synthetic', provider: 'grok', label: 'Grok', command: 'never', environment: 'native', enabled: true },
    ],
    quotaHistory: { burnRates: () => undefined },
    usage: { begin() {} },
    store: {
      storedRun: (id: string) => runs.get(id),
      storedRunForDistillation: (id: string, since = 0): RunRecord | undefined => {
        const value = controller.store.storedRun(id);
        return value &&
          (!value.endedAt || !Number.isFinite(Date.parse(value.endedAt)) || Date.parse(value.endedAt) > since)
          ? value
          : undefined;
      },
      run: (id: string) => runs.get(id),
      saveRun: (run: RunRecord) => runs.set(run.id, run),
    },
    preview: () => ({ runtimeId: 'synthetic' }),
    broadcast() {},
    async start(
      input: RunInput,
      _lease: unknown,
      signal: AbortSignal,
      guard: () => void,
      created: (run: RunRecord) => void,
    ) {
      signal.throwIfAborted();
      guard();
      calls.push(input);
      const run = {
        id: 'distilled-' + calls.length,
        prompt: input.prompt,
        userInput: input.userInput,
        route: { runtimeId: input.runtimeId },
        startedAt: iso(),
        status: hanging ? 'running' : 'completed',
        endedAt: hanging ? undefined : iso(),
        output,
        events: [],
      } as unknown as RunRecord;
      runs.set(run.id, run);
      created(run);
      return run;
    },
    cancel(id: string) {
      cancelled++;
      const run = runs.get(id)!;
      run.status = 'cancelled';
      run.endedAt = iso();
    },
  } as unknown as Controller;
  const host = { controller, store, idle: () => idle, language: () => '使用简体中文。', now: () => now, timeoutMs };
  const scheduler = new MemoryDistillationScheduler(host);
  function addProject(id = 'p') {
    const project: Project = {
      id,
      name: id,
      path: 'C:/synthetic/' + id,
      createdAt: iso(-20000),
      updatedAt: iso(-1000),
    };
    store.save('project', id, id, project);
    store.save('conversation', id, id, { id, projectId: id, createdAt: iso(-20000), updatedAt: iso(-1000) });
    for (let n = 0; n < 5; n++) {
      const wid = id + n,
        rid = 'run-' + wid;
      const workflow = {
        id: wid,
        projectId: id,
        conversationId: id,
        userMessageId: 'msg-' + wid,
        input: { content: 'Synthetic progress '.repeat(250) },
        status: 'completed',
        plan: [],
        runIds: [rid],
        createdAt: iso(-10000),
        updatedAt: iso(-1000),
      } as unknown as Workflow;
      store.save('workflow', wid, id, workflow);
      runs.set(rid, {
        id: rid,
        workflowId: wid,
        projectPath: project.path,
        startedAt: iso(-5000),
        endedAt: iso(-1000),
        status: 'completed',
        events: [{ at: iso(-1000), type: 'tool', data: { tool: 'Edit', status: 'completed' } }],
      } as unknown as RunRecord);
    }
    return project;
  }
  const project = addProject();
  t.after(async () => {
    await scheduler.close();
    db.close();
  });
  return {
    controller,
    scheduler,
    store,
    project,
    calls,
    runs,
    host,
    addProject,
    idle: (value: boolean) => {
      idle = value;
    },
    output: (value: string) => {
      output = value;
    },
    hang: () => {
      hanging = true;
    },
    cancelled: () => cancelled,
  };
}

test('off, busy, no waste, stale quota and unsupported tool-less runtime skip automatic and manual attempts', async (t) => {
  const f = fixture(t);
  const scenarios = [
    () => {
      f.controller.settings.memoryDistillation!.enabled = false;
    },
    () => {
      f.controller.settings.memoryDistillation!.enabled = true;
      f.idle(false);
    },
    () => {
      f.idle(true);
      f.controller.snapshots[0]!.quota.windows[0]!.usedPercent = 100;
    },
    () => {
      f.controller.snapshots[0]!.quota.windows[0]!.usedPercent = 10;
      f.controller.snapshots[0]!.quota.observedAt = iso(-180000);
    },
    () => {
      f.controller.snapshots[0]!.quota.observedAt = iso();
      f.controller.snapshots[0]!.capabilities.toolless = false;
    },
  ];
  for (const configure of scenarios) {
    configure();
    await f.scheduler.check();
    assert.equal(f.scheduler.view(f.project).eligible, false);
    await assert.rejects(f.scheduler.check(f.project));
  }
  assert.equal(f.calls.length, 0);
  assert.equal(f.store.get('memory-distillation-history', 'global'), undefined);
});

test('valid result uses a strict read-only tool-less run, preserves owner memory and persists cooldown across clear/restart', async (t) => {
  const f = fixture(t);
  const owner = f.store.setMemory(f.project.id, '\ufeffOwner\r\nExact bytes\n');
  await f.scheduler.check(f.project);
  assert.equal(f.calls.length, 1);
  const input = f.calls[0]!;
  assert.equal(input.runtimeId, 'synthetic');
  assert.equal(input.untrustedContent, true);
  assert.equal(input.permissionMode, 'read-only');
  assert.equal(input.agentCalls, false);
  assert.equal(input.allowExecutorFallback, false);
  assert.equal(input.memoryDistillation, true);
  assert.equal(input.userInput, '整理项目记忆');
  assert.equal(input.workflowId, undefined);
  assert.equal(input.resumeRunId, undefined);
  assert.match(input.prompt, /不可信历史数据/);
  assert.match(input.prompt, /使用简体中文/);
  assert.equal(f.store.memoryAuto('p')?.content, renderedNote);
  assert.equal(f.store.memoryAuto('p')?.runId, 'distilled-1');
  assert.deepEqual(f.store.memory('p'), owner);
  assert.equal(f.store.messages('p').length, 0);
  f.scheduler.clear(f.project);
  assert.equal(f.store.memoryAuto('p'), undefined);
  assert.deepEqual(f.store.memory('p'), owner);
  const restarted = new MemoryDistillationScheduler(f.host);
  await restarted.check();
  await assert.rejects(restarted.check(f.project));
  assert.equal(f.calls.length, 1);
  await restarted.close();
});

test('invalid notes are discarded, fail the normal run and consume the next eligible slot', async (t) => {
  const f = fixture(t);
  f.output('not a note');
  await f.scheduler.check();
  await f.scheduler.check();
  assert.equal(f.calls.length, 1);
  assert.equal(f.store.memoryAuto('p'), undefined);
  assert.equal(f.runs.get('distilled-1')!.status, 'failed');
  assert.equal(
    f.store.get<{ attempts: { status: string }[] }>('memory-distillation-history', 'global')!.attempts[0]!.status,
    'failed',
  );
  // An unsuccessful attempt must not advance the "new since the last note" watermark.
  f.host.now = () => now + 86400000;
  f.controller.snapshots[0]!.quota.observedAt = iso(86400000);
  f.controller.snapshots[0]!.quota.windows[0]!.resetsAt = iso(90000000);
  f.output(note);
  await f.scheduler.check(f.project);
  assert.equal(f.calls.length, 2);
  assert.equal(f.store.memoryAuto('p')?.content, renderedNote);
  assert.match(f.calls[1]!.prompt, /Synthetic progress/);
});

test('a completed invalid distillation cannot recreate a run after its owner was purged before the next poll', async (t) => {
  const f = fixture(t);
  f.output('not a note');
  f.hang();
  const pending = f.scheduler.check(f.project);
  for (let turn = 0; !f.runs.has('distilled-1') && turn < 10; turn++) await Promise.resolve();
  const run = f.runs.get('distilled-1')!;
  assert.ok(run);
  run.status = 'completed';
  run.endedAt = iso();
  f.store.db.prepare("DELETE FROM workspace_records WHERE kind='project' AND id=?").run(f.project.id);
  f.runs.delete(run.id);
  const saves = t.mock.method(f.controller.store, 'saveRun');
  await pending;
  assert.equal(saves.mock.callCount(), 0);
  assert.equal(f.runs.get(run.id), undefined);
  assert.equal(f.store.memoryAuto(f.project.id), undefined);
  assert.equal(
    f.store.get<{ attempts: { status: string }[] }>('memory-distillation-history', 'global')?.attempts.at(-1)?.status,
    'failed',
  );
});

test('hard deadline cancels and concurrent triggers cannot double spend', async (t) => {
  const f = fixture(t, 15);
  f.hang();
  const pending = f.scheduler.check();
  await f.scheduler.check();
  await pending;
  assert.equal(f.calls.length, 1);
  assert.equal(f.cancelled(), 1);
  assert.equal(f.store.memoryAuto('p'), undefined);
  assert.equal(f.runs.get('distilled-1')!.status, 'cancelled');
});

test('the production deadline is ten minutes and shutdown cancels an unfinished run', async (t) => {
  const f = fixture(t);
  delete (f.host as { timeoutMs?: number }).timeoutMs;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  f.hang();
  const pending = f.scheduler.check();
  // An automatic check yields before scanning, so the deadline starts once the run has started.
  while (!f.calls.length) await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(599999);
  assert.equal(f.cancelled(), 0);
  t.mock.timers.tick(1);
  await pending;
  assert.equal(f.cancelled(), 1);
  const project = f.addProject('shutdown');
  const stopping = f.scheduler.check(project);
  await f.scheduler.close();
  await stopping;
  assert.equal(f.cancelled(), 2);
  assert.equal(f.store.memoryAuto(project.id), undefined);
});

test('periodic checks run at ten-minute intervals and keep the disabled switch inert', async (t) => {
  const f = fixture(t);
  t.mock.timers.enable({ apis: ['setInterval'] });
  f.controller.settings.memoryDistillation!.enabled = false;
  f.scheduler.start();
  // Automatic checks yield between projects, so give them a few turns before looking.
  const turns = async () => {
    for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve));
  };
  t.mock.timers.tick(600000);
  await turns();
  assert.equal(f.calls.length, 0);
  f.controller.settings.memoryDistillation!.enabled = true;
  t.mock.timers.tick(599999);
  await turns();
  assert.equal(f.calls.length, 0);
  t.mock.timers.tick(1);
  await turns();
  assert.equal(f.calls.length, 1);
  await f.scheduler.close();
});

test('global cap includes failures and applies to manual regeneration', async (t) => {
  const f = fixture(t);
  f.output('invalid');
  const projects = [f.project, f.addProject('b'), f.addProject('c'), f.addProject('d')];
  for (const project of projects.slice(0, 3)) await f.scheduler.check(project);
  assert.equal(f.calls.length, 3);
  await assert.rejects(f.scheduler.check(projects[3]!));
  assert.equal(f.calls.length, 3);
});

test('last-moment foreground arrival cancels admission without trying a fallback', async (t) => {
  const f = fixture(t);
  const start = f.controller.start.bind(f.controller);
  t.mock.method(f.controller, 'start', async (...args: Parameters<Controller['start']>) => {
    f.idle(false);
    return start(...args);
  });
  await f.scheduler.check();
  assert.equal(f.calls.length, 0);
  assert.equal(f.store.memoryAuto('p'), undefined);
});

test('threshold accounting shares input filters and does not count old text again', (t) => {
  const f = fixture(t);
  const stats: DistillationStats = { workflows: [] };
  distillationInput(f.project, { store: f.store, run: (id) => f.runs.get(id) }, 0, stats);
  assert.equal(stats.workflows.length, 5);
  assert.ok(stats.workflows.reduce((sum, item) => sum + item.usableCharacters, 0) >= 20000);
  const fresh: DistillationStats = { workflows: [] };
  const text = distillationInput(f.project, { store: f.store, run: (id) => f.runs.get(id) }, now - 3000, fresh);
  assert.doesNotMatch(text, /Synthetic progress/);
  for (let n = 0; n < 5; n++) assert.match(text, new RegExp(`Task p${n}\\nRun run-p${n}`));
  assert.ok(fresh.workflows.reduce((sum, item) => sum + item.usableCharacters, 0) < 20000);
  const conversation = f.store.conversations('p')[0]!;
  f.store.save('conversation', conversation.id, 'p', { ...conversation, sideChat: { parentConversationId: 'parent' } });
  const excluded: DistillationStats = { workflows: [] };
  assert.equal(distillationInput(f.project, { store: f.store, run: (id) => f.runs.get(id) }, 0, excluded), '');
  assert.equal(excluded.workflows.length, 0);
});

test('cumulative notes retain an earlier fact when later history only corrects a pitfall and adds a decision', async (t) => {
  const f = fixture(t);
  f.output('add facts verified Tests use .runtime/node.exe | p0\nadd pitfalls inferred Old pitfall | p1');
  await f.scheduler.check(f.project);
  f.host.now = () => now + 86400000;
  f.controller.snapshots[0]!.quota.observedAt = iso(86400000);
  f.controller.snapshots[0]!.quota.windows[0]!.resetsAt = iso(90000000);
  for (let n = 0; n < 5; n++) {
    const id = `fresh-${n}`,
      rid = `run-${id}`;
    f.store.save('workflow', id, 'p', {
      id,
      projectId: 'p',
      conversationId: 'p',
      userMessageId: `msg-${id}`,
      input: { content: 'Unrelated synthetic progress '.repeat(180) },
      status: 'completed',
      plan: [],
      runIds: [rid],
      createdAt: iso(1000),
      updatedAt: iso(2000),
    } as unknown as Workflow);
    f.runs.set(rid, {
      id: rid,
      workflowId: id,
      projectPath: f.project.path,
      startedAt: iso(1000),
      endedAt: iso(2000),
      status: 'completed',
      events: [{ at: iso(2000), type: 'tool', data: { tool: 'Edit', status: 'completed' } }],
    } as unknown as RunRecord);
  }
  const stats: DistillationStats = { workflows: [] };
  const fresh = distillationInput(f.project, { store: f.store, run: (id) => f.runs.get(id) }, now, stats);
  assert.equal(stats.workflows.length, 5);
  assert.ok(stats.workflows.reduce((sum, item) => sum + item.usableCharacters, 0) >= 20000);
  assert.doesNotMatch(fresh, /Tests use|node.exe/);
  f.output('replace P1 verified Corrected pitfall | fresh-0\nadd decisions verified Keep the API stable | fresh-1');
  await f.scheduler.check(f.project);
  assert.equal(f.calls.length, 2);
  const content = f.store.memoryAuto('p')?.content ?? '';
  assert.match(content, /Tests use \.runtime\/node\.exe/, 'run-1 fact must survive run-2 changes');
  assert.doesNotMatch(content, /Old pitfall/);
  assert.match(content, /Corrected pitfall/);
  assert.match(content, /Keep the API stable/);
  assert.match(f.calls[1]!.prompt, /F1 \[verified\] Tests use \.runtime\/node\.exe/);
  assert.equal(f.store.memoryAuto('p')!.items!.length, 3);
});

test('empty output fails without consuming the old source history', async (t) => {
  const f = fixture(t);
  f.output('');
  await f.scheduler.check(f.project);
  assert.equal(f.runs.get('distilled-1')!.status, 'failed');
  assert.equal(f.store.memoryAuto('p'), undefined);
  f.host.now = () => now + 86400000;
  f.controller.snapshots[0]!.quota.observedAt = iso(86400000);
  f.controller.snapshots[0]!.quota.windows[0]!.resetsAt = iso(90000000);
  f.output(note);
  await f.scheduler.check(f.project);
  assert.equal(f.calls.length, 2);
  assert.match(f.calls[1]!.prompt, /Synthetic progress/);
  assert.equal(f.store.memoryAuto('p')?.content, renderedNote);
});

test('none preserves a legacy record exactly while completing the attempt', async (t) => {
  const f = fixture(t);
  const legacy = f.store.setMemoryAuto('p', {
    content: 'facts:\n- Legacy fact\ndecisions:\n* Keep API\npitfalls:\n1. Check inputs',
    sourceRuntimeId: 'old',
    runId: 'old-run',
  });
  f.output('none');
  await f.scheduler.check(f.project);
  assert.deepEqual(f.store.memoryAuto('p'), legacy);
  assert.match(f.calls[0]!.prompt, /F1 \[inferred\] Legacy fact/);
  assert.equal(f.runs.get('distilled-1')!.status, 'completed');
  assert.equal(
    f.store.get<{ attempts: { status: string }[] }>('memory-distillation-history', 'global')!.attempts[0]!.status,
    'completed',
  );
  f.host.now = () => now + 86400000;
  f.controller.snapshots[0]!.quota.observedAt = iso(86400000);
  f.controller.snapshots[0]!.quota.windows[0]!.resetsAt = iso(90000000);
  await f.scheduler.check();
  assert.equal(f.calls.length, 1);
});

test('a correction at the full budget survives ahead of an older untouched inferred item', async (t) => {
  const f = fixture(t);
  const items: AutoNoteItem[] = Array.from({ length: 6 }, (_, n) => ({
    section: 'facts',
    text: `Old ${n} ${'x'.repeat(184)}`,
    status: 'inferred',
    source: 'task',
    at: iso(-10000 + n),
  }));
  items.push({ section: 'pitfalls', text: 'Old pitfall', status: 'inferred', source: 'task', at: iso(-1000) });
  const render = () =>
    `facts:\n${items
      .slice(0, 6)
      .map((item) => `- [inferred] ${item.text} (task)`)
      .join('\n')}\npitfalls:\n- [inferred] ${items[6]!.text} (task)`;
  items[6]!.text += 'z'.repeat(1500 - render().length);
  assert.equal(render().length, 1500);
  f.store.setMemoryAuto('p', { content: render(), items, sourceRuntimeId: 'old', runId: 'old-run' });
  f.output(`replace P1 verified Corrected ${'y'.repeat(190)} | task`);
  await f.scheduler.check(f.project);
  const note = f.store.memoryAuto('p')!;
  assert.ok(note.content.length <= 1500);
  assert.match(note.content, /Corrected/);
  assert.doesNotMatch(note.content, /Old pitfall|Old 0/);
  assert.match(note.content, /Old 1/);
});

test('dropping the final item removes the automatic record without clearing attempt history', async (t) => {
  const f = fixture(t);
  f.store.setMemoryAuto('p', { content: 'facts:\nOnly fact', sourceRuntimeId: 'old', runId: 'old-run' });
  f.output('drop F1');
  await f.scheduler.check(f.project);
  assert.equal(f.store.memoryAuto('p'), undefined);
  assert.equal(f.runs.get('distilled-1')!.status, 'completed');
  await assert.rejects(f.scheduler.check(f.project));
  assert.equal(f.calls.length, 1);
});

test('synthetic 500 MiB audit workload: ineligible checks read zero archives and cache dialog stats for 60 seconds', async (t) => {
  const f = fixture(t);
  const projects = [f.project, ...Array.from({ length: 9 }, (_, n) => f.addProject('pressure-' + n))];
  for (const project of projects)
    for (const workflow of f.store.workflows(project.id)) {
      workflow.input.content = 'small synthetic task';
      f.store.save('workflow', workflow.id, project.id, workflow);
    }
  let archives = 0,
    peak = 0;
  const usage = () => {
    peak = Math.max(peak, process.memoryUsage().heapUsed);
  };
  const audit = (id: string) => {
    archives++;
    // Materialized JSON matches withAudit's allocation; 50 runs * 10 MiB.
    const payload = JSON.parse(JSON.stringify('x'.repeat(10 * 1024 * 1024))) as string;
    const run = {
      ...f.runs.get(id)!,
      events: [{ at: iso(-1000), type: 'tool' as const, data: { tool: 'Edit', output: payload } }],
    };
    usage();
    return run;
  };
  global.gc?.();
  const before = process.memoryUsage().heapUsed;
  peak = before;
  // Former prepare path: generate input and stats with audit-expanded runs for every project.
  for (const project of projects) distillationInput(project, { store: f.store, run: audit }, 0, { workflows: [] });
  const oldPeak = peak - before;
  assert.equal(archives, 50);
  archives = 0;
  t.mock.method(f.controller.store, 'run', audit);
  const light = t.mock.method(f.controller.store, 'storedRun', (id: string) => {
    usage();
    return f.runs.get(id);
  });
  global.gc?.();
  const after = process.memoryUsage().heapUsed;
  peak = after;
  await f.scheduler.check();
  usage();
  assert.equal(archives, 0);
  assert.equal(f.calls.length, 0);
  const newPeak = peak - after;
  assert.ok(newPeak < 50 * 1024 * 1024, String(newPeak));
  // The check above already read every task once; unchanged tasks are never read again, by a view or a later check.
  const reads = light.mock.callCount();
  assert.equal(reads, 50);
  f.scheduler.view(f.project);
  f.host.now = () => now + 60000;
  f.scheduler.view(f.project);
  await f.scheduler.check();
  assert.equal(light.mock.callCount(), reads);
  // One task changes: only its run is read, once the dialog's 60-second view has lapsed.
  const changed = f.store.workflows(f.project.id)[0]!;
  f.store.save('workflow', changed.id, f.project.id, { ...changed, updatedAt: iso(-500) });
  f.scheduler.view(f.project);
  assert.equal(light.mock.callCount(), reads, 'the dialog keeps its view for 60 seconds');
  f.host.now = () => now + 120000;
  f.scheduler.view(f.project);
  assert.equal(light.mock.callCount(), reads + 1);
  t.diagnostic(
    JSON.stringify({
      syntheticAuditMiB: 500,
      oldAuditReads: 50,
      newAuditReads: archives,
      oldPeakHeapMiB: oldPeak / 1024 ** 2,
      newPeakHeapMiB: newPeak / 1024 ** 2,
    }),
  );
});

test('input stops before reading more runs at the character cap; one eligible project produces one prompt', async (t) => {
  const f = fixture(t);
  f.addProject('other');
  for (const workflow of f.store.workflows('p')) {
    workflow.input.content = 'synthetic '.repeat(5000);
    f.store.save('workflow', workflow.id, 'p', workflow);
  }
  let reads = 0;
  const input = distillationInput(f.project, {
    store: f.store,
    run: (id) => {
      reads++;
      return f.runs.get(id);
    },
  });
  assert.equal(input.length, 40000);
  assert.equal(reads, 0);
  t.mock.method(f.controller.store, 'run', () => {
    throw Error('audit archive must not be read');
  });
  await f.scheduler.check();
  assert.equal(f.calls.length, 1);
  assert.ok(f.calls[0]!.prompt.length < 41000);
});

// Regression: one automatic check scanned every project in a single turn and blocked the backend for 26 s.
test('an automatic check yields between projects and never runs twice at once', async (t) => {
  const f = fixture(t);
  f.store.save('project', 'p', 'p', { ...f.project, scope: 'chat' });
  for (let index = 0; index < 6; index++) {
    const id = 'quiet-' + index;
    f.store.save('project', id, id, { ...f.project, id, name: id, path: 'C:/synthetic/' + id });
    f.store.save('conversation', id, id, { id, projectId: id, createdAt: iso(-20000), updatedAt: iso(-1000) });
  }
  let turn = 0,
    spinning = true;
  const spin = () => {
    turn++;
    if (spinning) setImmediate(spin);
  };
  setImmediate(spin);
  const scans: number[] = [];
  const conversations = f.store.conversations.bind(f.store);
  f.store.conversations = ((projectId?: string) => {
    scans.push(turn);
    return conversations(projectId);
  }) as typeof f.store.conversations;
  await Promise.all([f.scheduler.check(), f.scheduler.check()]);
  spinning = false;
  assert.equal(scans.length, 6);
  assert.equal(new Set(scans).size, scans.length, 'each project is scanned in its own event-loop turn');
  assert.equal(f.calls.length, 0);
});

// Regression: the first scan of one large project still held the backend for 11 s, and every check read it all again.
test('a project with many unread tasks is read a little at a time, and work arriving in between ends the check', async (t) => {
  const f = fixture(t);
  const projects = [f.project, ...Array.from({ length: 4 }, (_, n) => f.addProject('large-' + n))];
  // Too little new text to qualify, so the check looks at every project and starts no run.
  for (const project of projects)
    for (const workflow of f.store.workflows(project.id))
      f.store.save('workflow', workflow.id, project.id, { ...workflow, input: { content: 'small synthetic task' } });
  let turn = 0,
    spinning = true;
  const spin = () => {
    turn++;
    if (spinning) setImmediate(spin);
  };
  setImmediate(spin);
  // A failed assertion must not leave the counter turning and the test process alive.
  t.after(() => {
    spinning = false;
  });
  const reads: number[] = [];
  const stored = f.controller.store.storedRun;
  t.mock.method(f.controller.store, 'storedRun', (id: string) => {
    reads.push(turn);
    // Each read costs 15 ms, as a run with a long event history does.
    for (const until = performance.now() + 15; performance.now() < until;);
    return stored(id);
  });
  await f.scheduler.check();
  assert.equal(reads.length, 25);
  assert.ok(
    new Set(reads).size >= 10,
    `25 reads of 15 ms span many turns, not one per project: ${new Set(reads).size}`,
  );
  // Nothing changed: the next check reads nothing.
  await f.scheduler.check();
  assert.equal(reads.length, 25);
  // A task arrives while a changed project is being read: the check stops instead of holding the loop.
  for (const workflow of f.store.workflows('large-3'))
    f.store.save('workflow', workflow.id, 'large-3', { ...workflow, updatedAt: iso(-400) });
  let allowed = 2;
  f.idle(true);
  const idle = f.host.idle;
  f.host.idle = () => (reads.length - 25 < allowed ? idle() : false);
  await f.scheduler.check();
  spinning = false;
  assert.ok(reads.length - 25 >= allowed && reads.length - 25 < 5, String(reads.length - 25));
  assert.equal(f.calls.length, 0);
  allowed = Infinity;
});

test('the numbers survive a restart in a file that holds no task text', async (t) => {
  const f = fixture(t);
  const dataDir = mkdtempSync(join(tmpdir(), 'pugport-distillation-scan-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  (f.controller as unknown as { dataDir: string }).dataDir = dataDir;
  // Too little new text to qualify: the check only gathers numbers and starts no run.
  for (const workflow of f.store.workflows(f.project.id))
    f.store.save('workflow', workflow.id, f.project.id, { ...workflow, input: { content: 'small synthetic task' } });
  const read = t.mock.method(f.controller.store, 'storedRun');
  await f.scheduler.check();
  assert.equal(read.mock.callCount(), 5);
  await f.scheduler.close();
  const saved = readFileSync(join(dataDir, 'memory-distillation-scan.json'), 'utf8');
  assert.doesNotMatch(saved, /Synthetic progress|C:\/synthetic/);
  const parsed = JSON.parse(saved) as { version: number; projects: Record<string, unknown[][]> };
  assert.equal(parsed.version, 1);
  assert.equal(parsed.projects.p!.length, 5);
  assert.ok(parsed.projects.p!.every((row) => row.slice(2).every((value) => typeof value === 'number')));
  // A new backend on the same data reads nothing for unchanged tasks, and still reaches the same decision.
  const restarted = new MemoryDistillationScheduler(f.host);
  t.after(() => restarted.close());
  const before = restarted.view(f.project);
  assert.equal(read.mock.callCount(), 5);
  assert.deepEqual([before.eligible, before.reason], [f.scheduler.view(f.project).eligible, before.reason]);
  // A damaged file is ignored and rebuilt.
  writeFileSync(join(dataDir, 'memory-distillation-scan.json'), '{not json');
  const rebuilt = new MemoryDistillationScheduler(f.host);
  t.after(() => rebuilt.close());
  rebuilt.view(f.project);
  assert.equal(read.mock.callCount(), 10);
});
