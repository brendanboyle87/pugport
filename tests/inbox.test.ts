import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Inbox } from '../src/server/inbox.ts';
import { inboxText, openNotices, unreadCount, type InboxNotice } from '../src/shared/inbox.ts';
import { createTranslator } from '../src/shared/i18n/index.ts';
import englishCatalog from '../src/shared/i18n/en.json' with { type: 'json' };
import type { RuntimeSnapshot, RuntimeTarget } from '../src/shared/types.ts';
import { AgentBridge } from '../src/server/agent-bridge.ts';
import { WorkspaceStore } from '../src/server/workspace-store.ts';

test('Batch C adding rules raises separate reminders that survive read and reconcile', async (t) => {
  const f = fixture(t);
  const store = new WorkspaceStore(f.db, { recoverInterrupted: false });
  const project = { id: 'synthetic-project', name: 'Synthetic project', rules: [] as string[] };
  store.save('project', project.id, project.id, project);
  store.save('workflow', 'root', 'conversation', { id: 'root', projectId: project.id, conversationId: 'conversation' });
  store.save('message', 'human', 'conversation', {
    id: 'human',
    role: 'user',
    content: 'Use synthetic fixtures for tests. Keep changes within the task.',
  });
  store.save('human-message', 'human', 'conversation', { id: 'human' });
  const bridge = Object.create(AgentBridge.prototype);
  Object.assign(bridge, {
    controller: { inbox: f.inbox },
    workspace: {
      store,
      setProjectRules: (_id: string, rules: string[]) => {
        project.rules = rules;
        store.save('project', project.id, project.id, project);
      },
      broadcastProjectNotice: async () => ({ steered: 0, queued: 0 }),
    },
  });
  const add = (rule: string) => bridge.addProjectRule({ run: { workflowId: 'root' } }, { rule, quote: rule });
  await add('Use synthetic fixtures for tests.');
  assert.equal(f.inbox.list().length, 1);
  const first = f.inbox.list()[0];
  assert.equal(first.kind, 'rule-added');
  assert.equal(first.severity, 'info');
  assert.deepEqual(first.action, { kind: 'open-project-rules', projectId: project.id });
  assert.match(first.key, /^[0-9a-f-]{36}$/);
  f.inbox.markRead();
  assert.equal(f.inbox.list()[0]?.resolvedAt, undefined);
  f.inbox.reconcile([], []);
  assert.equal(f.inbox.list().length, 1);
  await add('Keep changes within the task.');
  assert.equal(f.inbox.list().length, 2);
  assert.notEqual(f.inbox.list()[0].key, first.key);
  await add('Keep changes within the task.');
  assert.equal(f.inbox.list().length, 2);
  f.inbox.dismiss(first.id);
  project.rules = [];
  store.save('project', project.id, project.id, project);
  await add('Use synthetic fixtures for tests.');
  assert.equal(f.inbox.list().length, 2);
  const english = createTranslator(englishCatalog);
  assert.equal(english(inboxText.ruleAddedTitle), 'Project rule added');
  assert.equal(
    english(inboxText.ruleAddedBody.replace('{0}', project.name)),
    'A rule was added to "Synthetic project". You can review or remove it in Project memory.',
  );
});

const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
test('English translation guard detects Chinese, Japanese and Korean characters', () => {
  for (const character of ['汉', 'あ', 'カ', '한']) assert.match(character, cjk);
});

