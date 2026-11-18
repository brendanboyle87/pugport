/** Optional enrichment shares one deadline; required task context and execution checks stay outside it. */
export const optionalContextBudgetMs = 5000;

export async function withinContextBudget<T>(
  work: (signal: AbortSignal) => Promise<T>,
  fallback: T,
  options: { signal: AbortSignal; deadline: number; stageMs?: number },
): Promise<T> {
  options.signal.throwIfAborted();
  const started = performance.now();
  const remaining = Math.min(options.stageMs ?? Infinity, options.deadline - started);
  if (remaining <= 0) return fallback;
  const timeout = new AbortController();
  const signal = AbortSignal.any([options.signal, timeout.signal]);
  const timer = setTimeout(() => timeout.abort(), remaining);
  let stop!: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    stop = () => reject(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
  });
  try {
    const result = await Promise.race([work(signal), interrupted]);
    options.signal.throwIfAborted();
    return timeout.signal.aborted || performance.now() >= started + remaining ? fallback : result;
  } catch (error) {
    options.signal.throwIfAborted();
    if (timeout.signal.aborted) return fallback;
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', stop);
    timeout.abort();
  }
}
