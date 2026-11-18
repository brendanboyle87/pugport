/** Workspace connectors stay dormant until OAuth setup is ready for users. */
export const connectorsEnabled = false;

export type ConnectorProvider = 'google' | 'microsoft';
export const connectorCapabilities = [
  'mail_read',
  'mail_draft',
  'mail_manage',
  'files_read',
  'files_write',
  'documents_write',
  'sheets_read',
  'sheets_write',
  'slides_read',
  'slides_write',
  'calendar_read',
  'calendar_write',
  'tasks_read',
  'tasks_write',
  'contacts_read',
  'contacts_write',
] as const;
export type ConnectorCapability = (typeof connectorCapabilities)[number];

export interface ConnectorAccount {
  id: string;
  provider: ConnectorProvider;
  alias: string;
  email: string;
  displayName: string;
  capabilities: ConnectorCapability[];
  status: 'connected' | 'reauth_required';
  enabled: boolean;
  connectedAt: string;
  /** Changes only on successful OAuth callbacks, including callbacks completed in the same millisecond. */
  authorizationRevision?: string;
  updatedAt: string;
}

export interface ConnectorProviderConfigView {
  provider: ConnectorProvider;
  configured: boolean;
  clientId: string;
  hasClientSecret: boolean;
  tenant: string;
  redirectUri: string;
}

export interface ConnectorProviderConfigInput {
  clientId: string;
  /** An empty string removes the saved secret; omission retains it. Never returned in views. */
  clientSecret?: string;
  tenant?: string;
}

export interface ConnectorConnectInput {
  provider: ConnectorProvider;
  alias: string;
  capabilities: ConnectorCapability[];
  accountId?: string;
}

export interface ConnectorTool {
  name: string;
  description: string;
  readOnly: boolean;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: false;
    anyOf?: { required: string[] }[];
  };
}

export const connectorProviders: ConnectorProvider[] = ['google', 'microsoft'];
