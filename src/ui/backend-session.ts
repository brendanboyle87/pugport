/** Every api helper's default: a call without a body is a read. Writes always carry a body. */
export const defaultRequestMethod = (body: unknown) => (body === undefined ? 'GET' : 'POST');

/** Stale session responses must not restore a token from the backend that just exited. */
export class BackendSession {
  token = '';
  generation = 0;
  private pending?: { generation: number; promise: Promise<void> };
  clear() {
    this.token = '';
    this.pending = undefined;
    return ++this.generation;
  }
  accept(generation: number, token: unknown) {
    if (generation !== this.generation || typeof token !== 'string' || !token) return false;
    this.token = token;
    return true;
  }
  async ensure(fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.token) return;
    if (!this.pending) {
      const generation = this.generation;
      // The shared refresh outlives any single caller's cancellation.
      const promise = (async () => {
        const response = await fetcher('/api/session');
        if (!response.ok) throw new Error('无法建立本地会话，请确认服务正在运行。');
        const payload = (await response.json()) as { token: unknown };
        if (!this.accept(generation, payload.token)) throw new Error('本地会话正在恢复，请稍后重试。');
      })();
      this.pending = { generation, promise };
      void promise
        .finally(() => {
          if (this.pending?.promise === promise) this.pending = undefined;
        })
        .catch(() => {});
    }
    const promise = this.pending.promise;
    if (!signal) return promise;
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
      if (signal.aborted) abort();
    });
  }
  async request(path: string, init: RequestInit, fetcher: typeof fetch = fetch): Promise<Response> {
    const signal = init.signal ?? undefined;
    for (let attempt = 0; ; attempt++) {
      await this.ensure(fetcher, signal);
      signal?.throwIfAborted();
      const token = this.token;
      const generation = this.generation;
      const headers = new Headers(init.headers);
      headers.set('x-agent-token', token);
      const response = await fetcher(path, { ...init, headers });
      let expired = response.status === 401 || response.status === 403;
      if (!response.ok && !expired) {
        const payload = await response
          .clone()
          .json()
          .catch(() => ({}));
        expired =
          ['SESSION_EXPIRED', 'INVALID_SESSION', 'SESSION_INVALID', 'SESSION_REQUIRED'].includes(payload.code) ||
          (typeof payload.error === 'string' && payload.error.startsWith('Local session token required:'));
      }
      if (attempt || !expired) return response;
      signal?.throwIfAborted();
      // A late rejection of an old request must not discard a concurrent recovery.
      if (generation === this.generation && token === this.token) this.clear();
    }
  }
}
