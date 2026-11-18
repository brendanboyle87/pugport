import { z } from 'zod';
import type { RunRecord } from '../shared/types.ts';

const marker = 'COMBORUNNER_TASK_RESULT:';
export function taskOutcomeInstruction(kind: 'check' | 'deliver', tool = false): string {
  const scope =
    kind === 'check'
      ? `以本次当前步骤明确要求的范围和交付物判断结果，并结合原始目标理解上下文；不要把当前检查/复核步骤扩大为完成原始目标的所有后续修改。执行可以是检查、分析、生成或修改。
若本次只要求查看、复核、分析、生成内容或给出建议，实际完成这些工作并交付结果即可报告 completed，不需要修改文件。`
      : `以本次当前步骤明确要求的范围和交付物判断结果，并结合原始目标理解上下文。本步骤要实际产出交付物（代码、文件、数据、测试或报告）：只核对现状、阅读资料或制定计划不算完成，不能报告 completed。
`;
  return `${scope}不要为取得 completed 状态执行未被要求的写入、移动、删除或其他变更。
若当前步骤只需要回答、不要求修改文件，答案已经交付而只是部分信息无法核实，应报告 completed，并在答案中明确列出未核实的点；partial 用于本次要求的工作实际尚未做完，不用于已交付答案中的核实限制。
若本次明确要求实际写入、修改、移动或删除，而只给出计划、口头承诺或完成检查，仍是 partial 或 blocked，不能自行缩小请求范围。遇到权限、工具或路径问题，明确指出阻碍和已完成部分，不要声称受阻的所需操作已完成。
已授权任务应持续处理到完成。任务耗时较长、达到预计耗时或单个文件读取/解码出错，不是自行收尾的理由；先保存已完成批次和待处理清单，隔离坏文件，尝试其他已授权的读取方式并继续能完成的部分。不要重复已完成的移动、删除或外部操作；遇到原生权限拒绝，不重试被拒绝的操作或绕过限制。确实无法继续时，在 summary 中写明实际停止原因、还缺哪些工作，以及继续需要什么，不要只写“尚未完成”。
completed：本次要求的工作或答案已交付；答案中注明无法核实的细节仍算完成。
partial：本次要求的工作尚未做完，但无需用户介入即可继续。
blocked：没有用户的回答就无法继续；question 必须提出一个具体问题，封闭选择可带最多 4 个简短 options。
failed：无法按要求完成；说明原因。
dropped：无需处理（已经完成、无法复现或已被取代）；说明原因。
核对本次实际结果后，${tool ? '先交付答复，再以调用 report_outcome 一次作为最后动作（调用后直接结束，不要再写任何文字，也不要复述或总结答复），参数为：' : `最后单独写一行：${marker} `}{"status":"completed|partial|blocked|failed|dropped","summary":"实际结果或阻碍","claims":[{"claim":"做到的一项","evidence":"依据：跑过的测试或命令及结果、改了哪些文件、截图路径；没有就留空","verified":true|false,"files":["本次声称改动的相对文件路径"]}]}。status 只能选一个；blocked 必须带 question: {"text":"具体问题","options":["可选项"]}。files 仅用于本次声称已创建、修改、移动或删除的工作目录内文件；回答、调研和检查不填 files，每个路径都需要实际文件回执。claims 逐条列出你声称做到的事（最多 8 条），没有实际依据的不要编造依据。每条 claims 标注 "verified"：本次实际运行过测试、命令或检查核实的写 true；仅凭推理、未复核或部分核实的写 false。未标注按未验证对待，不要把未验证的写成 true。不要把此前记录中的状态当作本次执行结果。`;
}

/** A report describes the executor's outcome, not independent filesystem verification.
 * Only a final anchored marker is parsed. Ordinary prose/history stays untouched.
 */
