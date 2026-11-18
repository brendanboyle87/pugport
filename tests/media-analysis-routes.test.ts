import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import type { AgentBridge } from '../src/server/agent-bridge.ts';
import { MediaWorkflowStore } from '../src/server/media-workflows.ts';
import { mediaAnalysisRoutes } from '../src/server/media-analysis-routes.ts';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { listenForFetch } from './helpers/fetch-port.ts';

test('media desktop API applies saved parameters and rejects widened or malformed requests', async () => {
  const folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'pugport-media-routes-')));
  const calls: Array<{ owner: string; options: unknown }> = [];
  const assistantCalls: Array<{ owner: string; id: string; worker: unknown }> = [];
  const workflows = new MediaWorkflowStore(folder);
  const custom = workflows.save({
    ...workflows.get('builtin-gemma-fast').workflow,
    name: 'Custom test',
    parameters: { engine: 'gemma', kind: 'videos', maxFiles: 42, topK: 3, videoSampleSeconds: 15 },
  });
  const bridge = {
    startMedia: async (owner: string, options: unknown) => {
      calls.push({ owner, options });
      return { id: 'job' };
    },
    listMedia: (owner: string) => [{ id: owner }],
    statusMedia: (owner: string, id: string, page: unknown) => ({ owner, id, page }),
    mediaAction: (owner: string, id: string, action: string) => ({ owner, id, action }),
    attachMediaAssistant: (owner: string, id: string, worker: unknown) => {
      assistantCalls.push({ owner, id, worker });
      return { status: 'running', ...(worker as object) };
    },
    statusMediaAssistants: (owner: string, id: string, workerId?: string) => ({ owner, id, workerId }),
    stopMediaAssistant: (owner: string, id: string, workerId: string) => ({ owner, id, workerId, status: 'stopped' }),
  } as unknown as AgentBridge;
  const app = express();
  app.use(express.json());
  mediaAnalysisRoutes(app, bridge, workflows);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(400).json({ error: error instanceof Error ? error.message : 'failure' });
  });
  const server = await listenForFetch(app);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (path: string, body: unknown) =>
    fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  try {
    const body = { conversationId: 'conversation', folders: ['D:\\Synthetic'], workflowId: custom.id };
    assert.equal((await post('/api/media-analysis', body)).status, 200);
    assert.deepEqual(calls, [
      { owner: 'conversation', options: { ...custom.workflow.parameters, folders: body.folders, recipeId: custom.id } },
    ]);
    for (const bad of [
      { ...body, command: 'bad' },
      { ...body, workflowId: 'missing' },
      { ...body, folders: [] },
      { ...body, folders: Array(21).fill('D:\\Synthetic') },
    ])
      assert.equal((await post('/api/media-analysis', bad)).status, 400);
    assert.equal(calls.length, 1);
    assert.deepEqual(await (await fetch(`${base}/api/media-analysis?conversationId=conversation`)).json(), {
      jobs: [{ id: 'conversation' }],
    });
    assert.equal((await fetch(`${base}/api/media-analysis/job?conversationId=conversation&limit=51`)).status, 400);
    const page = (await (
      await fetch(`${base}/api/media-analysis/job?conversationId=conversation&offset=20&limit=20`)
    ).json()) as { page: { offset: number; limit: number } };
    assert.equal(page.page.offset, 20);
    assert.equal(page.page.limit, 20);
    assert.equal(
      (await post('/api/media-analysis/job/pause', { conversationId: 'conversation', folders: ['ignored'] })).status,
      400,
    );
    const assist = {
      conversationId: 'conversation',
      workerId: '08c26583-0212-4a19-b3a3-bc2cfce74607',
      runtimeId: 'grok-b',
      sessionId: '28bd5fdc-005e-411b-8875-ecc1175a8111',
      model: 'grok-4.7-build-fast',
      effort: 'low',
    };
    assert.equal((await post('/api/media-analysis/job/assist', assist)).status, 200);
    assert.equal(assistantCalls.length, 1);
    assert.equal((assistantCalls[0].worker as typeof assist).runtimeId, 'grok-b');
    for (const invalid of [
      { ...assist, folders: ['widened'] },
      { ...assist, command: 'arbitrary-command' },
      { ...assist, evidence: { classification: 'exact-bytes' } },
      { ...assist, workerId: '../outside' },
      { ...assist, model: 'bad model\ncommand' },
      { ...assist, effort: 'invented' },
    ])
      assert.equal((await post('/api/media-analysis/job/assist', invalid)).status, 400);
    assert.equal(assistantCalls.length, 1);
    const assistantStatus = await (
      await fetch(`${base}/api/media-analysis/job/assist?conversationId=conversation&workerId=${assist.workerId}`)
    ).json();
    assert.equal(assistantStatus.workerId, assist.workerId);
    assert.equal(
      (
        await fetch(
          `${base}/api/media-analysis/job/assist?conversationId=conversation&workerId=${assist.workerId}&path=outside`,
        )
      ).status,
      400,
    );
    assert.equal(
      (await post(`/api/media-analysis/job/assist/${assist.workerId}/stop`, { conversationId: 'conversation' })).status,
      200,
    );
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    server.closeAllConnections();
    assert.equal(dirname(folder).toLowerCase(), realpathSync.native(tmpdir()).toLowerCase());
    assert.ok(basename(folder).startsWith('pugport-media-routes-'));
    rmSync(folder, { recursive: true, force: true });
  }
});
