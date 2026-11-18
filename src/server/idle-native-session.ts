import type { IdleNativeSession } from '../shared/types.ts';

/** One short-lived optimization per controller; a miss always uses ordinary native resume. */
export class IdleNativeSessionSlot {
  private session?: IdleNativeSession;
  private ready = false;
  private timer?: ReturnType<typeof setTimeout>;
  private closing = false;
  private stops = new Set<Promise<void>>();

  isPending(nativeSessionId: string): boolean {
    return !this.closing && !this.ready && this.session?.nativeSessionId === nativeSessionId && this.session.isAlive();
  }

  private stop(session: IdleNativeSession): Promise<void> {
    const stopped = session.close().finally(() => this.stops.delete(stopped));
    this.stops.add(stopped);
    return stopped;
  }

  async discard(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    const session = this.session;
    this.session = undefined;
    this.ready = false;
    if (session) await this.stop(session);
    await Promise.all(this.stops);
  }

  async take(key: string, nativeSessionId?: string): Promise<IdleNativeSession | undefined> {
    clearTimeout(this.timer);
    this.timer = undefined;
    const session = this.session;
    const ready = this.ready;
    this.session = undefined;
    this.ready = false;
    if (
      session &&
      ready &&
      !this.closing &&
      this.stops.size === 0 &&
      session.key === key &&
      session.nativeSessionId === nativeSessionId &&
      session.isAlive()
    )
      return session;
    if (session) await this.stop(session);
    await Promise.all(this.stops);
  }

  async hold(session: IdleNativeSession): Promise<void> {
    const previous = this.session;
    clearTimeout(this.timer);
    this.session = undefined;
    this.ready = false;
    if (this.closing || !session.isAlive()) {
      await Promise.all([this.stop(session), ...(previous ? [this.stop(previous)] : [])]);
      return;
    }
    // Register before any await: another run must close this pending child before it can spawn.
    this.session = session;
    this.timer = setTimeout(() => void this.discard().catch(() => undefined), 60_000);
    this.timer.unref();
    if (previous) await this.stop(previous);
  }

  activate(session: IdleNativeSession): boolean {
    if (this.closing || this.session !== session || !session.isAlive()) return false;
    this.ready = true;
    return true;
  }

  async release(session: IdleNativeSession): Promise<void> {
    if (this.session === session) await this.discard();
    else await this.stop(session);
  }

  async close(): Promise<void> {
    this.closing = true;
    const results = await Promise.allSettled([this.discard(), ...this.stops]);
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }
}
