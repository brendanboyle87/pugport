import assert from 'node:assert/strict';
import test from 'node:test';
import type { Conversation } from '../src/shared/types.ts';
import type { Api } from '../src/ui/Workspace.tsx';
import { openModConversation } from '../src/ui/mod-open.ts';

const mode = { id: 'synthetic.notes', version: '2.1.0', title: 'Synthetic notes' };
const chat = (id: string): Conversation => ({
  id,
  title: id,
  projectId: 'unchanged-project',
  createdAt: '2026-01-01',
  updatedAt: '2026-10-31',
  modeBinding: { modeId: mode.id, version: mode.version, instanceId: id },
});
test('Open reuses attachment order, reveals the Mod and never moves or recreates a chat', async () => {
  const calls: { path: string; body: unknown; method?: string }[] = [];
  const chats: Conversation[] = [chat('old'), { ...chat('recent'), updatedAt: '2026-01-01', modeHidden: true }];
  const api = (async (path, body, method) => {
    calls.push({ path, body, method });
    if (path.endsWith('/mode')) {
      const id = path.split('/')[3]!;
      return {
        installed: true,
        binding: chat(id).modeBinding,
        instance: { createdAt: id === 'old' ? '2026-01-01' : '2026-10-01' },
      };
    }
    return { ...chats[1], modeHidden: undefined };
  }) as Api;
  const result = await openModConversation(api, chats, mode);
  assert.equal(result?.id, 'recent');
  assert.equal(result?.projectId, 'unchanged-project');
  assert.deepEqual(
    calls.filter((c) => c.method !== 'GET'),
    [
      {
        path: '/api/conversations/recent/mode/visibility',
        body: { hidden: false, expectedInstanceId: 'recent' },
        method: 'PUT',
      },
    ],
  );
});
test('Open creates one ordinary chat and attaches only when no eligible chat exists', async () => {
  const calls: unknown[] = [];
  const created = { ...chat('new'), modeBinding: undefined };
  const api = (async (path, body, method) => {
    calls.push([path, body, method]);
    if (path === '/api/conversations') return created;
    if (path.endsWith('/mode')) return { binding: chat('new').modeBinding };
    return chat('new');
  }) as Api;
  const result = await openModConversation(
    api,
    [
      { ...chat('deleted'), deletedAt: 'now' },
      { ...chat('side'), sideChat: { parentConversationId: 'parent' } as Conversation['sideChat'] },
    ],
    mode,
  );
  assert.equal(result?.id, 'new');
  assert.deepEqual(calls, [
    ['/api/conversations', { title: mode.title }, undefined],
    ['/api/conversations/new/mode', { modeId: mode.id, version: mode.version }, 'PUT'],
    ['/api/conversations/new/mode/visibility', { hidden: false, expectedInstanceId: 'new' }, 'PUT'],
  ]);
});
test('reattaching an old saved instance takes precedence over its original creation time', async () => {
  const api = (async (path, body) => {
    const id = path.split('/')[3]!;
    if (path.endsWith('/mode'))
      return {
        installed: true,
        binding: { ...chat(id).modeBinding, attachedAt: id === 'old' ? '2026-10-31' : '2026-10-01' },
        instance: { createdAt: id === 'old' ? '2026-01-01' : '2026-10-01' },
      };
    assert.equal((body as { expectedInstanceId: string }).expectedInstanceId, 'old');
    return chat(id);
  }) as Api;
  assert.equal((await openModConversation(api, [chat('old'), chat('recent')], mode))?.id, 'old');
});
test('navigation during lookup cannot mutate a chat or create a new one', async () => {
  let current = true;
  const calls: string[] = [];
  const api = (async (path) => {
    calls.push(path);
    current = false;
    return { installed: true, binding: chat('a').modeBinding, instance: { createdAt: '2026-10-01' } };
  }) as Api;
  assert.equal(await openModConversation(api, [chat('a')], mode, () => current), undefined);
  assert.deepEqual(calls, ['/api/conversations/a/mode']);
});
