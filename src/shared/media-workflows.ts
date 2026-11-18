import { z } from 'zod';

/** Portable recipes contain parameters, never folders, credentials, commands or permissions. */
export const mediaWorkflowSteps = [
  'scan-local',
  'hash-exact',
  'retrieve-candidates',
  'verify-local',
  'report',
] as const;
export const mediaWorkflowParameters = z
  .object({
    engine: z.enum(['auto', 'gemma', 'legacy']),
    kind: z.enum(['all', 'images', 'videos']),
    maxFiles: z.number().int().min(1).max(20_000),
    topK: z.number().int().min(1).max(20),
    videoSampleSeconds: z.number().min(5).max(120),
    retrievalMode: z.enum(['adaptive', 'full-index']).optional(),
    ioConcurrency: z.number().int().min(1).max(8).optional(),
  })
  .strict();

const displayText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((text) => !/[\u0000-\u001f\u007f]/.test(text));
export const mediaWorkflowSchema = z
  .object({
    schemaVersion: z.literal(1),
    type: z.literal('pugport-media-workflow'),
    name: displayText(80),
    description: displayText(600),
    author: displayText(100),
    license: displayText(100),
    steps: z.tuple([
      z.literal('scan-local'),
      z.literal('hash-exact'),
      z.literal('retrieve-candidates'),
      z.literal('verify-local'),
      z.literal('report'),
    ]),
    parameters: mediaWorkflowParameters,
  })
  .strict();
export type MediaWorkflow = z.infer<typeof mediaWorkflowSchema>;
export type MediaWorkflowParameters = z.infer<typeof mediaWorkflowParameters>;
export type MediaWorkflowEntry = {
  id: string;
  builtin: boolean;
  workflow: MediaWorkflow;
  source: string;
  updatedAt: string;
};
export type MediaWorkflowPreview = {
  token: string;
  workflow: MediaWorkflow;
  source: string;
  expiresAt: string;
};

const base = {
  schemaVersion: 1 as const,
  type: 'pugport-media-workflow' as const,
  author: 'PugPort',
  license: 'MIT',
  steps: [...mediaWorkflowSteps],
};
export const builtinMediaWorkflows: MediaWorkflowEntry[] = [
  {
    id: 'builtin-gemma-fast',
    builtin: true,
    source: 'PugPort',
    updatedAt: '2026-10-07T00:00:00.000Z',
    workflow: mediaWorkflowSchema.parse({
      ...base,
      name: '快速筛选与本地核验',
      description:
        '先并行计算本地画面指纹，筛选疑似组合，再由固定程序核验。无需模型。快速预筛可能漏掉极短、裁剪或变速片段。',
      parameters: {
        engine: 'legacy',
        kind: 'all',
        maxFiles: 20_000,
        topK: 4,
        videoSampleSeconds: 30,
        retrievalMode: 'adaptive',
        ioConcurrency: 4,
      },
    }),
  },
  {
    id: 'builtin-legacy-backup',
    builtin: true,
    source: 'PugPort',
    updatedAt: '2026-10-07T00:00:00.000Z',
    workflow: mediaWorkflowSchema.parse({
      ...base,
      name: '原有流程备份',
      description: '沿用文件哈希和画面指纹查找与核验，适合模型不可用时继续分析。视频候选主要覆盖时长相近的版本。',
      parameters: { engine: 'legacy', kind: 'all', maxFiles: 20_000, topK: 8, videoSampleSeconds: 30 },
    }),
  },
];

export const mediaWorkflowStepLabels: Record<(typeof mediaWorkflowSteps)[number], string> = {
  'scan-local': '列出所选目录的文件',
  'hash-exact': '快速核对完全相同的文件',
  'retrieve-candidates': '查找少量相似候选',
  'verify-local': '本地程序核验候选',
  report: '输出匹配证据与清单',
};

export function parseMediaWorkflow(text: string): MediaWorkflow {
  if (new TextEncoder().encode(text).length > 64 * 1024) throw new Error('流程文件不能超过 64 KB。');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('流程文件必须是有效的 JSON。');
  }
  const result = mediaWorkflowSchema.safeParse(value);
  if (!result.success)
    throw new Error('流程格式不兼容：只接受版本 1 的本地媒体分析参数，不允许脚本、路径、删除步骤或额外字段。');
  return result.data;
}
