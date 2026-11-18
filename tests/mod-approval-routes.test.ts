import assert from 'node:assert/strict';
import test from 'node:test';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import { registerModWorkspaceRoutes } from '../src/server/mod-workspace-routes.ts';
import { fixture } from './helpers/session-workspace.ts';
import { findNode, nextTurn, uiBundle, uiHarness } from './helpers/ui-harness.ts';

test('approval HTTP endpoint rejects stale displayed identity and permissions with 409 without changing pending approval', async (t) => {
  const f = fixture(t, false);
  const chat = await f.workspace.createGeneralConversation('Synthetic author');
  const workspaces = f.workspace.modWorkspaces;
  const folder = workspaces.ensure(chat.id);
  const manifest = {
    schemaVersion: 2,
    id: 'synthetic.approval',
    version: '1.0.0',
    title: 'Synthetic approval',
    description: 'No real accounts or services.',
    permissions: ['model:run'],
  };
  writeFileSync(join(folder.path, 'manifest.json'), JSON.stringify(manifest));
  assert.deepEqual((await workspaces.load(chat.id, { now: 0 })).needsApproval, ['model:run']);
  const displayed = f.workspace.requireConversation(chat.id).modApproval!;
  writeFileSync(join(folder.path, 'manifest.json'), JSON.stringify({ ...manifest, permissions: ['connections:read'] }));
  assert.deepEqual((await workspaces.load(chat.id, { now: 10000, bump: 'patch' })).needsApproval, ['connections:read']);
  const pending = f.workspace.requireConversation(chat.id).modApproval!;
  const app = express();
  registerModWorkspaceRoutes(app, workspaces, {
    setWorkMode() {},
    createChat: async () => chat,
    openFolder() {},
    exportMod: (id, version) => f.workspace.modes.export(id, version),
  });
  app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(400).json({ error: 'Invalid request' });
  });
  const request = (body: unknown) =>
    new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = new IncomingMessage(new Socket());
      req.method = 'POST';
      req.url = `/api/conversations/${chat.id}/mod-approval`;
      Object.assign(req, { body });
      const res = new ServerResponse(req);
      res.end = ((data: string) => {
        resolve({ status: res.statusCode, body: JSON.parse(data) });
        return res;
      }) as typeof res.end;
      (
        app as unknown as { handle(req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void): void }
      ).handle(req, res, (error) => reject(error ?? Error('Route not found')));
    });
  const answer = { approved: true, modeId: pending.modeId, version: pending.version, permissions: pending.permissions };
  for (const changed of [
    { modeId: displayed.modeId, version: displayed.version, permissions: displayed.permissions },
    { modeId: 'synthetic.other' },
    { version: '0.0.1' },
    { permissions: ['model:run'] },
    { permissions: [] },
    { permissions: ['connections:read', 'connections:read'] },
    { approved: false, version: displayed.version },
  ]) {
    assert.equal((await request({ ...answer, ...changed })).status, 409);
    assert.deepEqual(f.workspace.requireConversation(chat.id).modApproval, pending);
    assert.equal(f.workspace.store.get('mode-installation', manifest.id), undefined);
  }
  assert.equal((await request({ approved: true })).status, 400);
  assert.equal((await request(answer)).status, 200);
  assert.equal(f.workspace.requireConversation(chat.id).modApproval, undefined);
  assert.equal(f.workspace.requireConversation(chat.id).modeBinding?.version, pending.version);
  assert.equal((await request(answer)).status, 409, 'a duplicate answer cannot approve a later card');
});

test('the approval card submits exactly the identity and permissions it displayed', async () => {
  const h = uiHarness(await uiBundle('src/ui/ModApprovalCard.tsx'));
  const answers: unknown[] = [];
  const request = {
    modeId: 'synthetic.card',
    version: '1.0.1',
    title: 'Card',
    permissions: ['model:run'],
    requestedAt: '',
  };
  try {
    const tree = h.render('ModApprovalCard', {
      request,
      onAnswer: async (answer: unknown) => {
        answers.push(answer);
      },
    });
    findNode(tree, (node) => node.type === 'button' && node.props.className === 'button primary')!.props.onClick();
    await nextTurn();
    assert.deepEqual(JSON.parse(JSON.stringify(answers)), [
      { approved: true, modeId: request.modeId, version: request.version, permissions: request.permissions },
    ]);
  } finally {
    h.unmount();
  }
});
