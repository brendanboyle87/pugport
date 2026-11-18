import assert from 'node:assert/strict';
import test from 'node:test';
import { mergePullByNumber, type MergeDeps } from '../src/server/maintainer/merge-by-number.ts';
import { ciState, requiredChecks } from '../src/server/maintainer/checks.ts';
import type { OutboxItem } from '../src/server/maintainer/outbox.ts';
import type { AuditLine } from '../src/server/maintainer/audit.ts';
import { card, sha, blobSha, stamp, mergeFixture, fakeGh } from './helpers/maintainer.ts';

function fixture() {
  const f = mergeFixture();
  let current: OutboxItem | undefined = card();
  const audit: AuditLine[] = [];
  const deps: MergeDeps = {
    gh: f.gh,
    card: async () => current,
    now: () => new Date(stamp),
    audit: (line) => {
      audit.push(line);
    },
  };
  const run = (extra = {}) =>
    mergePullByNumber({ repository: 'o/r', number: 7, judgedSha: sha, cardId: card().id, ...extra }, deps);
  return {
    ...f,
    deps,
    audit,
    run,
    setCard: (value: OutboxItem | undefined) => {
      current = value;
    },
  };
}
for (const [name, change] of Object.entries({
  missing: (f: ReturnType<typeof fixture>) => f.setCard(undefined),
  closed: (f: ReturnType<typeof fixture>) => f.setCard(card({ resolution: { outcome: 'declined', at: stamp } })),
  failed: (f: ReturnType<typeof fixture>) => f.setCard(card({ verdict: 'fail' })),
  blocked: (f: ReturnType<typeof fixture>) => f.setCard(card({ verdict: 'blocked' })),
  sha: (f: ReturnType<typeof fixture>) => f.setCard(card({ judgedSha: blobSha })),
  shadow: (f: ReturnType<typeof fixture>) => f.setCard(card({ mode: 'shadow' })),
  kind: (f: ReturnType<typeof fixture>) => f.setCard(card({ kind: 'review' })),
  expired: (f: ReturnType<typeof fixture>) => f.setCard(card({ expiresAt: stamp })),
  superseded: (f: ReturnType<typeof fixture>) => f.setCard(card({ supersededBy: blobSha })),
  repository: (f: ReturnType<typeof fixture>) => f.setCard(card({ url: 'https://github.com/o/other/pull/7' })),
  head: (f: ReturnType<typeof fixture>) => {
    f.data.view.headRefOid = blobSha;
  },
  draft: (f: ReturnType<typeof fixture>) => {
    f.data.view.isDraft = true;
  },
  state: (f: ReturnType<typeof fixture>) => {
    f.data.view.state = 'CLOSED';
  },
  hold: (f: ReturnType<typeof fixture>) => {
    f.data.view.labels = [{ name: 'hold' }];
  },
  conflicts: (f: ReturnType<typeof fixture>) => {
    f.data.view.mergeable = 'CONFLICTING';
  },
  pending: (f: ReturnType<typeof fixture>) => {
    f.data.view.statusCheckRollup[0].status = 'IN_PROGRESS';
  },
  failure: (f: ReturnType<typeof fixture>) => {
    f.data.view.statusCheckRollup[0].conclusion = 'FAILURE';
  },
  absent: (f: ReturnType<typeof fixture>) => {
    f.data.view.statusCheckRollup = [];
  },
  noRequired: (f: ReturnType<typeof fixture>) => {
    f.data.rules = [];
    f.setCard(card({ ci: { passed: 0, failed: 0, pending: 0, unavailable: true } }));
  },
  selfStatus: (f: ReturnType<typeof fixture>) => {
    f.data.view.statusCheckRollup[0].name = 'pugport/judge';
  },
  window: (f: ReturnType<typeof fixture>) => {
    f.deps.gates = { version: 1, windows: { noMerge: { from: '11:00', to: '13:00', tz: 'UTC' } } };
  },
})) {
  test(`merge refuses ${name} without invoking gh pr merge`, async () => {
    const f = fixture();
    change(f);
    const result = await f.run();
    assert.equal(result.status, 'refused');
    if (name === 'head') assert.match(result.status === 'refused' ? result.reason : '', /ccccccc/);
    if (name === 'noRequired')
      assert.match(result.status === 'refused' ? result.reason : '', /no required checks configured/);
    assert.equal(
      f.calls.some((call) => call.args[1] === 'merge'),
      false,
    );
  });
}
for (const [name, patch, reason] of [
  ['base', { baseRefName: 'release' }, 'base branch changed to release; a new review runs'],
  ['dirty', { mergeStateStatus: 'DIRTY' }, 'GitHub has not finished checking mergeability; try again'],
  ['unknown', { mergeStateStatus: 'UNKNOWN' }, 'GitHub has not finished checking mergeability; try again'],
] as const) {
  test(`merge refuses ${name} with a specific reason and no merge call`, async () => {
    const f = fixture();
    Object.assign(f.data.view, patch);
    assert.deepEqual(await f.run(), { status: 'refused', reason });
    assert.ok(!f.calls.some((call) => call.args[1] === 'merge'));
  });
}
for (const patch of [{ tier: 'owner' as const }, { external: true }]) {
  test(`merge refuses owner review ${JSON.stringify(patch)} before GitHub calls`, async () => {
    const f = fixture();
    f.setCard(card(patch));
    assert.deepEqual(await f.run(), {
      status: 'refused',
      reason: "this PR needs the maintainer's own review on GitHub",
    });
    assert.equal(f.calls.length, 0);
  });
}
test('legacy card without a reviewed base cannot merge', async () => {
  const f = fixture();
  f.setCard(card({ baseRef: undefined }));
  assert.deepEqual(await f.run(), { status: 'refused', reason: 'base branch changed to main; a new review runs' });
  assert.ok(!f.calls.some((call) => call.args[1] === 'merge'));
});
test('invalid request cannot invoke gh or merge', async () => {
  for (const extra of [{ number: 0 }, { judgedSha: 'x' }, { repository: 'o/r/extra' }, { method: 'squash' }]) {
    const f = fixture();
    assert.equal((await f.run(extra)).status, 'refused');
    assert.equal(f.calls.length, 0);
  }
});
for (const fork of [false, true])
  test(`merge uses exact pinned command, confirms readback (fork=${fork})`, async () => {
    const f = fixture();
    f.data.view.isCrossRepository = fork;
    assert.deepEqual(await f.run(), { status: 'merged', mergeCommit: blobSha });
    assert.deepEqual(f.calls.find((call) => call.args[1] === 'merge')?.args, [
      'pr',
      'merge',
      '7',
      '--repo',
      'o/r',
      '--merge',
      '--match-head-commit',
      sha,
    ]);
    assert.equal(f.calls.at(-1)?.args.at(-1), 'state,mergeCommit');
    assert.equal(f.audit.at(-1)?.action, 'merge');
  });
