import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Controller } from '../src/server/controller.ts';
import { Workspace } from '../src/server/workspace.ts';
import { defaultTargets } from '../src/server/discovery.ts';
import { APP_VERSION } from '../src/shared/identity.ts';

// Explicitly invoked smoke: one small live, read-only native Codex request.
if (process.argv.length > 2)
  throw new Error('Usage: node --import tsx scripts/smoke-one-for-all.ts (one live read-only native Codex request).');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const reportDirectory = join(root, 'reports', `native-one-for-all-${APP_VERSION}-${Date.now()}`);
await mkdir(reportDirectory, { recursive: true });
const controller = new Controller(root, join(reportDirectory, 'data'));
clearInterval(controller.timer);
controller.targets = defaultTargets().filter((target) => target.id === 'codex-native');
const workspace = new Workspace(controller);
const report: Record<string, unknown> = { at: new Date().toISOString(), version: APP_VERSION, realCloudRequest: false };
try {
  await controller.refresh();
  const snapshot = controller.snapshots[0];
  report.discovery = {
    runtimeId: snapshot?.id,
    status: snapshot?.status,
    models: snapshot?.models.map((model) => model.id),
    quotaStatus: snapshot?.quota.status,
  };
  if (!snapshot || snapshot.status !== 'ready' || snapshot.quota.status !== 'known')
    throw new Error('本机 Codex 尚未同时满足就绪与可靠额度条件；未发送推理请求。');
  const conversation = await workspace.createGeneralConversation(`${APP_VERSION} 本机最小验证`);
  const model = snapshot.models.find((value) => /luna/i.test(value.id)) ?? snapshot.models[0];
  if (!model) throw new Error('没有可用模型。');
  const result = await workspace.send(conversation.id, {
    content: 'Reply with exactly COMBORUNNER_OK. Do not use any tools.',
    mode: 'auto',
    permissionMode: 'read-only',
    runtimeId: snapshot.id,
    model: model.id,
    effort: model.efforts.includes('low') ? 'low' : model.defaultEffort,
    executionPolicy: 'cli-only',
    autoEscalate: false,
  });
  report.selection = 'Explicit Codex model/effort';
  report.realCloudRequest = true;
  const until = Date.now() + 90_000;
  while (Date.now() < until) {
    const state = workspace.conversation(conversation.id);
    const workflow = state.workflows.find((value) => value.id === result.workflow.id);
    if (workflow && ['completed', 'failed', 'blocked', 'cancelled', 'interrupted'].includes(workflow.status)) {
      const run = state.runs.find((value) => value.workflowId === workflow.id);
      report.workflow = {
        status: workflow.status,
        mode: workflow.input.mode,
        permissionMode: workflow.input.permissionMode,
        runCount: workflow.runIds.length,
        error: workflow.error,
        taskJudgment: workflow.taskJudgment,
      };
      report.run = run
        ? {
            status: run.status,
            runtimeId: run.route.runtimeId,
            model: run.route.model,
            effort: run.route.effort,
            outputMatches: run.output.trim() === 'COMBORUNNER_OK',
            error: run.error,
          }
        : null;
      report.usage = controller.usage.report().totals;
      if (workflow.status !== 'completed' || !run || run.output.trim() !== 'COMBORUNNER_OK')
        throw new Error('真实任务未通过预期输出验证。');
      report.passed = true;
      break;
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  if (!report.passed) throw new Error('真实任务超时；已停止本次验证任务。');
} catch (error) {
  report.passed = false;
  report.error = error instanceof Error ? error.message : 'smoke-failed';
  process.exitCode = 1;
} finally {
  await workspace.close();
  await controller.close();
  await writeFile(join(reportDirectory, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ...report, reportDirectory }, null, 2));
}
