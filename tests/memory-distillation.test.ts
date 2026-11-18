import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
  defaultMemoryDistillation,
  shouldDistill,
  distillationInput,
  pickDistiller,
  parseNoteChanges,
  noteItems,
  renderNote,
  mergeNote,
  distillationPrompt,
  type DistillationStats,
} from '../src/server/memory-distillation.ts';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import type {
  AutoNoteItem,
  ProjectMemoryAuto,
  Project,
  Workflow,
  RuntimeSnapshot,
  RuntimeTarget,
  Settings,
  RunRecord,
} from '../src/shared/types.ts';

const now = Date.parse('2026-10-12T12:00:00.000Z');
const day = 86400000;
const iso = (offset = 0) => new Date(now + offset).toISOString();
const project = {
  id: 'p',
  name: 'Synthetic',
  path: 'C:/synthetic/project',
  createdAt: iso(),
  updatedAt: iso(),
} as Project;
const small = (id: string) => ({
  id,
  finishedAt: iso(-1000),
  toolEvents: 1,
  durationMs: 1000,
  eventCount: 1,
  usableCharacters: 4000,
});
const stats: DistillationStats = { workflows: Array.from({ length: 5 }, (_, i) => small(String(i))) };

test('distillation thresholds, new text, deduplication and project/global cooldowns', () => {
  assert.equal(shouldDistill(project, stats, now), true);
  assert.equal(shouldDistill({ ...project, scope: 'chat' }, stats, now), false);
  assert.equal(shouldDistill(project, { workflows: stats.workflows.slice(1) }, now), false);
  assert.equal(
    shouldDistill(project, { workflows: stats.workflows.map((item) => ({ ...item, toolEvents: 0 })) }, now),
    false,
  );
  assert.equal(
    shouldDistill(project, { workflows: stats.workflows.map((item) => ({ ...item, usableCharacters: 3999 })) }, now),
    false,
  );
  assert.equal(
    shouldDistill(project, { workflows: stats.workflows.map((item) => ({ ...item, id: 'same' })) }, now),
    false,
  );
  const long = { ...small('long'), durationMs: 20 * 60000, usableCharacters: 20000 };
  assert.equal(shouldDistill(project, { workflows: [long] }, now), true);
  assert.equal(
    shouldDistill(project, { workflows: [{ ...long, finishedAt: undefined, updatedAt: iso(-1) }] }, now),
    true,
  );
  assert.equal(
    shouldDistill(
      project,
      { workflows: stats.workflows.map((item) => ({ ...item, finishedAt: undefined, updatedAt: iso(-1) })) },
      now,
    ),
    false,
  );
  assert.equal(shouldDistill(project, { workflows: [{ ...long, durationMs: long.durationMs - 1 }] }, now), false);
  assert.equal(shouldDistill(project, { workflows: [{ ...long, durationMs: 1, eventCount: 300 }] }, now), true);
  assert.equal(shouldDistill(project, { workflows: [{ ...long, usableCharacters: 19999 }] }, now), false);
  assert.equal(shouldDistill(project, stats, now, [{ projectId: 'p', at: iso(-day + 1) }]), false);
  assert.equal(shouldDistill(project, stats, now, [{ projectId: 'p', at: iso(-day) }]), true);
  assert.equal(
    shouldDistill(
      project,
      { workflows: stats.workflows.map((item) => ({ ...item, finishedAt: iso(-2 * day) })) },
      now,
      [{ projectId: 'p', at: iso(-day) }],
    ),
    false,
  );
  const history = ['a', 'b', 'c'].map((projectId) => ({ projectId, at: iso(-1000) }));
  assert.equal(shouldDistill(project, stats, now, history), false);
  assert.equal(shouldDistill(project, stats, now, history.slice(1)), true);
  assert.equal(
    shouldDistill(
      project,
      stats,
      now,
      history.map((item) => ({ ...item, at: iso(-day) })),
    ),
    true,
  );
});

const settings: Pick<Settings, 'memoryDistillation' | 'automaticExecutors' | 'reservePercent' | 'maxQuotaAgeSeconds'> =
  {
    memoryDistillation: { enabled: true },
    reservePercent: 10,
    maxQuotaAgeSeconds: 180,
  };
