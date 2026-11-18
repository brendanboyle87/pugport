/** Optional classifiers share one deadline; even a transport ignoring abort cannot hold dispatch. */
export async function optionalInference<T>(signal: AbortSignal, infer: () => Promise<T>): Promise<T | undefined> {
  if (signal.aborted) return undefined;
  let stop!: () => void;
  const cancelled = new Promise<undefined>((resolve) => {
    stop = () => resolve(undefined);
    signal.addEventListener('abort', stop, { once: true });
  });
  try {
    return await Promise.race([
      Promise.resolve()
        .then(infer)
        .catch(() => undefined),
      cancelled,
    ]);
  } finally {
    signal.removeEventListener('abort', stop);
  }
}
