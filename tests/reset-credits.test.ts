import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { codexResetCredits } from '../src/server/reset-credits.ts';
import { parseCodexQuota } from '../src/server/adapters/codex.ts';
import { resetCardSuggestion, ResetCreditsSummary } from '../src/ui/ResetCreditsSummary.tsx';
import type { RuntimeSnapshot } from '../src/shared/types.ts';
const at = '2026-09-28T00:00:00.000Z';
const row = {
  id: 'private-redemption-id',
  resetType: 'codexRateLimits',
  status: 'available',
  grantedAt: 1788489877,
  expiresAt: 1791081877,
};
test('reset count is authoritative when detail list is capped; identifiers are discarded', () => {
  const result = codexResetCredits({ rateLimitResetCredits: { availableCount: 3, credits: [row] } }, at)!;
  assert.equal(result.availableCount, 3);
  assert.equal(result.details?.length, 1);
  assert.equal(result.details?.[0]?.expiresAt, new Date(row.expiresAt * 1000).toISOString());
  assert.doesNotMatch(JSON.stringify(result), /private-redemption-id/);
  assert.equal(
    parseCodexQuota({ rateLimitResetCredits: { availableCount: 3, credits: [row] } }).resetCredits?.availableCount,
    3,
  );
});
test('unknown, count-only and confirmed zero remain distinct, without inventing expiration', () => {
  assert.equal(codexResetCredits({}), undefined);
  assert.equal(codexResetCredits({ rateLimitResetCredits: null }), undefined);
  const countOnly = codexResetCredits({ rateLimitResetCredits: { availableCount: 2, credits: null } }, at)!;
  assert.equal(countOnly.details, null);
  assert.equal(countOnly.availableCount, 2);
  assert.equal(codexResetCredits({ rateLimitResetCredits: { availableCount: 0, credits: [] } })?.availableCount, 0);
  for (const value of [-1, NaN, Infinity, '2', 1.5])
    assert.equal(
      codexResetCredits({ rateLimitResetCredits: { availableCount: value, credits: [{ ...row, expiresAt: NaN }] } })
        ?.availableCount,
      null,
    );
  const detail = codexResetCredits(
    { rateLimitResetCredits: { credits: [{ resetType: 'future', status: 'future', expiresAt: null }] } },
    at,
  )?.details?.[0];
  assert.equal(detail?.kind, 'unknown');
  assert.equal(detail?.status, 'unknown');
  assert.equal(detail?.expiresAt, null);
});
test('UI distinguishes reset entitlement expiry from periodic resets and does not expose redemption controls', () => {
  const credits = codexResetCredits({ rateLimitResetCredits: { availableCount: 3, credits: [row] } }, at);
  const html = renderToStaticMarkup(createElement(ResetCreditsSummary, { credits, now: Date.parse(at) }));
  assert.match(html, /3 次可用/);
  assert.match(html, /完整额度重置/);
  assert.match(html, /发放/);
  assert.match(html, /不自动使用/);
  const enabled = renderToStaticMarkup(
    createElement(ResetCreditsSummary, { credits, now: Date.parse(at), autoUseResetCards: true }),
  );
  assert.match(enabled, /已开启按条件自动使用/);
  assert.doesNotMatch(enabled, /不自动使用/);
  assert.doesNotMatch(html, /<button|private-redemption-id/);
  const missing = renderToStaticMarkup(createElement(ResetCreditsSummary, {}));
  assert.match(missing, /CLI 未报告/);
  assert.doesNotMatch(missing, /0 次/);
  // A card that expired since the report disappears at once and no longer counts.
  const expired = renderToStaticMarkup(createElement(ResetCreditsSummary, { credits, now: row.expiresAt * 1000 + 1 }));
  assert.doesNotMatch(expired, /完整额度重置/);
  assert.match(expired, /2 次可用/);
  const only = codexResetCredits({ rateLimitResetCredits: { availableCount: 1, credits: [row] } }, at);
  const none = renderToStaticMarkup(
    createElement(ResetCreditsSummary, { credits: only, now: row.expiresAt * 1000 + 1 }),
  );
  assert.match(none, /0 次可用/);
  assert.match(none, /没有可用的重置卡/);
  const used = codexResetCredits(
    { rateLimitResetCredits: { availableCount: 0, credits: [{ ...row, status: 'consumed' }] } },
    at,
  );
  assert.doesNotMatch(
    renderToStaticMarkup(createElement(ResetCreditsSummary, { credits: used, now: Date.parse(at) })),
    /完整额度重置/,
  );
});
test('low-quota suggestion appears only when the tightest window is under 15% and a card is available', () => {
  const now = Date.parse(at);
  const day = 86_400_000;
  const card = (expiresAt: string | null, status = 'available') =>
    ({ kind: 'full', status, grantedAt: at, expiresAt }) as NonNullable<
      NonNullable<RuntimeSnapshot['quota']['resetCredits']>['details']
    >[number];
  const account = (used: number[], details: ReturnType<typeof card>[] | null, availableCount: number | null) =>
    ({
      provider: 'codex',
      quota: {
        status: 'known',
        observedAt: at,
        windows: used.map((usedPercent, index) => ({ id: `w${index}`, usedPercent, resetsAt: null })),
        resetCredits: { availableCount, details, observedAt: at, source: 'synthetic' },
      },
    }) as unknown as RuntimeSnapshot;
  const two = [card(new Date(now + 5 * day).toISOString()), card(new Date(now + 2.5 * day).toISOString())];
  assert.equal(
    resetCardSuggestion(account([40, 90], two, 2), now),
    '额度快用完了，有 2 张重置卡（最早 3 天后到期），可以在详情里用一张',
  );
  assert.equal(
    resetCardSuggestion(account([95], [card(new Date(now + 20 * 3_600_000).toISOString())], 1), now),
    '额度快用完了，有 1 张重置卡（20 小时后到期），可以在详情里用一张',
  );
  // Not low (exactly 15% left on the tightest window), or no usable card: no line.
  assert.equal(resetCardSuggestion(account([85], two, 2), now), undefined);
  assert.equal(resetCardSuggestion(account([99], [], 0), now), undefined);
  assert.equal(resetCardSuggestion(account([99], [card(new Date(now - 1).toISOString())], 1), now), undefined);
  assert.equal(resetCardSuggestion(account([99], [card(null, 'consumed')], 0), now), undefined);
  assert.equal(
    resetCardSuggestion({ ...account([99], two, 2), provider: 'claude' } as RuntimeSnapshot, now),
    undefined,
  );
  // A count-only report gets no invented expiry.
  assert.equal(resetCardSuggestion(account([99], null, 2), now), '额度快用完了，有 2 张重置卡，可以在详情里用一张');
  assert.equal(
    resetCardSuggestion(account([99], [card(null)], null), now),
    '额度快用完了，有 1 张重置卡，可以在详情里用一张',
  );
});