test('post-command readback failure is reported as an attempted merge error', async () => {
  const f = fixture();
  f.data.merged.state = 'OPEN';
  assert.deepEqual(await f.run(), { status: 'refused', reason: 'merge reported but not confirmed' });
  assert.equal(f.calls.filter((call) => call.args[1] === 'merge').length, 1);
  assert.equal(f.audit.at(-1)?.action, 'error');
});
test('required checks use branch rules first, configured fallback only when unknown', async () => {
  const f = fixture();
  f.deps.requiredChecks = ['other'];
  assert.equal((await f.run()).status, 'merged');
  const g = fixture();
  g.data.ruleError = true;
  g.deps.requiredChecks = ['ci'];
  assert.equal((await g.run()).status, 'merged');
  const h = fixture();
  h.data.ruleError = true;
  assert.equal((await h.run()).status, 'refused');
  assert.ok(!h.calls.some((call) => call.args[1] === 'merge'));
  const mixed = fakeGh(() => [
    { type: 'pull_request', parameters: { required_approving_review_count: 1 } },
    ...f.data.rules,
  ]);
  assert.deepEqual(await requiredChecks(mixed.gh, 'o/r', 'main'), ['ci']);
});
test('ciState ignores own contexts, distinguishes missing/failure/pending and accepts legacy contexts', () => {
  assert.deepEqual(ciState([{ context: 'pugport/judge', state: 'SUCCESS' }], ['pugport/judge']), {
    green: false,
    missing: ['no required checks configured'],
    failed: [],
    pending: [],
  });
  assert.equal(
    ciState(
      [
        { context: 'ci', state: 'SUCCESS' },
        { context: 'pugport/judge', state: 'FAILURE' },
      ],
      ['ci'],
    ).green,
    true,
  );
  assert.deepEqual(
    ciState(
      [
        { context: 'broken', state: 'ERROR' },
        { name: 'running', status: 'QUEUED' },
      ],
      ['missing', 'broken', 'running'],
    ),
    { green: false, missing: ['missing'], failed: ['broken'], pending: ['running'] },
  );
});
