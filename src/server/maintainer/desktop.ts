import type { ProjectGates } from '../../shared/types.ts';
import { isDeepStrictEqual } from 'node:util';
import { fill, type Inbox } from '../inbox.ts';
import type { WorkspaceStore } from '../workspace-store.ts';
import {
  githubOutboxSchema,
  githubResolveSchema,
  githubStatusSchema,
  okReplySchema,
  outboxItemSchema,
  type GitHubResolve,
  type GitHubStatus,
} from '../node/peer-protocol.ts';
import type { Devices } from '../devices/service.ts';
import { PeerRefused } from '../devices/peer-client.ts';
import type { Outbox, OutboxItem } from './outbox.ts';
import type { DesktopMaintainerConfig } from './config.ts';
import type { Gh } from './gh.ts';
import type { AuditLine } from './audit.ts';
import { mergePullByNumber } from './merge-by-number.ts';
import type { FullSuiteRunner } from './suite-runner.ts';

export interface HostLink {
  kind?: 'local' | 'peer';
  status?(): Promise<GitHubStatus>;
  resumeJudge?(): void | Promise<void>;
  outbox(): Promise<OutboxItem[]>;
  card(id: string): Promise<OutboxItem | undefined>;
  resolve(id: string, resolution: GitHubResolve): Promise<boolean>;
}
export function memoryHostLink(
  outbox: Outbox,
  status?: () => Promise<GitHubStatus>,
  resumeJudge?: () => void | Promise<void>,
): HostLink {
  const repository = async () => (status ? ((await status()).repository ?? null) : undefined);
  const open = async () => {
    const repo = await repository();
    return repo === null ? [] : outbox.open(repo);
  };
  const all = async () => {
    const repo = await repository();
    return repo === null ? [] : outbox.all(repo);
  };
  return {
    kind: 'local',
    status,
    resumeJudge,
    outbox: open,
    async card(id) {
      return (await all()).find((item) => item.id === id);
    },
    async resolve(id, resolution) {
      if (!(await all()).some((item) => item.id === id)) return false;
      if (githubResolveSchema.parse(resolution).outcome === 'suite-started') return true;
      return !!outbox.resolve(id, { ...githubResolveSchema.parse(resolution), at: new Date().toISOString() });
    },
  };
}
export function peerHostLink(devices: Pick<Devices, 'request'>, deviceId: string): HostLink {
  const outbox = async () =>
    (await devices.request(deviceId, { path: '/peer/v1/github/outbox', schema: githubOutboxSchema })).items;
  return {
    kind: 'peer',
    status: () => devices.request(deviceId, { path: '/peer/v1/github/status', schema: githubStatusSchema }),
    async resumeJudge() {
      await devices.request(deviceId, {
        method: 'POST',
        path: '/peer/v1/github/judge/resume',
        body: {},
        schema: okReplySchema,
      });
    },
    outbox,
    card: async (id) => (await outbox()).find((item) => item.id === id),
    async resolve(id, resolution) {
      outboxItemSchema.shape.id.parse(id);
      try {
        await devices.request(deviceId, {
          method: 'POST',
          path: `/peer/v1/github/outbox/${encodeURIComponent(id)}/resolve`,
          body: githubResolveSchema.parse(resolution),
          schema: okReplySchema,
        });
        return true;
      } catch (error) {
        if (error instanceof PeerRefused && error.status === 404) return false;
        throw error;
      }
    },
  };
}
const titles = {
  merge: 'PR #{0} 可以合并',
  review: 'PR #{0} 等你看',
  ruling: 'PR #{0} 判官拿不准',
  security: 'Issue #{0} 像安全问题',
  close: 'Issue #{0} 建议关闭或标重复',
};
function notice(card: OutboxItem, refusal?: string) {
  if (card.kind === 'suite') return undefined;
  return {
    kind: 'github-card' as const,
    key: card.id,
    severity: card.kind === 'review' && !refusal ? ('info' as const) : ('action' as const),
    title: fill(titles[card.kind], String(card.number)),
    body: [
      fill('标题：{0}', card.title),
      fill('判官：{0} @ {1}', card.verdict ?? '-', card.judgedSha?.slice(0, 7) ?? '-'),
      ...(card.ci
        ? [
            fill(
              '检查：{0} 通过，{1} 失败，{2} 未完成',
              String(card.ci.passed),
              String(card.ci.failed),
              String(card.ci.pending),
            ),
          ]
        : []),
      fill('远程全量测试：{0}', card.suite?.state ?? 'not-run'),
      fill('等级：{0}', card.tier ?? '-'),
      fill('作者：{0}{1}', card.author, card.external ? ' (external)' : ''),
      ...card.reasons,
      ...(card.kind === 'review' && card.external
        ? ['首次贡献者：如果 CI 尚未开始，请在 GitHub 上批准工作流运行。']
        : []),
      card.url,
      ...(refusal ? [fill('未执行：{0}', refusal)] : []),
    ].join('\n\n'),
    action:
      card.mode === 'live' && card.kind === 'merge' ? { kind: 'github-merge' as const, cardId: card.id } : undefined,
    source: { label: 'GitHub maintenance' },
  };
}
type DeskState = { lastSyncAt?: string; refusals?: Record<string, string> };
type DeskDeps = {
  inbox: Inbox;
  store: Pick<WorkspaceStore, 'get' | 'save'>;
  config: () => Promise<DesktopMaintainerConfig | undefined>;
  link: () => HostLink | undefined;
  gh: Gh;
  suite?: FullSuiteRunner;
  gates?: ProjectGates | (() => Promise<ProjectGates | undefined>);
  audit: (line: AuditLine) => void;
  now?: () => number;
  intervalMs?: number;
  log?: (message: string) => void;
};
export class MaintainerDesk {
  private timer?: ReturnType<typeof setInterval>;
  private syncing?: Promise<void>;
  private readonly merging = new Map<string, ReturnType<typeof mergePullByNumber>>();
  private problem?: string;
  private closed = false;
  private suiteWork?: { controller: AbortController; done: Promise<void> };
  private readonly state: DeskState;
  constructor(private readonly deps: DeskDeps) {
    this.state = deps.store.get<DeskState>('maintainer-desk-state', 'singleton') ?? {};
    this.state.refusals ??= {};
  }
  private saveState() {
    this.deps.store.save('maintainer-desk-state', 'singleton', 'maintainer', this.state);
  }
  start() {
    if (this.closed || this.timer) return;
    void this.sync();
    this.timer = setInterval(() => {
      void this.sync();
    }, this.deps.intervalMs ?? 60_000);
    this.timer.unref();
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    this.timer = undefined;
    this.suiteWork?.controller.abort();
    await this.syncing;
    await this.suiteWork?.done;
    await Promise.all(this.merging.values());
  }
  sync(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.syncing) return this.syncing;
    this.syncing = this.syncOnce()
      .catch((error) => {
        this.problem = error instanceof Error ? error.message : 'Host unavailable';
        this.deps.log?.(this.problem);
      })
      .finally(() => {
        this.syncing = undefined;
      });
    return this.syncing;
  }
  private async syncOnce() {
    const link = this.deps.link();
    if (!link) return;
    const cards = githubOutboxSchema.parse({ items: await link.outbox() }).items;
    const notices = this.deps.inbox.list({ all: true }).filter((n) => n.kind === 'github-card');
    let suiteAttempted = false;
    for (const card of cards) {
      if (
        card.resolution ||
        card.supersededBy ||
        (card.expiresAt && Date.parse(card.expiresAt) <= (this.deps.now ?? Date.now)())
      )
        continue;
      if (
        !suiteAttempted &&
        !this.suiteWork &&
        this.deps.suite &&
        card.kind === 'suite' &&
        card.mode === 'live' &&
        !card.external
      ) {
        suiteAttempted = true;
        this.startSuite(card.id);
      }
      const existing = notices.find((n) => n.key === card.id);
      if (existing?.dismissedAt) {
        if (await link.resolve(card.id, { outcome: 'declined' })) {
          this.deps.inbox.resolve('github-card', card.id);
          delete this.state.refusals![card.id];
        }
      } else {
        const input = notice(card, this.state.refusals![card.id]);
        if (input && !existing) this.deps.inbox.raise(input);
        else if (
          input &&
          existing &&
          !existing.resolvedAt &&
          (input.title !== existing.title ||
            input.body !== existing.body ||
            input.severity !== existing.severity ||
            !isDeepStrictEqual(input.action, existing.action))
        )
          this.deps.inbox.update('github-card', card.id, input);
      }
    }
    for (const existing of notices.filter((n) => !n.resolvedAt)) {
      const card = await link.card(existing.key);
      if (
        !card ||
        card.resolution ||
        card.supersededBy ||
        (card.expiresAt && Date.parse(card.expiresAt) <= (this.deps.now ?? Date.now)())
      ) {
        this.deps.inbox.resolve('github-card', existing.key);
        delete this.state.refusals![existing.key];
      }
    }
    this.problem = undefined;
    this.state.lastSyncAt = new Date((this.deps.now ?? Date.now)()).toISOString();
    this.saveState();
  }
  merge(cardId: string): ReturnType<typeof mergePullByNumber> {
    const active = this.merging.get(cardId);
    if (active) return active;
    const work = this.mergeOnce(cardId).finally(() => this.merging.delete(cardId));
    this.merging.set(cardId, work);
    return work;
  }
  private async mergeOnce(cardId: string): ReturnType<typeof mergePullByNumber> {
    const link = this.deps.link();
    const config = await this.deps.config();
    if (!link || !config) return { status: 'refused', reason: 'GitHub maintenance is not configured' };
    const raw = await link.card(cardId);
    if (!raw) return { status: 'refused', reason: 'Merge card is no longer open' };
    const card = outboxItemSchema.parse(raw);
    const result = await mergePullByNumber(
      { repository: config.repository, number: card.number, judgedSha: card.judgedSha ?? '', cardId },
      {
        gh: this.deps.gh,
        card: () => link.card(cardId),
        requiredChecks: config.requiredChecks,
        gates: typeof this.deps.gates === 'function' ? await this.deps.gates() : this.deps.gates,
        now: () => new Date((this.deps.now ?? Date.now)()),
        audit: this.deps.audit,
      },
    );
    if (result.status === 'merged') {
      if (await link.resolve(cardId, { outcome: 'merged', mergeCommit: result.mergeCommit })) {
        this.deps.inbox.resolve('github-card', cardId);
        delete this.state.refusals![cardId];
      }
    } else {
      this.state.refusals![cardId] = result.reason;
      this.deps.inbox.update('github-card', cardId, {
        body: notice(card, result.reason)?.body,
        severity: 'action',
      });
    }
    this.saveState();
    return result;
  }
  private startSuite(cardId: string): void {
    if (this.closed || this.suiteWork) return;
    const controller = new AbortController();
    const done = (async () => {
      const link = this.deps.link();
      const raw = await link?.card(cardId);
      const card = raw && outboxItemSchema.parse(raw);
      if (
        !link ||
        !card ||
        card.resolution ||
        card.supersededBy ||
        card.mode !== 'live' ||
        (card.expiresAt && Date.parse(card.expiresAt) <= (this.deps.now ?? Date.now)()) ||
        card.kind !== 'suite'
      )
        throw new Error('Review card is no longer open');
      if (card.external) throw new Error('External PRs cannot run the full suite');
      if (!this.deps.suite) throw new Error('Full suite runner is not configured');
      const suite = await this.deps.suite.run(
        {
          cardId,
          number: card.number,
          sha: card.judgedSha ?? '',
          author: card.author,
          external: card.external,
        },
        controller.signal,
        async () => {
          await link.resolve(cardId, { outcome: 'suite-started' });
        },
      );
      await link.resolve(cardId, { outcome: 'suite-result', suite });
    })()
      .catch((error) => {
        const reason = error instanceof Error ? error.message : 'Suite unavailable';
        this.deps.log?.(reason);
      })
      .finally(() => {
        this.suiteWork = undefined;
      });
    this.suiteWork = { controller, done };
  }
  async resumeJudge(): Promise<{ status: 'resumed' | 'refused'; reason?: string }> {
    const link = this.deps.link();
    if (this.closed || !link?.resumeJudge) return { status: 'refused', reason: 'GitHub host is unavailable' };
    await link.resumeJudge();
    return { status: 'resumed' };
  }
  async status() {
    const state = this.deps.store.get<{ lastSyncAt?: string }>('maintainer-desk-state', 'singleton');
    const link = this.deps.link();
    let configured = false;
    let host: GitHubStatus | undefined;
    let problem = this.problem;
    try {
      configured = !!(await this.deps.config());
      if (link?.status) host = githubStatusSchema.parse(await link.status());
    } catch (error) {
      problem = error instanceof Error ? error.message : 'GitHub maintenance unavailable';
    }
    return {
      configured,
      host,
      desk: {
        lastSyncAt: state?.lastSyncAt,
        link: link ? (link.kind ?? 'local') : ('none' as const),
        problem,
      },
    };
  }
}
