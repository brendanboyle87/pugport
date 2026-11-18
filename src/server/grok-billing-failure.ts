import type { RunRecord } from '../shared/types.ts';

export const grokBuildBillingMessage =
  'Grok Build 使用余额已耗尽（HTTP 402）；当前账号暂时等待，订阅剩余额度不能证明此余额已恢复。';
const message = /^(?:API error \(status 402 Payment Required\):\s*)?Grok Build usage balance exhausted[.!]?$/i;
const neutral =
  /^(?:Internal error|Request failed|error|api|api_error|payment_required|Payment Required|runtime-request-failed)$/i;
const totals = new Set([
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'cachedReadTokens',
  'cacheCreationTokens',
  'reasoningTokens',
  'modelCalls',
  'apiDurationMs',
  'numTurns',
]);
function usage(value: unknown, models = true): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value).every(([key, item]) =>
    totals.has(key)
      ? Number.isSafeInteger(item) && (item as number) >= 0
      : key === 'costUsdTicks'
        ? item === null || Number.isSafeInteger(item)
        : ['costIsPartial', 'usageIsIncomplete'].includes(key)
          ? typeof item === 'boolean'
          : key === 'modelUsage' && models
            ? !!item &&
              typeof item === 'object' &&
              !Array.isArray(item) &&
              Object.values(item).every((model) => usage(model, false))
            : false,
  );
}

/** The official ACP error envelope uses data.message/http_status and optionally promptUsage. */
export function grokBuildBalanceFailure(value: unknown): boolean {
  let exhausted = false,
    payment = false,
    nodes = 0;
  function inspect(item: unknown, field = '', depth = 0): boolean {
    if (++nodes > 64 || depth > 6) return false;
    if (item === undefined || item === null) return true;
    if (field === 'promptUsage') return usage(item);
    if (typeof item === 'string') {
      const plain = item.trim();
      if (!plain) return true;
      if (message.test(plain)) {
        exhausted = true;
        if (/status 402 Payment Required/i.test(plain)) payment = true;
        return true;
      }
      return neutral.test(plain);
    }
    if (typeof item === 'number') {
      if (['http_status', 'status', 'status_code', 'statusCode'].includes(field)) {
        if (item !== 402) return false;
        payment = true;
        return true;
      }
      // Grok sampling reports billing failures as JSON-RPC InternalError. Other
      // RPC codes can describe authentication or invalid parameters and must
      // not be reclassified merely because another nested field says 402.
      return field === 'code' && (item === 402 || item === -32603);
    }
    if (typeof item !== 'object' || Array.isArray(item)) return false;
    const allowed = new Set([
      'message',
      'data',
      'error',
      'reason',
      'detail',
      'details',
      'cause',
      'type',
      'kind',
      'code',
      'http_status',
      'status',
      'status_code',
      'statusCode',
      'promptUsage',
    ]);
    return Object.entries(item).every(([key, child]) => allowed.has(key) && inspect(child, key, depth + 1));
  }
  return inspect(value) && exhausted && payment;
}

export function observedGrokBuildBalanceFailure(run: Pick<RunRecord, 'events'>): boolean {
  return run.events.some(
    (event) =>
      event.data?.source === 'native' &&
      event.data?.kind === 'billing-exhausted' &&
      event.data?.billingSource === 'grok-build' &&
      (event.data?.detail as { statusCode?: unknown } | undefined)?.statusCode === 402,
  );
}
