import type { ConversationMessage, Workflow } from './types.ts';

const resumePrefix = /^(?:继续原任务：|继续同一任务。(?:保留的)?原始需求：\s*|继续同一蜂群任务：\s*)/u;

/** Old saved prompts may contain several wrappers. Recover the innermost request and all updates. */
export function parseTaskRequest(content: string): NonNullable<Workflow['continuation']> {
  let originalRequest = content;
  const supplements: string[] = [];
  for (let depth = 0; depth < 64; depth++) {
    const prefix = originalRequest.match(resumePrefix);
    if (!prefix) break;
    let body = originalRequest.slice(prefix[0].length);
    const swarm = prefix[0].startsWith('继续同一蜂群任务：');
    const footer = swarm ? '\n\n先检查已完成的产物和操作记录' : '已有步骤状态：';
    const states = body.lastIndexOf(footer);
    if (states >= 0) body = body.slice(0, states).trimEnd();
    if (swarm) {
      originalRequest = body;
      continue;
    }
    const update = Math.max(body.lastIndexOf('\n\n当前补充（'), body.lastIndexOf('\n\n用户补充（'));
    if (update >= 0) {
      const start = body.indexOf('：\n', update);
      if (start >= 0) {
        const text = body
          .slice(start + 2)
          .split('\n\n先核对已有产物和工具记录')[0]!
          .trim();
        if (text && text !== '无') supplements.unshift(text);
      }
      body = body.slice(0, update).trimEnd();
    }
    originalRequest = body;
  }
  return { originalRequest, supplements };
}

export function taskRequest(workflow: Workflow): NonNullable<Workflow['continuation']> {
  return workflow.continuation ? structuredClone(workflow.continuation) : parseTaskRequest(workflow.input.content);
}

/** Normalize legacy user bubbles only at the display boundary; never rewrite saved history. */
export function resumedMessage(message: ConversationMessage): ConversationMessage {
  if (message.role !== 'user') return message;
  if (message.resumed) return message.systemNotice ? { ...message, systemNotice: undefined } : message;
  if (!resumePrefix.test(message.content)) return message;
  return {
    ...message,
    resumed: true,
    systemNotice: undefined,
    content: parseTaskRequest(message.content).supplements.join('\n\n'),
  };
}
