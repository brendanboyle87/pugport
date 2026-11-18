import { z } from 'zod';

/** Mod-owned storage, bank connections and statement import: the contracts shared by host, server and frame. */
export const MOD_STORAGE_QUOTA_BYTES = 200 * 1024 * 1024;
export const MOD_STORAGE_VALUE_MAX = 64 * 1024;
export const MOD_STORAGE_BATCH_MAX = 500;
export const MOD_STORAGE_LIST_MAX = 500;
export const modStorageCollectionSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/);
export const modStorageKeySchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^\u0000-\u001f]+$/);
const cursor = z.string().min(1).max(600);
const keys = z.array(modStorageKeySchema).min(1).max(MOD_STORAGE_BATCH_MAX);
export type ModStorageItem = { key: string; value: string; updatedAt: string };

const connectionId = z.string().regex(/^conn_[a-z0-9]{8,40}$/);
const accountId = z.string().min(1).max(200);
/** Frame method → its arguments. The host adds the binding; the frame never names a Mod or a chat. */
export const modDataMethodSchemas = {
  'storage.get': z.object({ collection: modStorageCollectionSchema, keys }).strict(),
  'storage.put': z
    .object({
      collection: modStorageCollectionSchema,
      items: z
        .array(z.object({ key: modStorageKeySchema, value: z.string().max(MOD_STORAGE_VALUE_MAX) }).strict())
        .min(1)
        .max(MOD_STORAGE_BATCH_MAX),
    })
    .strict(),
  'storage.delete': z.object({ collection: modStorageCollectionSchema, keys }).strict(),
  'storage.list': z
    .object({
      collection: modStorageCollectionSchema,
      prefix: z.string().max(200).optional(),
      cursor: cursor.optional(),
      limit: z.number().int().min(1).max(MOD_STORAGE_LIST_MAX).optional(),
    })
    .strict(),
  'storage.usage': z.object({}).strict(),
  'connections.list': z.object({}).strict(),
  'connections.status': z.object({ connectionId }).strict(),
  'connections.authorize': z.object({ provider: z.literal('plaid') }).strict(),
  'connections.reconnect': z.object({ connectionId }).strict(),
  'connections.sync': z.object({ connectionId }).strict(),
  'connections.accounts': z.object({ connectionId }).strict(),
  'connections.transactions': z
    .object({
      connectionId,
      cursor: cursor.optional(),
      limit: z.number().int().min(1).max(500).optional(),
      accountId: accountId.optional(),
    })
    .strict(),
  'connections.liabilities': z.object({ connectionId }).strict(),
  'files.pick': z
    .object({
      accept: z
        .array(z.enum(['.csv', '.txt', '.ofx', '.qfx', '.qif', '.json', '.pdf']))
        .min(1)
        .max(7),
    })
    .strict(),
  'files.readText': z
    .object({
      fileId: z.string().max(100),
      offset: z.number().int().nonnegative().optional(),
    })
    .strict(),
  'files.pdfText': z
    .object({
      fileId: z.string().max(100),
      fromPage: z.number().int().positive().optional(),
    })
    .strict(),
} as const;
export type ModDataMethod = keyof typeof modDataMethodSchemas;
/** Which declared permission each method needs. */
export const modDataPermission = (method: ModDataMethod) =>
  method.startsWith('storage.')
    ? 'data:store'
    : method.startsWith('connections.')
      ? 'connections:read'
      : 'files:import';
/** Methods the server answers; file picking and reading stay in the host window. */
export const modDataServerMethods = new Set<ModDataMethod>(
  (Object.keys(modDataMethodSchemas) as ModDataMethod[]).filter((method) => !method.startsWith('files.')),
);
export const modDataRequestSchema = z
  .object({ instanceId: z.string().min(1).max(200), method: z.string().max(40), params: z.unknown() })
  .strict();

export const modDataBackupSchema = z
  .object({
    format: z.literal('pugport-mod-data'),
    version: z.literal(1),
    modId: z.string().max(80),
    exportedAt: z.string().max(40),
    items: z
      .array(
        z
          .object({
            collection: modStorageCollectionSchema,
            key: modStorageKeySchema,
            value: z.string().max(MOD_STORAGE_VALUE_MAX),
            updatedAt: z.string().max(40),
          })
          .strict(),
      )
      .max(2_000_000),
  })
  .strict();
export type ModDataBackup = z.infer<typeof modDataBackupSchema>;

/** What a Mod sees of a connection: no tokens, item IDs or keys. */
export type BankConnectionStatus = 'connected' | 'syncing' | 'reauth_required' | 'error' | 'disconnected';
export type BankConnectionView = {
  id: string;
  provider: 'plaid';
  environment: 'sandbox' | 'production';
  institution?: { id: string; name: string };
  status: BankConnectionStatus;
  /** Time the last successful sync finished; older data is kept when a later sync fails. */
  lastSyncedAt?: string;
  lastAttemptAt?: string;
  nextSyncAt?: string;
  error?: { code: string; message: string };
  products: string[];
};
export type BankAccount = {
  id: string;
  name: string;
  officialName?: string;
  mask?: string;
  type: string;
  subtype?: string;
  currency?: string;
  balances: { current?: number; available?: number; limit?: number; asOf?: string };
};
export type BankTransaction = {
  id: string;
  accountId: string;
  date: string;
  authorizedDate?: string;
  name: string;
  merchantName?: string;
  /** Plaid's sign: positive is money out of the account (a purchase on a card), negative is money in. */
  amount: number;
  currency?: string;
  pending: boolean;
  category?: string;
};
/** A change-feed entry: `removed` means the institution withdrew the transaction. */
export type BankTransactionChange = { seq: number; removed: boolean; transaction: BankTransaction | { id: string } };
/** Credit-card liabilities. A field Plaid does not report stays absent; nothing is inferred. */
export type BankCreditLiability = {
  accountId: string;
  lastStatementIssueDate?: string;
  lastStatementBalance?: number;
  minimumPaymentAmount?: number;
  nextPaymentDueDate?: string;
  lastPaymentAmount?: number;
  lastPaymentDate?: string;
  isOverdue?: boolean;
  aprs: { type: string; percentage: number }[];
};
export type PlaidSettingsView = {
  configured: boolean;
  environment: 'sandbox' | 'production';
  clientIdEnding?: string;
  sandboxSecret: boolean;
  productionSecret: boolean;
};
/** A Plaid Link session the host polls; `url` is Plaid's own page and only shown while waiting. */
export type LinkSessionView = {
  id: string;
  status: 'waiting' | 'connected' | 'cancelled' | 'failed' | 'expired';
  url?: string;
  connectionId?: string;
  institution?: string;
  error?: string;
};
export type ModPdfText = {
  pageCount: number;
  pages: { page: number; text: string }[];
  /** Present when the text did not fit one reply: call again from this page. */
  nextPage?: number;
};
