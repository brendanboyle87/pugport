import assert from 'node:assert/strict';
import test from 'node:test';
import { fork } from '../src/server/platform/test-process.ts';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store } from '../src/server/store.ts';
import type { Conversation, ConversationMessage, RuntimeTarget } from '../src/shared/types.ts';
import { externalAgentCatalog, externalAgentIds } from '../src/shared/external-agents.ts';

test(
  'external chat HTTP creation, persistence, routing and unbinding use stored bindings',
  { timeout: 60_000 },
  async (t) => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'pugport-bound-chat-')));
    const data = join(directory, 'data');
    const trace = join(directory, 'dispatch.jsonl');
    writeFileSync(trace, '');
    const source = (path: string) => JSON.stringify(pathToFileURL(join(root, path)).href);
    const bootstrap = join(directory, 'server.mjs');
    // Only delivery boundaries are synthetic; the HTTP schemas, routing, agent checks and persistence are real.
    writeFileSync(
      bootstrap,
      `
import { appendFileSync } from 'node:fs';
import { Workspace } from ${source('src/server/workspace.ts')};
import { ConversationWebSearch } from ${source('src/server/conversation-web-search.ts')};
import { Devices } from ${source('src/server/devices/service.ts')};
import { desktopWebBridge } from ${source('src/server/external-agents/web-bridge-client.ts')};
const record = kind => appendFileSync(${JSON.stringify(trace)}, JSON.stringify({kind})+'\\n');
Workspace.prototype.send = async function(id, input) {
  record('ordinary');
  return { message: this.store.addMessage(id, 'user', input.content), route: 'ordinary' };
};
ConversationWebSearch.prototype.send = async () => { record('search'); throw Error('Unexpected synthetic search'); };
Devices.prototype.messageFor = async (_input, id) => {
  if (id) { record('device'); throw Error('Unexpected synthetic device'); }
};
desktopWebBridge.available = () => true;
desktopWebBridge.request = async () => ({ ok: true, reply: 'Synthetic reply' });
await import(${source('src/server/main.ts')});
`,
    );
    const config = new Store(data);
    config.setConfig(
      'targets',
      (['codex', 'claude', 'grok', 'pi', 'cursor', 'gemini'] as const).map<RuntimeTarget>((provider) => ({
        id: `${provider}-native`,
        provider,
        label: 'Disabled synthetic fixture',
        command: 'unused',
        environment: 'native',
        enabled: false,
        commandDiscovery: 'fixed',
      })),
    );
    config.close();
    let stop: (() => Promise<void>) | undefined;
    t.after(async () => {
      await stop?.();
      assert.equal(dirname(directory).toLowerCase(), realpathSync.native(tmpdir()).toLowerCase());
      assert.ok(basename(directory).startsWith('pugport-bound-chat-'));
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    async function start() {
      const child = fork(bootstrap, [], {
        cwd: root,
        execArgv: ['--import', 'tsx'],
        windowsHide: true,
        env: {
          ...process.env,
          COMBORUNNER_ROOT: directory,
          COMBORUNNER_DATA_DIR: data,
          COMBORUNNER_SECRETS_DIR: join(directory, 'secrets'),
          COMBORUNNER_MEMORY_DIR: join(directory, 'memory'),
          COMBORUNNER_PORT: '0',
          USERPROFILE: directory,
          HOME: directory,
          JEV_API_KEY: '',
          TYPESAFE_API_KEY: '',
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      let output = '';
      child.stdout?.on('data', (chunk) => {
        output += chunk;
      });
      child.stderr?.on('data', (chunk) => {
        output += chunk;
      });
      const exited = new Promise((resolve) => child.once('exit', resolve));
      stop = async () => {
        if (child.exitCode === null && child.connected) child.send('shutdown');
        const timer = setTimeout(() => child.kill(), 5000);
        await exited;
        clearTimeout(timer);
      };
      let token = '',
        owner = '';
      const port = await new Promise<number>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', () => reject(Error(output)));
        child.on('message', (message: { type?: string; token?: string; owner?: string; port?: number }) => {
          if (message.type === 'session') {
            token = message.token ?? '';
            owner = message.owner ?? '';
          }
          if (message.type === 'ready' && message.port) resolve(message.port);
        });
      });
      return async (path: string, method = 'GET', body?: unknown, status = 200) => {
        const response = await fetch(`http://127.0.0.1:${port}${path}`, {
          method,
          headers: { 'Content-Type': 'application/json', 'x-agent-token': token, 'x-pugport-owner': owner },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(10_000),
        });
        const value = await response.json();
        assert.equal(response.status, status, JSON.stringify(value));
        return value;
      };
    }
    let request = await start();
    const open = (agentId: string): Promise<Conversation> =>
      request('/api/conversations/external-agent', 'POST', { agentId });
    const chats = new Map<string, Conversation>();
    await request('/api/conversations/external-agent', 'POST', { agentId: 'unknown' }, 400);
    await request('/api/conversations/external-agent', 'POST', { agentId: 'muse', projectId: 'untrusted' }, 400);
    for (const agentId of externalAgentIds) {
      const results = await Promise.all(Array.from({ length: 8 }, () => open(agentId)));
      assert.equal(new Set(results.map((chat) => chat.id)).size, 1);
      const chat = results[0]!;
      chats.set(agentId, chat);
      assert.equal(chat.title, externalAgentCatalog[agentId].name);
      assert.equal(chat.defaultExternalAgentId, agentId);
      assert.ok(chat.pinnedAt);
      assert.equal(chat.incognito, undefined);
      assert.equal(chat.sideChat, undefined);
      const state = await request('/api/state');
      assert.equal(state.projects.find((item: { id: string }) => item.id === chat.projectId).scope, 'chat');
      assert.equal(
        state.conversations.filter((item: Conversation) => item.defaultExternalAgentId === agentId).length,
        1,
      );
      assert.equal((await open(agentId)).id, chat.id);
      await request(`/api/conversations/${chat.id}`, 'PATCH', { pinned: false });
      assert.ok((await open(agentId)).pinnedAt);
      assert.equal((await open(agentId)).id, chat.id);
    }
    assert.notEqual(chats.get('muse')!.id, chats.get('grok-bot')!.id);
    await stop!();
    request = await start();
    for (const agentId of externalAgentIds) assert.equal((await open(agentId)).id, chats.get(agentId)!.id);
    const plain = await request('/api/conversations', 'POST', {}, 201);
    async function rejected(id: string, body: object, expected: RegExp) {
      const before = await request(`/api/conversations/${id}`);
      const dispatched = readFileSync(trace, 'utf8');
      const result = await request(`/api/conversations/${id}/messages`, 'POST', body, 400);
      assert.match(result.error, expected);
      const after = await request(`/api/conversations/${id}`);
      assert.equal(after.messages.length, before.messages.length);
      assert.equal(after.workflows.length, before.workflows.length);
      assert.equal(readFileSync(trace, 'utf8'), dispatched, 'no ordinary, search or device dispatch');
    }
    for (const agentId of externalAgentIds) {
      const chat = chats.get(agentId)!;
      await rejected(chat.id, { content: '/search synthetic' }, /尚未添加/);
      await rejected(plain.id, { content: '/search synthetic', externalAgentId: agentId, freeChain: true }, /尚未添加/);
      await request(`/api/external-agents/${agentId}`, 'PATCH', { added: true, enabled: false });
      await rejected(chat.id, { content: '/search synthetic' }, /已关闭/);
      await rejected(plain.id, { content: 'synthetic', externalAgentId: agentId }, /已关闭/);
      await request(`/api/external-agents/${agentId}`, 'PATCH', {
        enabled: true,
        ...(agentId === 'muse' ? { acceptRisk: true, url: '' } : {}),
      });
      if (agentId === 'muse') {
        await rejected(chat.id, { content: 'synthetic' }, /还没填网址/);
        await rejected(plain.id, { content: 'synthetic', externalAgentId: agentId }, /还没填网址/);
        await request('/api/external-agents/muse', 'PATCH', { url: 'https://synthetic.invalid/' });
      }
      for (const content of [
        'Synthetic plain message',
        '/search synthetic',
        `@@${externalAgentCatalog[agentId].name} synthetic`,
      ]) {
        const sent = await request(
          `/api/conversations/${chat.id}/messages`,
          'POST',
          { content, defaultExternalAgentId: 'ignored-client-value' },
          201,
        );
        assert.equal(sent.message.externalRequest.agentId, agentId);
        const saved = await request(`/api/conversations/${chat.id}`);
        assert.equal(
          saved.messages.find((message: ConversationMessage) => message.id === sent.message.id).externalRequest.agentId,
          agentId,
        );
      }
      for (const conflict of [
        { externalAgentId: agentId === 'muse' ? 'grok-bot' : 'muse' },
        { deviceId: '00000000-0000-4000-8000-000000000001' },
        {
          participants: [
            { kind: 'external', id: 'muse' },
            { kind: 'external', id: 'grok-bot' },
          ],
        },
        { freeChain: true },
        { content: agentId === 'muse' ? '@@Grok Bot synthetic' : '@@Muse synthetic' },
      ])
        await rejected(chat.id, { content: 'Synthetic conflict', ...conflict }, /请先解除绑定/);
      await request(`/api/conversations/${chat.id}`, 'PATCH', { defaultExternalAgentId: agentId }, 400);
      const before = await request(`/api/conversations/${chat.id}`);
      const unbound = await request(`/api/conversations/${chat.id}`, 'PATCH', { defaultExternalAgentId: null });
      assert.equal(unbound.defaultExternalAgentId, undefined);
      assert.equal(unbound.pinnedAt, before.conversation.pinnedAt);
      assert.deepEqual(
        (await request(`/api/conversations/${chat.id}`)).messages.map((m: ConversationMessage) => m.id),
        before.messages.map((m: ConversationMessage) => m.id),
      );
      const ordinary = await request(
        `/api/conversations/${chat.id}/messages`,
        'POST',
        { content: 'Ordinary synthetic message' },
        201,
      );
      assert.equal(ordinary.route, 'ordinary');
      assert.equal(ordinary.message.externalRequest, undefined);
      let replacement = await open(agentId);
      assert.notEqual(replacement.id, chat.id);
      await request(`/api/conversations/${replacement.id}`, 'PATCH', { archived: true });
      let previous = replacement.id;
      replacement = await open(agentId);
      assert.notEqual(replacement.id, previous);
      await request(`/api/conversations/${replacement.id}`, 'DELETE', {});
      previous = replacement.id;
      assert.notEqual((await open(agentId)).id, previous);
    }
  },
);
