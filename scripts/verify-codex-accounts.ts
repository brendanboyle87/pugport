import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Store } from '../src/server/store.ts';
import { Controller } from '../src/server/controller.ts';
import { Workspace } from '../src/server/workspace.ts';
import { codexAdapter } from '../src/server/adapters/codex.ts';
import {
  nativeAccountFingerprint,
  defaultNativeAccountFingerprint,
  nativeAccountLoginPending,
} from '../src/server/native-accounts.ts';
import { APP_VERSION } from '../src/shared/identity.ts';
import { resolveDataLocation } from '../src/shared/data-location.ts';
import type { RuntimeTarget, RunRecord } from '../src/shared/types.ts';

const live = process.argv.includes('--live');
if (!live && !process.argv.includes('--discover'))
  throw new Error(
    'Use --discover for read-only account/catalog/quota checks, or --live for up to three small model requests and an injected quota failure.',
  );
const root = resolve('.'),
  dir = join(root, 'reports', `codex-relay-${APP_VERSION}-${Date.now()}`);
mkdirSync(dir, { recursive: true });
const db = new DatabaseSync(join(resolveDataLocation({ root }).dataDir, 'studio.sqlite'), { readOnly: true });
const targets: RuntimeTarget[] = JSON.parse(
  (db.prepare("SELECT value FROM config WHERE key='targets'").get() as { value: string }).value,
);
db.close();
const a = targets.find((t) => t.id === 'codex-native'),
  b = targets.find((t) => t.label === 'Codex B' && t.accountId);
assert.ok(a && b, 'Expected existing Codex and isolated Codex B.');
assert.equal(nativeAccountLoginPending(b), false, 'Finish login before verification.');
const firstIdentity = defaultNativeAccountFingerprint(a),
  secondIdentity = nativeAccountFingerprint(b);
assert.ok(
  firstIdentity && secondIdentity && firstIdentity !== secondIdentity,
  'Two distinct logged-in identities are required.',
);
const report: Record<string, unknown> = {
  at: new Date().toISOString(),
  version: APP_VERSION,
  distinctIdentities: true,
  credentialsDisplayed: false,
  realRequestsAttempted: 0,
  tests: [],
  controlledQuotaFault: live,
  actualProviderExhaustion: false,
};
const save = () => writeFileSync(join(dir, 'result.json'), JSON.stringify(report, null, 2) + '\n');
save();
const discovered = await Promise.all([a, b].map((target) => codexAdapter.discover(target)));
report.discovery = discovered.map((s) => ({
  runtimeId: s.id,
  status: s.status,
  authMode: s.authMode,
  modelCount: s.models.length,
  quota: s.quota,
}));
save();
assert.ok(
  discovered.every((s) => s.status === 'ready' && s.authMode === 'chatgpt'),
  'Both official CLIs must report ready ChatGPT authentication.',
);
const common = discovered[0]!.models.filter((m) => discovered[1]!.models.some((other) => other.id === m.id));
const model = common.find((m) => /luna/.test(m.id)) ?? common.find((m) => m.lightweight) ?? common[0];
assert.ok(model, 'No common model in the official account catalogs.');
const otherModel = discovered[1]!.models.find((m) => m.id === model.id)!;
const efforts = model.efforts.filter((e) => otherModel.efforts.includes(e));
const effort = efforts.includes('low') ? 'low' : efforts[0];
report.selection = { model: model.id, effort };
save();
if (!live) {
  report.passed = true;
  save();
  console.log(JSON.stringify({ ...report, reportDirectory: dir }, null, 2));
} else {
  const seed = new Store(join(dir, 'data'));
  seed.setConfig('targets', [
    { ...a, enabled: true, accountFingerprint: firstIdentity },
    { ...b, enabled: true, accountFingerprint: secondIdentity },
  ]);
  seed.setConfig('settings', {
    taskJudgment: 'local',
    architectureProvider: 'codex',
    routineProvider: 'codex',
    designProvider: 'codex',
  });
  seed.close();
  const controller = new Controller(root, join(dir, 'data'));
  clearInterval(controller.timer);
  controller.targets = controller.targets.filter((t) => t.provider === 'codex');
  const workspace = new Workspace(controller, { autoTick: false });
  const finish = async (id: string): Promise<RunRecord> => {
    const until = Date.now() + 90_000;
    while (Date.now() < until) {
      const run = controller.store.run(id);
      if (run && ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status) && !controller.active.has(id))
        return run;
      await new Promise((done) => setTimeout(done, 150));
    }
    controller.cancel(id);
    throw new Error('Codex request did not complete in 90 seconds.');
  };
  const originalExecute = codexAdapter.execute;
  try {
    await controller.checkNativeAccount(a.id);
    await controller.checkNativeAccount(b.id);
    for (const target of [a, b]) {
      const started = await controller.testConnection(target.id, model.id);
      report.realRequestsAttempted = Number(report.realRequestsAttempted) + 1;
      save();
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
    // Let the real scheduler choose the first account. The one injected failure
    // happens before contacting that account's model; the replacement is real.
    let failedRuntime: string | undefined;
    codexAdapter.execute = async (ctx) => {
      if (!failedRuntime) {
        failedRuntime = ctx.target.id;
        throw new Error('quota-or-rate-limit');
      }
      report.realRequestsAttempted = Number(report.realRequestsAttempted) + 1;
      save();
      return originalExecute.call(codexAdapter, ctx);
    };
    const conversation = await workspace.createGeneralConversation('Codex controlled account relay');
    const submitted = await workspace.send(conversation.id, {
      content: 'Reply exactly COMBORUNNER_RELAY_OK. Do not call tools, read files, or change anything.',
      mode: 'chat',
      provider: 'codex',
      permissionMode: 'read-only',
      model: model.id,
      effort,
      executionPolicy: 'cli-only',
      autoEscalate: true,
    });
    const until = Date.now() + 90_000;
    while (Date.now() < until) {
      await workspace.tickQueue();
      const flow = workspace.conversation(conversation.id).workflows.find((w) => w.id === submitted.workflow.id)!;
      if (['completed', 'blocked', 'failed', 'cancelled', 'interrupted'].includes(flow.status)) {
        const runs = flow.runIds.map((id) => controller.store.run(id)!);
        report.relay = {
          status: flow.status,
          error: flow.error,
          runCount: runs.length,
          injected: !!failedRuntime,
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
        assert.equal(runs[0]!.route.runtimeId, failedRuntime);
        assert.notEqual(runs[1]!.route.runtimeId, failedRuntime);
        assert.equal(runs[1]!.output.trim(), 'COMBORUNNER_RELAY_OK');
        assert.equal(runs[0]!.route.model, runs[1]!.route.model);
        assert.equal(runs[0]!.route.effort, runs[1]!.route.effort);
        report.passed = true;
        break;
      }
      await new Promise((done) => setTimeout(done, 150));
    }
    assert.equal(report.passed, true, 'Controlled relay timed out.');
    report.originalIdentityPreserved = defaultNativeAccountFingerprint(a) === firstIdentity;
    report.secondIdentityPreserved = nativeAccountFingerprint(b) === secondIdentity;
    assert.equal(report.originalIdentityPreserved, true);
    assert.equal(report.secondIdentityPreserved, true);
  } catch (error) {
    report.passed = false;
    report.error = error instanceof Error ? error.message : 'verification failed';
    process.exitCode = 1;
  } finally {
    codexAdapter.execute = originalExecute;
    await workspace.close();
    report.usage = controller.usage.report();
    await controller.close();
    save();
    console.log(JSON.stringify({ ...report, usage: undefined, reportDirectory: dir }, null, 2));
  }
}
