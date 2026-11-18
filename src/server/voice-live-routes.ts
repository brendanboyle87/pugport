import express, { type Express } from 'express';
import { z } from 'zod';
import { GptLiveError, type GptLive } from './gpt-live.ts';

/** Mount after the normal local-client authentication; only the exchange route takes a binary body. */
export function registerVoiceLiveRoutes(app: Express, live: GptLive, setting: () => 'gpt-live' | 'local' | undefined) {
  // GPT Live is the default whenever a usable OpenAI card exists; the user can choose this computer instead.
  const provider = () => (setting() !== 'local' && live.available() ? 'gpt-live' : 'local');
  // Why GPT Live cannot start now, so a Mod that requires it can say so plainly.
  const reason = () => (setting() === 'local' ? 'setting' : live.status().reason);
  app.get('/api/voice/live/status', (_req, res) => {
    const why = reason();
    res.json({
      setting: setting() ?? 'gpt-live',
      available: live.available(),
      provider: provider(),
      ...(why ? { reason: why } : {}),
    });
  });
  app.post('/api/voice/live/sessions', async (req, res) => {
    const input = z
      .object({
        instructions: z.string().max(16000),
        voice: z
          .string()
          .max(40)
          .regex(/^[a-z]+$/)
          .optional(),
        maxMinutes: z.number().min(1).max(30).optional(),
        maxCostUsd: z.number().min(0.05).max(100).optional(),
      })
      .strict()
      .parse(req.body);
    if (provider() !== 'gpt-live') {
      res.status(409).json({ error: 'GPT Live is not available.', code: 'unavailable' });
      return;
    }
    res.json(await live.start(input));
  });
  app.post(
    '/api/voice/live/sessions/:id/exchange',
    express.raw({ type: 'application/octet-stream', limit: '1mb' }),
    (req, res) =>
      res.json(live.exchange(String(req.params.id), Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0))),
  );
  app.post('/api/voice/live/sessions/:id/instruct', (req, res) => {
    const { text } = z
      .object({ text: z.string().min(1).max(4000) })
      .strict()
      .parse(req.body);
    live.instruct(String(req.params.id), text);
    res.json({});
  });
  app.delete('/api/voice/live/sessions/:id', (req, res) => {
    live.close(String(req.params.id));
    res.json({});
  });
  app.use(
    (
      error: unknown,
      req: import('express').Request,
      res: import('express').Response,
      next: import('express').NextFunction,
    ) => {
      if (res.headersSent || !(error instanceof GptLiveError) || !req.path.startsWith('/api/voice/live/'))
        return next(error);
      res.status(error.code === 'failed' ? 502 : 409).json({
        error: {
          unavailable: 'GPT Live is not available.',
          busy: 'GPT Live is busy.',
          failed: 'GPT Live did not connect.',
        }[error.code],
        code: error.code,
      });
    },
  );
}
