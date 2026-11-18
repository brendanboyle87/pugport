export const sandboxProviders = ['codex', 'claude', 'grok', 'cursor', 'gemini', 'pi'] as const;
export type SandboxProvider = (typeof sandboxProviders)[number];
export type SandboxMode = 'off' | 'learn' | 'enforce';
export const learningProviders = ['pi', 'claude', 'grok', 'cursor'] as const;
export type LearningProvider = (typeof learningProviders)[number];
export type LearningAccess = {
  id: string;
  resource: string;
  resourceType: 'file' | 'network' | 'other';
  accessType: string;
};
export type LearningGroup = { label: string; read: number; write: number; execute: number; entries: LearningAccess[] };
export type LearningResult = {
  provider: LearningProvider;
  observedAt: string;
  entries: LearningAccess[];
  groups: LearningGroup[];
  truncated: boolean;
};
export type LearningFailureHealth = {
  consecutiveFailures: number;
  autoDisabled: boolean;
  reason: string;
  code?: string;
};
export type LearningFailures = Partial<Record<LearningProvider, LearningFailureHealth>>;
export type SandboxStatus = {
  /** Sanitized helper error code/HRESULT only; never raw diagnostics. */
  diagnostic?: string;
  available: boolean;
  reason: 'checking' | 'platform' | 'build' | 'node' | 'sdk-missing' | 'probe-failed' | 'tier' | 'ready';
  message: string;
  build?: string;
  requiredBuild?: string;
  nodeVersion?: string;
  sdkVersion?: string;
  captureDenialsStreamingSupported?: boolean;
  learningUnavailableReason?: string;
  tier?: string;
  denyPathsSupported?: boolean;
  learningFailures?: LearningFailures;
};

export function defaultSandboxModes(): Record<SandboxProvider, SandboxMode> {
  return { codex: 'off', claude: 'off', grok: 'off', cursor: 'off', gemini: 'off', pi: 'off' };
}
