import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { codexAdapter } from '../src/server/adapters/codex.ts';
import { skippedLaya } from '../src/server/laya-workflow.ts';
import type { ExecuteContext, Workflow } from '../src/shared/types.ts';
import { fixture, result } from './helpers/session-workspace.ts';

async function until(check: () => boolean, label: string) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Synthetic Laya interleaving did not settle: ${label}`);
}

test('a delayed Laya record ID merges into current storage without overwriting independent workflow metadata', async (t) => {
  const f = fixture(t);
  f.controller.settings.laya = { enabled: false, recordTraining: true };
  t.mock.method(f.controller, 'machineReading', () => ({
    sampledAt: Date.now(),
    totalBytes: 32 * 1024 ** 3,
    availableMemoryBytes: 16 * 1024 ** 3,
    cpus: 16,
    cpuPercent: 20,
  }));
  t.mock.method(f.controller.laya, 'predict', async () => skippedLaya('synthetic-no-model'));
  let resolveCapture!: (id: string | undefined) => void;
  const captured = new Promise<string | undefined>((resolve) => {
    resolveCapture = resolve;
  });
  const capture = t.mock.method(f.controller.layaReviews, 'capture', async () => captured);
  const updateOutcome = t.mock.method(f.controller.layaReviews, 'updateOutcome', async () => {});
  let releaseNative!: () => void;
  const native = new Promise<void>((resolve) => {
    releaseNative = resolve;
  });
  let nativeContext: ExecuteContext | undefined;
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    nativeContext = ctx;
    await native;
    return result('completed', 'Synthetic inspection complete');
  });
  const newId = `2026-10-26/${randomUUID()}`;
  const existingId = `2026-10-26/${randomUUID()}`;
  try {
    const conversation = await f.workspace.createGeneralConversation();
    const submitted = await f.workspace.send(conversation.id, {
      content: 'Explain the synthetic parser.',
      mode: 'chat',
      permissionMode: 'read-only',
      executionPolicy: 'cli-only',
      runtimeId: 'mock',
      model: 'mock-model',
      effort: 'medium',
      autoEscalate: false,
    });
    await until(() => !!nativeContext, 'native executor started while capture is pending');
    assert.ok(capture.mock.callCount() > 0);
    const active = (f.workspace as unknown as { active: Map<string, { workflow: Workflow }> }).active.get(
      submitted.workflow.id,
    )!.workflow;
    const latest = f.workspace.store.get<Workflow>('workflow', submitted.workflow.id)!;
    assert.notEqual(latest, active);
    latest.deliveryPendingReason = 'Synthetic delivery metadata saved after native launch';
    latest.layaReviewIds = [existingId];
    f.workspace.store.save('workflow', latest.id, latest.conversationId, latest);
    assert.equal(active.deliveryPendingReason, undefined, 'the executor retains an older object than storage');
    resolveCapture(newId);
    await until(() => updateOutcome.mock.callCount() > 0, 'capture completion merged and outcome scheduled');
    const saved = f.workspace.store.get<Workflow>('workflow', submitted.workflow.id)!;
    assert.equal(saved.deliveryPendingReason, latest.deliveryPendingReason);
    assert.deepEqual(saved.layaReviewIds, [existingId, newId]);
    assert.deepEqual(
      active.layaReviewIds,
      saved.layaReviewIds,
      'later native publications retain the merged record IDs',
    );
    assert.equal(nativeContext!.signal.aborted, false);
  } finally {
    resolveCapture(undefined);
    releaseNative();
  }
});