const hour = 3_600_000;
function fixture(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  let now = Date.parse('2026-10-01T12:00:00Z');
  let changes = 0;
  const inbox = new Inbox(
    db,
    () => changes++,
    () => now,
  );
  return { db, inbox, advance: (ms: number) => (now += ms), changes: () => changes, now: () => now };
}
const input = (extra: Partial<Parameters<Inbox['raise']>[0]> = {}): Parameters<Inbox['raise']>[0] => ({
  kind: 'executor-login',
  key: 'synthetic-cli',
  severity: 'warning',
  title: 'Synthetic sign-in',
  source: { runtimeId: 'synthetic-cli' },
  ...extra,
});
const target: RuntimeTarget = {
  id: 'synthetic-cli',
  provider: 'codex',
  label: 'Synthetic CLI',
  command: 'synthetic',
  environment: 'native',
  enabled: true,
};
function snapshot(status: RuntimeSnapshot['status'], extra: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot {
  return {
    id: target.id,
    provider: target.provider,
    label: target.label,
    environment: 'native',
    installed: status !== 'missing',
    status,
    models: [],
    quota: { status: 'unknown', source: 'synthetic', observedAt: null, windows: [] },
    capabilities: { execute: true, resume: false, cancel: true, approvals: false },
    refreshedAt: '2026-10-01T12:00:00Z',
    ...extra,
  };
}

test('dedupe uses kind and key, increments count and persists notice state across service instances', (t) => {
  const f = fixture(t);
  const first = f.inbox.raise(input());
  f.advance(1000);
  const again = f.inbox.raise(input({ body: 'New details' }));
  assert.equal(again.id, first.id);
  assert.equal(again.count, 2);
  assert.equal(again.createdAt, first.createdAt);
  assert.notEqual(again.updatedAt, first.updatedAt);
  f.inbox.raise(input({ kind: 'executor-key' }));
  f.inbox.raise(input({ key: 'other' }));
  assert.equal(f.inbox.list().length, 3);
  const restored = new Inbox(f.db, undefined, f.now);
  assert.equal(restored.list().find((n) => n.id === first.id)?.body, 'New details');
  assert.equal(f.changes(), 4);
});

test('content changes and repeated failures keep read state; only a severity upgrade makes it unread', (t) => {
  const { inbox } = fixture(t);
  const notice = inbox.raise(input());
  inbox.markRead([notice.id]);
  const readAt = inbox.list()[0].readAt;
  inbox.raise(input({ body: 'Changed body', title: 'Changed title' }));
  assert.equal(inbox.list()[0].readAt, readAt);
  assert.equal(inbox.summary().unread, 0);
  inbox.raise(input({ severity: 'action' }));
  assert.equal(inbox.summary().unread, 1);
  assert.equal(inbox.summary().attention, 1);
  inbox.markRead();
  assert.equal(inbox.summary().attention, 1);
  inbox.raise(input({ severity: 'warning' }));
  assert.equal(inbox.summary().unread, 0);
});

test('resolve and reopen within one hour reuse the row and preserve read state, including upgrades', (t) => {
  const f = fixture(t);
  const notice = f.inbox.raise(input());
  f.inbox.markRead();
  const readAt = f.inbox.list()[0].readAt;
  f.inbox.resolve(notice.kind, notice.key);
  assert.equal(f.inbox.list().length, 0);
  f.advance(hour);
  const reopened = f.inbox.raise(input({ severity: 'action' }));
  assert.equal(reopened.id, notice.id);
  assert.equal(reopened.readAt, readAt);
  assert.equal(reopened.resolvedAt, undefined);
  assert.equal(f.inbox.list({ all: true }).length, 1);
  f.inbox.resolve(notice.kind, notice.key);
  f.advance(hour + 1);
  const fresh = f.inbox.raise(input());
  assert.notEqual(fresh.id, notice.id);
  assert.equal(fresh.readAt, undefined);
  assert.equal(fresh.count, 1);
  assert.equal(f.inbox.list({ all: true }).length, 2);
});

test('dismiss stays hidden after a day and severity upgrade until the problem resolves', (t) => {
  const f = fixture(t);
  const notice = f.inbox.raise(input());
  f.inbox.markRead();
  assert.equal(f.inbox.dismiss(notice.id), true);
  f.advance(25 * hour);
  const hidden = f.inbox.raise(input({ severity: 'action' }));
  assert.equal(hidden.id, notice.id);
  assert.ok(hidden.dismissedAt);
  assert.equal(f.inbox.summary().unread, 0);
  assert.equal(f.inbox.list().length, 0);
  f.inbox.resolve(notice.kind, notice.key);
  const reopened = f.inbox.raise(input({ severity: 'action' }));
  assert.equal(reopened.dismissedAt, undefined);
  assert.equal(reopened.id, notice.id);
  assert.ok(reopened.readAt);
  assert.equal(f.inbox.dismiss('unknown'), false);
});

test('markRead selection resolves info only and leaves action notices open', (t) => {
  const { inbox } = fixture(t);
  const info = inbox.raise(input({ severity: 'info' }));
  const action = inbox.raise(input({ key: 'other', severity: 'action' }));
  inbox.markRead([]);
  assert.equal(inbox.summary().unread, 2);
  inbox.markRead([info.id]);
  assert.ok(inbox.list({ all: true }).find((n) => n.id === info.id)?.resolvedAt);
  assert.deepEqual(
    inbox.list().map((n) => n.id),
    [action.id],
  );
  assert.equal(inbox.summary().unread, 1);
  inbox.markRead();
  assert.equal(inbox.summary().unread, 0);
  assert.equal(inbox.list().length, 1);
});

test('prune removes resolved rows after 30 days and retains every unresolved notice, including dismissed ones', (t) => {
  const f = fixture(t);
  const resolved = f.inbox.raise(input());
  const dismissed = f.inbox.raise(input({ key: 'dismissed' }));
  const open = f.inbox.raise(input({ key: 'open' }));
  f.inbox.resolve(resolved.kind, resolved.key);
  f.inbox.dismiss(dismissed.id);
  f.advance(30 * 24 * hour - 1);
  f.inbox.prune();
  assert.equal(f.inbox.list({ all: true }).length, 3);
  f.advance(2);
  f.inbox.prune();
  assert.deepEqual(
    f.inbox
      .list({ all: true })
      .map((n) => n.id)
      .sort(),
    [open.id, dismissed.id].sort(),
  );
  assert.ok(f.inbox.list({ all: true }).find((n) => n.id === dismissed.id)?.dismissedAt);
  assert.deepEqual(
    f.inbox.list().map((n) => n.id),
    [open.id],
  );
});

test('capacity pruning discards resolved history before retaining unresolved rows', (t) => {
  const f = fixture(t);
  const open = f.inbox.raise(input({ key: 'old-open' }));
  f.advance(1000);
  const resolved = f.inbox.raise(input({ key: 'resolved' }));
  f.inbox.resolve(resolved.kind, resolved.key);
  for (let i = 0; i < 199; i++) {
    f.advance(1000);
    f.inbox.raise(input({ key: `card-${i}` }));
  }
  const count = f.db.prepare('SELECT COUNT(*) AS count FROM inbox_notices').get() as { count: number };
  assert.equal(count.count, 200);
  assert.ok(f.inbox.list({ all: true }).some((n) => n.id === open.id));
  assert.ok(!f.inbox.list({ all: true }).some((n) => n.id === resolved.id));
  assert.equal(f.inbox.list({ limit: 3 }).length, 3);
});

test('discovery emits only ready-to-missing/auth transitions, never first-seen unavailable cards', (t) => {
  const { inbox } = fixture(t);
  inbox.reconcile([snapshot('missing')], [target]);
  inbox.reconcile([snapshot('auth-required')], [target]);
  assert.equal(inbox.list().length, 0);
  inbox.reconcile([snapshot('ready')], [target]);
  inbox.reconcile([snapshot('missing')], [target]);
  assert.equal(inbox.list()[0].kind, 'executor-missing');
  assert.equal(inbox.list()[0].action?.kind, 'open-usage');
  inbox.reconcile([snapshot('missing')], [target]);
  assert.equal(inbox.list()[0].count, 1);
  inbox.reconcile([snapshot('ready')], [target]);
  assert.equal(inbox.list().length, 0);
  inbox.reconcile([snapshot('auth-required')], [target]);
  assert.equal(inbox.list()[0].kind, 'executor-login');
  inbox.reconcile(
    [snapshot('ready', { availability: { reason: 'authentication', observedAt: '2026-10-01' } })],
    [target],
  );
  assert.equal(inbox.list().length, 1);
  inbox.reconcile([snapshot('ready')], [target]);
  assert.equal(inbox.list().length, 0);
});

test('pending login and disabled cards never create discovery notices; disabling or deleting resolves existing ones', (t) => {
  const { inbox } = fixture(t);
  inbox.reconcile([snapshot('ready')], [target]);
  inbox.reconcile([snapshot('auth-required')], [target], new Set([target.id]));
  assert.equal(inbox.list().length, 0);
  inbox.reconcile([snapshot('auth-required')], [target]);
  assert.equal(inbox.list()[0].kind, 'executor-login');
  inbox.reconcile([snapshot('ready')], [target]);
  inbox.reconcile([snapshot('missing')], [{ ...target, enabled: false }]);
  assert.equal(inbox.list().length, 0);
  inbox.reconcile([snapshot('ready')], [target]);
  inbox.reconcile([snapshot('missing')], [{ ...target, executionDisabledByUser: true }]);
  assert.equal(inbox.list().length, 0);
  inbox.raise(input());
  inbox.reconcile([snapshot('missing')], [{ ...target, enabled: false }]);
  assert.equal(inbox.list().length, 0);
  inbox.raise(input({ kind: 'executor-key' }));
  inbox.reconcile([], []);
  assert.equal(inbox.list().length, 0);
});

test('per-use key errors are key notices, native subscription key errors are sign-in notices', (t) => {
  const { inbox } = fixture(t);
  const failure = { id: 'synthetic-run', status: 'failed' as const, errorCode: 'api-key-auth-or-configuration' };
  const variants: Array<[RuntimeTarget, RuntimeSnapshot]> = [
    [{ ...target, gateway: 'api' }, snapshot('ready')],
    [target, snapshot('ready', { authMode: 'apiKey' })],
    [target, snapshot('ready', { accounting: { mode: 'usage', source: 'synthetic' } })],
  ];
  for (const [card, observed] of variants) {
    inbox.observeRun(card, failure, observed);
    assert.equal(inbox.list()[0].kind, 'executor-key');
    assert.equal(inbox.list()[0].action?.kind, 'replace-key');
    inbox.resolve('executor-key', target.id);
  }
  inbox.observeRun(target, failure, snapshot('ready', { accounting: { mode: 'subscription', source: 'synthetic' } }));
  assert.equal(inbox.list()[0].kind, 'executor-login');
  assert.equal(inbox.list()[0].action?.kind, 'sign-in');
});

test('key notices survive ready discovery and resolve only on explicit key replacement or successful run', (t) => {
  const { inbox } = fixture(t);
  const api = { ...target, gateway: 'api' as const };
  const failure = { id: 'synthetic-run', status: 'failed' as const, errorCode: 'api-key-auth-or-configuration' };
  inbox.observeRun(api, failure);
  inbox.reconcile([snapshot('ready')], [api]);
  assert.equal(inbox.list()[0].kind, 'executor-key');
  inbox.observeRun(api, { ...failure, status: 'cancelled' });
  assert.equal(inbox.list().length, 1);
  inbox.resolve('executor-key', target.id);
  assert.equal(inbox.list().length, 0);
  inbox.observeRun(api, failure);
  inbox.observeRun(api, { id: 'success', status: 'completed' });
  assert.equal(inbox.list().length, 0);
});

test('workspace auto-fix, quota, missing run errors and unrelated failures do not create v1 notices', (t) => {
  const { inbox } = fixture(t);
  for (const errorCode of [
    'api-key-workspace-required',
    'quota-or-rate-limit',
    'runtime-not-found',
    'runtime-request-failed',
    'runtime-network-error',
    'api-budget-exhausted',
    'api-budget-usage-unknown',
    undefined,
  ])
    inbox.observeRun(target, { id: 'synthetic-run', status: 'failed', errorCode });
  inbox.observeRun(
    { ...target, enabled: false },
    { id: 'disabled', status: 'failed', errorCode: 'authentication-required' },
  );
  inbox.observeRun(
    { ...target, executionDisabledByUser: true },
    { id: 'disabled', status: 'failed', errorCode: 'authentication-required' },
  );
  inbox.observeRun(target, { id: 'cancelled', status: 'cancelled', errorCode: 'authentication-required' });
  assert.equal(inbox.list().length, 0);
});

test('expired budget signals reconcile without counting every refresh as a new failure', (t) => {
  const { inbox } = fixture(t);
  for (const phase of ['normal', 'exhausted', 'expired'] as const) {
    const observed = snapshot('ready', { apiBudgetState: { phase } as NonNullable<RuntimeSnapshot['apiBudgetState']> });
    inbox.reconcile([observed], [target]);
    inbox.reconcile([observed], [target]);
    assert.equal(inbox.list().length, phase === 'expired' ? 1 : 0);
  }
  assert.equal(inbox.list()[0].kind, 'api-budget');
  assert.equal(inbox.list()[0].count, 1);
  inbox.reconcile(
    [snapshot('ready', { apiBudgetState: { phase: 'normal' } as NonNullable<RuntimeSnapshot['apiBudgetState']> })],
    [target],
  );
  assert.equal(inbox.list().length, 0);
});

test('executor-failing can carry semantic actions and verbatim text without implementing cooldown', (t) => {
  const { inbox } = fixture(t);
  const failing = inbox.raise(
    input({
      kind: 'executor-failing',
      body: 'Synthetic diagnosis',
      bodyVerbatim: true,
      action: { kind: 'view-run', runId: 'synthetic-run' },
    }),
  );
  assert.equal(inbox.list()[0].bodyVerbatim, true);
  assert.deepEqual(inbox.list()[0].action, { kind: 'view-run', runId: 'synthetic-run' });
  inbox.observeRun(target, { id: 'success', status: 'completed' });
  assert.ok(inbox.list({ all: true }).find((n) => n.id === failing.id)?.resolvedAt);
});

test('summary and shared helpers omit resolved and dismissed rows from unread counts', (t) => {
  const { inbox } = fixture(t);
  const action = inbox.raise(input({ severity: 'action' }));
  const dismissed = inbox.raise(input({ key: 'dismissed', severity: 'action' }));
  const resolved = inbox.raise(input({ key: 'resolved' }));
  inbox.dismiss(dismissed.id);
  inbox.resolve(resolved.kind, resolved.key);
  const all: InboxNotice[] = inbox.list({ all: true });
  assert.deepEqual(
    openNotices(all).map((n) => n.id),
    [action.id],
  );
  assert.equal(unreadCount(all), 1);
  assert.deepEqual(inbox.summary(), { open: [action], unread: 1, attention: 1 });
});

test('every inbox template translates to English and preserves its placeholders', () => {
  const translate = createTranslator(englishCatalog);
  const slots = (text: string) => (text.match(/\{\d+\}/g) ?? []).sort();
  for (const source of Object.values(inboxText)) {
    const english = (englishCatalog as Record<string, string>)[source];
    assert.ok(english, `Missing English template: ${source}`);
    assert.doesNotMatch(english, cjk);
    assert.deepEqual(slots(english), slots(source));
    assert.equal(translate(source), english);
  }
});

test('discovery uses key actions for per-use cards only after a ready-to-auth transition', (t) => {
  const { inbox } = fixture(t);
  const variants: Array<[RuntimeTarget, Partial<RuntimeSnapshot>]> = [
    [{ ...target, gateway: 'api' }, {}],
    [target, { authMode: 'apiKey' }],
    [target, { accounting: { mode: 'usage', source: 'synthetic' } }],
  ];
  for (const [card, observed] of variants) {
    inbox.resolveRuntime(target.id);
    inbox.reconcile([snapshot('auth-required', observed)], [card]);
    assert.equal(inbox.list().length, 0);
    inbox.reconcile([snapshot('ready', observed)], [card]);
    inbox.reconcile([snapshot('auth-required', observed)], [card]);
    assert.equal(inbox.list().length, 1);
    assert.equal(inbox.list()[0].kind, 'executor-key');
    assert.equal(inbox.list()[0].action?.kind, 'replace-key');
    inbox.reconcile([snapshot('ready', observed)], [card]);
    assert.equal(inbox.list().length, 1);
  }
});

test('unresolved dismissed rows survive 30 days and restart until resolution, disablement or deletion', (t) => {
  const f = fixture(t);
  let inbox = f.inbox;
  const blocked = snapshot('ready', {
    apiBudgetState: { phase: 'expired' } as NonNullable<RuntimeSnapshot['apiBudgetState']>,
  });
  inbox.reconcile([blocked], [target]);
  for (const clearance of ['resolve', 'disable', 'delete'] as const) {
    const notice = inbox.list()[0];
    assert.equal(notice.kind, 'api-budget');
    inbox.dismiss(notice.id);
    f.advance(31 * 24 * hour);
    inbox.prune();
    const retained = inbox.list({ all: true }).find((n) => n.id === notice.id);
    assert.ok(retained?.dismissedAt);
    assert.equal(retained.resolvedAt, undefined);
    inbox = new Inbox(f.db, undefined, f.now);
    inbox.reconcile([blocked], [target]);
    inbox.reconcile([blocked], [target]);
    assert.equal(inbox.summary().unread, 0, clearance);
    assert.equal(inbox.list().length, 0, clearance);
    if (clearance === 'resolve') inbox.resolve('api-budget', target.id);
    else if (clearance === 'disable') inbox.reconcile([blocked], [{ ...target, enabled: false }]);
    else inbox.reconcile([], []);
    inbox.reconcile([blocked], [target]);
    assert.equal(inbox.list().length, 1, `A ${clearance} releases the old dismissal`);
    assert.equal(inbox.list()[0].kind, 'api-budget');
  }
});

test('capacity pruning retains more than 200 unresolved rows and dedupes and resolves hidden rows beyond the list limit', (t) => {
  const f = fixture(t);
  const hiddenInput = input({ kind: 'executor-key' });
  const hidden = f.inbox.raise(hiddenInput);
  f.inbox.dismiss(hidden.id);
  for (let i = 0; i < 200; i++) {
    f.advance(1000);
    f.inbox.raise(input({ key: `other-${i}`, source: { runtimeId: `other-${i}` } }));
  }
  const count = () => (f.db.prepare('SELECT COUNT(*) AS count FROM inbox_notices').get() as { count: number }).count;
  assert.equal(count(), 201);
  assert.equal(f.inbox.list({ all: true }).length, 200);
  const stored = f.db.prepare('SELECT value FROM inbox_notices WHERE id=?').get(hidden.id) as { value: string };
  assert.ok((JSON.parse(stored.value) as InboxNotice).dismissedAt);
  f.advance(31 * 24 * hour);
  const restored = new Inbox(f.db, undefined, f.now);
  const repeated = restored.raise(hiddenInput);
  assert.equal(repeated.id, hidden.id);
  assert.ok(repeated.dismissedAt);
  assert.equal(count(), 201);
  assert.equal(restored.summary().unread, 200);
  assert.ok(!restored.list().some((n) => n.kind === hiddenInput.kind && n.key === hiddenInput.key));
  restored.resolve(hiddenInput.kind, hiddenInput.key);
  restored.raise(hiddenInput);
  assert.equal(restored.summary().unread, 201);
  assert.equal(restored.summary().open.length, 200);
  restored.markRead();
  assert.equal(restored.summary().unread, 0);
});

test('template insertion preserves dollar replacement sequences in a card label literally', (t) => {
  const { inbox } = fixture(t);
  const label = "Synthetic $& $$ $` $'";
  inbox.observeRun(
    { ...target, label },
    { id: 'synthetic-run', status: 'failed', errorCode: 'authentication-required' },
  );
  assert.equal(inbox.list()[0].title, `${label} 需要重新登录`);
  assert.equal(inbox.list()[0].source?.label, label);
});

test('a saved ready state detects sign-in expiry after the Inbox service restarts', (t) => {
  const f = fixture(t);
  f.inbox.reconcile([snapshot('ready')], [target]);
  const restored = new Inbox(f.db, undefined, f.now);
  restored.reconcile([snapshot('auth-required')], [target]);
  assert.equal(restored.list().length, 1);
  assert.equal(restored.list()[0].kind, 'executor-login');
  assert.equal(restored.list()[0].count, 1);
});

test('refreshing leaves the last stable state intact across restarts without replaying a transition', (t) => {
  const f = fixture(t);
  f.inbox.reconcile([snapshot('ready')], [target]);
  f.inbox.reconcile([snapshot('refreshing')], [target]);
  let restored = new Inbox(f.db, undefined, f.now);
  restored.reconcile([snapshot('auth-required')], [target]);
  assert.equal(restored.list()[0].kind, 'executor-login');
  restored.resolve('executor-login', target.id);
  restored.reconcile([snapshot('refreshing')], [target]);
  restored = new Inbox(f.db, undefined, f.now);
  restored.reconcile([snapshot('auth-required')], [target]);
  assert.equal(restored.list().length, 0);
});

test('pending login preserves stable state across restart while disablement and deletion forget it', (t) => {
  const f = fixture(t);
  f.inbox.reconcile([snapshot('ready')], [target]);
  f.inbox.reconcile([snapshot('auth-required')], [target], new Set([target.id]));
  let restored = new Inbox(f.db, undefined, f.now);
  restored.reconcile([snapshot('auth-required')], [target], new Set([target.id]));
  assert.equal(restored.list().length, 0);
  restored.reconcile([snapshot('auth-required')], [target]);
  assert.equal(restored.list()[0].kind, 'executor-login');
  for (const disabled of [false, true]) {
    restored.reconcile([snapshot('ready')], [target]);
    restored.reconcile(disabled ? [snapshot('ready')] : [], disabled ? [{ ...target, enabled: false }] : []);
    restored = new Inbox(f.db, undefined, f.now);
    restored.reconcile([snapshot('auth-required')], [target]);
    assert.equal(
      restored.list().length,
      0,
      disabled ? 'Disabled cards forget their ready state' : 'Deleted cards forget their ready state',
    );
  }
});

test('reconciliation skips already resolved notices for absent cards', (t) => {
  const { inbox } = fixture(t);
  const notice = inbox.raise(input({ key: 'removed', source: { runtimeId: 'removed' } }));
  inbox.resolve(notice.kind, notice.key);
  const history = inbox.list({ all: true });
  const resolveRuntime = t.mock.method(inbox, 'resolveRuntime');
  inbox.reconcile([], []);
  assert.equal(resolveRuntime.mock.callCount(), 0);
  assert.deepEqual(inbox.list({ all: true }), history);
  inbox.raise(input({ key: 'unresolved', source: { runtimeId: 'unresolved' } }));
  inbox.raise(input({ kind: 'executor-key', key: 'unresolved', source: { runtimeId: 'unresolved' } }));
  inbox.reconcile([], []);
  assert.equal(resolveRuntime.mock.callCount(), 1);
  assert.equal(inbox.list().length, 0);
});

test('legacy dismissal markers migrate to retained hidden notices and the obsolete table is removed', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(
    'CREATE TABLE inbox_dismissals(kind TEXT NOT NULL,key TEXT NOT NULL,runtime_id TEXT NOT NULL,dismissed_at TEXT NOT NULL,PRIMARY KEY(kind,key))',
  );
  db.prepare('INSERT INTO inbox_dismissals(kind,key,runtime_id,dismissed_at) VALUES(?,?,?,?)').run(
    'executor-key',
    target.id,
    target.id,
    '2026-09-01T00:00:00Z',
  );
  const inbox = new Inbox(db, undefined, () => Date.parse('2026-10-27T00:00:00Z'));
  assert.equal(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='inbox_dismissals'").get(),
    undefined,
  );
  assert.equal(inbox.list().length, 0);
  const retained = inbox.list({ all: true });
  assert.equal(retained.length, 1);
  assert.equal(retained[0].dismissedAt, '2026-09-01T00:00:00Z');
  const again = inbox.raise(input({ kind: 'executor-key' }));
  assert.equal(again.id, retained[0].id);
  assert.equal(inbox.list().length, 0);
  inbox.resolve('executor-key', target.id);
  inbox.raise(input({ kind: 'executor-key' }));
  assert.equal(inbox.list().length, 1);
});

