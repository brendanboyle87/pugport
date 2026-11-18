import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import type { AccountService } from './account-service.ts';

/** All secret handoff is Node IPC. Even an authenticated renderer/owner cannot use HTTP for it. */
export function accountRoutes(app: Express, account: AccountService) {
  app.use(/^\/api\/account\/internal/, (_req, res) => {
    res.status(403).json({ error: 'MAIN_PROCESS_ONLY' });
  });
  app.get('/api/account', (_req, res) => res.json(account.view()));
  const post = (path: string, run: (req: Request) => unknown | Promise<unknown>) =>
    app.post(`/api/account/${path}`, async (req: Request, res: Response) => {
      try {
        res.json(await run(req));
      } catch (error) {
        const code =
          error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'INVALID_ACCOUNT_REQUEST';
        res.status(400).json({ error: code });
      }
    });
  for (const action of ['sign-in', 'cancel', 'sign-out'] as const) post(action, () => account.action(action));
  post('merge', (req) => {
    account.assertSession(req.body?.sessionId);
    const body = z.object({ confirmed: z.literal(true), allowAccountChange: z.boolean().optional() }).parse(req.body);
    return account.merge(body.confirmed, body.allowAccountChange === true);
  });
  post('delete-cloud', (req) => {
    account.assertSession(req.body?.sessionId);
    return account.deleteCloud(z.object({ confirmed: z.literal(true) }).parse(req.body).confirmed);
  });
}
