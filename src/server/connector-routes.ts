import type { Express } from 'express';
import { z } from 'zod';
import { connectorCapabilities } from '../shared/connectors.ts';
import type { ConnectorService } from './connectors.ts';
import type { Workspace } from './workspace.ts';

const provider = z.enum(['google', 'microsoft']);
const capability = z.enum(connectorCapabilities);
const escape = (text: string) =>
  text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

/** Mounted behind main's localhost, origin and mutation-token guards. Callback uses OAuth state + PKCE. */
export function connectorRoutes(app: Express, connectors: ConnectorService, workspace: Workspace) {
  app.get('/api/connectors', async (_req, res) => {
    const [accounts, providers] = await Promise.all([connectors.list(), connectors.configInfo()]);
    res.json({ accounts, providers, redirectUri: providers[0]?.redirectUri });
  });
  app.put('/api/connectors/providers/:provider', async (req, res) => {
    const input = z
      .object({
        clientId: z.string().trim().max(500),
        clientSecret: z.string().max(4096).optional(),
        tenant: z.string().trim().max(200).optional(),
      })
      .strict()
      .parse(req.body);
    const selected = provider.parse(req.params.provider);
    await connectors.saveProviderConfig(selected, input);
    res.json((await connectors.configInfo()).find((value) => value.provider === selected));
  });
  app.post('/api/connectors/connect', async (req, res) => {
    const input = z
      .object({
        provider,
        alias: z.string().trim().min(1).max(80),
        capabilities: z.array(capability).min(1).max(connectorCapabilities.length),
        accountId: z.string().uuid().optional(),
      })
      .strict()
      .parse(req.body);
    res.json(await connectors.connect(input));
  });
  app.patch('/api/connectors/:id', async (req, res) => {
    res.json(
      await connectors.update(
        req.params.id,
        z
          .object({ alias: z.string().trim().min(1).max(80).optional(), enabled: z.boolean().optional() })
          .strict()
          .parse(req.body),
      ),
    );
  });
  app.delete('/api/connectors/:id', async (req, res) => {
    await connectors.disconnect(req.params.id);
    res.json({ disconnected: true });
  });
  app.patch('/api/conversations/:id/connectors', async (req, res) => {
    const { connectorIds } = z
      .object({ connectorIds: z.array(z.string().uuid()).max(50) })
      .strict()
      .parse(req.body);
    const accounts = await connectors.list();
    if (
      connectorIds.some(
        (id) => !accounts.some((account) => account.id === id && account.enabled && account.status === 'connected'),
      )
    )
      throw Error('选择的连接器已停用、断开或需要重新授权，请刷新后重选。');
    res.json(workspace.setConversationConnectors(req.params.id, connectorIds));
  });
  app.get('/api/connectors/oauth/callback', async (req, res) => {
    // No authorization codes, tokens, provider error strings or scripts enter the HTML response.
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    let text = '连接已完成。请回到 PugPort 的“扩展 → 连接与服务”查看账号，并在对话里选择它。';
    let success = true;
    try {
      const input = z
        .object({
          state: z.string().min(1).max(500),
          code: z.string().max(4096).optional(),
          error: z.string().max(200).optional(),
        })
        .parse(req.query);
      await connectors.completeOAuth(input);
    } catch {
      success = false;
      text =
        '授权未完成。请回到 PugPort 重新连接；学校或公司的账号若显示需要管理员批准，请联系管理员批准该应用与权限。';
    }
    res
      .status(success ? 200 : 400)
      .type('html')
      .send(
        `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PugPort · 连接器</title><style>body{margin:0;background:#111;color:#eee;font:16px system-ui;display:grid;place-items:center;min-height:100vh}main{max-width:540px;padding:32px}p{line-height:1.8;color:#bbb}</style><main><h1>${success ? '账号已连接' : '连接未完成'}</h1><p>${escape(text)}</p><p>可以关闭此页。</p></main></html>`,
      );
  });
}
