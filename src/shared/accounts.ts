import type { Provider, RuntimeSnapshot } from './types.ts';

/** PugPort's own labels for the CLIs it finds on this computer: interface text, unlike labels the user gives. */
export const defaultAccountLabels = {
  codex: 'Codex · 本机',
  claude: 'Claude · 本机',
  grok: 'Grok · 本机',
  cursor: 'Cursor · 本机',
} as const;

export type AccountRequestFailure = {
  runId: string;
  model?: string;
  at: string;
  source: 'Grok Build ACP';
  statusCode: 402;
  errorCode: 'quota-or-rate-limit';
  /** Fixed sanitized diagnostic, never the provider's raw response. */
  message: string;
  /** A later run on the same account completed; the 402 is no longer its latest request outcome. */
  laterSuccessAt?: string;
};
export type AccountAvailability = {
  reason: 'quota' | 'authentication';
  observedAt: string;
  retryAt?: string;
  billingFailure?: AccountRequestFailure;
};
export type NativeAccountView = {
  runtimeId: string;
  id: string;
  label: string;
  provider: Provider;
  home: string;
  enabled: boolean;
  managed: boolean;
  subscription?: RuntimeSnapshot['subscription'];
  status: RuntimeSnapshot['status'];
  modelCount: number;
  quota: RuntimeSnapshot['quota'];
  availability?: AccountAvailability;
  /** Last actual request failure, retained after the dispatch cooldown expires. */
  lastRequestFailure?: AccountRequestFailure;
  lastConnectionTest?: RuntimeSnapshot['lastConnectionTest'];
  loginPending?: boolean;
  inUse: boolean;
  duplicateOf?: string;
  identityKnown: boolean;
};
export type NativeAccountsState = {
  accounts: NativeAccountView[];
  providers: Array<{ id: string; supported: boolean; reason?: string }>;
};
