// Plaid API references (reviewed 2026-10-30):
// https://plaid.com/docs/api/ (base URLs, error envelope)
// https://plaid.com/docs/link/hosted-link/ (hosted_link, /link/token/get results without webhooks)
// https://plaid.com/docs/link/update-mode/ (access_token instead of products)
// https://plaid.com/docs/api/products/transactions/ (/transactions/sync, restart on mutation)
// https://plaid.com/docs/api/products/liabilities/ (credit fields, all nullable; Canada coverage limited)
// https://plaid.com/docs/api/accounts/ (/accounts/get is free and cached; /accounts/balance/get is billed)
export type PlaidEnvironment = 'sandbox' | 'production';
export const plaidBaseUrls: Record<PlaidEnvironment, string> = {
  sandbox: 'https://sandbox.plaid.com',
  production: 'https://production.plaid.com',
};
export type PlaidCredentials = { clientId: string; secret: string; environment: PlaidEnvironment };

export class PlaidError extends Error {
  constructor(
    readonly code: string,
    readonly type: string,
    message: string,
    readonly status = 0,
  ) {
    super(message);
  }
  /** The user has to sign in to the bank again through Link update mode. */
  get needsReauth() {
    return ['ITEM_LOGIN_REQUIRED', 'PENDING_EXPIRATION', 'PENDING_DISCONNECT', 'ACCESS_NOT_GRANTED'].includes(
      this.code,
    );
  }
  /** Plaid's credentials were rejected: no retry helps until the user fixes them in Settings. */
  get badKeys() {
    return ['INVALID_API_KEYS', 'INVALID_CLIENT_ID', 'INVALID_SECRET'].includes(this.code);
  }
}

/** One Plaid call. Credentials are added here and never leave the server; responses are untrusted input. */
export async function plaidCall<T>(
  credentials: PlaidCredentials,
  path: string,
  body: Record<string, unknown>,
  options: { fetch?: typeof fetch; baseUrl?: string; timeoutMs?: number } = {},
): Promise<T> {
  const url = `${options.baseUrl ?? plaidBaseUrls[credentials.environment]}${path}`;
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: credentials.clientId, secret: credentials.secret, ...body }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
      redirect: 'error',
    });
  } catch {
    throw new PlaidError('NETWORK_ERROR', 'NETWORK', 'Plaid could not be reached.');
  }
  const text = await response.text();
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* Handled below. */
  }
  if (!response.ok || typeof data.error_code === 'string') {
    const code = typeof data.error_code === 'string' ? data.error_code : `HTTP_${response.status}`;
    const message =
      typeof data.display_message === 'string' && data.display_message
        ? data.display_message
        : typeof data.error_message === 'string'
          ? data.error_message
          : 'Plaid request failed.';
    throw new PlaidError(
      code,
      typeof data.error_type === 'string' ? data.error_type : 'API_ERROR',
      message.slice(0, 500),
      response.status,
    );
  }
  return data as T;
}

export type PlaidAccount = {
  account_id: string;
  name: string;
  official_name?: string | null;
  mask?: string | null;
  type: string;
  subtype?: string | null;
  balances: {
    current?: number | null;
    available?: number | null;
    limit?: number | null;
    iso_currency_code?: string | null;
    unofficial_currency_code?: string | null;
    last_updated_datetime?: string | null;
  };
};
export type PlaidTransaction = {
  transaction_id: string;
  account_id: string;
  date: string;
  authorized_date?: string | null;
  name: string;
  merchant_name?: string | null;
  amount: number;
  iso_currency_code?: string | null;
  unofficial_currency_code?: string | null;
  pending: boolean;
  pending_transaction_id?: string | null;
  personal_finance_category?: { primary?: string; detailed?: string } | null;
};
export type PlaidSyncPage = {
  added: PlaidTransaction[];
  modified: PlaidTransaction[];
  removed: { transaction_id: string; account_id?: string }[];
  next_cursor: string;
  has_more: boolean;
};
export type PlaidCredit = {
  account_id: string | null;
  aprs?: { apr_type: string; apr_percentage: number }[] | null;
  is_overdue?: boolean | null;
  last_payment_amount?: number | null;
  last_payment_date?: string | null;
  last_statement_issue_date?: string | null;
  last_statement_balance?: number | null;
  minimum_payment_amount?: number | null;
  next_payment_due_date?: string | null;
};
export type PlaidLinkTokenGet = {
  link_token: string;
  expiration?: string;
  link_sessions?: {
    link_session_id: string;
    started_at?: string;
    finished_at?: string | null;
    exit?: { error?: { error_code?: string } | null; status?: string | null } | null;
    on_success?: { public_token?: string } | null;
    results?: {
      item_add_results?: { public_token: string; institution?: { institution_id?: string; name?: string } | null }[];
    } | null;
  }[];
};