function snapshot(id: string, provider: RuntimeSnapshot['provider'] = 'codex'): RuntimeSnapshot {
  return {
    id,
    provider,
    label: id,
    environment: 'native',
    installed: true,
    status: 'ready',
    models: [{ id: 'model', label: 'Model', efforts: ['low'] }],
    quota: {
      status: 'known',
      observedAt: iso(),
      source: 'synthetic',
      windows: [{ id: 'weekly', label: 'Weekly', usedPercent: 10, resetsAt: iso(day), durationMinutes: 7 * 24 * 60 }],
    },
    capabilities: { execute: true, resume: true, cancel: true, approvals: true },
    refreshedAt: iso(),
  };
}
const target = (s: RuntimeSnapshot): RuntimeTarget => ({
  id: s.id,
  provider: s.provider,
  label: s.label,
  command: 'never-execute',
  enabled: true,
  environment: 'native',
});

test('distiller intersects waste and executor checklist; Claude and paid APIs require opt-in', () => {
  const codex = snapshot('codex');
  const claude = snapshot('claude', 'claude');
  const api = { ...snapshot('api', 'pi'), gateway: 'api' as const, authMode: 'apiKey' as const };
  const all = [claude, api, codex];
  const targets = all.map(target);
  assert.equal(pickDistiller(all, targets, settings, undefined, now)?.runtimeId, 'codex');
  assert.equal(pickDistiller([claude, api], targets, settings, undefined, now), undefined);
  assert.equal(
    pickDistiller(all, targets, { ...settings, excludedExecutors: all.map((item) => item.id) }, undefined, now),
    undefined,
  );
  assert.equal(
    pickDistiller(
      all,
      targets,
      { ...settings, automaticExecutors: ['claude'], memoryDistillation: { enabled: true, executors: ['claude'] } },
      undefined,
      now,
    )?.runtimeId,
    'claude',
  );
  assert.equal(
    pickDistiller(
      [api],
      targets,
      { ...settings, memoryDistillation: { enabled: true, executors: ['api'] } },
      undefined,
      now,
    )?.runtimeId,
    'api',
  );
  assert.equal(pickDistiller([codex], [{ ...target(codex), enabled: false }], settings, undefined, now), undefined);
  assert.equal(
    pickDistiller([codex], [{ ...target(codex), executionDisabledByUser: true }], settings, undefined, now),
    undefined,
  );
});

test('stale, future, unknown and non-wasting quota never select a distiller', () => {
  const codex = snapshot('codex');
  const targets = [target(codex)];
  for (const observedAt of [iso(-180000), iso(1000), null, 'invalid'])
    assert.equal(
      pickDistiller([{ ...codex, quota: { ...codex.quota, observedAt } }], targets, settings, undefined, now),
      undefined,
    );
  assert.equal(
    pickDistiller([{ ...codex, quota: { ...codex.quota, status: 'unknown' } }], targets, settings, undefined, now),
    undefined,
  );
  assert.equal(
    pickDistiller([{ ...codex, quota: { ...codex.quota, windows: [] } }], targets, settings, undefined, now),
    undefined,
  );
  assert.equal(pickDistiller([], targets, settings, undefined, now), undefined);
  const lowWaste = { ...codex, quota: { ...codex.quota, windows: [{ ...codex.quota.windows[0]!, usedPercent: 70 }] } };
  assert.equal(pickDistiller([lowWaste], targets, settings, undefined, now), undefined);
});

