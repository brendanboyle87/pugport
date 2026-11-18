import { projectGatesInputSchema } from './project-gates.ts';
import { z } from 'zod';
import type { Settings } from './types.ts';
import { defaultSandboxModes, sandboxProviders, learningProviders } from './sandbox.ts';

export const safetySettingsSchema = z
  .object({
    sandbox: z.partialRecord(z.enum(sandboxProviders), z.enum(['off', 'learn', 'enforce'])).optional(),
    sandboxWhenUnavailable: z.enum(['stop', 'run-as-today']).optional(),
    toolApprovalMode: z.enum(['auto', 'ask']).optional(),
    autoUseResetCards: z.boolean().optional(),
  })
  .strict();
export const targetCommandSchema = z
  .object({
    command: z.string().min(1).max(4000).optional(),
    args: z.array(z.string().max(4000)).max(20).optional(),
  })
  .strict();
export const extensionInstallSchema = z
  .object({
    token: z.string().max(100),
    keys: z.array(z.string().max(100)).max(1000),
    fills: z.record(z.string().max(100), z.record(z.string().max(200), z.string().max(8000))).optional(),
    options: z
      .record(
        z.string().max(100),
        z.object({ name: z.string().max(80).optional(), replaceId: z.string().max(100).optional() }).strict(),
      )
      .optional(),
  })
  .strict();
export const sandboxAdoptSchema = z
  .object({
    provider: z.enum(learningProviders),
    ids: z
      .array(z.string().regex(/^[a-f0-9]{64}$/))
      .min(1)
      .max(10000),
  })
  .strict();

export const PERMISSION_CHANGE_CHANNEL = 'pugport:permission-change';
export const permissionChangeSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('approval'),
      id: z.string().min(1),
      allow: z.literal(true),
      remember: z.boolean().optional(),
    })
    .strict(),
  z.object({ kind: z.literal('settings'), patch: safetySettingsSchema }).strict(),
  z.object({ kind: z.literal('target-command'), id: z.string().min(1), patch: targetCommandSchema }).strict(),
  z.discriminatedUnion('action', [
    z.object({ kind: z.literal('extension-command'), action: z.literal('approve'), id: z.string().min(1) }).strict(),
    z
      .object({ kind: z.literal('extension-command'), action: z.literal('install'), ...extensionInstallSchema.shape })
      .strict(),
    z
      .object({
        kind: z.literal('extension-command'),
        action: z.literal('configure'),
        id: z.string().min(1),
        values: z.record(z.string().max(200), z.string().max(8000)),
      })
      .strict(),
  ]),
  z.object({ kind: z.literal('sandbox-adopt'), ...sandboxAdoptSchema.shape }).strict(),
  z
    .object({ kind: z.literal('verification'), projectId: z.string().min(1), command: z.string().min(1).max(4000) })
    .strict(),
  z.object({ kind: z.literal('project-gates'), projectId: z.string().min(1), gates: projectGatesInputSchema }).strict(),
  z.object({ kind: z.literal('project'), id: z.string().min(1), trusted: z.boolean() }).strict(),
  z
    .object({
      kind: z.literal('caller'),
      tool: z.enum(['claude', 'codex', 'cursor', 'grok']),
      mode: z.enum(['inherit', 'read-only', 'write']),
    })
    .strict(),
]);
export type PermissionChange = z.infer<typeof permissionChangeSchema>;

/** Return whole fields that relax safety; a supplied sandbox map replaces the old map. */
export function relaxingSettingsPatch(current: Partial<Settings>, next: Partial<Settings>) {
  const patch: z.infer<typeof safetySettingsSchema> = {};
  const defaults = defaultSandboxModes();
  const rank = { off: 0, learn: 1, enforce: 2 };
  if (
    next.sandbox !== undefined &&
    sandboxProviders.some(
      (provider) =>
        rank[next.sandbox?.[provider] ?? defaults[provider]] < rank[current.sandbox?.[provider] ?? defaults[provider]],
    )
  )
    patch.sandbox = next.sandbox;
  if (next.sandboxWhenUnavailable === 'run-as-today' && current.sandboxWhenUnavailable !== 'run-as-today')
    patch.sandboxWhenUnavailable = next.sandboxWhenUnavailable;
  if (next.toolApprovalMode === 'auto' && (current.toolApprovalMode ?? 'auto') !== 'auto')
    patch.toolApprovalMode = next.toolApprovalMode;
  if (next.autoUseResetCards === true && current.autoUseResetCards !== true) patch.autoUseResetCards = true;
  return patch;
}

export function targetCommandChanged(
  current: { command: string; args?: string[] },
  next: { command?: string; args?: string[] },
) {
  return (
    (next.command !== undefined && next.command !== current.command) ||
    (next.args !== undefined && JSON.stringify(next.args) !== JSON.stringify(current.args ?? []))
  );
}

export const displayCommand = (command: string, args: string[] = []) =>
  [command, ...args].map((part) => JSON.stringify(part)).join(' ');

/** Settings patches replace this map, so omitted entries also need checking. */
export function assertCallerNarrowing(current: Settings['externalCallers'], next: Settings['externalCallers']) {
  if (next === undefined) return;
  const rank = { 'read-only': 0, inherit: 1, write: 2 };
  for (const tool of ['claude', 'codex', 'cursor', 'grok'] as const)
    if (rank[next[tool] ?? 'inherit'] > rank[current?.[tool] ?? 'inherit'])
      throw new Error('放宽调用方权限需要在桌面应用中确认。');
}
