import { nativeFamily } from './model-family.ts';
import type { ModelInfo, Provider, QuotaWindow, RuntimeSnapshot } from './types.ts';

/**
 * Cursor's documented pools, verified 2026-10-04: https://cursor.com/docs/models-and-pricing.
 * Effort/speed variants retain their family's pool. Auto and new, unrecognized families remain
 * dynamic: selecting Auto must not promise that only Cursor Models will be charged.
 */
export function cursorModelPool(model: string): NonNullable<ModelInfo['quotaPool']> {
  const id = model.toLowerCase().replace(/^cursor-/, '');
  if (/^composer(?:-|$)/.test(id) || /^grok-4\.[567](?:-|$)/.test(id)) return 'cursor';
  if (
    /^(?:gpt|claude|gemini|gemma|llama|qwen|deepseek|kimi|mistral|minimax|glm|muse)(?:-|\d|$)/.test(id) ||
    /^o[134](?:-|$)/.test(id)
  )
    return 'other';
  return 'dynamic';
}

export function cursorModelPoolLabel(pool: NonNullable<ModelInfo['quotaPool']>): string {
  return pool === 'cursor' ? 'Cursor Models' : pool === 'other' ? 'Other Models' : '按实际模型扣费';
}

export type CursorPool = 'cursor' | 'other';
// The leading space keeps "改用 Cursor" apart wherever a name follows Chinese text.
const poolNames: Record<CursorPool, string> = { cursor: ' Cursor 自家模型池', other: '前沿模型池' };
/** Percentage points above the reserve line at which a pool counts as nearly used up. */
export const poolNearReserve = 10;

/**
 * Which of Cursor's two quota pools to try first when PugPort picks the Cursor model itself (a pinned model never
 * comes here). Light work starts in Cursor's own pool (Composer, Grok) so the frontier pool (Claude, GPT, Gemini…)
 * is kept for hard work, which starts there. Ordinary work takes the pool with more left. A preferred pool that is
 * used up or near its reserve gives way to the other one while that one is healthier. Auto, charged by whatever it
 * picks, always comes last. A quota fallback for an executor the task is bound to keeps its model family instead.
 */