test('input excludes third-party, untrusted and side chats, payloads, attachments and absolute paths', (t) => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE runs (id TEXT PRIMARY KEY, started_at TEXT, value TEXT)');
  const store = new WorkspaceStore(db);
  t.after(() => db.close());
  store.save('project', 'p', 'p', project);
  const runs = new Map<string, RunRecord>();
  const add = (id: string, patch: Partial<Workflow> = {}, conversationPatch = {}) => {
    store.save('conversation', id, 'p', {
      id,
      projectId: 'p',
      createdAt: iso(),
      updatedAt: iso(),
      ...conversationPatch,
    });
    const workflow = {
      id,
      projectId: 'p',
      conversationId: id,
      userMessageId: `m-${id}`,
      input: { content: `TASK_${id}`, attachments: [{ text: 'ATTACHMENT_SECRET' }] },
      plan: [{ title: 'keep parser stable', status: 'completed' }],
      runIds: [`r-${id}`],
      updatedAt: iso(),
      ...patch,
    } as unknown as Workflow;
    store.save('workflow', id, id, workflow);
    store.save('message', `m-${id}`, id, { id: `m-${id}`, conversationId: id, content: 'original', role: 'user' });
    runs.set(`r-${id}`, {
      id: `r-${id}`,
      workflowId: id,
      projectPath: project.path,
      status: 'completed',
      output: 'RAW_RUN_OUTPUT',
      prompt: 'RAW_PROMPT',
      events: [
        { type: 'text', text: 'RAW_TEXT_EVENT' },
        {
          type: 'tool',
          text: 'RAW_TOOL_TEXT',
          data: {
            tool: 'Edit',
            status: 'completed',
            input: { path: 'C:/synthetic/project/src/parser.ts', new_string: 'FILE_CONTENT' },
            output: 'RAW_TOOL_OUTPUT',
          },
        },
        { type: 'tool', data: { tool: 'Edit', input: { path: 'C:/outside/private.ts' } } },
      ],
    } as unknown as RunRecord);
    return workflow;
  };
  const trusted = add('trusted');
  trusted.input.content +=
    ' C:/synthetic/project/src/request.ts C:/outside/private.ts /etc/private password=synthetic-secret ```file content SECRET_CODE```';
  store.save('workflow', trusted.id, trusted.conversationId, trusted);
  add('third', {
    input: { content: 'TASK_third', externalRequest: { thirdParty: true } } as unknown as Workflow['input'],
  });
  add('untrusted', { input: { content: 'TASK_untrusted', untrustedContent: true } as Workflow['input'] });
  add('side', {}, { sideChat: { parentConversationId: 'trusted' } });
  add('tainted', {}, { untrustedContent: true });
  add('origin');
  store.save('message', 'm-origin', 'origin', { conversationId: 'origin', externalAgent: { untrusted: true } });
  add('other-project', { projectId: 'elsewhere' });
  const input = distillationInput(project, { store, run: (id) => runs.get(id) });
  assert.match(input, /TASK_trusted/);
  assert.match(input, /src\/parser.ts/);
  assert.match(input, /src\/request.ts/);
  assert.doesNotMatch(
    input,
    /TASK_(?:third|untrusted|side|tainted|origin|other-project)|RAW_|FILE_CONTENT|ATTACHMENT_SECRET|SECRET_CODE|synthetic-secret|C:|outside|\/etc/,
  );
  assert.equal(distillationInput({ ...project, scope: 'chat' }, { store, run: (id) => runs.get(id) }), '');
  trusted.input.content = 'Usable text '.repeat(10000);
  store.save('workflow', trusted.id, trusted.conversationId, trusted);
  assert.ok(distillationInput(project, { store, run: (id) => runs.get(id) }).length <= 40000);
  assert.equal(distillationInput(project, { store, run: (id) => runs.get(id) }, now), '');
});

test('change parser accepts case-insensitive forms, ignores stray lines and bounds sanitized fields', () => {
  assert.deepEqual(
    parseNoteChanges(
      '- ADD FACTS VERIFIED A | B | 12345678-1234-1234-1234-123456789abc\nstray\n- REPLACE p1 INFERRED Better | task\n- DROP d2\n- NONE',
    ),
    [
      { kind: 'add', section: 'facts', status: 'verified', text: 'A | B', source: '12345678' },
      { kind: 'replace', id: 'P1', status: 'inferred', text: 'Better', source: 'task' },
      { kind: 'drop', id: 'D2' },
    ],
  );
  for (const none of [
    'NONE',
    'None.',
    'none。',
    'none!',
    'none！',
    '`none`',
    '`None`.',
    '`none`。',
    '`none`!',
    '`none`！',
  ])
    assert.deepEqual(parseNoteChanges(none), [], none);
  assert.deepEqual(
    parseNoteChanges(
      '1. add facts verified A | task\n2. replace p1 inferred Better | task\n3. drop d2\n* add decisions inferred B | task\n4. `none`.',
    ),
    [
      { kind: 'add', section: 'facts', status: 'verified', text: 'A', source: 'task' },
      { kind: 'replace', id: 'P1', status: 'inferred', text: 'Better', source: 'task' },
      { kind: 'drop', id: 'D2' },
      { kind: 'add', section: 'decisions', status: 'inferred', text: 'B', source: 'task' },
    ],
  );
  const changes = parseNoteChanges(
    `add facts inferred ${'a'.repeat(201)} | ${'s'.repeat(41)}\nadd decisions verified password=synthetic-secret | task`,
  )!;
  assert.deepEqual(changes[0], {
    kind: 'add',
    section: 'facts',
    status: 'inferred',
    text: 'a'.repeat(200),
    source: 's'.repeat(40),
  });
  assert.doesNotMatch(JSON.stringify(changes), /synthetic-secret/);
  assert.match(JSON.stringify(changes), /redacted/);
  for (const invalid of [
    '',
    '  ',
    'none..',
    '`none',
    'none`',
    'stray\nadd facts verified missing source\ndrop X1\nreplace F0 inferred bad | task',
    'x'.repeat(1501),
    'none\n```code```',
    'none\n~~~',
    'none\n<<<marker',
    'none\n<tag>',
  ])
    assert.equal(parseNoteChanges(invalid), undefined);
});

