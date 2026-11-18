import { z } from 'zod';
import {
  conversationModeManifestSchema,
  fieldId,
  modeIdSchema,
  modeVersionSchema,
  modeStateSchema,
  validModImage,
  type ConversationModeManifest,
} from './conversation-modes.ts';

export { validModImage } from './conversation-modes.ts';
export const MOD_LOGO_MAX_BYTES = 8 * 1024;
export const MOD_COVER_V2_MAX_BYTES = 120 * 1024;
export const MOD_CARD_V2_MAX_BYTES = 60 * 1024;
export const MOD_PACKAGE_MAX_BYTES = 1024 * 1024;
export const MOD_STATE_MAX_BYTES = 512 * 1024;
export const MOD_STATE_MAX_KEYS = 32;
export const MOD_HTML_MAX_BYTES = 128 * 1024;
export const MOD_CSS_MAX_BYTES = 64 * 1024;
export const MOD_JS_MAX_BYTES = 256 * 1024;
export const MOD_MAX_ENTRIES = 6;
export const HOST_ICONS = [
  'puzzle',
  'notebook-pen',
  'book-open',
  'code-xml',
  'languages',
  'list-checks',
  'sparkles',
  'calendar',
  'check-square',
  'clipboard-list',
  'flask-conical',
  'graduation-cap',
  'image',
  'kanban',
  'layers',
  'lightbulb',
  'map',
  'mic',
  'music',
  'pen-line',
  'table',
  'target',
  'timer',
  'wallet',
] as const;
export type HostIcon = (typeof HOST_ICONS)[number];
export const modPermissionSchema = z.enum([
  'chat:read',
  'composer:draft',
  'model:run',
  'voice:session',
  'data:store',
  'connections:read',
  'files:import',
]);
const permission = modPermissionSchema;
export type ModPermission = z.infer<typeof permission>;
/** These can spend quota, use the microphone or read bank data, so the user approves them when loading the Mod. */
export const MOD_APPROVAL_PERMISSIONS: readonly ModPermission[] = ['model:run', 'voice:session', 'connections:read'];
/**
 * Permissions the user still has to approve before this version loads. A first load asks only for the approval
 * permissions; an update asks for anything the loaded version did not already have, once for every chat.
 */
export function modPermissionsToApprove(
  next: readonly ModPermission[],
  previous?: { permissions: readonly ModPermission[]; approved: readonly ModPermission[] },
): ModPermission[] {
  const granted = (item: ModPermission) =>
    previous
      ? previous.permissions.includes(item) &&
        (!MOD_APPROVAL_PERMISSIONS.includes(item) || previous.approved.includes(item))
      : !MOD_APPROVAL_PERMISSIONS.includes(item);
  return next.filter((item) => !granted(item));
}
const permissions = z
  .array(permission)
  .refine((items) => new Set(items).size === items.length, 'Permissions must be unique');
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
const byteString = (max: number) =>
  z.string().refine((value) => new TextEncoder().encode(value).length <= max, `Must not exceed ${max} UTF-8 bytes`);
const text = (max: number) => z.string().trim().min(1).max(max);
const image = (kind: 'logo' | 'cover' | 'card', max: number) =>
  z
    .object({
      src: z
        .string()
        .max(Math.ceil(max / 3) * 4 + 23)
        .refine(
          (src) => validModImage(kind, src, max),
          kind === 'logo'
            ? 'Logo must be a 64 x 64 static PNG or WebP with alpha, at most 8 KiB'
            : kind === 'card'
              ? 'Card must be a static PNG or WebP, 4:3 within 1%, at least 480 x 360, long edge at most 1200, at most 60 KiB'
              : 'Cover must be a bounded static PNG or WebP, at most 120 KiB',
        ),
      alt: text(160),
    })
    .strict();
const logo = image('logo', MOD_LOGO_MAX_BYTES);
const cover = image('cover', MOD_COVER_V2_MAX_BYTES);
const card = image('card', MOD_CARD_V2_MAX_BYTES);
export type ModImage = z.infer<typeof logo>;
const action = z.discriminatedUnion('type', [
  z.object({ id: fieldId, label: text(120), type: z.literal('save') }).strict(),
  z.object({ id: fieldId, label: text(120), type: z.literal('compose'), prompt: text(8000) }).strict(),
]);
export const modFormSchema = z
  .object({
    markdown: z.string().max(20000).optional(),
    fields: z
      .array(
        z
          .object({
            id: fieldId,
            label: text(60),
            type: z.enum(['text', 'textarea']),
            initialValue: z.string().max(4000).optional(),
            help: z.string().max(160).optional(),
          })
          .strict(),
      )
      .max(16),
    actions: z.array(action).max(16),
  })
  .strict()
  .superRefine((form, ctx) => {
    for (const key of ['fields', 'actions'] as const) {
      if (new Set(form[key].map((item) => item.id)).size !== form[key].length)
        ctx.addIssue({ code: 'custom', path: [key], message: `Form ${key} IDs must be unique` });
    }
  });
