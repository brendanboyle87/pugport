import { z } from 'zod';
import type { PrJudgeOutcome } from './pr-judge.ts';
import type { PrMaterial } from './pr-material.ts';
import type { TierResult } from './tiers.ts';
import type { Outbox, OutboxItem } from './outbox.ts';
import type { Gh } from './gh.ts';
import type { AuditLine } from './audit.ts';
import { checkOutbound, clampSection } from './outbound.ts';
import { repositorySchema } from './config.ts';

export const commentMarker = (runId: string, sha: string) => `<!-- pugport-maintainer run=${runId} sha=${sha} -->`;
const nextText = {
  'merge-card': "Recommended to merge — waiting for the maintainer's confirmation.",
  'changes-requested': 'Changes requested — push a new commit and the review runs again.',
  waiting: 'Waiting for the maintainer.',
  'owner-review': 'This PR touches maintainer-only files; the maintainer reviews it personally.',
  'external-review':
    'External contribution — the maintainer reviews it personally. CI runs on GitHub-hosted runners only.',
};
export function inertSection(text: string): string {
  return '````text\n' + clampSection(text.replaceAll('`', "'"), 1500) + '\n````';
}
export function renderReviewComment(input: {
  outcome: PrJudgeOutcome;
  tier: TierResult;
  trusted: boolean;
  ci: PrMaterial['checks'];
  suite: OutboxItem['suite'];
  next: keyof typeof nextText;
  mode: 'shadow' | 'live';
  withholdDetails?: boolean;
}): string {
  const { outcome: o, ci } = input;
  const sha = o.sha ?? 'unknown';
  const withheld = 'Details withheld by the outbound check; the maintainer will review.';
  return `## PugPort maintainer review

**Verdict:** ${o.verdict.toUpperCase()} @ \`${sha.slice(0, 7)}\` · \`${input.tier.label}\` · ${input.trusted ? 'collaborator' : 'external'}
**Risks:**
${input.withholdDetails ? withheld : inertSection(o.sections.risks)}
**Tests:** CI: ${ci.passed} passed, ${ci.failed} failed, ${ci.pending} pending · Remote full suite: ${input.suite?.state ?? 'not-run'}
${input.withholdDetails ? '' : inertSection(o.sections.tests)}
**Missing:**
${input.withholdDetails ? withheld : inertSection(o.sections.missing)}${!input.withholdDetails && o.omitted.length ? `\n**Omitted material:**\n${inertSection(o.omitted.join('\n'))}` : ''}
**Next:** ${nextText[!input.trusted ? 'external-review' : input.tier.tier === 'owner' ? 'owner-review' : input.next]}

<sub>Reviewed without tools, from the diff and base files only (judge ${o.judgeId}).${input.mode === 'shadow' ? " Shadow mode: this comment is a rehearsal on the owner's own PR." : ''}</sub>
${commentMarker(o.judgeId, sha)}`;
}
export function statusFor(
  verdict: PrJudgeOutcome['verdict'],
  tier: TierResult,
  trusted: boolean,
): { state: 'success' | 'failure' | 'error' | 'pending'; description: string } {
  if (verdict === 'pass' && (!trusted || tier.external || tier.tier === 'owner'))
    return { state: 'pending', description: 'Needs the maintainer' };
  return verdict === 'pass'
    ? { state: 'success', description: 'PASS — see the review comment' }
    : verdict === 'fail'
      ? { state: 'failure', description: 'FAIL — see the review comment' }
      : { state: 'error', description: 'Needs the maintainer' };
}
export function findOwnComment(
  comments: { id: number; body: string; user: string }[],
  sha: string,
  botLogin: string,
): { id: number } | undefined {
  if (!/^[0-9a-f]{40}$/.test(sha) || !/^[A-Za-z0-9-]+\[bot\]$/.test(botLogin)) return undefined;
  const marker = new RegExp(`<!-- pugport-maintainer run=pj-\\d{8}-[0-9a-f]{8} sha=${sha} -->`);
  const found = comments.find((comment) => comment.user === botLogin && marker.test(comment.body));
  return found ? { id: found.id } : undefined;
}

export type ReviewDone = {
  label?: boolean;
  comment?: boolean;
  status?: boolean;
  review?: boolean;
  needsRuling?: boolean;
};

