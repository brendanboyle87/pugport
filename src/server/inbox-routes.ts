import type { Express } from 'express';
import { z } from 'zod';
import type { Inbox } from './inbox.ts';

/** Mounted after the session-token middleware. */
export function inboxRoutes(app: Express, inbox: Inbox) {
  app.get('/api/inbox', (req, res) => {
    const query = z
      .object({ all: z.enum(['0', '1']).optional(), limit: z.coerce.number().int().min(1).max(200).optional() })
      .strict()
      .parse(req.query);
    res.json(inbox.list({ all: query.all === '1', limit: query.limit }));
  });
  app.post('/api/inbox/read', (req, res) => {
    const { ids } = z
      .object({ ids: z.array(z.string().uuid()).max(200).optional() })
      .strict()
      .parse(req.body);
    inbox.markRead(ids);
    res.json({ ok: true });
  });
  app.post('/api/inbox/:id/dismiss', (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    z.object({}).strict().parse(req.body);
    if (!inbox.dismiss(id)) {
      res.status(404).json({ error: 'Notice not found' });
      return;
    }
    res.json({ ok: true });
  });
}

export function rollbackCliRoute(
  app: Express,
  controller: Pick<import('./controller.ts').Controller, 'targets' | 'executorUpdate'>,
) {
  app.post('/api/inbox/rollback-cli', async (req, res) => {
    const { runtimeId } = z
      .object({ runtimeId: z.string().min(1).max(200) })
      .strict()
      .parse(req.body);
    const target = controller.targets.find((candidate) => candidate.id === runtimeId);
    if (!target) {
      res.status(404).json({ ok: false, reason: '找不到命令行程序。' });
      return;
    }
    res.json(await controller.executorUpdate.rollbackCli(target));
  });
}
