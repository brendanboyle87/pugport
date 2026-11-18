import type { Express } from 'express';
import { modeSourceRefreshSchema } from '../shared/mode-source.ts';
import { ModeSourceError, type ModeSource } from './mode-source.ts';
import { ModeApprovalRequired, ModeConflict } from './conversation-modes.ts';

/** Register after the normal local-client authentication and bounded JSON parser. */
export function registerModeSourceRoutes(app: Express, source: ModeSource) {
  app.get('/api/modes/source', (_req, res) => res.json(source.view()));
  app.put('/api/modes/source', (req, res) => res.json(source.configure(req.body)));
  app.post('/api/modes/source/refresh', async (req, res) => {
    const { force } = modeSourceRefreshSchema.parse(req.body ?? {});
    res.json(await source.refresh(force));
  });
  app.post('/api/modes/source/install', async (req, res) => res.json(await source.install(req.body)));
  app.get('/api/modes/source/:id/versions/:version/export', async (req, res) => {
    const manifest = await source.download({
      id: req.params.id,
      version: req.params.version,
      revision: req.query.revision,
    });
    res.setHeader('Content-Disposition', `attachment; filename="${manifest.id}-${manifest.version}.json"`);
    res.json(manifest);
  });
  app.use(
    (
      error: unknown,
      _req: import('express').Request,
      res: import('express').Response,
      next: import('express').NextFunction,
    ) => {
      if (!(error instanceof ModeSourceError || error instanceof ModeConflict) || res.headersSent) return next(error);
      res.status(error.status).json({
        error: error.message,
        ...(error instanceof ModeApprovalRequired ? { code: error.code, permissions: error.permissions } : {}),
      });
    },
  );
}
