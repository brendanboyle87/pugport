import { track } from './memory-telemetry.ts';

/** Serial leases prevent unload during inference, duplicate loads, and overlapping device copies. */
export class IdleModel<T> {
  private tail: Promise<unknown> = Promise.resolve();
  private value?: { key: string; model: T };
  private timer?: NodeJS.Timeout;
  private pending = 0;
  constructor(
    private dispose: (model: T) => Promise<void>,
    private idleMs = 5 * 60_000,
  ) {}
  use<R>(key: string, load: () => Promise<T>, run: (model: T) => Promise<R>): Promise<R> {
    clearTimeout(this.timer);
    this.pending++;
    const result = this.tail
      .then(async () => {
        if (this.value?.key !== key) {
          await this.unload();
          const end = track('embedding-model-load');
          try {
            this.value = { key, model: await load() };
          } finally {
            end();
          }
        }
        return run(this.value!.model);
      })
      .finally(() => {
        if (--this.pending === 0)
          this.timer = setTimeout(() => {
            void this.close().catch(() => undefined);
          }, this.idleMs).unref();
      });
    this.tail = result.catch(() => undefined);
    return result;
  }
  private async unload() {
    const value = this.value;
    if (!value) return;
    this.value = undefined;
    const end = track('embedding-model-unload');
    try {
      await this.dispose(value.model);
    } finally {
      end();
    }
  }
  close(): Promise<void> {
    clearTimeout(this.timer);
    const result = this.tail.then(() => this.unload());
    this.tail = result.catch(() => undefined);
    return result;
  }
}
