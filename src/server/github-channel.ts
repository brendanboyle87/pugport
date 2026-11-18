import { admit, AdmissionRules, type SenderClass } from './external-admission.ts';
import { ExternalEvents, type ExternalEvent } from './external-events.ts';
import type { Inbox } from './inbox.ts';

export type GitHubTransport = (
  path: string,
  options?: {
    method?: 'GET' | 'POST' | 'PATCH';
    body?: unknown;
    identity?: 'owner' | 'app';
  },
) => Promise<{ data: unknown; headers?: Record<string, string>; status?: number }>;
export type GitHubChannelOptions = {
  events: ExternalEvents;
  inbox?: Inbox;
  transport: GitHubTransport;
  project: (repository: string) => string | undefined | Promise<string | undefined>;
  dispatch: (input: {
    task: string;
    caller: string;
    title: string;
    readOnly: boolean;
    owner: boolean;
    untrusted: boolean;
    projectPath?: string;
    requestId: string;
  }) => Promise<{ taskId: string; conversationId: string }>;
  result: (id: string) => Promise<{ status: string; result?: string; error?: string }>;
  appLogin?: (repository: string) => string | undefined | Promise<string | undefined>;
  appIdentity?: (repository: string) => boolean | Promise<boolean>;
  now?: () => number;
};
type Row = Record<string, any>;
export const mentionsPugPort = (text: string) => /(^|[^\w@])@pugport(?![\w-])/i.test(text);
const terminal = new Set(['completed', 'failed', 'cancelled', 'stopped', 'blocked', 'interrupted', 'error']);

