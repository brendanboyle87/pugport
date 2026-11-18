import type { SyncStatus } from './account-sync.ts';

/** Public account state. Secrets must never be added to this contract. */
export type AccountAuthState = {
  phase: 'signed-out' | 'signing-in' | 'signed-in';
  email?: string;
  memoryOnly?: boolean;
  error?: string;
};
export type AccountCounts = { chats: number; folders: number; projects: number; memories: number };
export type AccountDevice = {
  id: string;
  name: string;
  platform: string;
  last_seen_at?: string;
  cli_providers: string[];
};
export type AccountView = {
  configured: boolean;
  /** Nonsecret identity of this sign-in; protects confirmations held by another window. */
  sessionId?: string;
  auth: AccountAuthState;
  sync: SyncStatus;
  lastSyncedAt?: string;
  firstPullComplete?: boolean;
  deviceName?: string;
  devices: AccountDevice[];
  missingProviders: string[];
  setup: 'none' | 'loading' | 'upgrading' | 'waiting-upgrade' | 'merge' | 'ready';
  merge?: { local: AccountCounts; cloud: AccountCounts; accountChange: boolean };
  error?: string;
};
export type AccountSession = { userId: string; email: string; accessToken: string; expiresAt: number };
/** These messages travel only on the existing Node parent/child IPC channel. */
export type AccountMainMessage =
  | { type: 'account-session'; session: AccountSession }
  | { type: 'account-clear' }
  | { type: 'account-key'; userId: string; key: string; keyId: string }
  | { type: 'account-auth'; auth: AccountAuthState }
  | { type: 'account-active'; active: boolean };
export type AccountBackendMessage =
  | { type: 'account-action'; action: 'sign-in' | 'cancel' | 'sign-out' | 'refresh' }
  | { type: 'account-persist-key'; userId: string; key?: string; keyId?: string };
