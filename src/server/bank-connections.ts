import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type {
  BankAccount,
  BankConnectionView,
  BankCreditLiability,
  BankTransaction,
  BankTransactionChange,
  LinkSessionView,
  PlaidSettingsView,
} from '../shared/mod-data.ts';
import {
  PlaidError,
  plaidCall,
  type PlaidAccount,
  type PlaidCredentials,
  type PlaidCredit,
  type PlaidEnvironment,
  type PlaidLinkTokenGet,
  type PlaidSyncPage,
  type PlaidTransaction,
} from './plaid-client.ts';
import { writePrivateConfig } from './private-config.ts';

const environment = z.enum(['sandbox', 'production']);
const connectionSchema = z.object({
  id: z.string(),
  environment,
  itemId: z.string(),
  accessToken: z.string(),
  institution: z.object({ id: z.string(), name: z.string() }).optional(),
  modIds: z.array(z.string()),
  status: z.enum(['connected', 'reauth_required', 'error']),
  products: z.array(z.string()),
  createdAt: z.string(),
  lastSyncedAt: z.string().optional(),
  lastAttemptAt: z.string().optional(),
  nextSyncAt: z.string().optional(),
  failures: z.number().int().nonnegative().default(0),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
const fileSchema = z.object({
  version: z.literal(1),
  /** Stable, random and meaningless to Plaid: Link needs a user ID, never a name or email. */
  userId: z.string(),
  plaid: z
    .object({
      clientId: z.string(),
      environment,
      secrets: z.object({ sandbox: z.string().optional(), production: z.string().optional() }),
    })
    .optional(),
  connections: z.array(connectionSchema),
});
type File = z.infer<typeof fileSchema>;
type Connection = z.infer<typeof connectionSchema>;
export const plaidSettingsInputSchema = z
  .object({
    clientId: z.string().trim().min(1).max(200).optional(),
    environment,
    sandboxSecret: z.string().trim().min(1).max(200).optional(),
    productionSecret: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
type LinkSession = LinkSessionView & {
  linkToken: string;
  modId?: string;
  reconnect?: string;
  environment: PlaidEnvironment;
  expiresAt: number;
  timer?: NodeJS.Timeout;
};
export class BankConnectionError extends Error {
  readonly status: number;
  constructor(
    readonly code: 'E_INVALID' | 'E_UNAVAILABLE' | 'E_NOT_CONFIGURED' | 'E_PERMISSION',
    message?: string,
  ) {
    super(
      message ??
        {
          E_INVALID: 'Invalid request.',
          E_UNAVAILABLE: 'Connection is unavailable.',
          E_NOT_CONFIGURED: 'Plaid keys are not set.',
          E_PERMISSION: 'Permission is not declared.',
        }[code],
    );
    this.status = code === 'E_INVALID' ? 400 : code === 'E_PERMISSION' ? 403 : 409;
  }
}
export type BankNotice =
  | { kind: 'new-data'; connectionId: string; institution: string; added: number; modIds: string[] }
  | { kind: 'reauth'; connectionId: string; institution: string }
  | { kind: 'resolved'; connectionId: string };
type Options = {
  file: string;
  db: DatabaseSync;
  fetch?: typeof fetch;
  /** Tests point Plaid at a fake server; production code never sets it. */
  baseUrl?: string;
  now?: () => number;
  notice?: (notice: BankNotice) => void;
  changed?: () => void;
  pollMs?: number;
};
const SYNC_EVERY_MS = 6 * 3600_000;
const FIRST_SYNC_RETRY_MS = 5 * 60_000;
const BACKOFF_BASE_MS = 5 * 60_000;
const SYNC_PAGES_MAX = 200;
const iso = (ms: number) => new Date(ms).toISOString();
const optional = <T>(value: T | null | undefined) => (value === null || value === undefined ? undefined : value);
const encodeCursor = (connectionId: string, seq: number) =>
  Buffer.from(JSON.stringify([connectionId, seq])).toString('base64url');
function decodeCursor(connectionId: string, cursor?: string) {
  if (!cursor) return 0;
  try {
    const [owner, seq] = z
      .tuple([z.string(), z.number().int().nonnegative()])
      .parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    if (owner === connectionId) return seq;
  } catch {
    /* Fall through. */
  }
  throw new BankConnectionError('E_INVALID');
}
export function backoffMs(failures: number) {
  return Math.min(SYNC_EVERY_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1));
}
function account(item: PlaidAccount): BankAccount {
  return {
    id: item.account_id,
    name: item.name,
    ...(item.official_name ? { officialName: item.official_name } : {}),
    ...(item.mask ? { mask: item.mask } : {}),
    type: item.type,
    ...(item.subtype ? { subtype: item.subtype } : {}),
    ...((item.balances.iso_currency_code ?? item.balances.unofficial_currency_code)
      ? { currency: (item.balances.iso_currency_code ?? item.balances.unofficial_currency_code)! }
      : {}),
    balances: {
      ...(typeof item.balances.current === 'number' ? { current: item.balances.current } : {}),
      ...(typeof item.balances.available === 'number' ? { available: item.balances.available } : {}),
      ...(typeof item.balances.limit === 'number' ? { limit: item.balances.limit } : {}),
      ...(item.balances.last_updated_datetime ? { asOf: item.balances.last_updated_datetime } : {}),
    },
  };
}
function transaction(item: PlaidTransaction): BankTransaction & { pendingTransactionId?: string } {
  const currency = item.iso_currency_code ?? item.unofficial_currency_code;
  return {
    id: item.transaction_id,
    accountId: item.account_id,
    date: item.date,
    ...(item.authorized_date ? { authorizedDate: item.authorized_date } : {}),
    name: item.name,
    ...(item.merchant_name ? { merchantName: item.merchant_name } : {}),
    amount: item.amount,
    ...(currency ? { currency } : {}),
    pending: item.pending,
    ...(item.pending_transaction_id ? { pendingTransactionId: item.pending_transaction_id } : {}),
    ...(item.personal_finance_category?.primary ? { category: item.personal_finance_category.primary } : {}),
  };
}
/** Plaid leaves a field null when the issuer does not report it; it stays absent here, never estimated. */
function credit(item: PlaidCredit): BankCreditLiability | undefined {
  if (!item.account_id) return undefined;
  const fields = {
    lastStatementIssueDate: optional(item.last_statement_issue_date),
    lastStatementBalance: optional(item.last_statement_balance),
    minimumPaymentAmount: optional(item.minimum_payment_amount),
    nextPaymentDueDate: optional(item.next_payment_due_date),
    lastPaymentAmount: optional(item.last_payment_amount),
    lastPaymentDate: optional(item.last_payment_date),
    isOverdue: optional(item.is_overdue),
  };
  return {
    accountId: item.account_id,
    ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)),
    aprs: (item.aprs ?? []).map((apr) => ({ type: apr.apr_type, percentage: apr.apr_percentage })),
  };
}

/**
 * Bank connections through Plaid. Keys and access tokens live only in a private file on this computer; Mods and the
 * window see connection IDs, status and the data Plaid returned. A failed sync keeps the last data and its time.
 */
export class BankConnections {
  private file?: File;
  private text = '';
  private writing: Promise<unknown> = Promise.resolve();
  private readonly sessions = new Map<string, LinkSession>();
  private readonly syncing = new Map<string, Promise<void>>();
  private timer?: NodeJS.Timeout;
  private readonly now: () => number;

  constructor(private readonly options: Options) {
    this.now = options.now ?? Date.now;
    options.db.exec(`CREATE TABLE IF NOT EXISTS bank_accounts (
      connection_id TEXT NOT NULL, account_id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (connection_id, account_id)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS bank_transactions (
      connection_id TEXT NOT NULL, transaction_id TEXT NOT NULL, account_id TEXT NOT NULL, seq INTEGER NOT NULL,
      removed INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY (connection_id, transaction_id)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS bank_transactions_seq ON bank_transactions(connection_id, seq);
    CREATE TABLE IF NOT EXISTS bank_liabilities (
      connection_id TEXT NOT NULL, account_id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (connection_id, account_id)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS bank_sync_state (connection_id TEXT PRIMARY KEY, cursor TEXT NOT NULL);`);
  }

  private async load(): Promise<File> {
    if (this.file) return this.file;
    let text = '';
    try {
      text = await readFile(this.options.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.text = text;
    this.file = text
      ? fileSchema.parse(JSON.parse(text))
      : { version: 1, userId: `pugport-${randomBytes(12).toString('hex')}`, connections: [] };
    return this.file;
  }
  /** Writes are queued, so two changes never overwrite each other. */
  private save(change: (file: File) => void): Promise<void> {
    const next = this.writing.then(async () => {
      const file = await this.load();
      change(file);
      const text = `${JSON.stringify(file, null, 2)}\n`;
      await writePrivateConfig(this.options.file, text, this.text);
      this.text = text;
    });
    this.writing = next.catch(() => {});
    return next.finally(() => this.options.changed?.());
  }

  async settings(): Promise<PlaidSettingsView> {
    const plaid = (await this.load()).plaid;
    return {
      configured: !!plaid?.secrets[plaid.environment],
      environment: plaid?.environment ?? 'sandbox',
      ...(plaid ? { clientIdEnding: plaid.clientId.slice(-4) } : {}),
      sandboxSecret: !!plaid?.secrets.sandbox,
      productionSecret: !!plaid?.secrets.production,
    };
  }
  /** A blank secret keeps the saved one; keys are never sent back to the window. */
  async saveSettings(input: z.infer<typeof plaidSettingsInputSchema>): Promise<PlaidSettingsView> {
    const value = plaidSettingsInputSchema.parse(input);
    const current = (await this.load()).plaid;
    const clientId = value.clientId ?? current?.clientId;
    if (!clientId) throw new BankConnectionError('E_INVALID', 'Enter the Plaid client ID.');
    await this.save((file) => {
      file.plaid = {
        clientId,
        environment: value.environment,
        secrets: {
          ...(current && current.clientId === clientId ? current.secrets : {}),
          ...(value.sandboxSecret ? { sandbox: value.sandboxSecret } : {}),
          ...(value.productionSecret ? { production: value.productionSecret } : {}),
        },
      };
    });
    return this.settings();
  }
  async clearSettings(): Promise<PlaidSettingsView> {
    await this.save((file) => delete file.plaid);
    return this.settings();
  }
  private credentials(file: File, env: PlaidEnvironment): PlaidCredentials {
    const secret = file.plaid?.secrets[env];
    if (!file.plaid || !secret) throw new BankConnectionError('E_NOT_CONFIGURED');
    return { clientId: file.plaid.clientId, secret, environment: env };
  }
  private call<T>(file: File, env: PlaidEnvironment, path: string, body: Record<string, unknown>) {
    return plaidCall<T>(this.credentials(file, env), path, body, {
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      ...(this.options.baseUrl ? { baseUrl: this.options.baseUrl } : {}),
    });
  }

  private view(connection: Connection): BankConnectionView {
    return {
      id: connection.id,
      provider: 'plaid',
      environment: connection.environment,
      ...(connection.institution ? { institution: connection.institution } : {}),
      status: this.syncing.has(connection.id) ? 'syncing' : connection.status,
      ...(connection.lastSyncedAt ? { lastSyncedAt: connection.lastSyncedAt } : {}),
      ...(connection.lastAttemptAt ? { lastAttemptAt: connection.lastAttemptAt } : {}),
      ...(connection.nextSyncAt ? { nextSyncAt: connection.nextSyncAt } : {}),
      ...(connection.error ? { error: connection.error } : {}),
      products: connection.products,
    };
  }
  /** All connections, for Settings, with the Mods each one is shared with. */
  async list(): Promise<(BankConnectionView & { modIds: string[] })[]> {
    return (await this.load()).connections.map((item) => ({ ...this.view(item), modIds: [...item.modIds] }));
  }
  async listFor(modId: string): Promise<BankConnectionView[]> {
    return (await this.load()).connections.filter((item) => item.modIds.includes(modId)).map((item) => this.view(item));
  }
  private async granted(modId: string | undefined, connectionId: string) {
    const connection = (await this.load()).connections.find((item) => item.id === connectionId);
    if (!connection || (modId !== undefined && !connection.modIds.includes(modId)))
      throw new BankConnectionError('E_UNAVAILABLE');
    return connection;
  }
  async status(modId: string | undefined, connectionId: string) {
    return this.view(await this.granted(modId, connectionId));
  }

  /**
   * Opens a Plaid Hosted Link session: the user signs in to the bank on Plaid's page, never in PugPort. With
   * `reconnect`, Link opens in update mode for that connection. The host polls Link for the result.
   */
  async startLink(input: { modId?: string; reconnect?: string }): Promise<LinkSessionView> {
    const file = await this.load();
    const previous = input.reconnect ? await this.granted(input.modId, input.reconnect) : undefined;
    const env = previous?.environment ?? file.plaid?.environment ?? 'sandbox';
    this.credentials(file, env);
    const body: Record<string, unknown> = {
      client_name: 'PugPort',
      language: 'en',
      country_codes: ['US', 'CA'],
      user: { client_user_id: file.userId },
      hosted_link: {},
      ...(previous
        ? { access_token: previous.accessToken }
        : {
            products: ['transactions'],
            optional_products: ['liabilities'],
            transactions: { days_requested: 730 },
          }),
    };
    let created: { link_token: string; hosted_link_url?: string; expiration?: string };
    try {
      created = await this.call(file, env, '/link/token/create', body);
    } catch (error) {
      throw new BankConnectionError('E_UNAVAILABLE', error instanceof PlaidError ? error.message : undefined);
    }
    if (!created.hosted_link_url || !/^https:\/\/[^/]*plaid\.com\//.test(created.hosted_link_url))
      throw new BankConnectionError('E_UNAVAILABLE', 'Plaid did not return a Link page.');
    const session: LinkSession = {
      id: `link_${randomBytes(12).toString('hex')}`,
      status: 'waiting',
      url: created.hosted_link_url,
      linkToken: created.link_token,
      ...(input.modId ? { modId: input.modId } : {}),
      ...(previous ? { reconnect: previous.id } : {}),
      environment: env,
      // Hosted Link pages last 30 minutes unless asked otherwise.
      expiresAt: Math.min(this.now() + 30 * 60_000, created.expiration ? Date.parse(created.expiration) : Infinity),
    };
    this.sessions.set(session.id, session);
    this.schedulePoll(session);
    return this.sessionView(session);
  }
  linkSession(id: string): LinkSessionView {
    const session = this.sessions.get(id);
    if (!session) throw new BankConnectionError('E_UNAVAILABLE');
    return this.sessionView(session);
  }
  cancelLink(id: string) {
    const session = this.sessions.get(id);
    if (session?.status === 'waiting') this.endSession(session, 'cancelled');
  }
  private sessionView(session: LinkSession): LinkSessionView {
    const { id, status, url, connectionId, institution, error } = session;
    return {
      id,
      status,
      ...(status === 'waiting' && url ? { url } : {}),
      ...(connectionId ? { connectionId } : {}),
      ...(institution ? { institution } : {}),
      ...(error ? { error } : {}),
    };
  }
  private endSession(session: LinkSession, status: LinkSession['status'], error?: string) {
    session.status = status;
    if (error) session.error = error;
    clearTimeout(session.timer);
    // Finished sessions stay readable for a while so the window can show the result.
    setTimeout(() => this.sessions.delete(session.id), 10 * 60_000).unref?.();
    this.options.changed?.();
  }
  private schedulePoll(session: LinkSession) {
    session.timer = setTimeout(
      () => void this.pollLink(session.id).catch(() => this.endSession(session, 'failed')),
      this.options.pollMs ?? 3000,
    );
    session.timer.unref?.();
  }
  /** One check of a Link session; exported for tests, otherwise driven by its timer. */
  async pollLink(id: string): Promise<LinkSessionView | undefined> {
    const session = this.sessions.get(id);
    if (!session || session.status !== 'waiting') return session && this.sessionView(session);
    if (this.now() > session.expiresAt) {
      this.endSession(session, 'expired');
      return this.sessionView(session);
    }
    const file = await this.load();
    let result: PlaidLinkTokenGet;
    try {
      result = await this.call(file, session.environment, '/link/token/get', { link_token: session.linkToken });
    } catch (error) {
      if (error instanceof PlaidError && error.badKeys) {
        this.endSession(session, 'failed', error.message);
        return this.sessionView(session);
      }
      this.schedulePoll(session);
      return this.sessionView(session);
    }
    const finished = result.link_sessions?.find((item) => item.finished_at || item.exit || item.results);
    const added = finished?.results?.item_add_results?.[0] ?? undefined;
    const token = added?.public_token ?? finished?.on_success?.public_token;
    try {
      if (session.reconnect && finished && (finished.finished_at || token) && !finished.exit) {
        await this.reconnected(session.reconnect);
        session.connectionId = session.reconnect;
        this.endSession(session, 'connected');
      } else if (!session.reconnect && token) {
        const connection = await this.exchange(file, session, token, added?.institution ?? undefined);
        session.connectionId = connection.id;
        session.institution = connection.institution?.name;
        this.endSession(session, 'connected');
      } else if (finished?.exit || (finished?.finished_at && !token)) {
        this.endSession(session, 'cancelled', finished?.exit?.error?.error_code);
      } else this.schedulePoll(session);
    } catch (error) {
      this.endSession(session, 'failed', error instanceof Error ? error.message : undefined);
    }
    return this.sessionView(session);
  }
  private async exchange(
    file: File,
    session: LinkSession,
    publicToken: string,
    institution?: { institution_id?: string; name?: string } | null,
  ): Promise<Connection> {
    const exchanged = await this.call<{ access_token: string; item_id: string }>(
      file,
      session.environment,
      '/item/public_token/exchange',
      { public_token: publicToken },
    );
    const at = iso(this.now());
    const existing = file.connections.find((item) => item.itemId === exchanged.item_id);
    const connection: Connection = existing ?? {
      id: `conn_${randomBytes(12).toString('hex')}`,
      environment: session.environment,
      itemId: exchanged.item_id,
      accessToken: exchanged.access_token,
      ...(institution?.institution_id
        ? { institution: { id: institution.institution_id, name: institution.name ?? institution.institution_id } }
        : {}),
      modIds: [],
      status: 'connected',
      products: ['transactions'],
      createdAt: at,
      failures: 0,
    };
    await this.save((current) => {
      const target = current.connections.find((item) => item.id === connection.id);
      const value = target ?? connection;
      if (!target) current.connections.push(value);
      if (session.modId && !value.modIds.includes(session.modId)) value.modIds.push(session.modId);
      value.accessToken = exchanged.access_token;
      value.status = 'connected';
      value.nextSyncAt = at;
      delete value.error;
    });
    void this.sync(connection.id);
    return (await this.load()).connections.find((item) => item.id === connection.id)!;
  }
  private async reconnected(connectionId: string) {
    await this.save((file) => {
      const target = file.connections.find((item) => item.id === connectionId);
      if (!target) return;
      target.status = 'connected';
      target.failures = 0;
      target.nextSyncAt = iso(this.now());
      delete target.error;
    });
    this.options.notice?.({ kind: 'resolved', connectionId });
    void this.sync(connectionId);
  }

  async share(connectionId: string, modId: string, shared: boolean) {
    await this.granted(undefined, connectionId);
    await this.save((file) => {
      const target = file.connections.find((item) => item.id === connectionId)!;
      target.modIds = shared ? [...new Set([...target.modIds, modId])] : target.modIds.filter((id) => id !== modId);
    });
  }
  /** Removing tells Plaid first (which ends that Item's billing), then forgets the token and the cached data. */
  async remove(connectionId: string) {
    const connection = await this.granted(undefined, connectionId);
    // A sync still writing would bring cached rows back after the delete below.
    await this.syncing.get(connectionId);
    const file = await this.load();
    try {
      await this.call(file, connection.environment, '/item/remove', { access_token: connection.accessToken });
    } catch (error) {
      // An Item Plaid no longer knows is already gone; anything else keeps the connection so the user can retry.
      if (!(error instanceof PlaidError) || !['ITEM_NOT_FOUND', 'INVALID_ACCESS_TOKEN'].includes(error.code))
        throw new BankConnectionError('E_UNAVAILABLE', error instanceof Error ? error.message : undefined);
    }
    await this.save((current) => {
      current.connections = current.connections.filter((item) => item.id !== connectionId);
    });
    for (const table of ['bank_accounts', 'bank_transactions', 'bank_liabilities', 'bank_sync_state'])
      this.options.db.prepare(`DELETE FROM ${table} WHERE connection_id=?`).run(connectionId);
    this.options.notice?.({ kind: 'resolved', connectionId });
  }

  /** Starts the periodic sync. It runs only while PugPort is open; missed syncs run soon after the next start. */
  start(intervalMs = 60_000) {
    const run = () => void this.syncDue().catch((error) => console.warn('Bank sync check failed:', error));
    this.timer ??= setInterval(run, intervalMs);
    this.timer.unref?.();
    setTimeout(run, 15_000).unref?.();
  }
  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
    for (const session of this.sessions.values()) clearTimeout(session.timer);
  }
  async syncDue() {
    const now = this.now();
    for (const connection of (await this.load()).connections)
      if (connection.status !== 'reauth_required' && Date.parse(connection.nextSyncAt ?? '') <= now)
        await this.sync(connection.id);
  }
  /** One sync per connection at a time; a second request waits for the running one. */
  sync(connectionId: string): Promise<void> {
    const running = this.syncing.get(connectionId);
    if (running) return running;
    // Failures are recorded on the connection; only a broken private file can get here.
    const task = this.syncOnce(connectionId)
      .catch((error) => console.warn('Bank sync failed:', connectionId, error))
      .finally(() => {
        this.syncing.delete(connectionId);
        this.options.changed?.();
      });
    this.syncing.set(connectionId, task);
    this.options.changed?.();
    return task;
  }
  async requestSync(modId: string | undefined, connectionId: string) {
    const connection = await this.granted(modId, connectionId);
    if (connection.status === 'reauth_required') return this.view(connection);
    void this.sync(connectionId);
    return this.view((await this.load()).connections.find((item) => item.id === connectionId)!);
  }
  private async syncOnce(connectionId: string) {
    const file = await this.load();
    const connection = file.connections.find((item) => item.id === connectionId);
    if (!connection) return;
    const startedAt = this.now();
    const db = this.options.db;
    try {
      const accounts = await this.call<{ accounts: PlaidAccount[] }>(file, connection.environment, '/accounts/get', {
        access_token: connection.accessToken,
      });
      const pages = await this.transactionPages(file, connection);
      let liabilities: PlaidCredit[] | undefined;
      try {
        liabilities =
          (
            await this.call<{ liabilities: { credit?: PlaidCredit[] | null } }>(
              file,
              connection.environment,
              '/liabilities/get',
              { access_token: connection.accessToken },
            )
          ).liabilities.credit ?? [];
      } catch (error) {
        // Many institutions, including most Canadian ones, have no Liabilities data; that is not a failure.
        if (error instanceof PlaidError && (error.needsReauth || error.badKeys)) throw error;
      }
      let added = 0;
      db.exec('BEGIN IMMEDIATE');
      try {
        const putAccount = db.prepare('INSERT OR REPLACE INTO bank_accounts VALUES (?,?,?)');
        for (const item of accounts.accounts)
          putAccount.run(connectionId, item.account_id, JSON.stringify(account(item)));
        let seq = Number(
          (
            db
              .prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM bank_transactions WHERE connection_id=?')
              .get(connectionId) as { seq: number }
          ).seq,
        );
        const existing = db.prepare(
          'SELECT value, removed FROM bank_transactions WHERE connection_id=? AND transaction_id=?',
        );
        const upsert = db.prepare('INSERT OR REPLACE INTO bank_transactions VALUES (?,?,?,?,?,?)');
        // The same transaction again changes nothing, so a repeated or overlapping sync is harmless.
        const write = (id: string, accountId: string, removed: boolean, value: string) => {
          const row = existing.get(connectionId, id) as { value: string; removed: number } | undefined;
          if (row && row.value === value && !!row.removed === removed) return false;
          upsert.run(connectionId, id, accountId, ++seq, removed ? 1 : 0, value);
          return !row;
        };
        for (const page of pages.pages) {
          for (const item of [...page.added, ...page.modified])
            if (write(item.transaction_id, item.account_id, false, JSON.stringify(transaction(item)))) added++;
          for (const item of page.removed) {
            const row = existing.get(connectionId, item.transaction_id) as { value: string } | undefined;
            if (row)
              write(
                item.transaction_id,
                (JSON.parse(row.value) as BankTransaction).accountId,
                true,
                JSON.stringify({ id: item.transaction_id }),
              );
          }
        }
        db.prepare('INSERT OR REPLACE INTO bank_sync_state VALUES (?,?)').run(connectionId, pages.cursor);
        if (liabilities) {
          db.prepare('DELETE FROM bank_liabilities WHERE connection_id=?').run(connectionId);
          const putLiability = db.prepare('INSERT INTO bank_liabilities VALUES (?,?,?)');
          for (const item of liabilities) {
            const value = credit(item);
            if (value) putLiability.run(connectionId, value.accountId, JSON.stringify(value));
          }
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      const firstEmpty = !connection.lastSyncedAt && added === 0;
      const at = this.now();
      await this.save((current) => {
        const target = current.connections.find((item) => item.id === connectionId);
        if (!target) return;
        target.status = 'connected';
        target.failures = 0;
        target.lastAttemptAt = iso(startedAt);
        target.lastSyncedAt = iso(at);
        // Plaid prepares history after the first link; check again soon rather than in six hours.
        target.nextSyncAt = iso(at + (firstEmpty ? FIRST_SYNC_RETRY_MS : SYNC_EVERY_MS));
        if (liabilities?.length && !target.products.includes('liabilities')) target.products.push('liabilities');
        delete target.error;
      });
      if (added > 0)
        this.options.notice?.({
          kind: 'new-data',
          connectionId,
          institution: connection.institution?.name ?? 'Plaid',
          added,
          modIds: connection.modIds,
        });
    } catch (error) {
      const plaid = error instanceof PlaidError ? error : undefined;
      const reauth = !!plaid?.needsReauth;
      await this.save((current) => {
        const target = current.connections.find((item) => item.id === connectionId);
        if (!target) return;
        target.failures += 1;
        target.lastAttemptAt = iso(startedAt);
        target.status = reauth ? 'reauth_required' : 'error';
        target.error = {
          code: plaid?.code ?? (error instanceof BankConnectionError ? error.code : 'SYNC_FAILED'),
          message: (error instanceof Error ? error.message : 'Sync failed.').slice(0, 300),
        };
        // Wrong keys wait for the user; everything else retries with growing gaps, at most every six hours.
        target.nextSyncAt = iso(
          this.now() +
            (plaid?.badKeys || error instanceof BankConnectionError ? SYNC_EVERY_MS : backoffMs(target.failures)),
        );
      });
      if (reauth)
        this.options.notice?.({
          kind: 'reauth',
          connectionId,
          institution: connection.institution?.name ?? 'Plaid',
        });
    }
  }
  /** Collects a whole update before anything is saved; a mutation during paging restarts from the first cursor. */
  private async transactionPages(file: File, connection: Connection) {
    const start =
      (
        this.options.db.prepare('SELECT cursor FROM bank_sync_state WHERE connection_id=?').get(connection.id) as
          { cursor: string } | undefined
      )?.cursor ?? '';
    for (let attempt = 0; ; attempt++) {
      const pages: PlaidSyncPage[] = [];
      let cursor = start;
      try {
        for (let page = 0; page < SYNC_PAGES_MAX; page++) {
          const result = await this.call<PlaidSyncPage>(file, connection.environment, '/transactions/sync', {
            access_token: connection.accessToken,
            count: 500,
            ...(cursor ? { cursor } : {}),
          });
          pages.push(result);
          cursor = result.next_cursor;
          if (!result.has_more) return { pages, cursor };
        }
        return { pages, cursor };
      } catch (error) {
        if (error instanceof PlaidError && error.code === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' && attempt < 2)
          continue;
        throw error;
      }
    }
  }

  async accounts(modId: string | undefined, connectionId: string): Promise<BankAccount[]> {
    await this.granted(modId, connectionId);
    return (
      this.options.db
        .prepare('SELECT value FROM bank_accounts WHERE connection_id=? ORDER BY account_id')
        .all(connectionId) as { value: string }[]
    ).map((row) => JSON.parse(row.value) as BankAccount);
  }
  /**
   * A change feed: every added, changed or removed transaction gets a higher sequence number, so a Mod that keeps
   * the returned cursor sees each change once and can upsert by transaction ID.
   */
  async transactions(
    modId: string | undefined,
    input: { connectionId: string; cursor?: string; limit?: number; accountId?: string },
  ): Promise<{ changes: BankTransactionChange[]; cursor: string; hasMore: boolean }> {
    await this.granted(modId, input.connectionId);
    const after = decodeCursor(input.connectionId, input.cursor);
    const limit = Math.min(input.limit ?? 200, 500);
    const rows = this.options.db
      .prepare(
        `SELECT seq, removed, value FROM bank_transactions WHERE connection_id=? AND seq>?
        ${input.accountId ? 'AND account_id=?' : ''} ORDER BY seq LIMIT ?`,
      )
      .all(
        ...([input.connectionId, after, ...(input.accountId ? [input.accountId] : []), limit + 1] as (
          string | number
        )[]),
      ) as { seq: number; removed: number; value: string }[];
    const page = rows.slice(0, limit);
    return {
      changes: page.map((row) => ({
        seq: Number(row.seq),
        removed: !!row.removed,
        transaction: JSON.parse(row.value) as BankTransaction,
      })),
      cursor: encodeCursor(input.connectionId, page.length ? Number(page.at(-1)!.seq) : after),
      hasMore: rows.length > limit,
    };
  }
  async liabilities(modId: string | undefined, connectionId: string): Promise<BankCreditLiability[]> {
    await this.granted(modId, connectionId);
    return (
      this.options.db
        .prepare('SELECT value FROM bank_liabilities WHERE connection_id=? ORDER BY account_id')
        .all(connectionId) as { value: string }[]
    ).map((row) => JSON.parse(row.value) as BankCreditLiability);
  }
}
