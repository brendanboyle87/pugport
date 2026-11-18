import type { AdmissionRules } from './external-admission.ts';
import type { Express } from 'express';
import { z } from 'zod';
import type { Controller } from './controller.ts';
import type { GitHubConnection } from './github.ts';

/** Mounted behind the same localhost, origin and mutation-token guards as connectors. */
export function githubRoutes(
  app: Express,
  controller: Pick<Controller, 'updateSettings'>,
  github: Pick<GitHubConnection, 'status' | 'setEnabled'>,
  rules?: AdmissionRules,
) {
  if (rules) {
    app.get('/api/github/admission', (_req, res) => res.json(rules.read()));
    app.put('/api/github/admission', (req, res) => res.json(rules.write(req.body)));
  }
  app.get('/api/github', async (_req, res) => res.json(await github.status()));
  app.post('/api/github', async (req, res) => {
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(req.body);
    await controller.updateSettings({ github: enabled });
    res.json(await github.setEnabled(enabled));
  });
}