test('info resolves at the current panel-open time while preserving an older read timestamp on reopening', (t) => {
  const f = fixture(t);
  const notice = f.inbox.raise(input({ kind: 'executor-failing', severity: 'warning' }));
  f.inbox.markRead();
  const readAt = f.inbox.list()[0].readAt;
  f.advance(2 * hour);
  f.inbox.raise(input({ kind: 'executor-failing', severity: 'info' }));
  const resolvedAt = new Date(f.now()).toISOString();
  f.inbox.markRead();
  assert.equal(f.inbox.list().length, 0);
  assert.equal(f.inbox.list({ all: true })[0].resolvedAt, resolvedAt);
  assert.equal(f.inbox.list({ all: true })[0].readAt, readAt);
  f.advance(5 * 60_000);
  const reopened = f.inbox.raise(input({ kind: 'executor-failing', severity: 'warning' }));
  assert.equal(reopened.id, notice.id);
  assert.equal(reopened.readAt, readAt);
  assert.equal(reopened.resolvedAt, undefined);
  assert.equal(f.inbox.summary().unread, 0);
  assert.equal(f.inbox.list({ all: true }).length, 1);
});

const protocolFailure = {
  id: 'failed-run',
  status: 'failed' as const,
  errorCode: 'runtime-protocol-incompatible',
  startupFailure: { exitCode: 1, elapsedMs: 10 },
  errorDetail: 'raw synthetic stderr',
};

