import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { fixture } from './helpers/session-workspace.ts';
import { HindsightMemory, type HindsightMemoryTrace } from '../src/server/hindsight-memory.ts';
import { defaultHindsightSettings } from '../src/shared/hindsight.ts';
import type { Workflow } from '../src/shared/types.ts';
import { ConversationWebSearch } from '../src/server/conversation-web-search.ts';
import type { WebSearchService } from '../src/server/web-search.ts';
import type { WebSearchResponse } from '../src/shared/web-search.ts';

test(
  'a delayed retain completion cannot recreate document or audit rows during or after project purge',
  { timeout: 10000 },
  async (t) => {
    const { workspace, directory } = fixture(t);
    const source = join(directory, 'source');
    mkdirSync(source);
    const project = await workspace.createProject(source);
    const conversation = workspace.createConversation(project.id);
    const question = workspace.store.addMessage(conversation.id, 'user', 'Where is the parser?');
    const reply = workspace.store.addMessage(
      conversation.id,
      'assistant',
      'The synthetic parser is in src/parser.ts.',
      'workflow',
    );
    const workflow = {
      id: randomUUID(),
      projectId: project.id,
      conversationId: conversation.id,
      userMessageId: question.id,
      finalMessageId: reply.id,
      input: { content: question.content },
      status: 'completed',
      runIds: [],
      createdAt: question.createdAt,
      updatedAt: reply.createdAt,
    } as unknown as Workflow;
    workspace.store.save('workflow', workflow.id, conversation.id, workflow);
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const memory = new HindsightMemory({
      store: workspace.store,
      runtime: {
        endpoint: () => ({ baseUrl: 'http://127.0.0.1:33333', token: 'synthetic-only' }),
        withJob: async (_job, run) => run(),
      },
      settings: () => ({ ...defaultHindsightSettings, enabled: true, projectIds: [project.id] }),
      idle: () => true,
      audit: (record) =>
        (workspace as unknown as { recordHindsightAudit(value: HindsightMemoryTrace): void }).recordHindsightAudit(
          record,
        ),
      fetch: async () => {
        entered();
        await held;
        return Response.json({});
      },
    });
    memory.enqueue(workflow);
    const retaining = memory.check();
    try {
      await started;
      workspace.removeProject(project.id);
      const preview = await workspace.projectData.preview(project.id);
      assert.equal(preview.canPurge, true);
      await workspace.projectData.purge(project.id, preview.token);
      assert.equal(workspace.store.get('project', project.id), undefined);
    } finally {
      release();
      await retaining;
      await memory.close();
    }
    assert.equal(workspace.store.list('hindsight-document', project.id).length, 0);
    assert.equal(workspace.store.list('hindsight-audit', workflow.id).length, 0);
    assert.equal(workspace.store.list('hindsight-audit', project.id).length, 0);
  },
);

test(
  'purge remains blocked while an old attachment request still owns private temporary bytes',
  { timeout: 10000 },
  async (t) => {
    const { workspace, directory, controller } = fixture(t);
    const source = join(directory, 'source');
    mkdirSync(source);
    const project = await workspace.createProject(source);
    const conversation = workspace.createConversation(project.id);
    let enter!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const upload = workspace.attachments.saveStream(
      conversation.id,
      { name: 'private.txt', mimeType: 'text/plain' },
      Readable.from(
        (async function* () {
          enter();
          yield Buffer.from('private content');
          await held;
          yield Buffer.from('end');
        })(),
      ),
    );
    try {
      await started;
      const folder = join(controller.dataDir, 'attachments');
      for (let attempt = 0; attempt < 100; attempt++) {
        if (readdirSync(folder).some((name) => name.endsWith('.tmp') && statSync(join(folder, name)).size > 0)) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.ok(readdirSync(folder).some((name) => name.endsWith('.tmp') && statSync(join(folder, name)).size > 0));
      workspace.removeProject(project.id);
      const preview = await workspace.projectData.preview(project.id);
      assert.equal(preview.canPurge, false);
      assert.match(preview.blockedReason!, /上传未结束/);
    } finally {
      release();
      await assert.rejects(upload, /已移除/);
    }
    const ready = await workspace.projectData.preview(project.id);
    assert.equal(ready.canPurge, true);
    await workspace.projectData.purge(project.id, ready.token);
    assert.deepEqual(readdirSync(join(controller.dataDir, 'attachments')), []);
  },
);

test(
  'an actually completed slow DS request releases a removed project for purge without another search or answer',
  { timeout: 10000 },
  async (t) => {
    const { workspace, directory } = fixture(t);
    const source = join(directory, 'source');
    mkdirSync(source);
    const project = await workspace.createProject(source);
    const conversation = workspace.createConversation(project.id);
    let release!: () => void, enter!: () => void;
    let calls = 0;
    const started = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const held = new Promise<WebSearchResponse>((resolve) => {
      release = () =>
        resolve({
          query: 'official docs',
          requestId: 'synthetic',
          durationMs: 1,
          estimatedCostCny: 0,
          truncated: false,
          results: [],
        });
    });
    const service = {
      available: () => true,
      search: async () => {
        calls++;
        enter();
        return held;
      },
    } as unknown as WebSearchService;
    const search = new ConversationWebSearch(workspace, service);
    const sent = search.send(conversation.id, {
      content: '/搜索 official docs',
      mode: 'chat',
      permissionMode: 'read-only',
      executionPolicy: 'cli-first',
    });
    try {
      await started;
      workspace.removeProject(project.id);
      assert.equal((await workspace.projectData.preview(project.id)).canPurge, false);
      release();
      for (let attempt = 0; attempt < 100; attempt++) {
        if (
          workspace.store.get<{ webSearch?: { status: string } }>('message', sent.reply.id)?.webSearch?.status !==
          'running'
        )
          break;
        await new Promise((resolve) => setImmediate(resolve));
      }
      const ready = await workspace.projectData.preview(project.id);
      assert.equal(ready.canPurge, true);
      await workspace.projectData.purge(project.id, ready.token);
      assert.equal(calls, 1);
      assert.equal(workspace.store.get('project', project.id), undefined);
      assert.equal(workspace.store.list('workflow').length, 0);
    } finally {
      release();
      await search.close();
    }
  },
);
