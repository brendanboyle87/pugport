type Json = Record<string, unknown>;
export const ROOTS_TIMEOUT_MS = 1500;

/** Client roots describe scope, never permission to write. Late answers remain useful after a tool timeout. */
export function createClientRoots(send: (message: Json) => unknown) {
  let supported = false;
  let sequence = 0;
  let applied = 0;
  let roots: unknown[] = [];
  let inFlight: Promise<void> | undefined;
  const pending = new Map<string, (message: Json) => void>();

  function refresh(changed = false): Promise<void> {
    if (!supported) return Promise.resolve();
    if (inFlight && !changed) return inFlight;
    if (changed) {
      // The old list may name a folder that was just removed: drop it now, and ignore answers to earlier requests,
      // so neither a timeout nor a late answer can bring a revoked folder back.
      roots = [];
      applied = sequence;
    }
    const seq = ++sequence;
    const id = `pugport-roots-${seq}`;
    const request = new Promise<void>((resolve) => {
      pending.set(id, (message) => {
        const result = message.result as Json | undefined;
        if (!('error' in message) && Array.isArray(result?.roots) && seq > applied) {
          roots = result.roots.slice(0, 200);
          applied = seq;
        }
        resolve();
      });
    });
    inFlight = request;
    void request.then(() => {
      if (inFlight === request) inFlight = undefined;
    });
    send({ id, method: 'roots/list' });
    return request;
  }

  return {
    initialize(capabilities: unknown) {
      supported = !!capabilities && typeof capabilities === 'object' && 'roots' in capabilities;
    },
    refresh,
    response(message: Json) {
      if (typeof message.id !== 'string') return;
      const resolve = pending.get(message.id);
      pending.delete(message.id);
      resolve?.(message);
    },
    async get(): Promise<unknown[]> {
      const request = refresh();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          request,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, ROOTS_TIMEOUT_MS);
          }),
        ]);
      } finally {
        clearTimeout(timer);
        // Release an unanswered request for the next call, but keep its id for a late answer. No cancellation.
        if (inFlight === request) inFlight = undefined;
      }
      return roots;
    },
  };
}
