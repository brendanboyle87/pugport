import express, { type Express, type ErrorRequestHandler } from 'express';
import { z } from 'zod';
import type { WebSearchService } from './web-search.ts';

export function webSearchRoutes(app: Express, service: WebSearchService) {
  app.use('/api/web-search', express.json({ limit: '16kb' }));
  app.use('/api/web-search', ((error, _req, res, _next) => {
    res
      .status(error?.type === 'entity.too.large' ? 413 : 400)
      .json({ error: '搜索设置格式不正确，请检查 Key 和预算。' });
  }) satisfies ErrorRequestHandler);
  app.get('/api/web-search', (_req, res) => res.json(service.view()));
  app.put('/api/web-search', async (req, res) => {
    const parsed = z
      .object({
        key: z.string().max(4096).optional(),
        clearKey: z.boolean().optional(),
        enabled: z.boolean().optional(),
        monthlyLimitCny: z.number().min(0).max(1000000).optional(),
      })
      .strict()
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: '搜索设置格式不正确，请检查 Key 和预算。' });
      return;
    }
    res.json(await service.update(parsed.data));
  });
}