const item = (text: string, patch: Partial<AutoNoteItem> = {}): AutoNoteItem => ({
  section: 'facts',
  text,
  status: 'inferred',
  source: 'old',
  at: iso(-day),
  ...patch,
});

test('legacy headings and bullets become inferred items; prompt IDs are section-local and JSON encoded', () => {
  const previous = noteItems({
    content:
      'ignored\n FACTS: \n- Old fact\n* Other fact\n\nDecisions: Keep API\n1. Keep tests\npitfalls:\nWatch escapes',
    updatedAt: iso(),
  } as ProjectMemoryAuto);
  assert.deepEqual(
    previous.map(({ section, text, status, source, at }) => [section, text, status, source, at]),
    [
      ['facts', 'Old fact', 'inferred', '', iso()],
      ['facts', 'Other fact', 'inferred', '', iso()],
      ['decisions', 'Keep API', 'inferred', '', iso()],
      ['decisions', 'Keep tests', 'inferred', '', iso()],
      ['pitfalls', 'Watch escapes', 'inferred', '', iso()],
    ],
  );
  assert.equal(
    renderNote(previous),
    'facts:\n- [inferred] Old fact\n- [inferred] Other fact\ndecisions:\n- [inferred] Keep API\n- [inferred] Keep tests\npitfalls:\n- [inferred] Watch escapes',
  );
  assert.deepEqual(noteItems(undefined), []);
  assert.deepEqual(noteItems({ items: [], content: 'facts:\nold' } as unknown as ProjectMemoryAuto), []);
  const prompt = distillationPrompt('history', 'English', [
    ...previous,
    item('Tests use .runtime/node.exe', { status: 'verified', source: '1a2b3c4d', at: iso() }),
  ]);
  assert.ok(prompt.includes(JSON.stringify('F3 [verified] Tests use .runtime/node.exe (1a2b3c4d, 2026-10-12)')));
  assert.ok(prompt.includes(JSON.stringify('D2 [inferred] Keep tests (2026-10-12)')));
});

test('merge dedupes normalized text, refreshes provenance and upgrades without downgrading', () => {
  const previous = [item('Keep   API。'), item('注意边界；！'), item('Unrelated', { section: 'decisions' })];
  const copy = structuredClone(previous);
  const merged = mergeNote(
    previous,
    parseNoteChanges(
      'add facts verified KEEP API! | fresh\nadd facts inferred 注意边界。 | newer\nadd pitfalls inferred Keep API | task',
    )!,
    iso(),
  );
  assert.equal(merged.length, 4);
  assert.deepEqual(merged[0], { ...previous[0], status: 'verified', source: 'fresh', at: iso() });
  assert.deepEqual(merged[1], { ...previous[1], source: 'newer', at: iso() });
  const refreshed = mergeNote(merged, parseNoteChanges('replace F1 inferred keep api | later')!, iso(1));
  assert.equal(refreshed.at(-1)!.status, 'verified');
  assert.equal(refreshed.at(-1)!.source, 'later');
  assert.deepEqual(previous, copy);
});

