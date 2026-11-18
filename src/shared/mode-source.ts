import { z } from 'zod';
import { modeIdSchema, modeVersionSchema } from './conversation-modes.ts';
import { modCatalogMetadataSchema, modPermissionSchema } from './mods-manifest.ts';

const metadata = modCatalogMetadataSchema.extend({
  schemaVersion: modCatalogMetadataSchema.shape.schemaVersion.optional(),
});
export const modeSourceRevisionSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const modeSourceConfigSchema = z
  .object({
    enabled: z.boolean(),
    repository: z
      .string()
      .max(140)
      .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/),
    ref: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
      .refine((value) => !value.includes('..') && !value.includes('//') && !value.endsWith('/'))
      .default('main'),
    catalogPath: z.literal('catalog.json').default('catalog.json'),
  })
  .strict();
const entry = metadata
  .extend({
    path: z
      .string()
      .max(240)
      .regex(/^mods\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.json$/)
      .refine((value) => !value.split('/').some((segment) => segment === '..' || segment === '.')),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const modeSourceCatalogSchema = z
  .object({
    schemaVersion: z.literal(1),
    mods: z.array(entry).max(200),
  })
  .strict()
  .refine(
    (value) => new Set(value.mods.map((item) => `${item.id}@${item.version}`)).size === value.mods.length,
    'Duplicate Mod version',
  );
export const modeSourceViewSchema = z
  .object({
    config: modeSourceConfigSchema.nullable(),
    status: z.enum(['unconfigured', 'ready', 'error']),
    catalog: z.array(metadata.extend({ compatible: z.literal(true) }).strict()).max(200),
    revision: modeSourceRevisionSchema.optional(),
    checkedAt: z.string().datetime().optional(),
    error: z.string().max(500).optional(),
  })
  .strict();
export const modeSourceInstallSchema = z
  .object({
    id: modeIdSchema,
    version: modeVersionSchema,
    revision: modeSourceRevisionSchema,
    /** Permissions the user approved in the load prompt; only used when the version needs approval. */
    approvedPermissions: z.array(modPermissionSchema).max(8).optional(),
  })
  .strict();
export const modeSourceRefreshSchema = z.object({ force: z.boolean().optional() }).strict();
export type ModeSourceConfig = z.infer<typeof modeSourceConfigSchema>;
export type ModeSourceCatalog = z.infer<typeof modeSourceCatalogSchema>;
export type ModeSourceView = z.infer<typeof modeSourceViewSchema>;
export type ModeSourceInstall = z.infer<typeof modeSourceInstallSchema>;