test('startup incompatibility creates a three-paragraph notice and resolves only on completion', (t) => {
  const f = fixture(t);
  f.inbox.observeRun(target, protocolFailure, snapshot('ready', { version: '1.2.3' }));
  const notice = f.inbox.list()[0];
  assert.equal(notice.kind, 'executor-incompatible');
  assert.equal(notice.key, target.id);
  assert.equal(notice.severity, 'warning');
  assert.match(notice.title, /Synthetic CLI/);
  assert.equal(notice.body?.split('\n\n').length, 3);
  assert.match(notice.body!, /1\.2\.3/);
  assert.doesNotMatch(notice.body!, /raw synthetic stderr/);
  assert.equal(notice.details, protocolFailure.errorDetail);
  assert.deepEqual(notice.action, { kind: 'view-run', runId: protocolFailure.id });
  const translate = createTranslator(englishCatalog);
  for (const text of [notice.title, ...notice.body!.split('\n\n')]) {
    const english = translate(text);
    assert.ok(english);
    assert.doesNotMatch(english, cjk);
  }
  f.inbox.markRead();
  const readAt = f.inbox.list()[0].readAt;
  f.inbox.observeRun(target, { ...protocolFailure, id: 'second-run', errorDetail: 'new raw error' }, snapshot('error'));
  assert.equal(f.inbox.list()[0].count, 2);
  assert.equal(f.inbox.list()[0].readAt, readAt);
  assert.equal(f.inbox.list()[0].details, notice.details);
  assert.deepEqual(f.inbox.list()[0].action, notice.action);
  assert.equal(f.inbox.list()[0].body, notice.body);
  f.inbox.reconcile([snapshot('ready')], [target]);
  assert.equal(f.inbox.list().length, 1);
  f.inbox.observeRun(target, { id: 'success', status: 'completed' });
  assert.equal(f.inbox.list().length, 0);
});

