/** Cooperative maintenance: the iterator must yield after each bounded unit of work. */
export class StartupMaintenance {
  private timer?: NodeJS.Timeout;
  private stopped = false;
  readonly done: Promise<void>;
  private finish!: () => void;
  get pending() {
    return !this.stopped;
  }

  constructor(
    private readonly work: Iterator<void>,
    private readonly budgetMs = 8,
  ) {
    this.done = new Promise((resolve) => {
      this.finish = resolve;
    });
    this.schedule();
  }

  private schedule() {
    this.timer = setTimeout(() => this.run(), 0);
    this.timer.unref();
  }

  private run() {
    if (this.stopped) return;
    const started = performance.now();
    try {
      do {
        if (this.work.next().done) {
          this.stop();
          return;
        }
      } while (!this.stopped && performance.now() - started < this.budgetMs);
      if (!this.stopped) this.schedule();
    } catch (error) {
      console.warn('Startup maintenance failed; unfinished work will retry next start:', error);
      this.stop();
    }
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.work.return?.();
    this.finish();
  }
}
