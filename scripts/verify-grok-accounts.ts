import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Store } from '../src/server/store.ts';
import { Controller } from '../src/server/controller.ts';
import { Workspace } from '../src/server/workspace.ts';
import { grokAdapter } from '../src/server/adapters/grok.ts';
import { nativeAccountFingerprint, defaultGrokAccountFingerprint } from '../src/server/native-accounts.ts';
import { APP_VERSION } from '../src/shared/identity.ts';
import { resolveDataLocation } from '../src/shared/data-location.ts';
import type { RuntimeTarget, RunRecord } from '../src/shared/types.ts';

if (!process.argv.includes('--live'))
  throw new Error(
    'Use --live for up to three small real read-only Grok requests and one explicit injected quota error.',
  );
const root = resolve('.'),
  dir = join(root, 'reports', `grok-relay-${APP_VERSION}-${Date.now()}`);
mkdirSync(dir, { recursive: true });
const db = new DatabaseSync(join(resolveDataLocation({ root }).dataDir, 'studio.sqlite'), { readOnly: true });
const targets: RuntimeTarget[] = JSON.parse(
  (db.prepare("SELECT value FROM config WHERE key='targets'").get() as { value: string }).value,
);
db.close();
const a = targets.find((t) => t.id === 'grok-native')!,
  b = targets.find((t) => t.label === 'Grok B' && t.accountId)!;
assert.ok(a && b, 'Expected existing Grok and isolated Grok B.');
const firstIdentity = defaultGrokAccountFingerprint(a),
  secondIdentity = nativeAccountFingerprint(b);
assert.ok(
  firstIdentity && secondIdentity && firstIdentity !== secondIdentity,
  'Two distinct logged-in identities are required.',
);
const seed = new Store(join(dir, 'data'));
seed.setConfig('targets', [
  { ...a, enabled: true, accountFingerprint: firstIdentity },
  { ...b, enabled: true, accountFingerprint: secondIdentity },
]);
seed.setConfig('settings', {
  taskJudgment: 'local',
  architectureProvider: 'grok',
  routineProvider: 'grok',
  designProvider: 'grok',
});
seed.close();
const controller = new Controller(root, join(dir, 'data'));
clearInterval(controller.timer);
controller.targets = controller.targets.filter((t) => t.provider === 'grok');
const workspace = new Workspace(controller, { autoTick: false });
const report: Record<string, unknown> = {
  at: new Date().toISOString(),
  version: APP_VERSION,
  distinctIdentities: true,
  credentialsDisplayed: false,
  realRequestsAttempted: 0,
  tests: [],
  controlledQuotaFault: true,
  actualProviderExhaustion: false,
};
const save = () => writeFileSync(join(dir, 'result.json'), JSON.stringify(report, null, 2) + '\n');
const finish = async (id: string): Promise<RunRecord> => {
  const until = Date.now() + 90000;
  while (Date.now() < until) {
    const r = controller.store.run(id);
    if (r && ['completed', 'failed', 'cancelled', 'interrupted'].includes(r.status) && !controller.active.has(id))
      return r;
    await new Promise((done) => setTimeout(done, 150));
  }
  controller.cancel(id);
  throw new Error('Grok request did not complete in 90 seconds.');
};
const originalExecute = grokAdapter.execute;
save();
try {
  await controller.checkNativeAccount(a.id);
  await controller.checkNativeAccount(b.id);
  report.discovery = controller.nativeAccounts().accounts.map((v) => ({
    runtimeId: v.runtimeId,
    ready: v.status === 'ready',
    identityKnown: v.identityKnown,
    enabled: v.enabled,
    modelCount: v.modelCount,
  }));
  save();
  for (const target of [a, b]) {
    report.realRequestsAttempted = Number(report.realRequestsAttempted) + 1;
    save();
    const started = await controller.testConnection(target.id, 'grok-4.7-build-fast');
    const run = await finish(started.id);
    (report.tests as unknown[]).push({
      runtimeId: target.id,
      runId: run.id,
      status: run.status,
      model: run.route.model,
      effort: run.route.effort,
      outputMatches: run.output.trim() === 'STUDIO_CONNECTED',
      error: run.error,
    });
    save();
    assert.equal(run.status, 'completed');
    assert.equal(run.output.trim(), 'STUDIO_CONNECTED');
  }
  let injected = false;
  grokAdapter.execute = async (ctx) => {
    if (ctx.target.id === a.id && !injected) {
      injected = true;
      throw new Error('quota-or-rate-limit');
    }
    report.realRequestsAttempted = Number(report.realRequestsAttempted) + 1;
    save();
    return originalExecute.call(grokAdapter, ctx);
  };
  const conversation = await workspace.createGeneralConversation('Grok controlled account relay');
  const submitted = await workspace.send(conversation.id, {
    content: 'Reply exactly COMBORUNNER_RELAY_OK. Do not call any tools or change files.',
    mode: 'chat',
    permissionMode: 'read-only',
    model: 'grok-4.7-build-fast',
    effort: 'low',
    executionPolicy: 'cli-only',
    autoEscalate: true,
  });
  const until = Date.now() + 90000;
  while (Date.now() < until) {
    await workspace.tickQueue();
    const state = workspace.conversation(conversation.id),
      flow = state.workflows.find((w) => w.id === submitted.workflow.id)!;
    if (['completed', 'blocked', 'failed', 'cancelled', 'interrupted'].includes(flow.status)) {
      const runs = flow.runIds.map((id) => controller.store.run(id)!);
      report.relay = {
        status: flow.status,
        error: flow.error,
        runCount: runs.length,
        injected,
        runs: runs.map((r) => ({
          id: r.id,
          runtimeId: r.route.runtimeId,
          status: r.status,
          error: r.error,
          relay: r.relay,
          outputMatches: r.output.trim() === 'COMBORUNNER_RELAY_OK',
        })),
      };
      save();
      assert.equal(flow.status, 'completed');
      assert.equal(runs.length, 2);
      assert.equal(runs[0]!.route.runtimeId, a.id);
      assert.equal(runs[1]!.route.runtimeId, b.id);
      assert.equal(runs[1]!.output.trim(), 'COMBORUNNER_RELAY_OK');
      report.passed = true;
      break;
    }
    await new Promise((done) => setTimeout(done, 150));
  }
  assert.equal(report.passed, true, 'Controlled relay timed out.');
} catch (error) {
  report.passed = false;
  report.error = error instanceof Error ? error.message : 'verification failed';
  process.exitCode = 1;
} finally {
  grokAdapter.execute = originalExecute;
  await workspace.close();
  report.usage = controller.usage.report();
  await controller.close();
  save();
  console.log(JSON.stringify({ ...report, usage: undefined, reportDirectory: dir }, null, 2));
}
