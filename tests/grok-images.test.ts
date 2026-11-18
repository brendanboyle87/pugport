import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import sharp from 'sharp';
import type { ExecuteContext, RunAttachment, RunEvent } from '../src/shared/types.js';
import { createGrokAdapter } from '../src/server/adapters/grok.js';
import { executeGrokAcp, grokAcpImageSupport, grokAcpPromptContent } from '../src/server/adapters/grok-acp.js';

type Packet = Record<string, any>;
const verifiedInitialize = {
  protocolVersion: 1,
  agentCapabilities: { loadSession: true, promptCapabilities: { image: false } },
  authMethods: [{ id: 'cached_token' }],
  _meta: { grokShell: true, agentVersion: '1.0.46', defaultAuthMethodId: 'cached_token' },
};

async function imageFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'pugport-grok-image-test-'));
  const bytes = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#008c95' } })
    .png()
    .toBuffer();
  const path = join(directory, 'shape.png');
  await writeFile(path, bytes);
  const attachment: RunAttachment = {
    id: 'image-1',
    kind: 'image',
    name: 'shape.png',
    mimeType: 'image/png',
    size: bytes.length,
    path,
  };
  return { bytes, attachment, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

function harness(attachments: RunAttachment[] = [], init: Packet = verifiedInitialize) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  }) as unknown as ChildProcessWithoutNullStreams;
  const requests: Packet[] = [];
  const events: RunEvent[] = [];
  let sessionId = '';
  let toolsEnded = 0;
  let spawnCount = 0;
  let terminated = 0;
  let buffer = '';
  let promptResolve: (packet: Packet) => void = () => {};
  const prompted = new Promise<Packet>((resolve) => (promptResolve = resolve));
  const send = (packet: Packet) => child.stdout.emit('data', JSON.stringify({ jsonrpc: '2.0', ...packet }) + '\n');
  child.stdin.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let at: number;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const packet: Packet = JSON.parse(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      requests.push(packet);
      queueMicrotask(() => {
        if (!packet.method) return;
        if (packet.method === 'initialize') send({ id: packet.id, result: init });
        else if (packet.method === '_x.ai/interject')
          send({ id: packet.id, error: { code: -32602, message: 'Invalid params' } });
        else if (packet.method === 'session/new') {
          sessionId = packet.params._meta.sessionId;
          send({ id: packet.id, result: { sessionId } });
          send({ method: '_x.ai/mcp_initialized', params: { sessionId } });
        } else if (packet.method === '_x.ai/session/info')
          send({ id: packet.id, result: { result: { sessionId, agentName: 'comborunner-grok' } } });
        else if (packet.method === 'session/prompt') promptResolve(packet);
        else send({ id: packet.id, result: {} });
      });
    }
  });
  const ctx: ExecuteContext = {
    target: { id: 'grok', provider: 'grok', label: 'Grok', command: 'fixture', environment: 'native', enabled: true },
    input: { prompt: 'Describe the attached shape.', projectPath: process.cwd(), kind: 'general', attachments },
    route: { runtimeId: 'grok', model: 'grok-4.7', kind: 'general', reasons: [], warnings: [] },
    signal: new AbortController().signal,
    approvalMode: 'ask',
    emit: (event) => events.push(event),
    approve: async () => false,
    endTools: () => toolsEnded++,
    registerSteer: () => {},
  };
  const deps = {
    spawn: async () => {
      spawnCount++;
      return child;
    },
    terminate: async () => {
      terminated++;
      child.emit('close', 0);
    },
    timeoutMs: 1000,
  };
  return {
    child,
    ctx,
    deps,
    requests,
    events,
    send,
    prompted,
    get sessionId() {
      return sessionId;
    },
    get toolsEnded() {
      return toolsEnded;
    },
    get spawnCount() {
      return spawnCount;
    },
    get terminated() {
      return terminated;
    },
  };
}

test('Grok image capability honors explicit support and narrowly recognizes the verified omitted flag', () => {
  assert.equal(grokAcpImageSupport({ agentCapabilities: { promptCapabilities: { image: true } } }), true);
  assert.equal(grokAcpImageSupport(verifiedInitialize), true);
  assert.equal(
    grokAcpImageSupport({ ...verifiedInitialize, _meta: { grokShell: true, agentVersion: '0.1.1' } }),
    false,
  );
  assert.equal(
    grokAcpImageSupport({ ...verifiedInitialize, _meta: { grokShell: true, agentVersion: '99.0.0' } }),
    false,
  );
  assert.equal(grokAcpImageSupport({ ...verifiedInitialize, _meta: { agentVersion: '1.0.46' } }), false);
  assert.equal(grokAcpImageSupport({}), false);
});

test('Grok discovery reports image input only for the locally verified CLI version', async () => {
  for (const [version, expected] of [
    ['1.0.46', true],
    ['1.0.41', false],
    ['1.0.47', false],
  ] as const) {
    const adapter = createGrokAdapter({
      capture: async (_target, args) => ({
        stdout: args[0] === '--version' ? `grok ${version}` : 'You are logged in with an API key.\n - grok-4.7',
        exitCode: 0,
      }),
      quota: async () => {
        throw new Error('Discovery must not read a subscription for this API fixture.');
      },
    });
    // The ACP handshake already passed for this version; otherwise discovery would start a real Grok.
    const state = await adapter.discover(harness().ctx.target, { grokHandshake: { lastPassedVersion: version } });
    assert.equal(state.status, 'ready');
    assert.equal(state.capabilities.imageInput, expected);
  }
});

