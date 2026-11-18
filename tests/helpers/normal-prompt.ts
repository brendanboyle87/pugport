import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { join } from 'node:path';
import type { ExecuteContext } from '../../src/shared/types.ts';
import { codexAdapter } from '../../src/server/adapters/codex.ts';
import { localComputer } from '../../src/server/platform/computer-context.ts';
import { idleMachineReading } from './machine-reading.ts';
import { fixture, settled, input, result } from './session-workspace.ts';

/** Capture the real Normal dispatch, replacing only volatile fixture identity and the clock line. */
export async function normalPrompt(t: TestContext, mode: 'chat' | 'build') {
  t.mock.method(localComputer, 'summary', () => 'Synthetic computer: 8 CPUs, 32 GiB RAM.');
  t.mock.method(localComputer, 'refresh', async () => {});
  const f = fixture(t, false);
  t.mock.method(f.controller, 'machineReading', idleMachineReading);
  f.controller.targets = f.controller.targets.slice(0, 1);
  f.controller.snapshots = f.controller.snapshots.slice(0, 1);
  f.controller.settings.globalInstructions = 'PERSONAL_FIXTURE';
  let captured = '';
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    captured = ctx.input.prompt;
    return result('completed', 'Synthetic reply.');
  });
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  const sent = await f.workspace.send(conversation.id, { ...input, mode, runtimeId: 'mock' });
  assert.equal((await settled(f.workspace, sent.workflow.id)).status, 'completed');
  assert.equal(sent.workflow.input.workMode, undefined);
  assert.ok(captured);
  return captured
    .replaceAll(
      join(f.directory, 'memory', project.id, 'conversations', conversation.id, 'handoff.md'),
      'DIRECTORY/memory/PROJECT/conversations/CONVERSATION/handoff.md',
    )
    .replaceAll(
      join(f.directory, 'memory', project.id, 'conversations', conversation.id, 'history.jsonl'),
      'DIRECTORY/memory/PROJECT/conversations/CONVERSATION/history.jsonl',
    )
    .replaceAll(f.directory, 'DIRECTORY')
    .replaceAll(project.id, 'PROJECT')
    .replaceAll(conversation.id, 'CONVERSATION')
    .replace(
      /^日期：\d{4}-\d{2}-\d{2} \d{2}:\d{2}（[^\n]+；ISO：[^\n]+）$/m,
      '日期：FIXED_DATE（FIXED_ZONE；ISO：FIXED_ISO）',
    );
}