export async function publishReview(
  input: {
    material: PrMaterial;
    outcome: PrJudgeOutcome;
    tier: TierResult;
    trusted: boolean;
    suite?: OutboxItem['suite'];
    next: keyof typeof nextText;
    mode: 'shadow' | 'live';
    authorIsOwner: boolean;
    done?: ReviewDone;
  },
  deps: {
    readGh: Gh;
    write: (
      kind: 'comment' | 'judge-status' | 'review',
      author: string,
      args: string[],
      body: object,
    ) => Promise<boolean>;
    botLogin: string;
    audit: (line: AuditLine) => void | Promise<void>;
    outbox: Outbox;
    now?: () => number;
    may: (kind: 'comment' | 'judge-status' | 'review') => boolean | Promise<boolean>;
    save?: () => void;
  },
) {
  const { material: m } = input;
  repositorySchema.parse(m.repository);
  z.number().int().positive().parse(m.number);
  z.string()
    .regex(/^[0-9a-f]{40}$/)
    .parse(m.headSha);
  z.string()
    .regex(/^pj-\d{8}-[0-9a-f]{8}$/)
    .parse(input.outcome.judgeId);
  z.string()
    .regex(/^[A-Za-z0-9-]+\[bot\]$/)
    .parse(deps.botLogin);
  if (input.outcome.sha && input.outcome.sha !== m.headSha) throw new Error('Review belongs to another head');
  const at = () => new Date((deps.now ?? Date.now)()).toISOString();
  const audit = (
    action: AuditLine['action'],
    result: AuditLine['result'],
    detail?: string,
    credential: AuditLine['credential'] = 'app',
  ) =>
    deps.audit({
      at: at(),
      mode: input.mode,
      event: 'pr',
      number: m.number,
      sha: m.headSha,
      action,
      result,
      credential,
      judgeId: input.outcome.judgeId,
      detail,
    });
  const render = (withholdDetails = false) =>
    renderReviewComment({
      ...input,
      suite: input.suite,
      outcome: { ...input.outcome, sha: m.headSha },
      ci: m.checks,
      withholdDetails,
    });
  let body = render();
  const scan = checkOutbound([{ field: 'comment', value: body }]);
  if (!scan.ok || /[\u3400-\u9fff]/u.test(body)) {
    const reason = scan.ok ? 'English-only outbound text required' : scan.hits.map((hit) => hit.rule).join(', ');
    await audit('refused', 'skipped', reason, 'none');
    deps.outbox.raise({
      kind: 'ruling',
      mode: input.mode,
      number: m.number,
      title: m.title.slice(0, 200),
      url: m.url,
      author: m.author,
      external: !input.trusted,
      judgedSha: m.headSha,
      baseRef: m.baseRef,
      reasons: [reason.slice(0, 200)],
    });
    body = render(true);
  }
  const done = input.done ?? {};
  const attempt = async (
    key: 'comment' | 'status' | 'review',
    action: 'comment' | 'comment-edit' | 'status' | 'review',
    endpoint: string,
    payload: object,
    text: string,
  ) => {
    if (done[key]) return;
    const kind = action === 'status' ? 'judge-status' : action === 'review' ? 'review' : 'comment';
    if (!(await deps.may(kind))) return;
    if (!checkOutbound([{ field: action, value: text }]).ok)
      throw new Error('Outbound check refused fixed review text');
    done[key] = await deps.write(
      kind,
      m.author,
      ['api', '-X', action === 'comment-edit' ? 'PATCH' : 'POST', endpoint, '--input', '-'],
      payload,
    );
    deps.save?.();
  };
  if (!done.comment) {
    const comments = await deps.readGh.json(
      z.array(
        z.array(z.object({ id: z.number().int().positive(), body: z.string(), user: z.object({ login: z.string() }) })),
      ),
      ['api', `repos/${m.repository}/issues/${m.number}/comments`, '--paginate', '--slurp'],
    );
    const own = findOwnComment(
      comments.flat().map((comment) => ({ ...comment, user: comment.user.login })),
      m.headSha,
      deps.botLogin,
    );
    await attempt(
      'comment',
      own ? 'comment-edit' : 'comment',
      own ? `repos/${m.repository}/issues/comments/${own.id}` : `repos/${m.repository}/issues/${m.number}/comments`,
      { body },
      body,
    );
  }
  const status = statusFor(input.outcome.verdict, input.tier, input.trusted);
  await attempt(
    'status',
    'status',
    `repos/${m.repository}/statuses/${m.headSha}`,
    { ...status, context: 'pugport/judge', target_url: m.url },
    status.description,
  );
  if (!done.review && !input.authorIsOwner && input.outcome.verdict === 'fail') {
    const reviews = await deps.readGh.json(
      z.array(z.array(z.object({ commit_id: z.string(), user: z.object({ login: z.string() }) }))),
      ['api', `repos/${m.repository}/pulls/${m.number}/reviews`, '--paginate', '--slurp'],
    );
    if (reviews.flat().some((review) => review.user.login === deps.botLogin && review.commit_id === m.headSha)) {
      done.review = true;
      deps.save?.();
    } else {
      const reviewBody = 'See the PugPort maintainer review above.';
      await attempt(
        'review',
        'review',
        `repos/${m.repository}/pulls/${m.number}/reviews`,
        { event: 'REQUEST_CHANGES', body: reviewBody, commit_id: m.headSha },
        reviewBody,
      );
    }
  } else if (input.authorIsOwner || input.outcome.verdict !== 'fail') done.review = true;
  return { status: done.comment && done.status && done.review ? ('written' as const) : ('skipped' as const) };
}