export type ModForm = z.infer<typeof modFormSchema>;
const entryKey = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
const web = z.object({ kind: z.literal('web'), entry: entryKey }).strict();
const webPanel = web.extend({ title: text(40).optional() });
export const modManifestV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    id: modeIdSchema,
    version: modeVersionSchema,
    title: text(60),
    description: text(200),
    author: text(80).optional(),
    category: text(40).optional(),
    license: text(40).optional(),
    icon: z.enum(HOST_ICONS).optional(),
    logo: logo.optional(),
    cover: cover.optional(),
    card: card.optional(),
    readme: z.string().max(20000).optional(),
    homepage: conversationModeManifestSchema.shape.homepage,
    permissions: permissions.optional(),
    state: z
      .object({
        keys: z
          .array(z.object({ id: fieldId }).strict())
          .max(MOD_STATE_MAX_KEYS)
          .refine((keys) => new Set(keys.map((key) => key.id)).size === keys.length, 'State key IDs must be unique'),
      })
      .strict()
      .optional(),
    ui: z
      .object({
        entries: z
          .record(
            entryKey,
            z
              .object({
                html: byteString(MOD_HTML_MAX_BYTES),
                css: byteString(MOD_CSS_MAX_BYTES).optional(),
                js: byteString(MOD_JS_MAX_BYTES).optional(),
              })
              .strict(),
          )
          .refine((entries) => Object.keys(entries).length <= MOD_MAX_ENTRIES, 'At most 6 UI entries are allowed'),
      })
      .strict()
      .optional(),
    contributions: z
      .object({
        mainView: web.optional(),
        rightPanel: z
          .discriminatedUnion('kind', [
            webPanel,
            z.object({ kind: z.literal('form'), form: modFormSchema, title: text(40).optional() }).strict(),
          ])
          .optional(),
        sidebarPanel: webPanel.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const used = new Set<string>();
    for (const [slot, contribution] of Object.entries(manifest.contributions ?? {})) {
      if (contribution.kind === 'web') {
        if (!Object.hasOwn(manifest.ui?.entries ?? {}, contribution.entry))
          ctx.addIssue({
            code: 'custom',
            path: ['contributions', slot, 'entry'],
            message: 'Entry must exist in ui.entries',
          });
        if (used.has(contribution.entry))
          ctx.addIssue({
            code: 'custom',
            path: ['contributions', slot, 'entry'],
            message: 'One entry may serve only one slot',
          });
        used.add(contribution.entry);
      } else {
        const keys = new Set(manifest.state?.keys.map((key) => key.id));
        contribution.form.fields.forEach((field, index) => {
          if (!keys.has(field.id))
            ctx.addIssue({
              code: 'custom',
              path: ['contributions', slot, 'form', 'fields', index, 'id'],
              message: 'Form field must be declared in state.keys',
            });
        });
      }
    }
    if (bytes(manifest) > MOD_PACKAGE_MAX_BYTES)
      ctx.addIssue({ code: 'custom', message: 'Manifest must not exceed 1 MiB UTF-8' });
  });
export type ModManifestV2 = z.infer<typeof modManifestV2Schema>;
export type ModManifest = ConversationModeManifest | ModManifestV2;
export const modManifestSchema = z.discriminatedUnion('schemaVersion', [
  conversationModeManifestSchema,
  modManifestV2Schema,
]);

/** Compatibility transform, deliberately without revalidating v1 text and state limits. */
export function normalizeModManifest(manifest: ModManifest): ModManifestV2 {
  if (manifest.schemaVersion === 2) return manifest;
  const { view, schemaVersion: _version, ...metadata } = manifest;
  const { layout: _layout, ...form } = view;
  return {
    ...metadata,
    schemaVersion: 2,
    permissions: view.actions.some((action) => action.type === 'compose') ? ['composer:draft'] : [],
    state: { keys: view.fields.map(({ id }) => ({ id })) },
    contributions: { rightPanel: { kind: 'form', form } },
  };
}

/** Catalogs accept the wider limits of both manifest versions. */
export const modCatalogMetadataSchema = z.object({
  id: modeIdSchema,
  version: modeVersionSchema,
  title: text(120),
  description: text(2000),
  author: text(120).optional(),
  category: text(40).optional(),
  icon: z.enum(HOST_ICONS).optional(),
  logo: logo.optional(),
  cover: cover.optional(),
  card: card.optional(),
  homepage: conversationModeManifestSchema.shape.homepage,
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  permissions: permissions.optional(),
});

export function validateModeState(manifest: ModManifest, values: unknown): Record<string, string> {
  const state =
    manifest.schemaVersion === 1
      ? modeStateSchema.parse(values)
      : z
          .record(fieldId, z.string())
          .refine((value) => Object.keys(value).length <= MOD_STATE_MAX_KEYS, 'State must not exceed 32 keys')
          .refine((value) => bytes(value) <= MOD_STATE_MAX_BYTES, 'State must not exceed 512 KiB UTF-8')
          .parse(values);
  const ids = new Set(
    manifest.schemaVersion === 1
      ? manifest.view.fields.map((field) => field.id)
      : manifest.state?.keys.map((key) => key.id),
  );
  if (Object.keys(state).some((id) => !ids.has(id))) throw new Error('Unknown mode field');
  return state;
}

/** Returns a draft for the existing composer; the caller never sends it automatically. */
export function composeModePrompt(form: ModForm, actionId: string, values: Record<string, string>): string {
  const selected = form.actions.find((item) => item.id === actionId);
  if (selected?.type !== 'compose') throw new Error('Unknown compose action');
  const state = z.record(fieldId, z.string()).parse(values);
  const ids = new Set(form.fields.map((field) => field.id));
  if (Object.keys(state).some((id) => !ids.has(id))) throw new Error('Unknown mode field');
  return [
    selected.prompt,
    ...form.fields.map((field) => `${field.label}:\n${state[field.id] ?? field.initialValue ?? ''}`),
  ].join('\n\n');
}
