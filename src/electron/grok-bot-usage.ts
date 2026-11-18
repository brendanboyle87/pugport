import { grokBotUsageEndpoint, parseGrokBotUsage } from '../server/cursor-usage.ts';
import type { WebAgentResult } from '../shared/web-bridge.ts';
import { grokDiagnostic } from '../shared/grok-usage.ts';
const plan = (v: unknown) =>
  typeof v === 'string' &&
  /^(?:SuperGrok(?: Heavy)?|Grok Bot Plan|(?:Cursor )?(?:Free|Pro|Pro\+|Ultra|Business|Enterprise|Team))$/i.test(
    v.trim(),
  )
    ? v.trim()
    : undefined;
const date = (v: unknown) =>
  (typeof v === 'number' && Number.isFinite(v)) ||
  (typeof v === 'string' && /^(?:\d{1,14}|\d{4}-\d{2}-\d{2}T[\d:.Z+-]+)$/.test(v))
    ? v
    : undefined;
/** Runs in the dashboard session. Request options and retained quota fields match the working RPC. */
export const grokBotUsageScript = String.raw`(async () => {
  if (location.origin !== 'https://cursor.com' || location.pathname !== '/dashboard/spending') return { outcome: 'login' };
  let status;
  let step = 'request';
  try {
    const response = await fetch(${JSON.stringify(grokBotUsageEndpoint)}, {
      method: 'POST', credentials: 'include', redirect: 'error', cache: 'no-store',
      headers: { 'content-type': 'application/json', 'connect-protocol-version': '1' },
      body: '{}', signal: AbortSignal.timeout(8000)
    });
    status = response.status;
    if (!response.ok) return { outcome: 'refused', status };
    const text = await response.text(); if (text.length > 131072) return { outcome: 'no-data', status };
    step = 'parse';
    const json = JSON.parse(text);
    const plan = value => typeof value === 'string' && /^(?:SuperGrok(?: Heavy)?|Grok Bot Plan|(?:Cursor )?(?:Free|Pro|Pro\+|Ultra|Business|Enterprise|Team))$/i.test(value.trim()) ? value.trim() : undefined;
    const date = value => typeof value === 'number' && Number.isFinite(value) || typeof value === 'string' && /^(?:\d{1,14}|\d{4}-\d{2}-\d{2}T[\d:.Z+-]+)$/.test(value) ? value : undefined;
    return { outcome: 'success', status, payload: {
      usagePercent: typeof json.usagePercent === 'number' ? json.usagePercent : undefined,
      nextResetTimestampUtc: date(json.nextResetTimestampUtc), currentPeriodStart: date(json.currentPeriodStart),
      grokPlanLabel: plan(json.grokPlanLabel), cursorPlanName: plan(json.cursorPlanName),
      billingBrand: typeof json.billingBrand === 'string' && /^SAND_BILLING_BRAND_[A-Z_]{1,40}$/.test(json.billingBrand) ? json.billingBrand : undefined
    } };
  } catch { return { outcome: step === 'request' ? 'unreachable' : 'no-data', status }; }
})()`;

export async function readGrokBotPageUsage(
  page: <T>(code: string) => Promise<T>,
  pageUrl: string,
): Promise<WebAgentResult> {
  try {
    const result = await page<{ outcome?: string; status?: number; payload?: unknown }>(grokBotUsageScript);
    if (result?.outcome === 'success') {
      // Unlike an observed candidate, this response is already from the fixed RPC and may omit its plan.
      const raw =
        result.payload && typeof result.payload === 'object' ? (result.payload as Record<string, unknown>) : {};
      const parsed = grokObservedUsage({ ...raw, grokPlanLabel: raw.grokPlanLabel }, pageUrl, result.status);
      return parsed ?? { ok: false, grokDiagnostic: grokDiagnostic('no-data', 'parse', pageUrl, result.status) };
    }
    const code =
      result?.outcome === 'login' || result?.outcome === 'refused' || result?.outcome === 'unreachable'
        ? result.outcome
        : 'no-data';
    return {
      ok: false,
      grokDiagnostic: grokDiagnostic(
        code,
        code === 'login' ? 'login' : code === 'no-data' ? 'parse' : 'request',
        pageUrl,
        result?.status,
      ),
    };
  } catch {
    return { ok: false, grokDiagnostic: grokDiagnostic('error', 'request', pageUrl) };
  }
}
/** Project only documented Sand response fields; never keep bodies or arbitrary plan text. */
export function grokObservedUsage(value: unknown, pageUrl: string, status?: number): WebAgentResult | undefined {
  if (!value || typeof value !== 'object') return;
  const raw = value as Record<string, unknown>;
  if (!Object.hasOwn(raw, 'usagePercent') || !('grokPlanLabel' in raw || 'billingBrand' in raw)) return;
  const payload = {
    usagePercent: raw.usagePercent,
    grokPlanLabel: plan(raw.grokPlanLabel),
    cursorPlanName: plan(raw.cursorPlanName),
    nextResetTimestampUtc: date(raw.nextResetTimestampUtc),
    currentPeriodStart: date(raw.currentPeriodStart),
    billingBrand:
      typeof raw.billingBrand === 'string' && /^SAND_BILLING_BRAND_[A-Z_]{1,40}$/.test(raw.billingBrand)
        ? raw.billingBrand
        : undefined,
  };
  // Only explicit entitlement evidence justifies no-plan; 403 or empty data does not.
  if (
    raw.hasNonZeroIncludedLimit === false &&
    raw.hasAvailableUsage === false &&
    !payload.grokPlanLabel &&
    !payload.cursorPlanName
  )
    return { ok: false, grokDiagnostic: grokDiagnostic('no-plan', 'parse', pageUrl, status) };
  const quota = parseGrokBotUsage(payload, new Date().toISOString(), '独立登录 · Grok Bot 用量');
  return {
    ok: quota.status === 'known',
    quota,
    grokDiagnostic: grokDiagnostic(quota.status === 'known' ? 'success' : 'no-data', 'parse', pageUrl, status),
  };
}
/** Observe same-origin usage candidates only. POST responses need the documented Sand shape and are never replayed. */
export function grokObservedRequest(method: string, url: string, pageUrl: string): boolean {
  try {
    const request = new URL(url),
      page = new URL(pageUrl);
    return (
      page.origin === 'https://cursor.com' &&
      request.origin === page.origin &&
      !request.username &&
      !request.password &&
      !request.search &&
      ((['GET', 'POST'].includes(method) &&
        /usage|spending|sand/i.test(request.pathname) &&
        !/delete|remove|purchase|subscribe|auth/i.test(request.pathname)) ||
        (method === 'POST' && request.pathname.endsWith('/aiserver.v1.DashboardService/GetSandUsageStatus')))
    );
  } catch {
    return false;
  }
}
