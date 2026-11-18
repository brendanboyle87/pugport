import type { Express } from 'express';
import { z } from 'zod';
import type { SlackGateway } from './slack-gateway.ts';

/** Mounted behind main's localhost, origin and mutation-token guards. Responses carry token hints only. */
export function slackRoutes(app: Express, gateway: SlackGateway, afterDecision?: () => void) {
  const token = z.string().max(1000).optional();
  app.get('/api/slack', async (_req, res) => res.json(await gateway.view()));
  app.put('/api/slack/tokens', async (req, res) => {
    const input = z.object({ appToken: token, botToken: token }).strict().parse(req.body);
    res.json(await gateway.saveTokens(input));
  });
  app.patch('/api/slack', async (req, res) => {
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(req.body);
    res.json(await gateway.setEnabled(enabled));
  });
  app.post('/api/slack/pairing', (req, res) => {
    const { isOwner } = z
      .object({ isOwner: z.boolean().optional() })
      .strict()
      .parse(req.body ?? {});
    res.json(gateway.createPairingCode(isOwner));
  });
  app.patch('/api/slack/users/:id', async (req, res) => {
    const { isOwner } = z.object({ isOwner: z.boolean() }).strict().parse(req.body);
    res.json(await gateway.setOwner(req.params.id, isOwner));
  });
  app.get('/api/slack/admission', (_req, res) => res.json(gateway.rules().read()));
  app.put('/api/slack/admission', (req, res) => res.json(gateway.rules().write(req.body)));
  app.post('/api/slack/requests/:id/resolve', async (req, res) => {
    const { decision } = z
      .object({ decision: z.enum(['approve', 'reject', 'always']) })
      .strict()
      .parse(req.body);
    const result = await gateway.resolveRequest(req.params.id, decision);
    afterDecision?.();
    res.json(result);
  });
  app.delete('/api/slack/users/:id', async (req, res) => res.json(await gateway.removeUser(req.params.id)));
}
