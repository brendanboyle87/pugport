export type MemoryEvidenceScores = { relevant: number; answers: number; contradicts: number; injection: number };
export type MemoryEvidenceDecision = {
  messageId: string;
  sourceOffset: number;
  /** SHA-256 of the exact original excerpt, before request truncation. */
  sourceHash?: string;
  status: 'context' | 'supported' | 'partial' | 'conflicting' | 'needs-current-check' | 'excluded';
  reason: string;
  scores?: MemoryEvidenceScores;
};
export type MemoryEvidenceReport = {
  /** 'jev' is retained for archived records; current evidence checks are local. */
  source: 'local' | 'jev';
  status: 'local' | 'accepted' | 'fallback' | 'empty';
  reason: string;
  assessedAt: string;
  elapsedMs: number;
  requestCount: number;
  cachedCount: number;
  usage: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null };
  decisions: MemoryEvidenceDecision[];
};
