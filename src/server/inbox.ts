import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import {
  inboxText,
  openNotices,
  unreadCount,
  type InboxKind,
  type InboxNotice,
  type InboxSummary,
} from '../shared/inbox.ts';
import type { RunRecord, RuntimeSnapshot, RuntimeTarget } from '../shared/types.ts';

type Raise = Pick<
  InboxNotice,
  | 'kind'
  | 'key'
  | 'severity'
  | 'title'
  | 'body'
  | 'details'
  | 'action'
  | 'source'
  | 'bodyVerbatim'
  | 'externalRequest'
  | 'externalDigest'
>;
const rank = { info: 0, warning: 1, action: 2 };
const hour = 3_600_000;
const usesKey = (target: RuntimeTarget, snapshot?: RuntimeSnapshot) =>
  target.gateway === 'api' || snapshot?.authMode === 'apiKey' || snapshot?.accounting?.mode === 'usage';
export const fill = (template: string, ...values: string[]) =>
  template.replace(/\{(\d+)\}/g, (_, index: string) => values[Number(index)] ?? '');
const incompatibleParagraph = (target: RuntimeTarget, snapshot?: RuntimeSnapshot) =>
  snapshot?.status === 'error' ? fill(inboxText.incompatiblePausedBody, target.label) : inboxText.incompatibleRetryBody;
const incompatibleBody = (target: RuntimeTarget, snapshot?: RuntimeSnapshot) =>
  [
    snapshot?.version
      ? fill(inboxText.incompatibleVersionBody, target.label, snapshot.version)
      : fill(inboxText.incompatibleBody, target.label),
    incompatibleParagraph(target, snapshot),
    inboxText.incompatibleInvestigatingBody,
  ].join('\n\n');

