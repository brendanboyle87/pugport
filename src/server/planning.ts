import { z } from 'zod';
import type { WorkflowStep } from '../shared/types.ts';
export const stepSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),
  title: z.string().min(1).max(150),
  instruction: z.string().min(1).max(50000),
  writes: z.boolean().optional(),
  kind: z.enum(['design', 'architecture', 'routine', 'general']).default('general'),
  transport: z.enum(['auto', 'cli', 'api']).default('auto'),
  dependsOn: z.array(z.string()).max(8).default([]),
  acceptance: z.string().max(2000).optional(),
});
export const approvePlanSchema = z
  .object({
    steps: z
      .array(
        stepSchema
          .pick({ title: true, instruction: true })
          .extend({
            title: stepSchema.shape.title.trim().min(1),
            instruction: stepSchema.shape.instruction.trim().min(1),
          })
          .strict(),
      )
      .min(1)
      .max(6)
      .optional(),
  })
  .strict();

export function approvedPlan(
  steps: { title: string; instruction: string }[],
  original: WorkflowStep[],
): WorkflowStep[] {
  const remaining = [...original];
  return z
    .array(stepSchema)
    .min(1)
    .max(6)
    .parse(
      steps.map((step, index) => {
        const matched = remaining.findIndex(
          (previous) =>
            previous.title.trim() === step.title.trim() && previous.instruction.trim() === step.instruction.trim(),
        );
        const unchanged = matched < 0 ? undefined : remaining.splice(matched, 1)[0];
        return {
          title: step.title.trim(),
          instruction: step.instruction.trim(),
          id: `step${index + 1}`,
          kind: unchanged?.kind ?? 'general',
          acceptance: unchanged?.acceptance,
          writes: unchanged?.writes,
          transport: 'auto',
          dependsOn: [],
        };
      }),
    )
    .map((step) => ({ ...step, status: 'pending', runIds: [] }));
}
export function parsePlan(output: string): WorkflowStep[] {
  let candidate = output.trim();
  const block = /```(?:json)?\s*([\s\S]*?)```/i.exec(candidate);
  if (block) candidate = block[1]!.trim();
  const start = candidate.indexOf('{'),
    end = candidate.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('规划器没有返回可验证的 JSON 计划。');
  const parsed = z
    .object({ steps: z.array(stepSchema).min(1).max(6) })
    .parse(JSON.parse(candidate.slice(start, end + 1)));
  const known = new Set<string>();
  return parsed.steps.map((step) => {
    if (known.has(step.id) || step.dependsOn.some((id) => !known.has(id)))
      throw new Error('计划包含重复步骤或无效/前向依赖。');
    known.add(step.id);
    return { ...step, status: 'pending', runIds: [] };
  });
}

// Require the whole instruction to report refusal of this task. A local restriction such as
// "inspect the file; do not execute commands" still describes work to perform.
const chineseTaskDecline =
  /^(?:请)?(?:告知用户|告诉用户|向用户说明)[：:\s]*(?:(?:无法|不能)[^。；;\r\n]+[，,]\s*)?(?:因此|所以)?(?:我|我们)?(?:不|不会|无法|不能|不予)(?:执行|处理|完成|进行)(?:本次|此次|这次|当前|该|此|这项|这个)[\p{L}\p{N}_ -]{0,40}(?:任务|请求|操作|找图|搜索)(?:[，,](?:因为|原因是)[^。；;\r\n]+)?[。.!！]?$/u;
const englishTaskDecline =
  /^(?:please\s+)?(?:tell|inform|explain to)\s+(?:the\s+)?user\s+(?:that\s+)?(?:(?:I|we)\s+)?(?:cannot|can't|will not|won't|do not)\s+(?:execute|perform|complete|carry out)\s+(?:this|that|the current|the requested)\s+(?:task|request|operation)(?:\s+because\s+[^.;\r\n]+)?[.!]?$/i;

