import type { Express } from 'express';
import { z } from 'zod';
import type { ConversationAutomation } from './conversation-automation.ts';

/** Local UI routes stay behind the existing host, origin and session-token guards. */
export function conversationAutomationRoutes(app: Express, work: ConversationAutomation) {
  const root = '/api/conversations/:id/work';
  app.get(root, (req, res) => res.json(work.list(z.string().uuid().parse(req.params.id))));
  app.patch(`${root}/settings`, (req, res) =>
    res.json(work.settings(z.string().uuid().parse(req.params.id), req.body)),
  );
  app.get(`${root}/peers`, (req, res) =>
    res.json(
      work.conversations({ conversationId: z.string().uuid().parse(req.params.id), source: 'human', write: false }),
    ),
  );
  app.post(`${root}/messages`, async (req, res) =>
    res
      .status(201)
      .json(
        await work.message(
          { conversationId: z.string().uuid().parse(req.params.id), source: 'human', write: false },
          req.body,
        ),
      ),
  );
  app.post(`${root}/jobs`, (req, res) =>
    res
      .status(201)
      .json(
        work.create({ conversationId: z.string().uuid().parse(req.params.id), source: 'human', write: true }, req.body),
      ),
  );
  app.post(`${root}/lanes`, async (req, res) =>
    res
      .status(201)
      .json(
        await work.createLane(
          { conversationId: z.string().uuid().parse(req.params.id), source: 'human', write: true },
          req.body,
        ),
      ),
  );
  app.patch(`${root}/jobs/:jobId`, (req, res) => {
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(req.body);
    res.json(
      work.setEnabled(z.string().uuid().parse(req.params.id), z.string().uuid().parse(req.params.jobId), enabled),
    );
  });
  app.delete(`${root}/jobs/:jobId`, (req, res) => {
    work.remove(z.string().uuid().parse(req.params.id), z.string().uuid().parse(req.params.jobId));
    res.json({ ok: true });
  });
}
