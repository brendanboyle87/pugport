import type { Express } from 'express';
import { z } from 'zod';
import { routingProfileIdSchema } from '../shared/routing-profiles.ts';
import { routingRuleSetSchema } from '../shared/routing-schema.ts';
import type { ConversationActions } from './conversation-actions.ts';
import type { RoutingProfiles } from './routing-profiles.ts';
import { routingDraftRequestSchema, type draftRoutingProfile } from './routing-draft.ts';

/** Register after the host's normal local-session authentication middleware. */
export function registerRoutingProfileRoutes(
  app: Express,
  profiles: RoutingProfiles,
  actions: Pick<ConversationActions, 'setRoutingProfile' | 'inheritRoutingProfile' | 'setProjectRoutingProfile'>,
  compile: (request: Parameters<typeof draftRoutingProfile>[1]) => ReturnType<typeof draftRoutingProfile>,
) {
  app.get('/api/routing-profiles', (_req, res) => res.json({ profiles: profiles.list() }));
  app.post('/api/routing-profiles/compile', async (req, res) => {
    const request = routingDraftRequestSchema.parse(req.body);
    res.json(await compile(request));
  });
  app.put('/api/routing-profiles/:id', (req, res) => {
    const id = routingProfileIdSchema.parse(req.params.id);
    const body = z
      .object({ name: z.string().trim().min(1).max(60), rules: routingRuleSetSchema })
      .strict()
      .parse(req.body);
    res.json(profiles.put({ id, ...body }));
  });
  app.delete('/api/routing-profiles/:id', (req, res) => {
    res.json(profiles.remove(routingProfileIdSchema.parse(req.params.id)));
  });
  app.patch('/api/conversations/:id/routing-profile', (req, res) => {
    const body = z
      .union([
        z.object({ profileId: routingProfileIdSchema.nullable() }).strict(),
        z.object({ inheritProject: z.literal(true) }).strict(),
      ])
      .parse(req.body);
    res.json(
      'inheritProject' in body
        ? actions.inheritRoutingProfile(req.params.id)
        : actions.setRoutingProfile(req.params.id, body.profileId),
    );
  });
  app.patch('/api/projects/:id/routing-profile', (req, res) => {
    const { profileId } = z.object({ profileId: routingProfileIdSchema.nullable() }).strict().parse(req.body);
    res.json(actions.setProjectRoutingProfile(req.params.id, profileId));
  });
}
