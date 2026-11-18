import type { Express, NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import {
  modDataMethodSchemas,
  modDataPermission,
  modDataRequestSchema,
  modDataServerMethods,
  type ModDataMethod,
  type ModPdfText,
} from '../shared/mod-data.ts';
import { BankConnectionError, plaidSettingsInputSchema, type BankConnections } from './bank-connections.ts';
import type { ConversationModes } from './conversation-modes.ts';
import { ModStorageError, type ModStorage } from './mod-storage.ts';
import { pdfPages, PdfTextError } from './pdf-text.ts';

class ModDataError extends Error {
  constructor(
    readonly code: 'E_INVALID' | 'E_PERMISSION' | 'E_UNAVAILABLE',
    readonly status = code === 'E_INVALID' ? 400 : code === 'E_PERMISSION' ? 403 : 409,
  ) {
    super(
      {
        E_INVALID: 'Invalid request.',
        E_PERMISSION: 'Permission is not declared.',
        E_UNAVAILABLE: 'Mod is unavailable.',
      }[code],
    );
  }
}
const modId = z
  .string()
  .max(80)
  .regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/);
const PDF_REPLY_CHARS = 400_000;

/**
 * The binding decides the namespace: a frame never names its Mod, so one Mod cannot read another's data. The
 * permission must be declared by the bound version, and approved when it needs approval.
 */
function boundMod(modes: ConversationModes, conversationId: string, instanceId: string, permission: string) {
  let view: ReturnType<ConversationModes['view']>;
  try {
    view = modes.view(conversationId);
  } catch {
    throw new ModDataError('E_UNAVAILABLE');
  }
  if (!view.installed || !view.manifest || view.binding?.instanceId !== instanceId)
    throw new ModDataError('E_UNAVAILABLE');
  if (!view.granted?.includes(permission as never)) throw new ModDataError('E_PERMISSION');
  return view.manifest.id;
}