test('Grok converts hosted image bytes into real ACP image blocks without embedding base64 in prose', async () => {
  const fixture = await imageFixture();
  try {
    const h = harness([fixture.attachment]);
    const content = await grokAcpPromptContent(h.ctx, verifiedInitialize);
    assert.deepEqual(content[0], { type: 'text', text: h.ctx.input.prompt });
    assert.equal(content.length, 2);
    assert.deepEqual(content[1], { type: 'image', mimeType: 'image/png', data: fixture.bytes.toString('base64') });
    await assert.rejects(
      grokAcpPromptContent(h.ctx, { ...verifiedInitialize, _meta: { grokShell: true, agentVersion: '0.1.1' } }),
      /image|图片|看图|protocol/i,
    );
  } finally {
    await fixture.cleanup();
  }
});

test('Text-only Grok prompts do not require image capability or read attachment files', async () => {
  const h = harness([
    { id: 'doc', name: 'notes.txt', path: 'missing.txt', kind: 'file', mimeType: 'text/plain', size: 1 },
  ]);
  assert.deepEqual(await grokAcpPromptContent(h.ctx, {}), [{ type: 'text', text: h.ctx.input.prompt }]);
});

test('Grok submits image pixels to the same selected native session', async () => {
  const fixture = await imageFixture();
  try {
    const h = harness([fixture.attachment]);
    const execution = executeGrokAcp(h.ctx, h.deps);
    const prompt = await h.prompted;
    assert.equal(prompt.params.sessionId, h.sessionId);
    assert.deepEqual(prompt.params.prompt[1], {
      type: 'image',
      mimeType: 'image/png',
      data: fixture.bytes.toString('base64'),
    });
    h.send({
      method: 'session/update',
      params: {
        sessionId: h.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'A teal shape.' } },
      },
    });
    h.send({ id: prompt.id, result: { stopReason: 'end_turn' } });
    const result = await execution;
    assert.equal(result.output, 'A teal shape.');
    assert.equal(h.spawnCount, 1);
    assert.equal(h.terminated, 1);
  } finally {
    await fixture.cleanup();
  }
});

test('Grok image drop revokes tools and fails instead of silently acting without the image', async () => {
  const fixture = await imageFixture();
  try {
    const h = harness([fixture.attachment]);
    const execution = executeGrokAcp(h.ctx, h.deps);
    const rejected = assert.rejects(execution, /image|图片|看图/i);
    await h.prompted;
    h.send({
      method: '_x.ai/session_notification',
      params: { sessionId: h.sessionId, update: { type: 'image_dropped', notes: ['Invalid image content'] } },
    });
    await rejected;
    assert.ok(h.toolsEnded > 0);
    assert.equal(h.terminated, 1);
  } finally {
    await fixture.cleanup();
  }
});

test('Grok ignores a buffered permission request after image drop even when the process closes immediately', async () => {
  const fixture = await imageFixture();
  try {
    const h = harness([fixture.attachment]);
    h.ctx.input.permissionMode = 'workspace-write';
    h.ctx.agentBridge = { url: 'http://127.0.0.1:1/fixture', token: 'fixture-only' };
    const execution = executeGrokAcp(h.ctx, h.deps);
    const rejected = assert.rejects(execution, /runtime-image-dropped/);
    await h.prompted;
    const dropped = {
      jsonrpc: '2.0',
      method: '_x.ai/session_notification',
      params: { sessionId: h.sessionId, update: { type: 'image_dropped', notes: ['Invalid image content'] } },
    };
    const permission = {
      jsonrpc: '2.0',
      id: 500,
      method: 'session/request_permission',
      params: {
        sessionId: h.sessionId,
        toolCall: { title: 'pugport__recycle_files' },
        options: [
          { kind: 'allow_once', optionId: 'allow' },
          { kind: 'reject_once', optionId: 'reject' },
        ],
      },
    };
    // One data event leaves the permission request buffered when image failure stops parsing.
    h.child.stdout.emit('data', JSON.stringify(dropped) + '\n' + JSON.stringify(permission) + '\n');
    assert.ok(h.toolsEnded > 0, 'Tool authorization must end synchronously on the image-drop event.');
    assert.doesNotThrow(
      () => h.child.emit('close', 0),
      'Close must not parse or reply to buffered RPCs after failure.',
    );
    await rejected;
    assert.ok(!h.requests.some((packet) => packet.id === 500 && packet.result?.outcome?.optionId === 'allow'));
    assert.equal(h.terminated, 1);
  } finally {
    await fixture.cleanup();
  }
});

test('Grok never falls back to the text-only legacy command after image ACP incompatibility', async () => {
  const fixture = await imageFixture();
  try {
    const h = harness([fixture.attachment], { protocolVersion: 999 });
    await assert.rejects(createGrokAdapter(h.deps).execute(h.ctx), /image|图片|看图|protocol/i);
    assert.equal(h.spawnCount, 1);
    assert.ok(!h.requests.some((request) => request.method === 'session/prompt'));
  } finally {
    await fixture.cleanup();
  }
});

test('A text-only Grok task can still use legacy execution after ACP incompatibility', async () => {
  const h = harness([], { protocolVersion: 999 });
  const legacy = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  }) as unknown as ChildProcessWithoutNullStreams;
  legacy.stdin.on('finish', () => {
    legacy.stdout.emit('data', JSON.stringify({ type: 'result', subtype: 'success', result: 'Text answer' }) + '\n');
    legacy.emit('close', 0);
  });
  let launches = 0;
  const adapter = createGrokAdapter({
    ...h.deps,
    spawn: async (_target, args) => {
      launches++;
      if (launches === 1) return h.deps.spawn();
      assert.ok(args.includes('--prompt-file'));
      return legacy;
    },
    targetPath: async (_target, path) => path,
    terminate: async (child) => {
      child.emit('close', 0);
    },
  });
  const result = await adapter.execute(h.ctx);
  assert.equal(result.output, 'Text answer');
  assert.equal(launches, 2);
});
