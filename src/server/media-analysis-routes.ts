import type { Express } from 'express';
import { z } from 'zod';
import type { AgentBridge } from './agent-bridge.ts';
import type { MediaWorkflowStore } from './media-workflows.ts';

/** Mounted after the desktop session/origin checks in main.ts. */
export function mediaAnalysisRoutes(app: Express, bridge: AgentBridge, workflows: MediaWorkflowStore) {
  const owner = z.object({ conversationId: z.string().min(1).max(100) }).strict();
  const start = owner.extend({
    folders: z.array(z.string().min(1).max(4000)).min(1).max(20),
    workflowId: z.string().min(1).max(100).default('builtin-gemma-fast'),
  });
  app.post('/api/media-analysis', async (req, res) => {
    const { conversationId, folders, workflowId } = start.parse(req.body);
    res.json(await bridge.startMedia(conversationId, workflows.options(workflowId, folders)));
  });
  app.get('/api/media-analysis', (req, res) => {
    const { conversationId } = owner.parse(req.query);
    res.json({ jobs: bridge.listMedia(conversationId) });
  });
  app.get('/api/media-analysis/:id', (req, res) => {
    const page = z
      .object({
        conversationId: z.string().min(1).max(100),
        offset: z.coerce.number().int().min(0).optional(),
        limit: z.coerce.number().int().min(1).max(50).optional(),
      })
      .strict()
      .parse(req.query);
    res.json(bridge.statusMedia(page.conversationId, String(req.params.id), page));
  });
  const assistance = owner.extend({
    workerId: z.string().uuid(),
    runtimeId: z.string().min(1).max(100),
    sessionId: z.string().uuid().optional(),
    model: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9._:-]+$/)
      .optional(),
    effort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']).optional(),
  });
  app.post('/api/media-analysis/:id/assist', (req, res) => {
    const { conversationId, ...worker } = assistance.parse(req.body);
    res.json(bridge.attachMediaAssistant(conversationId, String(req.params.id), worker));
  });
  app.get('/api/media-analysis/:id/assist', (req, res) => {
    const { conversationId, workerId } = owner.extend({ workerId: z.string().uuid().optional() }).parse(req.query);
    res.json(bridge.statusMediaAssistants(conversationId, String(req.params.id), workerId));
  });
  app.post('/api/media-analysis/:id/assist/:workerId/stop', (req, res) => {
    const { conversationId } = owner.parse(req.body);
    const workerId = z.string().uuid().parse(req.params.workerId);
    res.json(bridge.stopMediaAssistant(conversationId, String(req.params.id), workerId));
  });
  for (const action of ['pause', 'resume'] as const)
    app.post(`/api/media-analysis/:id/${action}`, (req, res) => {
      const { conversationId } = owner.parse(req.body);
      res.json(bridge.mediaAction(conversationId, String(req.params.id), action));
    });
  app.delete('/api/media-analysis/:id', (req, res) => {
    const { conversationId } = owner.parse(req.body);
    res.json(bridge.mediaAction(conversationId, String(req.params.id), 'close'));
  });
}
