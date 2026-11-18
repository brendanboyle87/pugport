import type { Express, RequestHandler } from 'express';
import { z } from 'zod';
import type { MaintainerDesk } from './desktop.ts';

/** Mounted after session-token middleware; the owner guard is supplied by main. */
export function maintainerRoutes(app: Express, desk: MaintainerDesk, refuseExecutors: RequestHandler) {
  app.get('/api/maintainer/status', async (_req, res) => {
    res.json(await desk.status());
  });
  app.post('/api/maintainer/judge/resume', refuseExecutors, async (req, res) => {
    z.object({}).strict().parse(req.body);
    const result = await desk.resumeJudge();
    if (result.status === 'refused') return void res.status(409).json({ error: result.reason });
    res.json({ ok: true });
  });
  app.post('/api/maintainer/cards/:id/merge', refuseExecutors, async (req, res) => {
    const id = z
      .string()
      .regex(/^card-\d{8}-[0-9a-f]{8}$/)
      .parse(req.params.id);
    z.object({}).strict().parse(req.body);
    const result = await desk.merge(id);
    res
      .status(result.status === 'refused' ? 409 : 200)
      .json(result.status === 'refused' ? { ...result, error: result.reason } : result);
  });
}