export class Inbox {
  constructor(
    private readonly db: DatabaseSync,
    private readonly changed: () => void = () => {},
    private readonly now: () => number = Date.now,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS inbox_notices (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS inbox_notice_key ON inbox_notices(kind,key);
    CREATE TABLE IF NOT EXISTS inbox_stable_states (
      runtime_id TEXT PRIMARY KEY, status TEXT NOT NULL
    );`);
    this.migrateDismissals();
    this.prune();
  }
  private migrateDismissals() {
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='inbox_dismissals'").get()) return;
    const rows = this.db.prepare('SELECT kind,key,runtime_id,dismissed_at FROM inbox_dismissals').all() as Array<{
      kind: InboxKind;
      key: string;
      runtime_id: string;
      dismissed_at: string;
    }>;
    this.db.exec('BEGIN');
    try {
      for (const row of rows) {
        const existing = this.notices().find((n) => n.kind === row.kind && n.key === row.key && !n.resolvedAt);
        const notice: InboxNotice = existing ?? {
          id: randomUUID(),
          kind: row.kind,
          key: row.key,
          severity: 'action',
          title: '',
          count: 1,
          createdAt: row.dismissed_at,
          updatedAt: row.dismissed_at,
          source: { runtimeId: row.runtime_id },
        };
        notice.dismissedAt = row.dismissed_at;
        this.save(notice);
      }
      this.db.exec('DROP TABLE inbox_dismissals');
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  private save(notice: InboxNotice) {
    this.db
      .prepare(
        'INSERT INTO inbox_notices(id,kind,key,value) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value',
      )
      .run(notice.id, notice.kind, notice.key, JSON.stringify(notice));
  }
  private notices(): InboxNotice[] {
    const rows = this.db
      .prepare("SELECT value FROM inbox_notices ORDER BY json_extract(value,'$.updatedAt') DESC, rowid DESC")
      .all() as Array<{ value: string }>;
    return rows.map((row) => JSON.parse(row.value) as InboxNotice);
  }
  list({ all = false, limit = 200 }: { all?: boolean; limit?: number } = {}): InboxNotice[] {
    const notices = this.notices();
    return (all ? notices : openNotices(notices)).slice(0, Math.max(0, Math.min(200, limit)));
  }
  summary(): InboxSummary {
    const open = openNotices(this.notices());
    return {
      open: open.slice(0, 200),
      unread: unreadCount(open),
      attention: open.filter((n) => n.severity === 'action').length,
    };
  }
  raise(input: Raise): InboxNotice {
    const at = new Date(this.now()).toISOString();
    const previous = this.notices().find((n) => n.kind === input.kind && n.key === input.key);
    const reopen = previous?.resolvedAt && this.now() - Date.parse(previous.resolvedAt) <= hour;
    const reuse = previous && (!previous.resolvedAt || reopen);
    const notice: InboxNotice = reuse
      ? { ...previous, ...input, updatedAt: at, count: previous.count + 1 }
      : { ...input, id: randomUUID(), createdAt: at, updatedAt: at, count: 1 };
    if (reuse && reopen) {
      delete notice.resolvedAt;
      delete notice.dismissedAt;
    } else if (reuse && !notice.dismissedAt && rank[input.severity] > rank[previous.severity]) delete notice.readAt;
    this.save(notice);
    this.prune();
    this.changed();
    return notice;
  }
  resolve(kind: InboxKind, key: string) {
    this.resolveWhere((n) => n.kind === kind && n.key === key);
  }
  update(
    kind: InboxKind,
    key: string,
    patch: Partial<
      Pick<InboxNotice, 'body' | 'details' | 'action' | 'severity' | 'externalRequest' | 'externalDigest'>
    >,
  ) {
    const notice = openNotices(this.notices()).find((n) => n.kind === kind && n.key === key);
    if (
      !notice ||
      Object.entries(patch).every(([field, value]) => isDeepStrictEqual(notice[field as keyof InboxNotice], value))
    )
      return;
    Object.assign(notice, patch);
    notice.updatedAt = new Date(this.now()).toISOString();
    delete notice.readAt;
    this.save(notice);
    this.changed();
  }
  resolveRuntime(id: string) {
    this.db.prepare('DELETE FROM inbox_stable_states WHERE runtime_id=?').run(id);
    this.resolveWhere((n) => (n.source?.runtimeId ?? n.key) === id);
  }
  private resolveWhere(matches: (notice: InboxNotice) => boolean) {
    let changed = false;
    for (const notice of this.notices()) {
      if (notice.resolvedAt || !matches(notice)) continue;
      notice.resolvedAt = new Date(this.now()).toISOString();
      this.save(notice);
      changed = true;
    }
    if (changed) this.changed();
  }
  dismiss(id: string): boolean {
    const notice = this.notices().find((n) => n.id === id);
    if (!notice) return false;
    if (!notice.dismissedAt && !notice.resolvedAt) {
      notice.dismissedAt = new Date(this.now()).toISOString();
      this.save(notice);
      this.changed();
    }
    return true;
  }
  markRead(ids?: readonly string[]) {
    let changed = false;
    for (const notice of openNotices(this.notices())) {
      if (ids && !ids.includes(notice.id)) continue;
      if (notice.readAt && notice.severity !== 'info') continue;
      const at = new Date(this.now()).toISOString();
      notice.readAt ??= at;
      if (
        notice.severity === 'info' &&
        notice.kind !== 'github-card' &&
        notice.kind !== 'rule-added' &&
        notice.kind !== 'external-digest'
      )
        notice.resolvedAt = at;
      this.save(notice);
      changed = true;
    }
    if (changed) this.changed();
  }
  prune() {
    const cutoff = this.now() - 30 * 24 * hour;
    const remove = this.db.prepare('DELETE FROM inbox_notices WHERE id=?');
    const rows = this.db.prepare('SELECT value FROM inbox_notices ORDER BY rowid').all() as Array<{ value: string }>;
    const remaining: InboxNotice[] = [];
    for (const row of rows) {
      const notice = JSON.parse(row.value) as InboxNotice;
      if (notice.resolvedAt && Date.parse(notice.resolvedAt) <= cutoff) remove.run(notice.id);
      else remaining.push(notice);
    }
    const resolved = remaining.filter((n) => n.resolvedAt).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    for (const notice of resolved.slice(0, Math.max(0, remaining.length - 200))) remove.run(notice.id);
  }
  private notify(
    kind: Exclude<
      InboxKind,
      | 'executor-failing'
      | 'executor-incompatible'
      | 'executor-update'
      | 'network'
      | 'github-card'
      | 'rule-added'
      | 'bank-connection'
      | 'external-request'
      | 'external-digest'
    >,
    target: RuntimeTarget,
    runId?: string,
  ) {
    const templates = {
      'executor-login': [inboxText.loginTitle, inboxText.loginBody, 'sign-in'],
      'executor-key': [inboxText.keyTitle, inboxText.keyBody, 'replace-key'],
      'executor-missing': [inboxText.missingTitle, inboxText.missingBody, 'open-usage'],
      'api-budget': [inboxText.budgetTitle, inboxText.budgetBody, 'open-usage'],
    } as const;
    const [title, body, action] = templates[kind];
    this.raise({
      kind,
      key: target.id,
      severity: 'action',
      title: title.replace('{0}', () => target.label),
      body,
      action: { kind: action, runtimeId: target.id },
      source: { runtimeId: target.id, label: target.label, ...(runId ? { runId } : {}) },
    });
  }
  observeRun(
    target: RuntimeTarget,
    run: Pick<RunRecord, 'id' | 'status' | 'errorCode' | 'startupFailure' | 'errorDetail'>,
    snapshot?: RuntimeSnapshot,
  ) {
    if (run.status === 'completed') {
      for (const kind of [
        'executor-key',
        'executor-login',
        'executor-failing',
        'executor-missing',
        'executor-incompatible',
      ] as const)
        this.resolve(kind, target.id);
      if (!snapshot?.local && snapshot?.costTier !== 'free') this.resolve('network', 'global');
      return;
    }
    if (!target.enabled || target.executionDisabledByUser) return;
    if (run.status !== 'failed') return;
    if (target.gateway !== 'api' && run.startupFailure && run.errorCode === 'runtime-protocol-incompatible') {
      const existing = this.notices().find(
        (n) => n.kind === 'executor-incompatible' && n.key === target.id && !n.resolvedAt,
      );
      this.raise(
        existing ?? {
          kind: 'executor-incompatible',
          key: target.id,
          severity: 'warning',
          title: fill(inboxText.incompatibleTitle, target.label),
          body: incompatibleBody(target, snapshot),
          details: run.errorDetail,
          action: { kind: 'view-run', runId: run.id },
          source: { runtimeId: target.id, label: target.label, runId: run.id },
        },
      );
    } else if (['authentication-required', 'api-key-auth-or-configuration'].includes(run.errorCode ?? ''))
      this.notify(usesKey(target, snapshot) ? 'executor-key' : 'executor-login', target, run.id);
    else if (run.errorCode === 'api-budget-expired') this.notify('api-budget', target, run.id);
  }
  reconcile(
    snapshots: readonly RuntimeSnapshot[],
    targets: readonly RuntimeTarget[],
    loginPending: ReadonlySet<string> = new Set(),
  ) {
    const live = new Map(targets.filter((t) => t.enabled && !t.executionDisabledByUser).map((t) => [t.id, t]));
    const stale = new Set(
      this.notices()
        .filter(
          (notice) =>
            notice.kind !== 'network' &&
            notice.kind !== 'github-card' &&
            notice.kind !== 'rule-added' &&
            !notice.resolvedAt &&
            !live.has(notice.source?.runtimeId ?? notice.key),
        )
        .map((notice) => notice.source?.runtimeId ?? notice.key),
    );
    for (const id of stale) this.resolveRuntime(id);
    const states = this.db.prepare('SELECT runtime_id FROM inbox_stable_states').all() as Array<{ runtime_id: string }>;
    for (const { runtime_id } of states) if (!live.has(runtime_id)) this.resolveRuntime(runtime_id);
    for (const snapshot of snapshots) {
      const target = live.get(snapshot.id);
      if (!target || loginPending.has(snapshot.id) || snapshot.status === 'refreshing') continue;
      const before = (
        this.db.prepare('SELECT status FROM inbox_stable_states WHERE runtime_id=?').get(snapshot.id) as
          { status: string } | undefined
      )?.status;
      if (
        ['ready', 'auth-required', 'missing'].includes(snapshot.status) ||
        (snapshot.status === 'error' && snapshot.note === 'runtime-protocol-incompatible')
      )
        this.db
          .prepare(
            'INSERT INTO inbox_stable_states(runtime_id,status) VALUES(?,?) ON CONFLICT(runtime_id) DO UPDATE SET status=excluded.status',
          )
          .run(snapshot.id, snapshot.status);
      if (['ready', 'error'].includes(before ?? '') && snapshot.status === 'auth-required')
        this.notify(usesKey(target, snapshot) ? 'executor-key' : 'executor-login', target);
      if (['ready', 'error'].includes(before ?? '') && snapshot.status === 'missing' && target.gateway !== 'api')
        this.notify('executor-missing', target);
      if (target.gateway !== 'api') {
        const existing = this.notices().find(
          (n) => n.kind === 'executor-incompatible' && n.key === target.id && !n.resolvedAt,
        );
        if (existing && existing.body) {
          const paragraphs = existing.body.split('\n\n');
          paragraphs[1] = incompatibleParagraph(target, snapshot);
          this.update('executor-incompatible', target.id, { body: paragraphs.join('\n\n') });
        } else if (
          before === 'ready' &&
          snapshot.status === 'error' &&
          snapshot.note === 'runtime-protocol-incompatible' &&
          !existing
        ) {
          this.raise({
            kind: 'executor-incompatible',
            key: target.id,
            severity: 'warning',
            title: fill(inboxText.incompatibleTitle, target.label),
            body: incompatibleBody(target, snapshot),
            details: snapshot.errorDetail,
            source: { runtimeId: target.id, label: target.label },
          });
        }
      }
      if (snapshot.status === 'ready') {
        if (
          this.notices().some(
            (n) =>
              n.kind === 'executor-update' &&
              n.key === `${target.provider}:broken` &&
              n.source?.runtimeId === target.id &&
              !n.resolvedAt,
          )
        )
          this.resolve('executor-update', `${target.provider}:broken`);
        if (snapshot.availability?.reason !== 'authentication') this.resolve('executor-login', target.id);
        this.resolve('executor-missing', target.id);
      }
      if (snapshot.apiBudgetState?.phase === 'expired') {
        if (!this.notices().some((n) => n.kind === 'api-budget' && n.key === target.id && !n.resolvedAt))
          this.notify('api-budget', target);
      } else if (!target.apiBudget || snapshot.apiBudgetState) this.resolve('api-budget', target.id);
    }
    this.prune();
  }
}
