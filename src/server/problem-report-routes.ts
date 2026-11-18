import type { Express } from 'express';
import { z } from 'zod';
import type { ProblemReports } from './problem-reports.ts';
import type { ProblemReportPayload } from '../shared/problem-report.ts';

export function problemReportRoutes(app: Express, reports: ProblemReports) {
  app.post('/api/problem-reports/preview', async (req, res) => {
    const input = z
      .object({
        description: z.string().max(4000),
        taskId: z.string().max(200).optional(),
        conversationId: z.string().max(200).optional(),
        includeConversation: z.boolean().optional(),
      })
      .strict()
      .parse(req.body);
    res.json(await reports.preview(input));
  });
  app.get('/api/problem-reports', async (_req, res) => res.json({ reports: await reports.list() }));
  app.post('/api/problem-reports', async (req, res) => {
    const input = z
      .object({
        payload: z.record(z.string(), z.unknown()),
        images: z.array(z.object({ dataUrl: z.string().max(1400000) }).strict()).max(4),
      })
      .strict()
      .parse(req.body);
    res.json(await reports.submit(input.payload as ProblemReportPayload, input.images));
  });
  app.get('/api/problem-reports/inbox', (_req, res) => res.json({ reports: reports.inbox() }));
  app.post('/api/problem-reports/focus', async (_req, res) => {
    await reports.tick(true);
    res.json({ ok: true });
  });
  app.post('/api/problem-reports/:id/files', async (req, res) => {
    const input = z
      .object({ images: z.array(z.object({ dataUrl: z.string().max(1400000) }).strict()).max(4) })
      .strict()
      .parse(req.body);
    res.json(await reports.addFiles(String(req.params.id), input.images));
  });
  app.post('/api/problem-reports/:id/diagnose', async (req, res) =>
    res.json(await reports.diagnose(String(req.params.id))),
  );
  app.post('/api/problem-reports/:id/status', async (req, res) => {
    const input = z
      .object({ status: z.enum(['fixed', 'ignored']), fixedIn: z.string().max(120).optional() })
      .strict()
      .parse(req.body);
    await reports.setStatus(String(req.params.id), input.status, input.fixedIn);
    res.json({ ok: true });
  });
}
