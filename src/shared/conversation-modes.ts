import { z } from 'zod';
import type { Conversation } from './types.ts';
import type { ModManifestV2, ModPermission, modCatalogMetadataSchema } from './mods-manifest.ts';

export const MODE_COVER_MAX_BYTES = 48 * 1024;
export const MODE_MANIFEST_MAX_BYTES = 160 * 1024;
export const MODE_SOURCE_PACKAGE_MAX_BYTES = 256 * 1024;
export const MODE_SOURCE_CATALOG_MAX_BYTES = 16 * 1024 * 1024;

const safeCoverSize = (width: number, height: number) =>
  width > 0 && height > 0 && Math.max(width, height) <= 1600 && width * height <= 1_440_000;

/** Self-contained static raster data only: no remote requests, SVG, or animated image allocations. */
export function validModImage(imageKind: 'cover' | 'logo' | 'card', source: string, maxBytes: number): boolean {
  const safeSize = (width: number, height: number) =>
    imageKind === 'logo'
      ? width === 64 && height === 64
      : imageKind === 'card'
        ? width >= 480 &&
          height >= 360 &&
          Math.max(width, height) <= 1200 &&
          Math.abs(width * 3 - height * 4) <= height * 0.04
        : safeCoverSize(width, height);
  const match = /^data:image\/(png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(source);
  if (!match || match[2]!.length % 4 || match[2]!.length > Math.ceil(maxBytes / 3) * 4) return false;
  try {
    const binary = atob(match[2]!);
    if (binary.length > maxBytes || btoa(binary) !== match[2]) return false;
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const view = new DataView(bytes.buffer);
    const kind = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
    if (match[1] === 'png') {
      if (![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) return false;
      let image = false;
      let alpha = false;
      let imageStarted = false;
      for (let offset = 8; offset + 12 <= bytes.length;) {
        const length = view.getUint32(offset),
          end = offset + 12 + length,
          type = kind(offset + 4);
        if (end > bytes.length || type === 'acTL') return false;
        if (offset === 8) {
          if (type !== 'IHDR' || length !== 13 || !safeSize(view.getUint32(offset + 8), view.getUint32(offset + 12)))
            return false;
          alpha = bytes[25] === 4 || bytes[25] === 6;
        } else if (type === 'IHDR') return false;
        if (type === 'tRNS' && !imageStarted && bytes[25] === 3 && length > 0) alpha = true;
        if (type === 'IDAT') imageStarted = true;
        if (type === 'IDAT' && length) image = true;
        if (type === 'IEND') return length === 0 && image && end === bytes.length && (imageKind !== 'logo' || alpha);
        offset = end;
      }
      return false;
    }
    if (kind(0) !== 'RIFF' || kind(8) !== 'WEBP' || view.getUint32(4, true) !== bytes.length - 8) return false;
    let image = false;
    let alpha = false;
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const type = kind(offset),
        length = view.getUint32(offset + 4, true),
        start = offset + 8;
      const end = start + length + (length & 1);
      if (end > bytes.length || type === 'ANIM' || type === 'ANMF') return false;
      let width = 0,
        height = 0;
      if (type === 'VP8X') {
        if (length !== 10 || bytes[start]! & 2) return false;
        alpha = !!(bytes[start]! & 0x10);
        width = 1 + bytes[start + 4]! + (bytes[start + 5]! << 8) + (bytes[start + 6]! << 16);
        height = 1 + bytes[start + 7]! + (bytes[start + 8]! << 8) + (bytes[start + 9]! << 16);
      } else if (type === 'VP8 ') {
        if (
          length < 10 ||
          bytes[start]! & 1 ||
          bytes[start + 3] !== 0x9d ||
          bytes[start + 4] !== 1 ||
          bytes[start + 5] !== 0x2a
        )
          return false;
        width = view.getUint16(start + 6, true) & 0x3fff;
        height = view.getUint16(start + 8, true) & 0x3fff;
        image = true;
      } else if (type === 'VP8L') {
        if (length < 5 || bytes[start] !== 0x2f) return false;
        const bits = view.getUint32(start + 1, true);
        alpha ||= !!(bits & 0x10000000);
        width = (bits & 0x3fff) + 1;
        height = ((bits >>> 14) & 0x3fff) + 1;
        image = true;
      }
      if ((width || height) && !safeSize(width, height)) return false;
      if (end === bytes.length) return image && (imageKind !== 'logo' || alpha);
      offset = end;
    }
    return false;
  } catch {
    return false;
  }
}

const cover = z
  .object({
    src: z
      .string()
      .max(Math.ceil(MODE_COVER_MAX_BYTES / 3) * 4 + 23)
      .refine(
        (source) => validModImage('cover', source, MODE_COVER_MAX_BYTES),
        'Cover must be a bounded static PNG or WebP data URI',
      ),
    alt: z.string().trim().min(1).max(160),
  })
  .strict();

/** A Mod attaches to a live ordinary or project chat, never a specialized child. */
export function canAttachMod(
  conversation?: Pick<Conversation, 'deletedAt' | 'closedAt' | 'sideChat' | 'lane' | 'swarm'>,
) {
  return (
    !!conversation &&
    !conversation.deletedAt &&
    !conversation.closedAt &&
    !conversation.sideChat &&
    !conversation.lane &&
    !conversation.swarm
  );
}

export const fieldId = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/)
  .refine((value) => !['constructor', 'prototype'].includes(value));