test('IDs resolve against the old snapshot once, including unknown replacements and drops', () => {
  const previous = [item('First'), item('Second'), item('Third')];
  const merged = mergeNote(
    previous,
    parseNoteChanges(
      'drop F1\nreplace F2 verified Corrected | task\nreplace F2 inferred Duplicate | task\ndrop F2\ndrop P99\nreplace D99 inferred New decision | task',
    )!,
    iso(),
  );
  assert.deepEqual(
    merged.map(({ section, text }) => [section, text]),
    [
      ['facts', 'Third'],
      ['facts', 'Corrected'],
      ['decisions', 'New decision'],
    ],
  );
  assert.deepEqual(mergeNote(previous, parseNoteChanges('drop F1\ndrop F2\ndrop F3')!, iso()), []);
  const deduped = mergeNote(previous, parseNoteChanges('replace F1 verified SECOND! | task')!, iso());
  assert.equal(deduped.length, 2);
  assert.equal(deduped[0]!.status, 'verified');
  const crossed = mergeNote(
    previous,
    parseNoteChanges('replace F1 verified Second | task\nreplace F2 inferred First | task')!,
    iso(),
  );
  assert.deepEqual(
    crossed.map((entry) => entry.text),
    ['Third', 'Second', 'First'],
  );
  assert.deepEqual(
    mergeNote(previous, parseNoteChanges('drop F1\nreplace F1 verified Ignored | task')!, iso()),
    previous.slice(1),
  );
});

test('budget evicts untouched before changed, inferred before verified, then oldest first', () => {
  const previous = Array.from({ length: 6 }, (_, n) =>
    item(`${n}${'x'.repeat(199)}`, { status: n < 2 ? 'verified' : 'inferred', at: iso(n * 1000) }),
  );
  assert.ok(renderNote(previous).length <= 1500);
  const merged = mergeNote(
    previous,
    parseNoteChanges(
      `replace F6 inferred Corrected${'y'.repeat(190)} | task\nadd decisions verified ${'d'.repeat(200)} | task`,
    )!,
    iso(day),
  );
  assert.ok(renderNote(merged).length <= 1500);
  assert.ok(merged.some((entry) => entry.text.startsWith('Corrected')));
  assert.ok(!merged.some((entry) => entry.text === previous[2]!.text));
  assert.ok(merged.some((entry) => entry.text === previous[0]!.text));
  const refreshed = mergeNote(
    previous,
    parseNoteChanges(
      `add facts verified ${previous[2]!.text} | task\nadd decisions verified ${'d'.repeat(200)} | task`,
    )!,
    iso(day),
  );
  assert.ok(refreshed.some((entry) => entry.text === previous[2]!.text));
  assert.ok(!refreshed.some((entry) => entry.text === previous[3]!.text));
  const verified = previous.map((entry) => ({ ...entry, status: 'verified' as const }));
  const keepNew = mergeNote(verified, parseNoteChanges(`add decisions inferred ${'d'.repeat(200)} | task`)!, iso(day));
  assert.ok(keepNew.some((entry) => entry.section === 'decisions'));
  assert.ok(!keepNew.some((entry) => entry.text === previous[0]!.text));
  const allNew = mergeNote(
    [],
    Array.from({ length: 8 }, (_, n) => ({
      kind: 'add' as const,
      section: 'facts' as const,
      text: `${n}${'x'.repeat(199)}`,
      status: n === 0 ? ('verified' as const) : ('inferred' as const),
      source: 'task',
    })),
    iso(),
  );
  assert.ok(renderNote(allNew).length <= 1500);
  assert.ok(allNew.some((entry) => entry.text.startsWith('0')));
  assert.ok(!allNew.some((entry) => entry.text.startsWith('1')));
});

test('disabled helpers cannot select an executor', () => {
  assert.deepEqual(defaultMemoryDistillation, { enabled: false });
  const account = snapshot('codex');
  const unvisitedTargets = new Proxy([] as RuntimeTarget[], {
    get() {
      throw new Error('off switch must return before examining executors');
    },
  });
  assert.equal(
    pickDistiller(
      [account],
      unvisitedTargets,
      { ...settings, memoryDistillation: defaultMemoryDistillation },
      undefined,
      now,
    ),
    undefined,
  );
  assert.equal(
    pickDistiller([account], unvisitedTargets, { ...settings, memoryDistillation: undefined }, undefined, now),
    undefined,
  );
  const source = readFileSync(new URL('../src/server/memory-distillation.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\b(?:setTimeout|setInterval|execute|spawn|fetch)\s*\(/);
});
