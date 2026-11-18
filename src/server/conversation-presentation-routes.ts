import type { Express } from 'express';
import type { Controller } from './controller.ts';
import type { Workflow } from '../shared/types.ts';

/** Register behind the application's existing origin and access checks. */
export function registerConversationPresentationRoutes(
  app: Express,
  controller: Pick<Controller, 'conversationPresentationBatch'>,
  workflows: (conversationId: string) => Workflow[],
) {
  app.get('/api/conversations/:id/presentations', (req, res) => {
    const raw = req.query.workflows;
    if (typeof raw !== 'string' || raw.length > 4096) {
      res.status(400).json({ error: 'Expected workflow IDs' });
      return;
    }
    const ids = raw.split(',');
    if (!ids.length || ids.length > 30 || ids.some((id) => !id || id.length > 128)) {
      res.status(400).json({ error: 'Expected 1 to 30 workflow IDs' });
      return;
    }
    const values = workflows(req.params.id);
    if (ids.some((id) => !values.some((w) => w.id === id && w.conversationId === req.params.id && !w.deletedAt))) {
      res.status(404).json({ error: 'Workflow not found in conversation' });
      return;
    }
    res.json({ presentations: controller.conversationPresentationBatch(req.params.id, ids, values) });
  });
}