test('ready to protocol error creates one notice and refresh updates only changed paragraph', (t) => {
  const f = fixture(t);
  f.inbox.reconcile([snapshot('ready')], [target]);
  const failed = snapshot('error', {
    note: 'runtime-protocol-incompatible',
    errorDetail: 'raw discovery',
    version: '2.0',
  });
  f.inbox.reconcile([failed], [target]);
  const first = f.inbox.list()[0];
  assert.equal(first.kind, 'executor-incompatible');
  assert.equal(first.details, 'raw discovery');
  assert.equal(first.action, undefined);
  assert.equal(first.body?.split('\n\n').length, 3);
  f.inbox.markRead();
  const before = f.inbox.list()[0];
  const changes = f.changes();
  f.advance(1000);
  f.inbox.reconcile([failed], [target]);
  assert.deepEqual(f.inbox.list()[0], before);
  assert.equal(f.changes(), changes);
  f.inbox.reconcile([snapshot('ready')], [target]);
  assert.equal(f.inbox.list()[0].kind, 'executor-incompatible');
  f.inbox.observeRun(target, { id: 'ok', status: 'completed' });
  assert.equal(f.inbox.list().length, 0);
});

test('existing run notice updates paragraph when discovery becomes incompatible', (t) => {
  const f = fixture(t);
  f.inbox.reconcile([snapshot('ready')], [target]);
  f.inbox.observeRun(target, protocolFailure, snapshot('ready'));
  f.inbox.markRead();
  const old = f.inbox.list()[0];
  f.advance(1000);
  f.inbox.reconcile([snapshot('error', { note: 'runtime-protocol-incompatible' })], [target]);
  const updated = f.inbox.list()[0];
  assert.equal(updated.count, old.count);
  assert.equal(updated.readAt, undefined);
  assert.notEqual(updated.body?.split('\n\n')[1], old.body?.split('\n\n')[1]);
  assert.equal(updated.details, old.details);
});