export const modeIdSchema = z
  .string()
  .max(80)
  .regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/);
export const modeVersionSchema = z
  .string()
  .max(32)
  .regex(/^\d+\.\d+\.\d+$/);
const field = z
  .object({
    id: fieldId,
    label: z.string().trim().min(1).max(120),
    type: z.enum(['text', 'textarea']),
    initialValue: z.string().max(4000).optional(),
  })
  .strict();
const action = z.discriminatedUnion('type', [
  z.object({ id: fieldId, label: z.string().trim().min(1).max(120), type: z.literal('save') }).strict(),
  z
    .object({
      id: fieldId,
      label: z.string().trim().min(1).max(120),
      type: z.literal('compose'),
      prompt: z.string().trim().min(1).max(8000),
    })
    .strict(),
]);
/** Only host-rendered data: importing a manifest cannot install code or grant tools. */
export const conversationModeManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: modeIdSchema,
    version: modeVersionSchema,
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(2000),
    author: z.string().trim().min(1).max(120).optional(),
    category: z.string().trim().min(1).max(40).optional(),
    cover: cover.optional(),
    readme: z.string().max(20000).optional(),
    homepage: z
      .string()
      .trim()
      .max(2000)
      .url()
      .refine((value) => {
        try {
          const url = new URL(value);
          return url.protocol === 'https:' && !url.username && !url.password;
        } catch {
          return false;
        }
      }, 'Mod homepage must be an HTTPS URL without credentials')
      .optional(),
    icon: z
      .enum(['puzzle', 'notebook-pen', 'book-open', 'code-xml', 'languages', 'list-checks', 'sparkles'])
      .optional(),
    view: z
      .object({
        layout: z.literal('form').optional(),
        markdown: z.string().max(20000).optional(),
        fields: z.array(field).max(16),
        actions: z.array(action).max(16),
      })
      .strict(),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.view.fields.map((item) => item.id)).size === value.view.fields.length &&
      new Set(value.view.actions.map((item) => item.id)).size === value.view.actions.length &&
      (value.cover === undefined && value.readme === undefined && value.homepage === undefined
        ? JSON.stringify(value).length <= 80000
        : new TextEncoder().encode(JSON.stringify(value)).length <= MODE_MANIFEST_MAX_BYTES) &&
      modeStateSchema.safeParse(Object.fromEntries(value.view.fields.map((item) => [item.id, item.initialValue ?? ''])))
        .success,
    'Manifest IDs must be unique; presentation packages must not exceed 160 KiB UTF-8, legacy packages 80000 characters',
  );