export function parseTaskOutcome(output: string): { output: string; outcome: NonNullable<RunRecord['taskOutcome']> } {
  const at = output.lastIndexOf(marker);
  const unknown = { output, outcome: { status: 'unverified' as const, source: 'missing-report' as const } };
  if (at < 0 || (at > 0 && output[at - 1] !== '\n') || output.length - at > 8192) return unknown;
  const payload = output.slice(at + marker.length).trim();
  try {
    const value: unknown = JSON.parse(payload);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return unknown;
    const record = value as Record<string, unknown>;
    if (
      typeof record.status !== 'string' ||
      !['completed', 'partial', 'blocked', 'failed', 'dropped'].includes(record.status)
    )
      return unknown;
    return {
      output: output.slice(0, at).trimEnd(),
      outcome: {
        status: record.status as NonNullable<RunRecord['taskOutcome']>['status'],
        source: 'executor-report',
        ...(record.question !== undefined && outcomeQuestionSchema.safeParse(record.question).success
          ? { question: outcomeQuestionSchema.parse(record.question) }
          : {}),
        ...(typeof record.summary === 'string'
          ? {
              summary: redactOutcomeSummary(record.summary),
            }
          : {}),
        ...(Array.isArray(record.claims)
          ? {
              claims: (record.claims as unknown[])
                .flatMap((item) => {
                  const claim = item as { claim?: unknown; evidence?: unknown; verified?: unknown; files?: unknown };
                  if (typeof claim?.claim !== 'string' || !claim.claim.trim()) return [];
                  const evidence = typeof claim.evidence === 'string' ? claim.evidence.trim().slice(0, 300) : '';
                  return [
                    {
                      claim: claim.claim.trim().slice(0, 200),
                      ...(evidence ? { evidence } : {}),
                      ...(Array.isArray(claim.files)
                        ? {
                            files: claim.files
                              .filter((path): path is string => typeof path === 'string' && !!path.trim())
                              .map((path) => path.trim().slice(0, 2000))
                              .slice(0, 100),
                          }
                        : {}),
                      ...(typeof claim.verified === 'boolean' ? { verified: claim.verified } : {}),
                    },
                  ];
                })
                .slice(0, 12),
            }
          : {}),
      },
    };
  } catch {
    return unknown;
  }
}

export function redactOutcomeSummary(summary: string): string {
  return summary
    .replace(/\b(?:sk|pk|xai)-[\w-]{12,}/g, '[redacted]')
    .replace(/(bearer\s+)[\w.+/=-]+/gi, '$1[redacted]')
    .replace(/((?:api[_-]?key|token|password|secret)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .slice(0, 600);
}

const outcomeQuestionSchema = z
  .object({
    text: z.string().max(500).trim().min(1),
    options: z.array(z.string().max(80).trim().min(1)).max(4).optional(),
  })
  .strict();
const reportOutcomeSchema = z
  .object({
    status: z.enum(['completed', 'partial', 'blocked', 'failed', 'dropped']),
    summary: z.string().max(600).trim().min(1),
    question: outcomeQuestionSchema.optional(),
    claims: z
      .array(
        z
          .object({
            claim: z.string().trim().min(1).max(200),
            evidence: z.string().max(300).optional(),
            verified: z.boolean().optional(),
            files: z.array(z.string().trim().min(1).max(2000)).max(100).optional(),
          })
          .strict(),
      )
      .max(12)
      .optional(),
  })
  .strict()
  .refine((value) => value.status !== 'blocked' || !!value.question, {
    path: ['question'],
    message: 'blocked requires question.text: ask one concrete question',
  });

/** Reject invalid tool calls so the executor can correct them during the same turn. */
export function reportTaskOutcome(value: unknown): NonNullable<RunRecord['taskOutcome']> {
  const parsed = reportOutcomeSchema.safeParse(value);
  if (!parsed.success)
    throw new Error(
      `Invalid report_outcome: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
    );
  return { ...parsed.data, summary: redactOutcomeSummary(parsed.data.summary), source: 'executor-tool' };
}