test('API gateways never raise incompatibility; network survives refresh and success resolves it', (t) => {
  const f = fixture(t);
  const api = { ...target, gateway: 'api' as const };
  f.inbox.observeRun(api, protocolFailure, snapshot('ready'));
  f.inbox.reconcile([snapshot('ready')], [api]);
  f.inbox.reconcile([snapshot('error', { note: 'runtime-protocol-incompatible' })], [api]);
  assert.equal(f.inbox.list().length, 0);
  f.inbox.raise({ kind: 'network', key: 'global', severity: 'warning', title: 'network' });
  f.inbox.reconcile([], []);
  assert.equal(f.inbox.list()[0].kind, 'network');
  f.inbox.observeRun(target, { id: 'ok', status: 'completed' });
  assert.equal(f.inbox.list().length, 0);
});

for (const [kind, fields] of [
  ['local', { local: true }],
  ['free', { costTier: 'free' as const }],
] as const)
  test(`network notice survives a completed ${kind} card run`, (t) => {
    const { inbox } = fixture(t);
    inbox.raise({ kind: 'network', key: 'global', severity: 'warning', title: 'network' });
    inbox.observeRun(target, { id: 'success', status: 'completed' }, snapshot('ready', fields));
    assert.equal(inbox.list().filter((notice) => notice.kind === 'network' && notice.key === 'global').length, 1);
  });

