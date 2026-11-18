import type { z } from 'zod';
import type { ConnectorCapability, ConnectorProvider } from '../shared/connectors.ts';

/** API paths are relative to a provider allowlist, never arbitrary URLs from model output. */
export type OfficeApi = (path: string, init?: RequestInit, format?: 'json' | 'text' | 'bytes') => Promise<any>;
export interface OfficeOperation {
  name: string;
  provider: ConnectorProvider;
  capability: ConnectorCapability;
  readOnly: boolean;
  description: string;
  /** Strict parameter schema; accountId/accountAlias are handled separately by ConnectorService. */
  schema: z.ZodObject<any>;
  run: (args: any, api: OfficeApi) => Promise<unknown>;
}
