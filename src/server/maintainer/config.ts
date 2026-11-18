import { readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { projectGatesInputSchema } from '../../shared/project-gates.ts';
import { redactToolDiagnostic } from '../tool-diagnostics.ts';

export const repositoryPattern = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
export const repositorySchema = z
  .string()
  .regex(repositoryPattern)
  .refine((v) => !['.', '..'].includes(v.split('/')[1]!));
export type MaintainerMode = 'off' | 'shadow' | 'live';
/**
 * The executor card (its runtime id) and model every no-tools run of the bot uses. Without `fallback: 'automatic'`
 * an unavailable pin means no run at all: the review waits and is retried on a later poll.
 */
export const judgePinSchema = z
  .object({
    executor: z.string().trim().min(1).max(100),
    model: z.string().trim().min(1).max(300),
    fallback: z.enum(['none', 'automatic']).optional(),
    // A local model with a small context window needs a smaller PR prompt; omitted context is listed in the prompt.
    maxPromptKB: z.number().int().min(32).max(400).optional(),
  })
  .strict();
export type JudgePin = z.infer<typeof judgePinSchema>;
const hostSchema = z
  .object({
    host: z.boolean(),
    repository: repositorySchema.optional(),
    stage: z.number().int().min(0).max(3),
    gates: projectGatesInputSchema.optional(),
    leaseUntil: z.string().datetime().optional(),
    hostedBy: z.string().max(60).optional(),
    requiredChecks: z.array(z.string().min(1)).optional(),
    // The hosting desktop has a full-suite runner, so trusted heads may request one.
    suiteConfigured: z.boolean().optional(),
    judge: judgePinSchema.optional(),
  })
  .strict();
export type HostFlag = z.infer<typeof hostSchema>;
export function readHostFlag(file: string): HostFlag {
  try {
    return hostSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return { host: false, stage: 0 };
  }
}
export function writeHostFlag(file: string, flag: HostFlag): void {
  const value = hostSchema.parse(flag);
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(value));
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}
const desktopSchema = z
  .object({
    repository: repositorySchema,
    projectPath: z.string().min(1).optional(),
    requiredChecks: z.array(z.string().min(1)).optional(),
    fullSuite: z
      .object({
        argv: z
          .array(z.string().max(4000))
          .min(1)
          .max(40)
          .refine((argv) => argv.filter((arg) => arg === '{sha}').length === 1),
        cwd: z.string().refine(isAbsolute),
        timeoutMinutes: z.number().min(5).max(240).default(120),
      })
      .strict()
      .optional(),
    judge: judgePinSchema.optional(),
  })
  .strict();
export type DesktopMaintainerConfig = z.input<typeof desktopSchema>;
export async function readDesktopConfig(
  file: string,
): Promise<{ config?: DesktopMaintainerConfig; error?: string; errorAt?: string }> {
  try {
    return { config: desktopSchema.parse(JSON.parse(await readFile(file, 'utf8'))) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    return { error: redactToolDiagnostic(String(error)), errorAt: file };
  }
}
export function decideMode(input: { host: boolean; repoPrivate: boolean | undefined }): MaintainerMode {
  return !input.host || input.repoPrivate === undefined ? 'off' : input.repoPrivate ? 'shadow' : 'live';
}
export function credentialFor(
  action: 'read' | 'write',
  available: { app: boolean; ghLogin: boolean },
): 'app' | 'gh-login' | 'none' {
  return available.app ? 'app' : action === 'read' && available.ghLogin ? 'gh-login' : 'none';
}
