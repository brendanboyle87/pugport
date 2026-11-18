export type LayaSettings = {
  mode?: 'cloud' | 'local' | 'jev' | 'rules';
  shareTraining?: boolean;
  /** Legacy local worker preference; mode now selects the judgment provider. */
  enabled?: boolean;
  recordTraining?: boolean;
  pythonPath?: string;
  checkpointPath?: string;
};

export function layaSharesTraining(settings: LayaSettings | undefined, region?: 'eu' | 'other'): boolean {
  return (settings?.mode ?? 'cloud') === 'cloud' && (settings?.shareTraining ?? region === 'other');
}

export type LayaState = {
  message: string;
  recent_context: string;
  reference_text: string;
  attachments: Array<{ kind: string; name: string; mime_type?: string }>;
  candidate_executors: string[];
};

export type LayaChoices = {
  task_type:
    | 'conversation'
    | 'coding'
    | 'research'
    | 'writing'
    | 'translation'
    | 'data_analysis'
    | 'media'
    | 'automation'
    | 'mixed'
    | 'unclear';
  difficulty: 'simple' | 'standard' | 'complex' | 'unclear';
  web_search: 'yes' | 'no' | 'unclear';
  input_modality: 'text' | 'image' | 'audio' | 'video' | 'mixed' | 'unclear';
  document_read: 'yes' | 'no' | 'unclear';
  media_output:
    | 'none'
    | 'image_create'
    | 'image_edit'
    | 'speech'
    | 'music'
    | 'video_generate'
    | 'video_render'
    | 'mixed'
    | 'unclear';
  project_access: 'none' | 'read' | 'write' | 'unclear';
  run_commands: 'yes' | 'no' | 'unclear';
  browser_use: 'yes' | 'no' | 'unclear';
  executor_intent: 'none' | 'assign' | 'exclude' | 'reassign' | 'mention_only' | 'unclear';
};

export type LayaInference = {
  status: 'ok' | 'fallback' | 'skipped';
  reason: string;
  modelVersion: 'pugport-laya-v4';
  modelSha256?: string;
  device?: string;
  latencyMs: number;
  choices?: LayaChoices;
  raw?: Record<string, unknown>;
};

export type LayaStatus = {
  state: 'disabled' | 'starting' | 'ready' | 'error';
  modelVersion: 'pugport-laya-v4';
  device?: string;
  reason?: string;
  lastLatencyMs?: number;
  region?: 'eu' | 'other';
};

export type LayaPolicy = {
  applied: boolean;
  reasons: string[];
  conflicts: string[];
  runtimeId?: string;
  excludeRuntimeIds: string[];
  permissionMode?: 'read-only';
  prohibitCommands?: boolean;
  suggestedTier?: 'light' | 'standard' | 'strong';
  suggestedEffort?: 'low' | 'medium' | 'high';
  /** Classification saw a compacted input; start cautiously and assess without blocking the reply. */
  needsAssessment?: boolean;
  category?: { id: string; confidence: 'high' | 'low'; reason: string };
};

export type LayaRouteAssessment = {
  status: 'running' | 'completed' | 'skipped' | 'failed';
  runId?: string;
  suggestedTier?: 'light' | 'standard' | 'strong';
  suggestedEffort?: 'low' | 'medium' | 'high';
  reason: string;
  /** When the assessment ended; a later step may follow its advice only after this. */
  completedAt?: string;
};

export type LayaReviewRecord = {
  id: string;
  workflowId: string;
  messageId?: string;
  origin?: 'user' | 'steering';
  projectId: string;
  conversationId: string;
  createdAt: string;
  question: string;
  state: LayaState;
  inference: LayaInference;
  policy: LayaPolicy;
  outcome?: {
    status: string;
    assessment?: LayaRouteAssessment;
    routes: Array<{
      runId: string;
      runtimeId?: string;
      model?: string;
      effort?: string;
      reason?: string;
      stepId?: string;
      startedAt?: string;
      /** The tier routing aimed at for this step. */
      targetTier?: 'light' | 'standard' | 'strong';
    }>;
  };
  training: {
    status: 'pending' | 'reviewed' | 'reserved' | 'used' | 'excluded';
    batchId?: string;
    modelVersion?: string;
    updatedAt: string;
  };
};
