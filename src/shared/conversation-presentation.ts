import type { ActivityCategory } from './activity-vocabulary.ts';
import type { TrajectoryRow } from './trajectory.ts';

/**
 * What a task says from taking its project until its first run starts. The conversation tail already names
 * that stage, so the presentation does not repeat it as a waiting reason.
 */
export const projectStartNotice = '已取得项目执行权，准备启动。';

export type PresentationItem = {
  key: string;
  kind: 'narration' | 'activity-group' | 'reasoning' | 'handoff' | 'member' | 'question' | 'final-answer';
  runId?: string;
  preview?: string;
  text?: string;
  calls?: { key: string; category: ActivityCategory }[];
  tools?: TrajectoryRow[];
  live?: { key: string; category: ActivityCategory; detail: string };
  target?: string;
  reason?: string;
  status?: string;
  options?: string[];
};
export type ConversationPresentation = {
  /** Only the display was limited; durable audit records are unchanged. */
  detailLimited?: boolean;
  revision?: string;
  tasks?: import('./task-list.ts').TaskListItem[];
  background?: BackgroundWork[];
  version: 1;
  workflowId: string;
  needsDetail: boolean;
  items: PresentationItem[];
  /** Before any run starts: why the task is still waiting (reading a video, queued for capacity...). */
  waiting?: string;
};
export type BackgroundWork = {
  key: string;
  title: string;
  kind: string;
  status: 'running' | 'completed' | 'failed';
  startedAt?: string;
  endedAt?: string;
  exitCode?: number;
  tail: string;
  output?: string;
  runId?: string;
  workflowId?: string;
  conversationId?: string;
};
