import type { Express } from 'express';
import { z } from 'zod';
import type { Workspace } from './workspace.ts';

/** Register behind the app's existing local-session and JSON mutation guards. */
export function hindsightRoutes(
  app: Express,
  workspace: Pick<Workspace, 'hindsightRuntime' | 'hindsightMemory' | 'store'>,
) {
  app.get('/api/hindsight/status', (_req, res) => res.json(workspace.hindsightRuntime.status()));
  app.post('/api/hindsight/forget', async (req, res) => {
    const { projectId } = z
      .object({ projectId: z.string().min(1).max(200) })
      .strict()
      .parse(req.body);
    if (!workspace.store.get('project', projectId)) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    res.json(await workspace.hindsightMemory.forgetProject(projectId));
  });
}