test('sign-in notice appears when protocol error discovery is followed by authentication expiry', (t) => {
  const { inbox } = fixture(t);
  inbox.reconcile([snapshot('ready')], [target]);
  inbox.reconcile([snapshot('error', { note: 'runtime-protocol-incompatible' })], [target]);
  assert.equal(inbox.list().filter((notice) => notice.kind === 'executor-incompatible').length, 1);
  inbox.reconcile([snapshot('auth-required')], [target]);
  const notices = inbox.list().filter((notice) => notice.kind === 'executor-login');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].key, target.id);
});

test('protocol failures without startup evidence do not raise incompatibility', (t) => {
  const { inbox } = fixture(t);
  inbox.observeRun(target, { ...protocolFailure, startupFailure: undefined });
  inbox.observeRun(target, { ...protocolFailure, errorCode: 'runtime-process-closed' });
  assert.equal(inbox.list().length, 0);
});

test('update changes only open notices and does nothing for identical fields', (t) => {
  const f = fixture(t);
  const notice = f.inbox.raise(input({ body: 'one', action: { kind: 'view-run', runId: 'r' } }));
  f.inbox.markRead();
  const original = f.inbox.list()[0];
  const changes = f.changes();
  f.advance(1000);
  f.inbox.update(notice.kind, notice.key, { body: 'one', action: { kind: 'view-run', runId: 'r' } });
  assert.deepEqual(f.inbox.list()[0], original);
  assert.equal(f.changes(), changes);
  f.inbox.update(notice.kind, notice.key, { body: 'two', details: 'detail', severity: 'action' });
  const updated = f.inbox.list()[0];
  assert.equal(updated.count, original.count);
  assert.equal(updated.readAt, undefined);
  assert.notEqual(updated.updatedAt, original.updatedAt);
  assert.equal(updated.details, 'detail');
  assert.equal(f.changes(), changes + 1);
  f.inbox.dismiss(notice.id);
  f.inbox.update(notice.kind, notice.key, { body: 'hidden' });
  assert.equal(f.inbox.list({ all: true })[0].body, 'two');
});
