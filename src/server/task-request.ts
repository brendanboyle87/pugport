import type { Workflow } from '../shared/types.ts';
export { taskRequest } from '../shared/task-request.ts';

export function continuationPrompt(request: NonNullable<Workflow['continuation']>, context: string): string {
  return `继续同一任务。保留的原始需求：\n${request.originalRequest}\n\n用户补充（按时间先后，最新修正优先；保留范围限制和撤销要求）：\n${request.supplements.join('\n\n') || '无'}\n\n已有步骤状态：\n${context}\n先核对已有产物和操作回执，只完成当前仍授权的剩余工作。已完成及未确认的操作都不得直接重放。`;
}