/** GitHub poll adapter; all durable event and delivery state lives in the shared event ledger. */
export class GitHubChannel {
  private permissions = new Map<string, { until: number; trusted: boolean }>();
  private busy = new Set<string>();
  private polling = new Map<string, Promise<void>>();
  private now: () => number;
  constructor(private options: GitHubChannelOptions) {
    this.now = options.now ?? Date.now;
  }
  deferred(repo: string) {
    return (
      (this.options.events.store.get<{ until: number }>('github-channel-rate', repo.toLowerCase())?.until ?? 0) >
      this.now()
    );
  }
  private async call(repo: string, path: string, options?: Parameters<GitHubTransport>[1]) {
    const state = this.options.events.store.get<{ until: number }>('github-channel-rate', repo);
    if (state && state.until > this.now()) throw new Error('GitHub rate limit deferred');
    const response = await this.options.transport(path, { identity: 'owner', ...options });
    const headers = Object.fromEntries(Object.entries(response.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const remaining = Number(headers['x-ratelimit-remaining'] ?? Infinity);
    const retry = Number(headers['retry-after'] ?? 0);
    if (remaining <= 20 || retry > 0) {
      const until = Math.max(this.now() + Math.max(retry, 60) * 1000, Number(headers['x-ratelimit-reset'] ?? 0) * 1000);
      this.options.events.store.save('github-channel-rate', repo, 'github', { until });
    }
    if ((response.status ?? 200) >= 400) throw new Error(`GitHub HTTP ${response.status}`);
    return response.data as any;
  }
  poll(repository: string) {
    const repo = repository.toLowerCase();
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return Promise.reject(new Error('Invalid repository'));
    const previous = this.polling.get(repo);
    if (previous) return previous;
    const work = this.cycle(repo).finally(async () => {
      try {
        await this.recover();
      } catch {
        /* A later existing poll retries recovery independently of a sweep failure. */
      }
      this.polling.delete(repo);
    });
    this.polling.set(repo, work);
    return work;
  }
  private async pages(repo: string, path: string) {
    const rows: Row[] = [];
    for (let page = 1; page <= 10; page++) {
      const data = await this.call(repo, `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      const batch = Array.isArray(data) ? data : data.workflow_runs;
      if (!Array.isArray(batch)) throw new Error('Invalid GitHub list');
      rows.push(...batch);
      if (batch.length < 100) return rows;
    }
    // Do not advance a cursor when a bounded sweep cannot prove complete coverage.
    throw new Error('GitHub channel sweep exceeded page budget');
  }
  private async cycle(repo: string) {
    const owner = await this.call(repo, 'user');
    const metadata = await this.call(repo, `repos/${repo}`);
    if (!owner.login || String(metadata.owner?.login).toLowerCase() !== String(owner.login).toLowerCase()) return;
    const cursor = this.options.events.store.get<{ since: string }>('github-channel-cursor', repo);
    const started = new Date(this.now()).toISOString();
    const since = cursor ? `&since=${encodeURIComponent(cursor.since)}` : '';
    const issues = await this.pages(repo, `repos/${repo}/issues?state=all&sort=updated&direction=desc${since}`);
    for (const row of issues) await this.ingest(repo, owner.login, row.pull_request ? 'pr' : 'issue', row, row.number);
    for (const path of ['issues/comments', 'pulls/comments']) {
      const comments = await this.pages(repo, `repos/${repo}/${path}?sort=updated&direction=desc${since}`);
      for (const row of comments) {
        const number = Number(
          String(row.issue_url ?? row.pull_request_url)
            .split('/')
            .pop(),
        );
        if (
          number > 0 &&
          (mentionsPugPort(row.body ?? '') ||
            this.options.events
              .list()
              .some((e) => e.source === 'github' && e.eventId === `${repo}:comment:${path}:${row.id}`))
        )
          await this.ingest(repo, owner.login, 'comment', { ...row, id: `${path}:${row.id}` }, number);
      }
    }
    const runs = await this.pages(
      repo,
      `repos/${repo}/actions/runs?branch=${encodeURIComponent(metadata.default_branch)}&status=failure`,
    );
    for (const row of runs) {
      if (row.head_branch !== metadata.default_branch || row.conclusion !== 'failure') continue;
      const commit = await this.call(repo, `repos/${repo}/commits/${encodeURIComponent(row.head_sha)}`);
      await this.ingest(repo, owner.login, 'ci', { ...row, commitAuthor: commit.author?.login }, 0);
    }
    this.options.events.store.save('github-channel-cursor', repo, 'github', { since: started });
  }
  private async sender(repo: string, login: string, user: Row, owner: string): Promise<SenderClass> {
    if (user.type === 'Bot' || user.type === 'App' || /\[bot\]$/i.test(login)) return 'bot';
    if (login.toLowerCase() === owner.toLowerCase()) return 'owner';
    const key = `${repo}:${login.toLowerCase()}`;
    let cached = this.permissions.get(key);
    if (!cached || cached.until <= this.now()) {
      let data: Row;
      try {
        data = await this.call(repo, `repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`);
      } catch (error) {
        if (!/404|not found/i.test(String(error))) throw error;
        data = { permission: 'none' };
      }
      const trusted =
        ['admin', 'maintain', 'write', 'triage', 'read'].includes(data.permission) && data.permission !== 'none';
      cached = { until: this.now() + 300000, trusted };
      this.permissions.set(key, cached);
    }
    return cached.trusted ? 'trusted' : 'other';
  }
  private async ingest(
    repo: string,
    owner: string,
    scope: 'issue' | 'pr' | 'comment' | 'ci',
    row: Row,
    number: number,
  ) {
    if (String(row.body ?? '').includes('<!-- pugport-event:')) return;
    const ci = scope === 'ci';
    const user = row.user ?? {};
    const login = String(user.login ?? 'github-actions[bot]');
    const input = {
      source: 'github' as const,
      scope,
      senderId: login,
      senderClass: ci ? ('system' as const) : await this.sender(repo, login, user, owner),
      rateLimited: this.rateLimited(login),
      ownerRepository: true,
      mentioned: mentionsPugPort(row.body ?? ''),
      defaultBranchFailure: ci,
      ownerCommit:
        ci && String(row.commitAuthor ?? row.head_commit?.author?.username ?? '').toLowerCase() === owner.toLowerCase(),
    };
    const { event, fresh } = this.options.events.record({
      ...input,
      ...admit(input, new AdmissionRules(this.options.events.store, 'github').read()),
      eventId: `${repo}:${scope}:${row.id}`,
      senderName: login,
      scopeLabel: `${repo}#${number}`,
      channel: repo,
      ts: ci ? `commit:${row.head_sha}` : String(number),
      quotedContext: /(^|\n)\s*>|```/.test(row.body ?? '') ? 'Quoted GitHub content' : undefined,
      text: ci
        ? `CI failure: ${row.name ?? ''}\n${row.html_url ?? ''}`
        : `${row.title ? row.title + '\n\n' : ''}${row.body ?? ''}`,
      permalink: row.html_url,
    });
    if (!fresh) {
      this.notice(event);
      return;
    }
    if (event.verdict === 'ignore' || event.verdict === 'digest') return;
    this.options.events.receipt(
      event.id,
      'received',
      event.verdict === 'ask-owner' ? '收到，等主人确认' : '收到，马上处理',
    );
    this.notice(event);
    await this.flush(event.id);
    if (event.verdict === 'do-now') await this.start(event.id);
  }
  private notice(event: ExternalEvent) {
    if (
      event.verdict !== 'ask-owner' &&
      (event.level !== 'L2' || !['done', 'failed'].includes(event.receipt?.state ?? ''))
    )
      return;
    const externalRequest = {
      eventId: event.id,
      source: 'github' as const,
      senderName: event.senderName,
      scopeLabel: event.scopeLabel ?? event.channel,
      permalink: event.permalink,
      status:
        event.decision === 'reject'
          ? ('rejected' as const)
          : event.decision || event.level === 'L2'
            ? ('approved' as const)
            : ('pending' as const),
      workflowId: event.workflowId,
      receiptState: event.receipt?.state,
      suggestAlways: this.options.events.streak(event) >= 2,
    };
    const values = {
      body: event.text,
      externalRequest,
      severity: externalRequest.status === 'pending' ? ('action' as const) : ('info' as const),
    };
    if (this.options.inbox?.list({ all: true }).some((n) => n.kind === 'external-request' && n.key === event.id))
      this.options.inbox.update('external-request', event.id, values);
    else
      this.options.inbox?.raise({
        kind: 'external-request',
        key: event.id,
        title: `GitHub · ${event.scopeLabel}`,
        bodyVerbatim: true,
        ...values,
      });
  }
  async resolveRequest(id: string, decision: 'approve' | 'reject' | 'always') {
    const e = this.options.events.get(id);
    if (!e || e.source !== 'github' || e.verdict !== 'ask-owner') throw new Error('请求不存在');
    if (e.decision) return e;
    e.decision = decision;
    e.decisionOrder = this.options.events.list().reduce((n, x) => Math.max(n, x.decisionOrder ?? 0), 0) + 1;
    this.options.events.save(e);
    if (decision === 'always') new AdmissionRules(this.options.events.store, 'github').trust(e.scope, e.senderId);
    if (decision === 'reject') this.options.events.receipt(id, 'rejected', '主人这次没有接这个请求');
    else await this.start(id);
    this.notice(this.options.events.get(id)!);
    await this.flush(id);
    return this.options.events.get(id);
  }
  private rateLimited(senderId: string, exclude?: string) {
    const events = this.options.events
      .list()
      .filter((e) => e.source === 'github' && e.id !== exclude && e.senderId.toLowerCase() === senderId.toLowerCase());
    const active = events.filter(
      (e) =>
        (e.verdict === 'do-now' || e.decision === 'approve' || e.decision === 'always') &&
        (e.receipt?.state === 'received' || e.receipt?.state === 'working'),
    ).length;
    const hourly = events.filter(
      (e) => (e.workflowId || e.dispatching) && Date.parse(e.dispatchStartedAt ?? e.createdAt) > this.now() - 3600000,
    ).length;
    return active >= 3 || hourly >= 30;
  }
  private async start(id: string) {
    let e = this.options.events.get(id)!;
    if (e.workflowId || e.dispatching || this.busy.has(id)) return;
    this.busy.add(id);
    try {
      const login = await this.call(e.channel, 'user');
      const repository = await this.call(e.channel, `repos/${e.channel}`);
      if (
        !login.login ||
        String(repository.owner?.login).toLowerCase() !== String(login.login).toLowerCase() ||
        (e.senderClass === 'owner' && e.senderId.toLowerCase() !== String(login.login).toLowerCase())
      )
        throw new Error('GitHub owner identity no longer matches this request');
      const path = await this.options.project(e.channel);
      e = this.options.events.get(id)!;
      if (e.workflowId || e.dispatching || e.decision === 'reject') return;
      if (this.rateLimited(e.senderId, id)) {
        e.level = 'L4';
        e.verdict = 'digest';
        e.reason = '\u592a\u9891\u7e41';
        this.options.events.save(e);
        this.options.events.receipt(id, 'noted', '');
        this.options.inbox?.update('external-request', id, {
          severity: 'info',
          body: e.reason,
          externalRequest: {
            eventId: id,
            source: 'github',
            senderName: e.senderName,
            scopeLabel: e.scopeLabel ?? e.channel,
            status: 'approved',
            receiptState: 'noted',
            suggestAlways: false,
            permalink: e.permalink,
          },
        });
        return;
      }
      const owner = e.senderClass === 'owner' && e.level === 'L1';
      e.dispatching = true;
      e.dispatchStartedAt = new Date(this.now()).toISOString();
      this.options.events.save(e);
      const result = await this.options.dispatch({
        task: e.text,
        caller: `github:${e.channel}:${e.senderId}`,
        title: `GitHub · ${e.scopeLabel} ${e.text.slice(0, 80)}`,
        readOnly: !owner || !path || !!e.quotedContext,
        owner,
        untrusted: !owner || !!e.quotedContext,
        projectPath: path,
        requestId: e.id,
      });
      const latest = this.options.events.get(id)!;
      latest.workflowId = result.taskId;
      latest.conversationId = result.conversationId;
      latest.dispatching = false;
      this.options.events.save(latest);
      this.options.events.receipt(id, 'working', '处理中…');
      this.notice(this.options.events.get(id)!);
      await this.flush(id);
    } catch (error) {
      // An ambiguous dispatch is never blindly repeated after restart.
      this.options.events.receipt(id, 'failed', `没做成：${String(error).slice(0, 300)}`);
    } finally {
      this.busy.delete(id);
    }
  }
  async recover() {
    for (const e of this.options.events.list().filter((e) => e.source === 'github')) {
      if (e.workflowId && e.receipt?.state === 'working') {
        const outcome = await this.options.result(e.workflowId);
        if (terminal.has(outcome.status)) {
          this.options.events.receipt(
            e.id,
            outcome.status === 'completed' ? 'done' : 'failed',
            (outcome.status === 'completed' ? '完成：' : '没做成：') +
              this.summary(outcome.result ?? outcome.error ?? outcome.status),
          );
          this.notice(this.options.events.get(e.id)!);
        }
      } else if (e.dispatching && !e.workflowId && e.receipt?.state === 'received' && !this.busy.has(e.id)) {
        this.options.events.receipt(e.id, 'failed', '没做成：任务启动结果不明确，请在 PugPort 检查');
      } else if (
        !e.workflowId &&
        !e.dispatching &&
        e.receipt?.state === 'received' &&
        (e.verdict === 'do-now' || e.decision === 'approve' || e.decision === 'always')
      )
        await this.start(e.id);
      await this.flush(e.id);
    }
  }
  private summary(text: string) {
    const links = [
      ...new Set(text.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:pull\/\d+|commit\/[a-f0-9]+)/gi) ?? []),
    ];
    return [text.slice(0, 1500), ...links].join('\n');
  }
  private async flush(id: string) {
    const e = this.options.events.get(id)!;
    const receipt = e.receipt;
    const key = `receipt:${id}`;
    if (
      !receipt ||
      !e.ts ||
      e.ts === '0' ||
      e.verdict === 'digest' ||
      e.verdict === 'ignore' ||
      receipt.nextAttempt > this.now() ||
      this.busy.has(key)
    )
      return;
    this.busy.add(key);
    let attempted = false;
    let deliveryError: string | undefined;
    let delivered: string | undefined;
    let nextAttempt = receipt.nextAttempt;
    const messages = [...receipt.messages];
    let identity = receipt.identity;
    let authorLogin = receipt.authorLogin;
    try {
      identity ??= (await this.options.appIdentity?.(e.channel)) ? 'app' : 'owner';
      const marker = `<!-- pugport-event:${id} -->`;
      const body = `${receipt.text}${identity === 'owner' ? '\n\n\u2014 PugPort' : ''}\n\n${marker}`;
      if (receipt.delivered === body) return;
      const currentLogin =
        identity === 'owner' ? (await this.call(e.channel, 'user')).login : await this.options.appLogin?.(e.channel);
      if (!currentLogin) throw new Error('Missing receipt author identity');
      if (authorLogin && authorLogin.toLowerCase() !== String(currentLogin).toLowerCase())
        throw new Error('Receipt author identity changed');
      authorLogin ??= String(currentLogin);
      attempted = true;
      // Save the posting identity before the network call, including an ambiguous successful POST.
      const current = this.options.events.get(id)!;
      current.receipt!.identity = identity;
      current.receipt!.authorLogin = authorLogin;
      current.receipt!.attempts++;
      this.options.events.save(current);
      if (!messages.length) {
        const target = e.ts.startsWith('commit:') ? `commits/${encodeURIComponent(e.ts.slice(7))}` : `issues/${e.ts}`;
        const comments = await this.pages(e.channel, `repos/${e.channel}/${target}/comments`);
        const existing = comments.find(
          (c) => String(c.body).includes(marker) && c.user?.login?.toLowerCase() === authorLogin!.toLowerCase(),
        );
        if (existing) messages.push(String(existing.id));
        else {
          const created = await this.call(e.channel, `repos/${e.channel}/${target}/comments`, {
            method: 'POST',
            body: { body },
            identity,
          });
          if (!created.id) throw new Error('Missing GitHub receipt comment id');
          messages.push(String(created.id));
        }
        const latest = this.options.events.get(id)!;
        latest.receipt!.messages = messages;
        this.options.events.save(latest);
      }
      await this.call(
        e.channel,
        `repos/${e.channel}/${e.ts.startsWith('commit:') ? 'comments' : 'issues/comments'}/${messages[0]}`,
        { method: 'PATCH', body: { body }, identity },
      );
      delivered = body;
      nextAttempt = 0;
    } catch (error) {
      deliveryError = String(error).slice(0, 300);
      nextAttempt = this.now() + Math.min(60000, 1000 * 2 ** Math.min(receipt.attempts + 1, 6));
    } finally {
      const latest = this.options.events.get(id);
      if (latest?.receipt && (attempted || deliveryError)) {
        latest.receipt.identity = identity;
        latest.receipt.authorLogin = authorLogin;
        latest.receipt.messages = messages;
        if (delivered) latest.receipt.delivered = delivered;
        latest.receipt.nextAttempt = nextAttempt;
        if (deliveryError)
          latest.receipt.history.push({
            state: receipt.state,
            at: new Date(this.now()).toISOString(),
            error: deliveryError,
          });
        this.options.events.save(latest);
      }
      this.busy.delete(key);
    }
  }
}
