import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { MaintainerHost } from '../../src/server/maintainer/poller.ts';
import { MaintainerAudit } from '../../src/server/maintainer/audit.ts';
import { StoreOutbox } from '../../src/server/maintainer/outbox.ts';
import { writeHostFlag } from '../../src/server/maintainer/config.ts';
import type { NoToolsRunner } from '../../src/server/maintainer/executor.ts';
import type { Gh } from '../../src/server/maintainer/gh.ts';
import type { PullRecord, IssueRecord } from '../../src/server/maintainer/pipeline.ts';
import { fakeGh, memoryStore, pullFixture, stamp } from './maintainer.ts';
import { botLabels } from '../../src/server/maintainer/labels.ts';

export async function hostFixture(t: TestContext, options: { runner?: (flagFile: string) => NoToolsRunner } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'maintainer-host-'));
  const flagFile = join(dir, 'github-host.json');
  let clock = Date.parse(stamp);
  const store = memoryStore(),
    outbox = new StoreOutbox(store, () => clock),
    audit = new MaintainerAudit(join(dir, 'maintainer-audit.jsonl'));
  const data = {
    private: false as boolean | undefined,
    honorSearch: false,
    owner: 'owner',
    token: true,
    ready: true,
    rate: 5000,
    reset: clock / 1000 + 60,
    required: ['ci'],
    permissions: new Map<string, string>(),
    labels: [...Object.keys(botLabels), 'bug'],
    prs: new Map<number, ReturnType<typeof pullFixture>['fixture'] & { updatedAt: string }>(),
    issues: [] as {
      number: number;
      title: string;
      body: string;
      url: string;
      author: { login: string };
      labels: { name: string }[];
      createdAt: string;
      updatedAt: string;
    }[],
    duplicates: [] as { number: number; title: string; url: string; state: string }[],
    comments: new Map<number, { id: number; body: string; user: { login: string } }[]>(),
    forbidden: 0,
    verdict: 'PASS',
    triage: JSON.stringify({
      type: 'bug',
      labels: ['bug'],
      keywords: ['widget'],
      missingInfo: ['version'],
      looksLikeSecurity: false,
    }),
    wait: undefined as undefined | (() => Promise<void>),
    repoError: false,
    writeWait: undefined as undefined | ((args: string[]) => Promise<void>),
    readWait: undefined as undefined | ((args: string[]) => Promise<void>),
  };
  const reads = fakeGh(async (args) => {
    await data.readWait?.(args);
    if (args[0] === 'api' && args[1] === 'rate_limit') return { remaining: data.rate, reset: data.reset };
    if (args[0] === 'api' && args[1] === 'repos/o/r') {
      if (data.repoError) throw new Error('Synthetic repo failure');
      return { private: data.private, owner: { login: data.owner }, default_branch: 'main' };
    }
    if (args[0] === 'label' && args[1] === 'list') return data.labels.map((name) => ({ name }));
    if (args[0] === 'pr' && args[1] === 'list')
      return [...data.prs.values()]
        .filter((p) => args[args.indexOf('--state') + 1] !== 'open' || p.view.state === 'OPEN')
        .filter(
          (p) =>
            !data.honorSearch ||
            !args.includes('--search') ||
            p.updatedAt >= args[args.indexOf('--search') + 1]!.replace('updated:>=', ''),
        )
        .slice(0, Number(args[args.indexOf('--limit') + 1]))
        .map((p) => ({ ...p.view, updatedAt: p.updatedAt }));
    if (args[0] === 'pr' && args[1] === 'view') {
      const p = data.prs.get(Number(args[2]));
      if (!p) throw new Error('Missing fake PR');
      return { ...p.view, updatedAt: p.updatedAt };
    }
    if (args[0] === 'issue' && args[1] === 'list')
      return args.includes('number,title,state,url') ? data.duplicates : data.issues;
    if (args[0] === 'issue' && args[1] === 'view') return data.issues.find((i) => i.number === Number(args[2]));
    if (args[1]?.includes('/rules/branches/'))
      return [
        {
          type: 'required_status_checks',
          parameters: { required_status_checks: data.required.map((context) => ({ context })) },
        },
      ];
    if (args[1]?.includes('/collaborators/')) return data.permissions.get(args[1].split('/')[4]) ?? 'write';
    if (/\/pulls\/\d+\/reviews$/.test(args[1] ?? '')) return [[]];
    if (/\/issues\/\d+\/comments$/.test(args[1] ?? '')) return [data.comments.get(Number(args[1].split('/')[4])) ?? []];
    if (args[1]?.includes('/compare/')) {
      const p = [...data.prs.values()].find((p) => args[1].endsWith(p.view.headRefOid));
      if (!p) throw new Error('Missing fake compare');
      return args.includes('Accept: application/vnd.github.diff')
        ? p.diff
        : { merge_base_commit: { sha: p.mergeBaseSha }, files: p.files, total_commits: 1 };
    }
    if (args[1]?.includes('/git/trees/')) return { truncated: false, tree: [] };
    throw new Error(`Unexpected read: ${args.join(' ')}`);
  });
  const writes = fakeGh((args, input) => {
    if (args[0] === 'label') {
      data.labels.push(args[2]);
      return {};
    }
    if (args[0] === 'pr' || args[0] === 'issue') return {};
    const endpoint = args[3],
      payload = input ? JSON.parse(input) : {};
    if (/\/comments(?:\/\d+)?$/.test(endpoint)) {
      const n = Number(/\/issues\/(\d+)\/comments/.exec(endpoint)?.[1]);
      const id = Number(/\/comments\/(\d+)/.exec(endpoint)?.[1]) || 100 + writes.calls.length;
      if (n)
        data.comments.set(n, [
          ...(data.comments.get(n) ?? []),
          { id, body: payload.body, user: { login: 'synthetic[bot]' } },
        ]);
      return { id, html_url: `https://github.com/o/r/pull/${n || 1}#issuecomment-${id}` };
    }
    if (endpoint?.includes('/statuses/') || endpoint?.endsWith('/reviews')) return {};
    throw new Error(`Unexpected write: ${args.join(' ')}`);
  });
  const writeGh: Gh = {
    ...writes.gh,
    run: async (args, opts) => {
      await data.writeWait?.(args);
      opts?.signal?.throwIfAborted();
      if (data.forbidden > 0) {
        data.forbidden--;
        writes.calls.push({ args, input: opts?.input });
        return { code: 1, stdout: '', stderr: 'HTTP 403 forbidden' };
      }
      return writes.gh.run(args, opts);
    },
  };
  const dispatches: { prompt: string; title: string }[] = [],
    cancelled: string[] = [];
  const runner: NoToolsRunner = {
    toollessReady: () => data.ready,
    dispatch: async (input) => {
      dispatches.push(input);
      return { taskId: String(dispatches.length - 1) };
    },
    result: async (id) => {
      await data.wait?.();
      const input = dispatches[Number(id)];
      const n = Number(/PR #(\d+)/.exec(input.title)?.[1]);
      return {
        status: 'completed',
        result: n
          ? `${data.verdict} @ ${data.prs.get(n)!.view.headRefOid.slice(0, 7)}\n## Risks\nnone\n## Tests\nsynthetic\n## Missing\nnone\nJUDGE: pr-judge`
          : data.triage,
      };
    },
    cancel: async (id) => {
      cancelled.push(id);
    },
  };
  const app = {
    token: async () => (data.token ? 'synthetic-token' : undefined),
    botLogin: async () => (data.token ? 'synthetic[bot]' : undefined),
    forget: () => {},
  };
  const enable = (suiteConfigured = false) =>
    writeHostFlag(flagFile, {
      host: true,
      repository: 'o/r',
      stage: 0,
      leaseUntil: new Date(clock + 6 * 3600_000).toISOString(),
      suiteConfigured,
      requiredChecks: ['ci'],
    });
  // Construct after the flag exists, like startup from a saved hosting configuration.
  enable();
  const running = new MaintainerHost({
    flagFile,
    dataDir: dir,
    store,
    outbox,
    audit,
    gh: reads.gh,
    writeGh,
    runner: options.runner?.(flagFile) ?? runner,
    app,
    now: () => clock,
  });
  t.after(async () => {
    await running.close();
    await rm(dir, { recursive: true, force: true });
  });
  return {
    dir,
    flagFile,
    store,
    outbox,
    audit,
    data,
    reads: reads.calls,
    writes: writes.calls,
    dispatches,
    cancelled,
    host: running,
    enable,
    advance: (ms: number) => {
      clock += ms;
    },
    now: () => clock,
    async poll() {
      await running.poll();
      await (running as unknown as { worker?: Promise<void> }).worker;
    },
    record: (number = 1) => store.get<PullRecord>('maintainer-pr', `o/r#${number}`)!,
    issueRecord: (number = 10) => store.get<IssueRecord>('maintainer-issue', `o/r#${number}`)!,
    addPr(number = 1, author = 'contributor', path = 'README.md') {
      const p = pullFixture().fixture;
      p.view = {
        ...p.view,
        number,
        author: { login: author },
        url: `https://github.com/o/r/pull/${number}`,
        headRefOid: number.toString(16).padStart(40, 'a'),
        changedFiles: 1,
      };
      p.files = [{ filename: path, status: 'modified', additions: 1, deletions: 0, patch: '@@' }];
      p.view.files = [{ path, additions: 1, deletions: 0 }];
      const value = { ...p, updatedAt: new Date(clock).toISOString() };
      data.prs.set(number, value);
      return value;
    },
    addIssue(number = 10, author = 'reporter') {
      const value = {
        number,
        author: { login: author },
        title: 'Widget problem',
        body: 'Synthetic report',
        url: `https://github.com/o/r/issues/${number}`,
        labels: [] as { name: string }[],
        createdAt: new Date(clock).toISOString(),
        updatedAt: new Date(clock).toISOString(),
      };
      data.issues.push(value);
      return value;
    },
    suiteResult(sha: string, status: 'passed' | 'failed' | 'error' = 'passed') {
      return {
        sha,
        tests: 3,
        passed: status === 'passed' ? 3 : 2,
        failed: status === 'failed' ? 1 : 0,
        failingFiles: status === 'failed' ? ['@someone `file` #12.ts'] : [],
        minutes: 1,
        runId: 'suite-fake',
        status,
      };
    },
  };
}