export type ConversationModeManifest = z.infer<typeof conversationModeManifestSchema>;
export type ModeCatalogEntry = z.infer<typeof modCatalogMetadataSchema> & {
  compatible: true;
  /** Built from a Mods author workspace on this computer (Store: "Local build"). */
  localBuild?: ModLocalBuild;
};
export type ModLocalBuild = {
  workspaceId: string;
  conversationId: string;
  /** The chat it was built in; absent when that chat was deleted. */
  conversationTitle?: string;
  incognito?: boolean;
};
export type ModeBinding = { instanceId: string; modeId: string; version: string; attachedAt?: string };
export type PendingModeBinding = { binding: ModeBinding | null; afterWorkflowId: string; requestedAt: string };
export type ModeInstallation = {
  modeId: string;
  version: string;
  installedAt: string;
  /** Approval permissions the user accepted when loading this version. */
  approvedPermissions?: ModPermission[];
};
export type ConversationModesView = { catalog: ModeCatalogEntry[]; installed: ModeInstallation[] };
export type ConversationModeInstance = {
  id: string;
  conversationId: string;
  modeId: string;
  version: string;
  schemaVersion: 1 | 2;
  revision: number;
  state: Record<string, string>;
  createdAt: string;
  updatedAt: string;
};
export type ConversationModeView = {
  binding: ModeBinding | null;
  pending: PendingModeBinding | null;
  instance: ConversationModeInstance | null;
  manifest: ModManifestV2 | null;
  installed: boolean;
  /** Permissions this chat's Mod may use now: declared, and approved when approval is needed. */
  granted?: ModPermission[];
  /** Recent model runs started by this chat's Mod, newest first. */
  runs?: ModRunView[];
};
export const MOD_RUN_PROMPT_MAX = 20000;
export const MOD_RUN_RESULT_MAX = 100000;
export const modRunRequestSchema = z
  .object({
    instanceId: z.string().uuid(),
    prompt: z.string().trim().min(1).max(MOD_RUN_PROMPT_MAX),
    saveTo: fieldId.optional(),
    format: z.enum(['text', 'json']).optional(),
    fresh: z.boolean().optional(),
  })
  .strict();
export type ModRunStatus = 'running' | 'completed' | 'failed' | 'cancelled';
export type ModRunView = {
  id: string;
  status: ModRunStatus;
  text?: string;
  error?: 'E_FAILED' | 'E_FORMAT' | 'E_LIMIT' | 'E_CANCELLED';
  saveTo?: string;
  createdAt: string;
  finishedAt?: string;
};
export type WorkflowModeSnapshot = { binding: ModeBinding; revision: number };
export const modeStateSchema = z
  .record(fieldId, z.string().max(8000))
  .refine((value) => Object.keys(value).length <= 16 && JSON.stringify(value).length <= 64000);
export const modeActionSchema = z.object({ type: z.literal('save'), values: z.record(fieldId, z.string()) }).strict();
export type ModeAction = z.infer<typeof modeActionSchema>;
export const modeActionRequestSchema = z
  .object({ instanceId: z.string().uuid(), expectedRevision: z.number().int().nonnegative(), action: modeActionSchema })
  .strict();
export const modeBindingRequestSchema = z
  .object({
    modeId: modeIdSchema.nullable(),
    version: modeVersionSchema.optional(),
    expectedInstanceId: z.string().uuid().optional(),
    restoreInstanceId: z.string().uuid().optional(),
    restoreFromInstanceId: z.string().uuid().nullable().optional(),
  })
  .strict()
  .refine((value) => value.expectedInstanceId === undefined || value.modeId === null)
  .refine((value) => value.modeId !== null || value.version === undefined)
  .refine((value) => !value.restoreInstanceId || (value.modeId !== null && value.version !== undefined))
  .refine((value) => value.restoreFromInstanceId === undefined || !!value.restoreInstanceId);
export const modeVisibilityRequestSchema = z
  .object({
    hidden: z.boolean(),
    expectedInstanceId: z.string().min(1).max(200).optional(),
  })
  .strict();
