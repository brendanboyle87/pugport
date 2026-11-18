export const TASK_JUDGMENT_CONTRACT_VERSION = 'comborunner-task-judgment-v1' as const;
export type TaskIntent = 'question' | 'action' | 'uncertain';
export type JudgmentKind = 'routine' | 'general' | 'design' | 'architecture';
export type TaskComplexity = 'simple' | 'standard' | 'complex';
export type TaskContent = 'standard' | 'adult';
export type TaskJudgmentReason =
  | 'accepted'
  | 'disabled'
  | 'not_recorded'
  | 'confirmation-mode'
  | 'manual-selection'
  | 'bounded-lookup'
  | 'self-contained-chat'
  | 'gateway-routing'
  | 'in-progress'
  | 'cancelled'
  | 'not-configured'
  | 'empty-input'
  | 'input-too-long'
  | 'credential-unavailable'
  | 'authentication-rejected'
  | 'payment-required'
  | 'access-forbidden'
  | 'rate-limited'
  | 'http-error'
  | 'network-error'
  | 'timeout'
  | 'response-too-large'
  | 'invalid-response'
  | 'low-confidence'
  | 'uncertain-intent';

export type JudgmentConfidence = {
  /** Provider-reported confidence; this is not a measured success rate. */
  value: number;
  /** Probability assigned to the provider's chosen option. */
  support: number;
  /** Chosen option probability minus the strongest alternative. */
  margin: number;
  probabilities: Record<string, number>;
};
export type JudgmentUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  costUsd: null;
};
export type TaskJudgment = {
  contractVersion: typeof TASK_JUDGMENT_CONTRACT_VERSION;
  inputHash: string;
  status: 'accepted' | 'fallback' | 'skipped';
  /** Jev supplies tier advice only; it never grants permissions. */
  source: 'jev' | 'local';
  suggestedTier?: 'light' | 'standard' | 'strong';
  intent?: TaskIntent;
  kind?: JudgmentKind;
  complexity?: TaskComplexity;
  /** Adult content is routed to a platform that accepts it. */
  content?: TaskContent;
  confidence: {
    intent: JudgmentConfidence | null;
    kind: JudgmentConfidence | null;
    complexity: JudgmentConfidence | null;
    content?: JudgmentConfidence | null;
  };
  observedAt: string;
  latencyMs: number;
  reason: TaskJudgmentReason;
  usage: JudgmentUsage;
  requestAttempted: boolean;
};
export type JudgmentUsageReport = {
  calls: number;
  attemptedCalls: number;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  costUsd: null;
  byProject: Array<{
    projectId: string;
    calls: number;
    attemptedCalls: number;
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    costUsd: null;
  }>;
};