export function chooseCursorPool(input: {
  tier: 'light' | 'standard' | 'strong';
  /** Percent left after local in-flight buffers; absent when unknown or not reported per pool. */
  headroom: Partial<Record<CursorPool, number>>;
  /** Whether the pool has a model that passed the capability and quota checks and suits the task. */
  offered: Record<CursorPool, boolean>;
  reservePercent: number;
  /** Effective reserve of each pool's binding window, after applying its own reset time. */
  reserveByPool?: Partial<Record<CursorPool, number>>;
  /** How far each pool's tightest window is behind its straight line; higher means more would go unused. */
  pace?: Partial<Record<CursorPool, number>>;
  resetInHours?: Partial<Record<CursorPool, number>>;
  /** Whether the pool's pick is at least as capable as the task needs. */
  fits?: Record<CursorPool, boolean>;
}): { order: Array<CursorPool | 'dynamic'>; reason?: string } {
  const { tier, headroom, offered, reservePercent } = input;
  const reserve = (pool: CursorPool) => input.reserveByPool?.[pool] ?? reservePercent;
  const near = (pool: CursorPool) => headroom[pool] !== undefined && headroom[pool]! < reserve(pool) + poolNearReserve;
  const spent = (pool: CursorPool) => headroom[pool] !== undefined && headroom[pool]! <= reserve(pool);
  const left = (pool: CursorPool) => `${Math.max(0, Math.round(headroom[pool]!))}%`;
  const task = tier === 'light' ? '简单任务' : tier === 'strong' ? '复杂任务' : '一般任务';
  const known = headroom.cursor !== undefined && headroom.other !== undefined;
  const { pace, fits } = input;
  // Ordinary and hard work goes to the pool that is further behind its line, when both can do the job.
  const byPace =
    tier !== 'light' &&
    !!fits?.cursor &&
    !!fits.other &&
    pace?.cursor !== undefined &&
    pace.other !== undefined &&
    pace.cursor !== pace.other;
  const preferred: CursorPool =
    tier === 'light'
      ? 'cursor'
      : byPace
        ? pace!.other! > pace!.cursor!
          ? 'other'
          : 'cursor'
        : tier === 'strong'
          ? 'other'
          : known && headroom.other! > headroom.cursor!
            ? 'other'
            : 'cursor';
  const hours = input.resetInHours?.[preferred];
  const fallback: CursorPool = preferred === 'cursor' ? 'other' : 'cursor';
  if (!offered.cursor && !offered.other) return { order: ['dynamic'] };
  if (!offered[preferred])
    return {
      order: [fallback, 'dynamic'],
      reason: `${task}本应先用${poolNames[preferred]}，但它${spent(preferred) ? '已用到保留线' : '现在没有能用的模型'}，改用${poolNames[fallback]}`,
    };
  if (near(preferred) && offered[fallback] && headroom[fallback] !== undefined && !near(fallback))
    return {
      order: [fallback, preferred, 'dynamic'],
      reason: `${task}本应先用${poolNames[preferred]}，但它只剩 ${left(preferred)}，接近保留线，改用${poolNames[fallback]}（剩 ${left(fallback)}）`,
    };
  return {
    order: [preferred, fallback, 'dynamic'],
    reason:
      // Say "by pace" only when pace chose the pool, or light work's usual pool is indeed behind its line.
      byPace || (tier === 'light' && (pace?.[preferred] ?? 0) >= 1)
        ? hours === undefined
          ? `${task}，${poolNames[preferred].trim()}剩 ${left(preferred)}，按进度优先用`
          : hours < 48
            ? `${task}，${poolNames[preferred].trim()}剩 ${left(preferred)}，约 ${Math.max(1, Math.round(hours))} 小时后重置，按进度优先用`
            : `${task}，${poolNames[preferred].trim()}剩 ${left(preferred)}，${Math.round(hours / 24)} 天后重置，按进度优先用`
        : tier === 'light'
          ? `${task}，先用 Cursor 自家模型池（Composer、Grok），把前沿模型池留给复杂任务`
          : tier === 'strong'
            ? `${task}，先用前沿模型池（Claude、GPT、Gemini 等）`
            : known && headroom.cursor !== headroom.other
              ? `${task}，先用剩余较多的${poolNames[preferred]}`
              : `${task}，先用${poolNames[preferred]}`,
  };
}

/** Shared limits still apply. A missing selected pool is unknown, never another pool's balance. */
export function quotaWindowsForModel(
  quota: RuntimeSnapshot['quota'],
  model: ModelInfo,
  provider?: Provider,
): QuotaWindow[] {
  let windows = quota.windows;
  if (provider === 'claude' && windows.some((window) => window.modelFamily)) {
    // Default/automatic/mixed aliases can cross families, so they retain every limit. An exact
    // named alias wins over a stale display label; versioned names use the shared family parser.
    const alias = /^(fable|opus|sonnet|haiku)$/i.exec(model.id)?.[1]?.toLowerCase();
    const family = /^(auto|default|best|opusplan|fableplan)$/i.test(model.id)
      ? undefined
      : (alias ?? /^claude-(fable|opus|sonnet|haiku)(?:-|$)/.exec(nativeFamily('claude', model) ?? '')?.[1]);
    if (family) windows = windows.filter((window) => !window.modelFamily || window.modelFamily === family);
  }
  if (!windows.some((window) => window.modelPool)) return windows;
  if (!model.quotaPool || model.quotaPool === 'dynamic') return windows;
  if (!windows.some((window) => window.modelPool === model.quotaPool)) return [];
  return windows.filter((window) => !window.modelPool || window.modelPool === model.quotaPool);
}
