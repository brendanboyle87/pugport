import type { Provider, RunEvent, RunRecord } from './types';

const count = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

// The Claude CLI reports each model's window in its result; until then only a `[1m]` launch suffix tells it.
// No guess otherwise: the old 200K default showed a 1M Claude 5 session at five times its real share.
const claudeOneMillion = 1_000_000;

export function contextFromEvent(provider: Provider, model: string, event: RunEvent): RunRecord['context'] {
  const data = event.data ?? {};
  let tokens: unknown, window: unknown;
  if (provider === 'codex' && event.type === 'usage') {
    const last = object(data.last);
    if (!count(last.totalTokens) || (last.reasoningOutputTokens !== undefined && !count(last.reasoningOutputTokens)))
      return;
    tokens = last.totalTokens - (last.reasoningOutputTokens ?? 0);
    window = data.modelContextWindow;
  } else if (provider === 'claude' && event.type === 'status' && data.messageUsage) {
    const usage = object(data.messageUsage);
    const values = [usage.input_tokens, usage.cache_read_input_tokens ?? 0, usage.cache_creation_input_tokens ?? 0];
    if (!values.every(count)) return;
    tokens = values.reduce((sum, value) => sum + value, 0);
    window = count(data.contextWindow) ? data.contextWindow : model.endsWith('[1m]') ? claudeOneMillion : undefined;
  } else if (provider === 'pi' && event.type === 'usage' && data.scope === 'assistant-message') {
    // Pi reports usage for every assistant message; its prompt side is uncached input plus both cache buckets.
    // A failed or aborted request, or one with an empty prompt side, reports no occupancy: not reported, never 0.
    if (data.stopReason === 'error' || data.stopReason === 'aborted') return;
    const values = [data.input, data.cacheRead, data.cacheWrite];
    if (!values.every(count)) return;
    tokens = values.reduce((sum, value) => sum + value, 0);
    if (!tokens) return;
    window = data.contextWindow;
  } else if (provider === 'cursor' && event.type === 'status') {
    tokens = data.contextTokens;
    window = data.contextWindow;
  }
  if (!count(tokens)) return;
  return { tokens, ...(count(window) && window > 0 ? { window } : {}), at: event.at };
}
