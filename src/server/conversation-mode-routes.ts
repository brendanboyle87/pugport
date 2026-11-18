import type { Express } from 'express';
import { z } from 'zod';
import { modeVersionSchema } from '../shared/conversation-modes.ts';
import { modPermissionSchema } from '../shared/mods-manifest.ts';
import { ModeApprovalRequired, ModeConflict, ModeStateError, type ConversationModes } from './conversation-modes.ts';
import { ModRunError, type ModRuns } from './mod-runs.ts';

export const approvedPermissionsSchema = z.array(modPermissionSchema).max(8).optional();

/** Mount after the existing loopback/origin/token checks and bounded JSON parser. */
export function registerConversationModeRoutes(
  app: Express,
  modes: ConversationModes,
  runs: Pick<ModRuns, 'start' | 'cancel'>,
) {
  app.get('/api/modes', (_req, res) => res.json(modes.catalog()));
  app.get('/api/modes/:id/versions/:version/export', (req, res) => {
    const manifest = modes.export(req.params.id, req.params.version);
    res.setHeader('Content-Disposition', `attachment; filename="${manifest.id}-${manifest.version}.json"`);
    res.json(manifest);
  });
  app.post('/api/modes/import', (req, res) => {
    const { manifest } = z.object({ manifest: z.unknown() }).strict().parse(req.body);
    res.json(modes.import(manifest));
  });
  app.post('/api/modes/:id/install', (req, res) => {
    const { version, approvedPermissions } = z
      .object({ version: modeVersionSchema, approvedPermissions: approvedPermissionsSchema })
      .strict()
      .parse(req.body);
    res.json(modes.install(req.params.id, version, approvedPermissions));
  });
  app.delete('/api/modes/:id/install', (req, res) => res.json(modes.install(req.params.id, null)));
  app.get('/api/conversations/:id/mode', (req, res) => res.json(modes.view(req.params.id)));
  app.put('/api/conversations/:id/mode', (req, res) => res.json(modes.bind(req.params.id, req.body)));
  app.put('/api/conversations/:id/mode/visibility', (req, res) => res.json(modes.setHidden(req.params.id, req.body)));
  app.post('/api/conversations/:id/mode-actions', (req, res) => res.json(modes.action(req.params.id, req.body)));
  app.post('/api/conversations/:id/mode-runs', async (req, res) => res.json(await runs.start(req.params.id, req.body)));
  app.delete('/api/conversations/:id/mode-runs/:runId', (req, res) => {
    runs.cancel(req.params.id, req.params.runId);
    res.json({});
  });
  app.use(
    (
      error: unknown,
      _req: import('express').Request,
      res: import('express').Response,
      next: import('express').NextFunction,
    ) => {
      if (res.headersSent) return next(error);
      if (error instanceof ModeStateError || error instanceof ModRunError)
        return res.status(error.status).json({ error: error.message, code: error.code });
      if (error instanceof ModeApprovalRequired)
        return res
          .status(error.status)
          .json({ error: error.message, code: error.code, permissions: error.permissions });
      if (!(error instanceof ModeConflict)) return next(error);
      res.status(error.status).json({ error: error.message });
    },
  );
}
