export type ManualResetNote = {
  id: string;
  kind?: 'reset' | 'cloud-credit' | 'subscription-credit' | 'subscription-usage';
  creditPool?: 'event' | 'account';
  expiryPrecision?: 'exact' | 'date' | 'estimated' | 'unknown';
  source?: string;
  observedAt?: string;
  /** Assigned by the server from a verified CLI identity, never supplied by a form. */
  accountFingerprint?: string | null;
  provider?: 'cursor';
  /** Computed when reading local notes; never persisted as account verification. */
  identityStatus?: 'matched' | 'unverified' | 'different';
  subscriptionUsage?: {
    cycleResetsOn: string | null;
    cycleResetsAt: string | null;
    cycleResetPrecision: 'exact' | 'date' | 'estimated' | 'unknown';
    onDemandEnabled: boolean | null;
    pools: Array<{ id: 'cursor-models' | 'other-models'; usedPercent: number | null }>;
  };
  remainingUsd?: number | null;
  totalUsd?: number | null;
  expiresAt?: string | null;
  label: string;
  count: number | null;
  expiresOn: string | null;
  status: 'available' | 'used' | 'expired' | 'unknown';
  note: string;
  updatedAt: string;
};
