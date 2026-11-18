import assert from 'node:assert/strict';
import test from 'node:test';
import type { Conversation, ExecuteContext, MessageInput, Project, RunInput, Workflow } from '../src/shared/types.ts';
import type { Workspace } from '../src/server/workspace.ts';
import { trustedCommandTurn } from '../src/shared/permission-reason.ts';
import { codexFullAccess, deviceFullAccess } from '../src/server/adapters/device-access.ts';
import { fixture } from './helpers/session-workspace.ts';

const write: MessageInput = {
  content: 'Update the synthetic file',
  mode: 'build',
  permissionMode: 'workspace-write',
  executionPolicy: 'cli-only',
  runtimeId: 'other',
};
const runInput = (workspace: Workspace, workflow: Workflow, project: Project) =>
  (workspace as unknown as { input(workflow: Workflow, project: Project, prompt: string): RunInput }).input(
    workflow,
    project,
    'Synthetic context',
  );
/** The two messages `/search` leaves, as conversation-web-search.ts writes them. */
function search(workspace: Workspace, conversationId: string, status: 'completed' | 'failed' = 'completed') {
  const store = workspace.store;
  const message = store.addMessage(conversationId, 'user', '/search synthetic');
  const reply = store.addMessage(conversationId, 'assistant', 'Synthetic search sources');
  store.save('message', message.id, conversationId, {
    ...message,
    webSearch: { query: 'synthetic', status, replyId: reply.id },
  });
  store.save('message', reply.id, conversationId, {
    ...reply,
    webSearch: { query: 'synthetic', status },
    replyIdentity: { automatic: false, kind: 'system', runs: [] },
  });
  return reply;
}

test('only a plain write turn in a trusted project runs unnarrowed, whether typed or sent by a local caller', () => {
  const plain: RunInput = { prompt: 'x', projectPath: '/p', kind: 'auto', permissionMode: 'workspace-write' };
  assert.equal(trustedCommandTurn(plain, true), true);
  assert.equal(trustedCommandTurn(plain, false), false);
  for (const narrowed of [
    { webDriven: true },
    { permissionMode: 'read-only' as const },
    { untrustedContent: true },
    { prohibitCommands: true },
  ])
    assert.equal(trustedCommandTurn({ ...plain, ...narrowed }, true), false, JSON.stringify(narrowed));
  // A local caller's writable task counts too; executors are refused before a task exists.
  const caller = { mode: 'workspace-write', source: 'caller' } as const;
  assert.equal(trustedCommandTurn({ ...plain, permissionOrigin: caller }, true), true);
  assert.equal(trustedCommandTurn({ ...plain, permissionOrigin: caller, webDriven: true }, true), false);
  assert.equal(trustedCommandTurn({ ...plain, permissionOrigin: caller }, false), false);
  // A scheduled wake-up in a trusted project keeps the full access it had.
  assert.equal(trustedCommandTurn({ ...plain, backgroundTrigger: { kind: 'schedule', id: 's' } }, true), true);
  // A coordinator's answer to a lane question never gets an unnarrowed CLI.
  const answer = { ...plain, backgroundTrigger: { kind: 'lane-answer', id: 'q' } } as RunInput;
  assert.equal(trustedCommandTurn(answer, true), false);
  assert.equal(codexFullAccess({ input: answer, trustedProject: true } as ExecuteContext), false);
  const device = { ...plain, permissionOrigin: { mode: 'workspace-write', source: 'device' } } as RunInput;
  const ctx = (input: RunInput) => ({ input, trustedProject: true }) as ExecuteContext;
  assert.equal(deviceFullAccess(ctx(device)), true);
  assert.equal(deviceFullAccess(ctx({ ...device, webDriven: true })), false);
  assert.equal(codexFullAccess(ctx(plain)), true);
  assert.equal(codexFullAccess(ctx({ ...plain, webDriven: true })), false);
});

test('a write turn whose prompt carries PugPort search results is web-driven; reads and failed searches are not', async (t) => {
  const f = fixture(t);
  t.mock.method(f.workspace, 'wake', () => {});
  const project = await f.workspace.createProject(f.directory, 'Fixture');
  const send = async (conversationId: string, input = write) =>
    (await f.workspace.send(conversationId, input)).workflow;
  const driven = async (workflow: Workflow) => runInput(f.workspace, workflow, project).webDriven;

  const conversation = f.workspace.createConversation(project.id);
  assert.equal(await driven(await send(conversation.id)), undefined);
  search(f.workspace, conversation.id, 'failed');
  assert.equal(await driven(await send(conversation.id)), undefined);
  const reply = search(f.workspace, conversation.id);
  const after = await send(conversation.id);
  assert.equal(await driven(after), true);
  assert.equal(
    await driven(await send(conversation.id, { ...write, mode: 'chat', permissionMode: 'read-only' })),
    undefined,
  );

  // Once the search scrolls out of the 12-message context, quoting it still counts.
  for (let i = 0; i < 14; i++)
    f.workspace.store.addMessage(conversation.id, i % 2 ? 'assistant' : 'user', `filler ${i}`);
  const later = await send(conversation.id);
  assert.equal(await driven(later), undefined);
  // A child task in the same conversation inherits it from the turn that delegated it.
  const child: Workflow = { ...later, delegation: { parentId: after.id, role: 'worker', requestId: 'synthetic' } };
  assert.equal(await driven(child), true);
  const quoting = await send(conversation.id, {
    ...write,
    quotes: [{ messageId: reply.id, text: 'Synthetic search sources' }],
  } as MessageInput);
  assert.equal(await driven(quoting), true);

  // A side chat quotes its main conversation's last messages, search results included.
  const main = f.workspace.createConversation(project.id);
  search(f.workspace, main.id);
  const side = f.workspace.createConversation(project.id);
  f.workspace.store.save('conversation', side.id, project.id, {
    ...f.workspace.store.get<Conversation>('conversation', side.id)!,
    sideChat: { parentConversationId: main.id, context: '', selection: {} },
  });
  assert.equal(await driven(await send(side.id)), true);
});
