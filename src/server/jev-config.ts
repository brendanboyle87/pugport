import express from 'express';
import { z } from 'zod';
import { readApiKey, saveApiKey, removeApiKey } from './api-providers.ts';

// Use the same private, unsynced key store as user-added API providers.
const keyId = 'api-jev-routing';
export const readJevKey = () => readApiKey(keyId);
export const jevConfigured = () => !!readJevKey();
export async function saveJevKey(apiKey: string): Promise<void> {
  if (apiKey.trim()) await saveApiKey(keyId, apiKey);
  else await removeApiKey(keyId);
}

/** Register before the general JSON parser so malformed credentials never enter parser error replies. */
export function jevRoutes(app: express.Express): void {
  app.get('/api/jev/status', (_req, res) => res.json({ configured: jevConfigured() }));
  app.put('/api/jev/config', express.json({ limit: '16kb' }));
  app.use(
    '/api/jev/config',
    (error: { type?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(error.type === 'entity.too.large' ? 413 : 400).json({ error: 'Invalid JSON body' });
    },
  );
  app.put('/api/jev/config', async (req, res) => {
    const body = z
      .object({ apiKey: z.string().max(4096) })
      .strict()
      .safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'Invalid Jev configuration' });
      return;
    }
    await saveJevKey(body.data.apiKey);
    res.json({ configured: jevConfigured() });
  });
}