export function registerModDataRoutes(
  app: Express,
  deps: { modes: ConversationModes; storage: ModStorage; bank: BankConnections; python: () => string | undefined },
) {
  const { modes, storage, bank } = deps;
  app.post('/api/conversations/:id/mod-data', async (req, res) => {
    const parsedRequest = modDataRequestSchema.safeParse(req.body);
    if (!parsedRequest.success) throw new ModDataError('E_INVALID');
    const request = parsedRequest.data;
    if (!Object.hasOwn(modDataMethodSchemas, request.method) || !modDataServerMethods.has(request.method as never))
      throw new ModDataError('E_INVALID');
    const method = request.method as ModDataMethod;
    const owner = boundMod(modes, req.params.id, request.instanceId, modDataPermission(method));
    const parsed = modDataMethodSchemas[method].safeParse(request.params ?? {});
    if (!parsed.success) throw new ModDataError('E_INVALID');
    // Each case reads only the fields its schema above has just checked.
    const args = parsed.data as Record<string, never>;
    switch (method) {
      case 'storage.get':
        return res.json({ items: storage.get(owner, args.collection, args.keys) });
      case 'storage.put':
        return res.json(storage.put(owner, args.collection, args.items));
      case 'storage.delete':
        return res.json(storage.delete(owner, args.collection, args.keys));
      case 'storage.list':
        return res.json(storage.list(owner, args as never));
      case 'storage.usage':
        return res.json(storage.usage(owner));
      case 'connections.list':
        return res.json({ connections: await bank.listFor(owner) });
      case 'connections.status':
        return res.json(await bank.status(owner, args.connectionId));
      case 'connections.authorize':
        return res.json(await bank.startLink({ modId: owner }));
      case 'connections.reconnect':
        return res.json(await bank.startLink({ modId: owner, reconnect: args.connectionId }));
      case 'connections.sync':
        return res.json(await bank.requestSync(owner, args.connectionId));
      case 'connections.accounts':
        return res.json({ accounts: await bank.accounts(owner, args.connectionId) });
      case 'connections.transactions':
        return res.json(await bank.transactions(owner, args as never));
      case 'connections.liabilities':
        return res.json({ credit: await bank.liabilities(owner, args.connectionId) });
      default:
        throw new ModDataError('E_INVALID');
    }
  });
  app.post('/api/conversations/:id/mod-files/pdf-text', async (req, res) => {
    const instanceId = z.string().min(1).max(200).safeParse(req.query.instanceId);
    const fromPage = z.coerce
      .number()
      .int()
      .positive()
      .max(100_000)
      .safeParse(req.query.fromPage ?? 1);
    if (!instanceId.success || !fromPage.success) throw new ModDataError('E_INVALID');
    boundMod(modes, req.params.id, instanceId.data, 'files:import');
    if (!Buffer.isBuffer(req.body)) throw new ModDataError('E_INVALID');
    const pages = await pdfPages(deps.python(), req.body);
    const result: ModPdfText = { pageCount: pages.length, pages: [] };
    let size = 0;
    for (const page of pages.filter((item) => item.page >= fromPage.data)) {
      // A reply fits the Mod bridge's message limit; the Mod asks again from `nextPage`.
      if (result.pages.length && size + page.text.length > PDF_REPLY_CHARS) {
        result.nextPage = page.page;
        break;
      }
      result.pages.push({ page: page.page, text: page.text.slice(0, PDF_REPLY_CHARS) });
      size += page.text.length;
    }
    res.json(result);
  });

  // Settings: Plaid keys (never sent back), connections and each Mod's data.
  app.get('/api/bank/settings', async (_req, res) => res.json(await bank.settings()));
  app.put('/api/bank/settings', async (req, res) =>
    res.json(await bank.saveSettings(plaidSettingsInputSchema.parse(req.body))),
  );
  app.delete('/api/bank/settings', async (_req, res) => res.json(await bank.clearSettings()));
  app.get('/api/bank/connections', async (_req, res) => res.json({ connections: await bank.list() }));
  app.post('/api/bank/connections/link', async (req, res) => {
    const { reconnect } = z
      .object({ reconnect: z.string().max(100).optional() })
      .strict()
      .parse(req.body ?? {});
    res.json(await bank.startLink(reconnect ? { reconnect } : {}));
  });
  app.get('/api/bank/link/:id', (req, res) => res.json(bank.linkSession(req.params.id)));
  app.delete('/api/bank/link/:id', (req, res) => {
    bank.cancelLink(req.params.id);
    res.json({});
  });
  app.post('/api/bank/connections/:id/sync', async (req, res) =>
    res.json(await bank.requestSync(undefined, req.params.id)),
  );
  app.put('/api/bank/connections/:id/mods/:modId', async (req, res) => {
    const { shared } = z.object({ shared: z.boolean() }).strict().parse(req.body);
    await bank.share(req.params.id, modId.parse(req.params.modId), shared);
    res.json({ connections: await bank.list() });
  });
  app.delete('/api/bank/connections/:id', async (req, res) => {
    await bank.remove(req.params.id);
    res.json({ connections: await bank.list() });
  });
  app.get('/api/mod-data', (_req, res) => res.json({ mods: storage.owners() }));
  // POST, so only the desktop window (not a CLI session token) can read a whole ledger.
  app.post('/api/mod-data/:modId/backup', (req, res) => {
    const id = modId.parse(req.params.modId);
    res.setHeader('Content-Disposition', `attachment; filename="${id}-data.json"`);
    res.json(storage.backup(id));
  });
  app.post('/api/mod-data/:modId/restore', (req, res) =>
    res.json(storage.restore(modId.parse(req.params.modId), req.body)),
  );
  app.delete('/api/mod-data/:modId', (req, res) => {
    const { confirm } = z
      .object({ confirm: z.string().max(80) })
      .strict()
      .parse(req.body);
    res.json(storage.clear(modId.parse(req.params.modId), confirm));
  });
  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(error);
    if (error instanceof ModDataError || error instanceof ModStorageError || error instanceof BankConnectionError)
      return res.status(error.status).json({ error: error.message, code: error.code });
    if (error instanceof PdfTextError)
      return res
        .status(error.code === 'E_LIMIT' ? 413 : error.code === 'E_INVALID' ? 400 : 409)
        .json({ error: error.message, code: error.code });
    next(error);
  });
}
