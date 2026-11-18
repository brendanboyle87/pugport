import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server, type ServerResponse, type RequestListener } from 'node:http';
import { access, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { writePrivateConfig } from '../server/private-config.ts';
import { configuredSync, type SyncConfig } from '../shared/account-sync.ts';
import type {
  AccountAuthState,
  AccountBackendMessage,
  AccountMainMessage,
  AccountSession,
} from '../shared/account-ui.ts';

export const ACCOUNT_CALLBACK_PORTS = [38917, 38918, 38919, 38920, 38921] as const;
export type Schedule = (callback: () => void, milliseconds: number) => () => void;
const schedule: Schedule = (callback, milliseconds) => {
  const timer = setTimeout(callback, milliseconds);
  timer.unref();
  return () => clearTimeout(timer);
};
export const pkceChallenge = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');
export function createPkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: pkceChallenge(verifier) };
}
export type CallbackListener = {
  redirectUrl: string;
  code: Promise<string>;
  cancel: () => void;
  complete?: (success: boolean) => void;
};

/** A short-lived listener; tests inject the server factory so they never open a socket. */
export async function startAccountCallback(
  state: string,
  options: { createServer?: (listener: RequestListener) => Server; schedule?: Schedule } = {},
): Promise<CallbackListener> {
  let server: Server | undefined;
  let done = false;
  let received = false;
  let callbackResponse: ServerResponse | undefined;
  let cancelTimeout: (() => void) | undefined;
  let resolveCode!: (value: string) => void;
  let rejectCode!: (error: Error) => void;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  // A timeout or early cancellation can precede the caller awaiting the callback.
  void code.catch(() => {});
  const page = (response: ServerResponse, success: boolean) => {
    response.writeHead(success ? 200 : 400, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'",
      'Referrer-Policy': 'no-referrer',
      Connection: 'close',
    });
    response.end(
      success
        ? 'Signed in. You can close this tab and return to PugPort.'
        : 'Sign-in failed. You can close this tab and try again in PugPort.',
    );
  };
  const finish = (error?: string) => {
    if (done) return;
    done = true;
    cancelTimeout?.();
    if (callbackResponse) page(callbackResponse, !error);
    server?.close();
    if (error === 'CANCELLED' || error === 'TIMED_OUT') server?.closeAllConnections();
    if (error) rejectCode(new Error(error));
  };
  for (const port of ACCOUNT_CALLBACK_PORTS) {
    const candidate = (options.createServer ?? createServer)((request, response) => {
      let url: URL;
      try {
        url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
      } catch {
        response.writeHead(400);
        response.end();
        return;
      }
      if (request.method !== 'GET' || url.pathname !== '/auth/callback') {
        response.writeHead(404);
        response.end();
        return;
      }
      if (received || done) {
        page(response, false);
        return;
      }
      const actual = Buffer.from(url.searchParams.get('state') ?? '');
      const expected = Buffer.from(state);
      const valid =
        url.searchParams.getAll('state').length === 1 &&
        actual.length === expected.length &&
        timingSafeEqual(actual, expected);
      if (!valid) {
        page(response, false);
        return;
      }
      const authCode = url.searchParams.get('code');
      const error = !authCode || url.searchParams.has('error') ? 'SIGN_IN_FAILED' : undefined;
      callbackResponse = response;
      if (error) finish(error);
      else {
        received = true;
        server?.close();
        resolveCode(authCode!);
      }
    });
    candidate.requestTimeout = 10000;
    candidate.headersTimeout = 10000;
    candidate.keepAliveTimeout = 1;
    try {
      await new Promise<void>((resolve, reject) => {
        candidate.once('error', reject);
        candidate.listen(port, '127.0.0.1', () => {
          candidate.removeListener('error', reject);
          resolve();
        });
      });
      server = candidate;
      candidate.on('error', () => finish('CALLBACK_FAILED'));
      cancelTimeout = (options.schedule ?? schedule)(() => finish('TIMED_OUT'), 5 * 60 * 1000);
      return {
        redirectUrl: `http://127.0.0.1:${port}/auth/callback?state=${encodeURIComponent(state)}`,
        code,
        cancel: () => finish('CANCELLED'),
        complete: (success) => finish(success ? undefined : 'SIGN_IN_FAILED'),
      };
    } catch (error) {
      candidate.close();
      if (!['EADDRINUSE', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  }
  throw new Error('NO_CALLBACK_PORT');
}

export type AccountSecrets = { userId: string; email: string; refreshToken?: string; key?: string; keyId?: string };
type SafeStorage = {
  isEncryptionAvailable(): boolean;
  isAsyncEncryptionAvailable?(): Promise<boolean>;
  getSelectedStorageBackend?(): string;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
  encryptStringAsync?(value: string): Promise<Buffer>;
  decryptStringAsync?(value: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>;
};

/** Only ciphertext leaves this class. An unavailable OS keyring means memory-only storage. */
export class AccountVault {
  readonly file: string;
  private value?: AccountSecrets;
  private revision = 0;
  private tail: Promise<void> = Promise.resolve();
  memoryOnly = true;
  private availability?: Promise<void>;
  private keyring = 0;
  constructor(
    directory: string,
    private readonly storage: SafeStorage,
  ) {
    this.file = join(directory, 'account.enc');
  }
  /**
   * True while a request to the OS keyring is unanswered. macOS asks the user before an app with a new signature
   * (every ad-hoc signed build) reads its key, and until that dialog is answered the app cannot finish exiting.
   */
  get keyringBusy() {
    return this.keyring > 0;
  }
  private async keyringCall<T>(call: () => T | Promise<T>): Promise<T> {
    this.keyring++;
    try {
      return await call();
    } finally {
      this.keyring--;
    }
  }
  private checkStorage(): Promise<void> {
    return (this.availability ??= Promise.resolve().then(async () => {
      try {
        const available = this.storage.isAsyncEncryptionAvailable
          ? await this.keyringCall(() => this.storage.isAsyncEncryptionAvailable!())
          : this.storage.isEncryptionAvailable();
        this.memoryOnly = !available || this.storage.getSelectedStorageBackend?.() === 'basic_text';
      } catch {
        this.memoryOnly = true;
      }
    }));
  }
  async load(): Promise<AccountSecrets | undefined> {
    // Without a saved sign-in there is nothing to decrypt, so the OS keyring is not asked at all.
    if (
      !this.value &&
      !(await access(this.file).then(
        () => true,
        () => false,
      ))
    )
      return undefined;
    await this.checkStorage();
    await this.tail;
    if (this.value || this.memoryOnly) return this.value && { ...this.value };
    const revision = this.revision;
    try {
      const encrypted = Buffer.from(await readFile(this.file, 'utf8'), 'base64');
      const text = this.storage.decryptStringAsync
        ? (await this.keyringCall(() => this.storage.decryptStringAsync!(encrypted))).result
        : this.storage.decryptString(encrypted);
      const value = JSON.parse(text) as AccountSecrets;
      if (
        typeof value.userId !== 'string' ||
        typeof value.email !== 'string' ||
        (value.refreshToken !== undefined && typeof value.refreshToken !== 'string')
      )
        return;
      if (value.key !== undefined && (typeof value.key !== 'string' || Buffer.from(value.key, 'base64').length !== 32))
        return;
      if (revision !== this.revision) return;
      this.value = value;
      return { ...value };
    } catch {
      return;
    }
  }
  save(value: AccountSecrets): Promise<void> {
    ++this.revision;
    this.value = { ...value };
    const snapshot = JSON.stringify(value);
    this.tail = this.tail.then(async () => {
      await this.checkStorage();
      if (this.memoryOnly) return;
      try {
        const encrypted = this.storage.encryptStringAsync
          ? await this.keyringCall(() => this.storage.encryptStringAsync!(snapshot))
          : this.storage.encryptString(snapshot);
        const previous = await readFile(this.file, 'utf8').catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
          return '';
        });
        await writePrivateConfig(this.file, encrypted.toString('base64'), previous);
      } catch {
        this.memoryOnly = true;
        // Do not leave a stale rotating refresh token behind after a failed replacement.
        await unlink(this.file).catch(() => {});
      }
    });
    return this.tail;
  }
  clear(): Promise<void> {
    ++this.revision;
    this.value = undefined;
    this.tail = this.tail.then(async () => {
      await unlink(this.file).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    });
    return this.tail;
  }
}

type Options = {
  config: SyncConfig;
  vault: AccountVault;
  send: (message: AccountMainMessage) => void;
  openExternal: (url: string) => Promise<unknown>;
  fetch?: typeof fetch;
  now?: () => number;
  schedule?: Schedule;
  callback?: typeof startAccountCallback;
  protocolAvailable?: () => boolean;
  signedIn?: () => void;
};
class AuthFailure extends Error {
  constructor(readonly status: number) {
    super('AUTH_FAILED');
  }
}

export class AccountAuth {
  state: AccountAuthState = { phase: 'signed-out' };
  private session?: AccountSession;
  private secrets?: AccountSecrets;
  private callback?: CallbackListener;
  private acceptProtocol?: (url: string) => boolean;
  private generation = 0;
  private retry = 1000;
  private cancelTimer?: () => void;
  private refreshInFlight?: Promise<void>;
  private active = true;
  private readonly enabled: boolean;
  constructor(private readonly options: Options) {
    this.enabled = configuredSync(options.config);
  }
  private publish(phase: AccountAuthState['phase'], error?: string) {
    this.state = {
      phase,
      ...(phase === 'signed-in' && this.secrets ? { email: this.secrets.email } : {}),
      memoryOnly: this.options.vault.memoryOnly,
      ...(error ? { error } : {}),
    };
    this.options.send({ type: 'account-auth', auth: this.state });
  }
  private timer(delay: number) {
    this.cancelTimer?.();
    this.cancelTimer = (this.options.schedule ?? schedule)(() => {
      void this.refresh();
    }, delay);
  }
  private async request(path: string, body?: unknown, accessToken?: string) {
    const response = await (this.options.fetch ?? fetch)(
      `${this.options.config.url.replace(/\/$/, '')}/auth/v1/${path}`,
      {
        method: 'POST',
        headers: {
          apikey: this.options.config.publishableKey,
          'Content-Type': 'application/json',
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!response.ok) throw new AuthFailure(response.status);
    return response;
  }
  private async accept(response: Response, generation: number) {
    const data = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      expires_at?: number;
      user: { id: string; email?: string };
    };
    if (generation !== this.generation) return;
    if (
      typeof data.access_token !== 'string' ||
      !data.access_token ||
      typeof data.refresh_token !== 'string' ||
      !data.refresh_token ||
      typeof data.user?.id !== 'string' ||
      !Number.isFinite(data.expires_in) ||
      data.expires_in <= 0
    )
      throw new Error('INVALID_SESSION');
    const now = (this.options.now ?? Date.now)();
    this.session = {
      userId: data.user.id,
      email: data.user.email ?? '',
      accessToken: data.access_token,
      expiresAt: now + data.expires_in * 1000,
    };
    this.secrets = {
      userId: data.user.id,
      email: this.session.email,
      refreshToken: data.refresh_token,
      ...(this.secrets?.userId === data.user.id && this.secrets.key
        ? { key: this.secrets.key, keyId: this.secrets.keyId }
        : {}),
    };
    await this.options.vault.save(this.secrets);
    if (generation !== this.generation) return;
    this.retry = 1000;
    this.publish('signed-in');
    this.handoff();
    this.timer(Math.max(1000, this.session.expiresAt - now - 60000));
  }
  async restore() {
    if (!this.enabled) return;
    const generation = this.generation;
    const secrets = await this.options.vault.load();
    if (generation !== this.generation || !secrets) return;
    this.secrets = secrets;
    if (secrets.refreshToken) {
      this.publish('signed-in');
      await this.refresh();
    }
  }
  /** Consume only a live fallback callback; protocol links never enter the renderer. */
  handleUrl(url: string): boolean {
    return this.acceptProtocol?.(url) ?? false;
  }
  private startProtocolCallback(state: string): CallbackListener {
    let settled = false;
    let cancelTimeout: (() => void) | undefined;
    let resolveCode!: (code: string) => void;
    let rejectCode!: (error: Error) => void;
    const code = new Promise<string>((resolve, reject) => {
      resolveCode = resolve;
      rejectCode = reject;
    });
    void code.catch(() => {});
    const finish = (authCode?: string, error?: string) => {
      if (settled) return;
      settled = true;
      cancelTimeout?.();
      if (this.acceptProtocol === accept) this.acceptProtocol = undefined;
      if (error) rejectCode(new Error(error));
      else resolveCode(authCode!);
    };
    const accept = (value: string): boolean => {
      if (
        settled ||
        value.length > 8192 ||
        /[\u0000-\u0020\u007f]/.test(value) ||
        !value.startsWith('pugport://auth/callback?')
      )
        return false;
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        return false;
      }
      if (
        url.protocol !== 'pugport:' ||
        url.host !== 'auth' ||
        url.pathname !== '/callback' ||
        url.username ||
        url.password ||
        url.hash
      )
        return false;
      const actual = Buffer.from(url.searchParams.get('state') ?? '');
      const expected = Buffer.from(state);
      if (
        url.searchParams.getAll('state').length !== 1 ||
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
      )
        return false;
      else if (
        url.searchParams.has('error') ||
        url.searchParams.getAll('code').length !== 1 ||
        !url.searchParams.get('code')
      )
        finish(undefined, 'SIGN_IN_FAILED');
      else finish(url.searchParams.get('code')!);
      return true;
    };
    this.acceptProtocol = accept;
    cancelTimeout = (this.options.schedule ?? schedule)(() => finish(undefined, 'TIMED_OUT'), 5 * 60 * 1000);
    return {
      redirectUrl: `pugport://auth/callback?state=${encodeURIComponent(state)}`,
      code,
      cancel: () => finish(undefined, 'CANCELLED'),
    };
  }
  async signIn() {
    if (!this.enabled || this.state.phase !== 'signed-out') return;
    const generation = ++this.generation;
    this.publish('signing-in');
    try {
      const pkce = createPkce();
      const state = randomBytes(32).toString('base64url');
      let callback: CallbackListener;
      try {
        callback = await (this.options.callback ?? startAccountCallback)(state);
      } catch (error) {
        if (generation !== this.generation) return;
        if (!(error instanceof Error) || error.message !== 'NO_CALLBACK_PORT' || !this.options.protocolAvailable?.())
          throw error;
        callback = this.startProtocolCallback(state);
      }
      if (generation !== this.generation) {
        callback.cancel();
        return;
      }
      this.callback = callback;
      const url = new URL(`${this.options.config.url.replace(/\/$/, '')}/auth/v1/authorize`);
      url.search = new URLSearchParams({
        provider: 'google',
        redirect_to: callback.redirectUrl,
        code_challenge: pkce.challenge,
        code_challenge_method: 's256',
      }).toString();
      await this.options.openExternal(url.href);
      const code = await callback.code;
      if (generation !== this.generation) return;
      await this.accept(
        await this.request('token?grant_type=pkce', { auth_code: code, code_verifier: pkce.verifier }),
        generation,
      );
      if (generation === this.generation) {
        callback.complete?.(true);
        this.options.signedIn?.();
      }
    } catch (error) {
      if (generation === this.generation) this.callback?.complete?.(false);
      if (generation === this.generation)
        this.publish(
          'signed-out',
          error instanceof Error && ['TIMED_OUT', 'NO_CALLBACK_PORT', 'STATE_MISMATCH'].includes(error.message)
            ? error.message === 'TIMED_OUT'
              ? 'AUTH_TIMEOUT'
              : error.message
            : 'SIGN_IN_FAILED',
        );
    } finally {
      if (generation === this.generation) {
        this.callback?.cancel();
        this.callback = undefined;
      }
    }
  }
  cancel() {
    if (this.state.phase !== 'signing-in') return;
    // Encryption can still be in flight after the code exchange; queue deletion after that write.
    void this.clear();
  }
  refresh(): Promise<void> {
    if (!this.enabled || !this.secrets?.refreshToken) return Promise.resolve();
    if (this.refreshInFlight) return this.refreshInFlight;
    const generation = this.generation;
    const refreshToken = this.secrets.refreshToken;
    this.refreshInFlight = (async () => {
      try {
        await this.accept(
          await this.request('token?grant_type=refresh_token', { refresh_token: refreshToken }),
          generation,
        );
      } catch (error) {
        if (generation !== this.generation) return;
        if (error instanceof AuthFailure && [400, 401, 403].includes(error.status)) await this.clear('SESSION_EXPIRED');
        else {
          this.publish('signed-in', 'OFFLINE');
          this.timer(this.retry);
          this.retry = Math.min(300000, this.retry * 2);
        }
      }
    })().finally(() => {
      this.refreshInFlight = undefined;
    });
    return this.refreshInFlight;
  }
  private async clear(error?: string) {
    ++this.generation;
    this.callback?.cancel();
    this.callback = undefined;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    const retained =
      error === 'SESSION_EXPIRED' && this.secrets
        ? {
            userId: this.secrets.userId,
            email: this.secrets.email,
            ...(this.secrets.key ? { key: this.secrets.key, keyId: this.secrets.keyId } : {}),
          }
        : undefined;
    this.secrets = retained;
    this.session = undefined;
    this.options.send({ type: 'account-clear' });
    this.publish('signed-out', error);
    try {
      if (retained) await this.options.vault.save(retained);
      else await this.options.vault.clear();
    } catch {
      this.publish('signed-out', 'STORAGE_CLEAR_FAILED');
    }
  }
  async signOut() {
    if (!this.enabled) return;
    const accessToken = this.session?.accessToken;
    await this.clear();
    if (accessToken) await this.request('logout?scope=local', undefined, accessToken).catch(() => {});
  }
  handoff() {
    if (!this.enabled) return;
    this.options.send({ type: 'account-auth', auth: this.state });
    if (this.session) {
      if (this.secrets?.key && this.secrets.keyId)
        this.options.send({
          type: 'account-key',
          userId: this.session.userId,
          key: this.secrets.key,
          keyId: this.secrets.keyId,
        });
      this.options.send({ type: 'account-session', session: this.session });
    }
    this.options.send({ type: 'account-active', active: this.active });
  }
  setActive(active: boolean) {
    this.active = active;
    if (this.enabled) this.options.send({ type: 'account-active', active });
  }
  async handle(message: AccountBackendMessage) {
    if (!this.enabled) return;
    if (message.type === 'account-action') {
      if (message.action === 'sign-in') await this.signIn();
      else if (message.action === 'cancel') this.cancel();
      else if (message.action === 'sign-out') await this.signOut();
      else if (message.action === 'refresh') await this.refresh();
    } else if (
      message.type === 'account-persist-key' &&
      this.secrets?.userId === message.userId &&
      this.session?.userId === message.userId
    ) {
      if (
        message.key !== undefined &&
        (typeof message.key !== 'string' || Buffer.from(message.key, 'base64').length !== 32)
      )
        return;
      if (message.key && !message.keyId) return;
      this.secrets = { ...this.secrets, key: message.key, keyId: message.key ? message.keyId : undefined };
      await this.options.vault.save(this.secrets);
      if (this.secrets) this.publish('signed-in');
    }
  }
  /** An OS keyring request is still unanswered (see AccountVault.keyringBusy). */
  get keyringBusy() {
    return this.options.vault.keyringBusy;
  }
  stop() {
    ++this.generation;
    this.callback?.cancel();
    this.callback = undefined;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
  }
}
