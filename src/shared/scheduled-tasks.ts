import type { Workflow } from './types.ts';

export type RoutineSchedule =
  | { type: 'daily' | 'weekdays'; time: string }
  | { type: 'weekly'; time: string; weekday: number }
  | { type: 'interval'; hours: number };
export type RoutineInput = {
  name: string;
  prompt: string;
  schedule: RoutineSchedule;
  permissionMode: 'read-only' | 'workspace-write';
  projectPath?: string;
  executor?: string;
  model?: string;
  effort?: string;
};
export type RoutineRun = {
  at: string;
  workflowId: string;
  conversationId?: string;
  status: Workflow['status'] | 'starting';
  reason?: string;
};
export type Routine = RoutineInput & {
  id: string;
  enabled: boolean;
  createdAt: string;
  lastRunAt?: string;
  projectId?: string;
  lastConversationId?: string;
  lastConversationDate?: string;
  nextRunAt: string;
  history: RoutineRun[];
};