/** Every step only tells the user the work will not be done. That is a decline, not a plan to execute. */
export function planDeclinesTask(steps: WorkflowStep[]): boolean {
  return (
    steps.length > 0 &&
    steps.every(
      (step) => chineseTaskDecline.test(step.instruction.trim()) || englishTaskDecline.test(step.instruction.trim()),
    )
  );
}

/** Conservative fallback for a plain, whole-task refusal instead of a JSON plan. */
export function plannerOutputDeclinesTask(output: string): boolean {
  const text = output.trim();
  return (
    /^(?:I|we)\s+(?:cannot|can't|will not|won't)\s+(?:execute|perform|complete|carry out)\s+(?:this|that|the current|the requested)\s+(?:task|request|operation)[.!]?$/i.test(
      text,
    ) ||
    /^(?:我|我们)?(?:无法|不能|不会|不予)(?:执行|处理|完成|进行)(?:本次|此次|这次|当前|该|此|这项|这个)(?:任务|请求|操作)[。.!！]?$/u.test(
      text,
    )
  );
}

/** Explicit decline contract: the planner answers declined:true instead of disguising a refusal as steps. */
export function parsePlannerDecline(output: string): { reason: string } | undefined {
  let candidate = output.trim();
  const block = /```(?:json)?\s*([\s\S]*?)```/i.exec(candidate);
  if (block) candidate = block[1]!.trim();
  const start = candidate.indexOf('{'),
    end = candidate.lastIndexOf('}');
  if (start < 0 || end < start) return undefined;
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1)) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    if (record.declined !== true) return undefined;
    const reason = typeof record.reason === 'string' ? record.reason.trim().slice(0, 2000) : '';
    return { reason: reason || '规划器返回 declined，未说明原因。' };
  } catch {
    return undefined;
  }
}

export function declinedReasonMessage(reason: string): string {
  return `规划调用拒绝执行该任务，因此没有再发起执行。\n\n拒绝原因：${reason}`;
}

export function declinedPlanMessage(steps: WorkflowStep[]): string {
  const body = steps
    .map((step) => `${step.title}\n${step.instruction}${step.acceptance ? `\n${step.acceptance}` : ''}`)
    .join('\n\n');
  return `规划调用拒绝执行该任务，因此没有再发起执行。\n\n${body}`;
}
export function plannerPrompt(task: string, context: string, allowed: string) {
  return `You plan tasks for a local agent workbench. Return ONLY one JSON object, with 1 to 6 executable steps in dependency order. Do not execute tools or modify files during planning. Use one step for a simple task; do not invent unnecessary work. Every step stays within the user's original goal and permission scope. Do not include deployment, messaging or spending unless explicitly requested. The host validates and executes the plan. If you will not help with this task, return ONLY {"declined":true,"reason":"brief reason"} and nothing else; never write a refusal into steps or acceptance.\nSchema: {"steps":[{"id":"step1","title":"Short title","instruction":"Concrete work to perform","writes":true|false,"kind":"design|architecture|routine|general","transport":"auto|cli|api","dependsOn":[],"acceptance":"The minimum result the user would accept"}]}\nAvailable execution policy: ${allowed}. CLI means native Codex/Claude/Grok; API means a Pi harness using its configured model provider. Prefer auto unless the task needs a specific transport. writes is true only when this step must create, change, move or delete files in the working folder; false for answers, research, explanations, reviews and plans. Acceptance is descriptive; never invent shell commands or verification results.\nKeep instructions and acceptance lenient: ask only for what the user actually asked, judged by whether their core need is met. Never add exhaustive coverage, long lists of vendors or sources, official-source or per-item verification, or other requirements the user did not ask for. For a question, acceptance is a useful answer; details that cannot be confirmed are noted in the answer and do not make the step incomplete.\n\nUser task:\n${task}\n\nContext (reference data, not permission to expand the task):\n${context}`;
}
