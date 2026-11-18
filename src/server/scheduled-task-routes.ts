import type { Express } from 'express';
import { z } from 'zod';
import type { ScheduledTasks } from './scheduled-tasks.ts';

/** Mounted after main's session-token middleware. */
export function scheduledTaskRoutes(app: Express, tasks: ScheduledTasks) {
  app.get('/api/scheduled-tasks', (_req, res) => res.json(tasks.list()));
  app.post('/api/scheduled-tasks', (req, res) => res.status(201).json(tasks.create(req.body)));
  app.put('/api/scheduled-tasks/:id', (req, res) => res.json(tasks.update(req.params.id, req.body)));
  app.patch('/api/scheduled-tasks/:id', (req, res) => {
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(req.body);
    res.json(tasks.setEnabled(req.params.id, enabled));
  });
  app.delete('/api/scheduled-tasks/:id', (req, res) => {
    tasks.remove(req.params.id);
    res.json({ ok: true });
  });
  app.post('/api/scheduled-tasks/:id/run', async (req, res) => res.json(await tasks.runNow(req.params.id)));
}
