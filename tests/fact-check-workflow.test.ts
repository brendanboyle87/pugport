import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Controller } from '../src/server/controller.ts';
import { Workspace } from '../src/server/workspace.ts';
import { codexAdapter } from '../src/server/adapters/codex.ts';
import { claudeAdapter } from '../src/server/adapters/claude.ts';
import { factCheckMarker, factCheckPrompt } from '../src/server/fact-check.ts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FactCheck } from '../src/ui/ClaimsCheck.tsx';
import type { ExecuteContext, MessageInput, RuntimeSnapshot, RuntimeTarget, Workflow } from '../src/shared/types.ts';

const question = '示例服务的保留期限是多少？';
const url = 'https://example.org/policy';
const checked = (status = 'verified', claim = 'Retention is 30 days') =>
  `${factCheckMarker} ${JSON.stringify({ claims: [{ claim, status, source: url, ...(status === 'wrong' ? { correction: 'Retention is 60 days' } : {}) }] })}`;
function fixture(
  t: TestContext,
  verdicts: Array<string | Error>,
  options: {
    tool?: string;
    noWeb?: boolean;
    singleVendor?: boolean;
    noClaims?: boolean;
    hang?: boolean;
    skipCheckerSearch?: boolean;
    childWeb?: boolean;
  } = {},
) {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'fact-workflow-test-')));
  const controller = new Controller(directory, join(directory, 'data'));
  clearInterval(controller.timer);
  controller.settings.decisionMode = 'auto';
  controller.settings.routePreferencesEnabled = true;
  controller.settings.architectureProvider = 'codex';
  controller.settings.routineProvider = 'codex';
  controller.settings.designProvider = 'codex';
  controller.targets = (['codex', 'claude'] as const).map((provider): RuntimeTarget => ({
    id: provider,
    provider,
    label: provider,
    command: 'unused',
    environment: 'native',
    enabled: true,
  }));
  controller.snapshots = controller.targets.map((target): RuntimeSnapshot => ({
    ...target,
    installed: true,
    status: 'ready',
    models: [{ id: 'test-model', label: 'Test model', efforts: ['low', 'medium', 'high'] }],
    quota: {
      status: 'known',
      source: 'fixture',
      observedAt: new Date().toISOString(),
      windows: [
        { id: 'week', label: 'week', usedPercent: 10, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
      ],
    },
    capabilities: { execute: true, resume: true, cancel: true, approvals: true },
    refreshedAt: new Date().toISOString(),
  }));
  t.mock.method(controller, 'refresh', async () => {});
  if (options.singleVendor) {
    controller.targets = controller.targets.filter((target) => target.provider === 'codex');
    controller.snapshots = controller.snapshots.filter((target) => target.provider === 'codex');
  }
  const queries: string[] = [];
  t.mock.method(controller.webSearch, 'search', async ({ query }: { query: string }) => {
    queries.push(query);
    return { query, results: [{ title: 'Synthetic primary policy', url, summary: 'Retention is 60 days' }] };
  });
  const calls: ExecuteContext[] = [];
  const execute = async (ctx: ExecuteContext) => {
    calls.push(ctx);
    const checker = !!ctx.input.verifierOf;
    if (!checker && options.childWeb) {
      const parent = workspace.store.get<Workflow>('workflow', ctx.input.workflowId!)!;
      const run = [...controller.active.values()].find((entry) => entry.run.workflowId === parent.id)!.run;
      const childId = `${parent.id}-research`;
      controller.store.saveRun({
        ...run,
        id: childId,
        workflowId: childId,
        status: 'completed',
        webInformationUsed: true,
      });
      workspace.store.save('workflow', childId, parent.conversationId, {
        ...parent,
        id: childId,
        status: 'completed',
        input: { ...parent.input, review: undefined },
        delegation: { parentId: parent.id, role: 'scout', requestId: 'synthetic-research' },
        runIds: [childId],
      });
    }
    if (checker && options.hang)
      await new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => resolve(), { once: true }));
    if ((!checker && !options.noWeb) || (ctx.input.factCheck && !options.skipCheckerSearch)) {
      const result = await controller.webSearch.search({ query: checker ? 'Example retention policy' : question });
      ctx.emit({
        at: new Date().toISOString(),
        type: 'tool',
        data: { tool: options.tool ?? 'web_search', output: result },
      });
    }
    if (checker) {
      const result = verdicts.shift() ?? checked();
      if (result instanceof Error) throw result;
      return { output: result, nativeSessionId: `check-session-${calls.length}` };
    }
    const claim = ctx.input.prompt.includes('Retention is 60 days') ? 'Retention is 60 days' : 'Retention is 30 days';
    return {
      output: `ANSWER_PRIVATE_EXPLANATION ${claim} [policy](${url})\nCOMBORUNNER_TASK_RESULT: ${JSON.stringify({ status: 'completed', ...(!options.noClaims ? { claims: [{ claim }] } : {}) })}`,
      nativeSessionId: 'worker-session',
    };
  };
  t.mock.method(codexAdapter, 'execute', execute);
  t.mock.method(claudeAdapter, 'execute', execute);
  let clock = Date.now();
  const workspace = new Workspace(controller, { autoTick: false, now: () => clock });
  t.after(async () => {
    await workspace.close();
    await controller.close();
    const absolute = resolve(directory);
    assert.ok(
      absolute.startsWith(realpathSync.native(tmpdir()) + sep) && basename(absolute).startsWith('fact-workflow-test-'),
    );
    rmSync(absolute, { recursive: true, force: true });
  });
  return {
    workspace,
    calls,
    directory,
    controller,
    queries,
    advance: () => {
      clock += 11 * 60_000;
    },
  };
}
const input: MessageInput = {
  content: question,
  mode: 'build',
  permissionMode: 'read-only',
  executionPolicy: 'cli-first',
  autoEscalate: false,
  review: true,
};
async function settle(workspace: Workspace, conversationId: string) {
  for (let i = 0; i < 600; i++) {
    await workspace.tickQueue();
    const flows = workspace.store.workflows(conversationId);
    const busy = flows.some(
      (w) =>
        !['completed', 'blocked', 'failed', 'cancelled', 'interrupted'].includes(w.status) ||
        w.review?.status === 'reviewing' ||
        (w.input.review && !w.delegation && w.status === 'completed' && !w.review),
    );
    if (!busy) return flows;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error('review did not settle');
}

async function start(f: ReturnType<typeof fixture>, override: Partial<MessageInput> = {}, profile = false) {
  const project = await f.workspace.createProject(f.directory);
  f.workspace.setProjectRules(project.id, ['PRIVATE_PROJECT_RULE']);
  f.workspace.store.setMemory(project.id, 'PRIVATE_MEMORY');
  f.workspace.store.setMemoryAuto(project.id, {
    content: 'PRIVATE_AUTO_MEMORY',
    sourceRuntimeId: 'synthetic',
    runId: 'synthetic',
  });
  f.workspace.store.save('worklog', 'synthetic-log', project.id, { at: 'now', summary: 'PRIVATE_PROJECT_NOTES' });
  f.controller.settings.globalInstructions = 'PRIVATE_GLOBAL_INSTRUCTION';
  const conversation = f.workspace.createConversation(project.id);
  f.workspace.store.addMessage(conversation.id, 'user', 'PRIVATE_HISTORY_QUESTION');
  f.workspace.store.addMessage(conversation.id, 'assistant', 'PRIVATE_PREVIOUS_OUTPUT');
  if (profile) {
    conversation.routing = {
      version: 2,
      text: '',
      rules: [],
      unparsed: [],
      updatedAt: 'now',
      chapterAgents: false,
      mask: false,
      roles: {
        coordinator: { provider: 'codex', model: 'test-model' },
        verifier: [{ provider: 'codex' }, { provider: 'claude', model: 'test-model', effort: 'high' }],
      },
    };
    f.workspace.store.save('conversation', conversation.id, project.id, conversation);
  }
  const sent = await f.workspace.send(conversation.id, { ...input, ...override });
  return { conversation, sent, project };
}
const parents = (flows: Workflow[]) =>
  flows.filter((flow) => !flow.delegation).sort((a, b) => a.review!.round - b.review!.round);
const html = (workflow: Workflow) =>
  renderToStaticMarkup(createElement(FactCheck, { result: workflow.review!.factCheck! }));

test('web completion starts an isolated fresh checker and saves a verified compact result', async (t) => {
  const f = fixture(t, [checked()]);
  const { conversation } = await start(f);
  const flows = await settle(f.workspace, conversation.id);
  const task = parents(flows)[0]!;
  assert.equal(task.review?.status, 'passed');
  assert.match(html(task), /核验：已核实 1 条 · 无法核实 0 条/);
  const checker = f.calls.find((call) => call.input.verifierOf)!;
  assert.equal(checker.target.provider, 'claude');
  assert.equal(checker.input.permissionMode, 'read-only');
  assert.equal(checker.nativeSessionId, undefined);
  assert.equal(checker.input.resumeRunId, undefined);
  assert.equal(checker.input.continuationRunId, undefined);
  assert.deepEqual(checker.input.skills, []);
  assert.equal(checker.input.autoMemoryDirectory, undefined);
  assert.notEqual(checker.input.projectPath, f.directory);
  assert.equal(flows.find((flow) => flow.delegation?.review?.factCheck)?.memoryExcerpt, '');
  assert.doesNotMatch(JSON.stringify(checker.input), /PRIVATE_|ANSWER_PRIVATE_EXPLANATION/);
  assert.equal(
    checker.input.prompt,
    factCheckPrompt(question, `[policy](${url})`, [{ claim: 'Retention is 30 days' }]),
  );
  assert.ok(f.queries.length >= 2, 'executor and checker searched independently through the mocked provider');
  const { WorkspaceStore } = await import('../src/server/workspace-store.ts');
  const reopened = new DatabaseSync(join(f.controller.store.directory, 'studio.sqlite'));
  try {
    const reloaded = new WorkspaceStore(reopened);
    assert.deepEqual(reloaded.get<Workflow>('workflow', task.id)?.review, task.review);
  } finally {
    reopened.close();
  }
});

test('a wrong fact goes through the original executor redo loop and is counted only after recheck', async (t) => {
  const f = fixture(t, [checked('wrong'), checked('verified', 'Retention is 60 days')]);
  const { conversation } = await start(f);
  const tasks = parents(await settle(f.workspace, conversation.id));
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0]!.review?.successorId, tasks[1]!.id);
  assert.equal(tasks[0]!.review?.status, 'fixing');
  assert.ok(tasks[1]!.input.content.includes('更正：Retention is 60 days'));
  assert.equal(tasks[1]!.input.runtimeId, 'codex');
  assert.equal(tasks[1]!.review?.status, 'passed');
  assert.match(html(tasks[1]!), /已更正 1 条/);
  assert.match(
    f.workspace.store.get<{ content: string }>('message', tasks[1]!.finalMessageId!)!.content,
    /Retention is 60 days/,
  );
  const checks = f.calls.filter((call) => call.input.verifierOf);
  assert.equal(checks.length, 2);
  for (const check of checks) assert.equal(check.nativeSessionId, undefined);
});

for (const failure of [new Error('synthetic checker timeout'), 'invalid checker output'])
  test(`checker failure preserves the answer: ${String(failure)}`, async (t) => {
    const f = fixture(t, [failure]);
    const { conversation } = await start(f);
    const task = parents(await settle(f.workspace, conversation.id))[0]!;
    assert.equal(task.status, 'completed');
    assert.equal(task.review?.status, 'stopped');
    assert.match(html(task), /核验未完成/);
    assert.equal(task.review?.successorId, undefined);
    assert.ok(
      f.workspace.store
        .get<{ content: string }>('message', task.finalMessageId!)
        ?.content.includes('ANSWER_PRIVATE_EXPLANATION'),
    );
  });

test('without web information the engineering/writing reviewer still crosses vendors', async (t) => {
  const f = fixture(t, ['COMBORUNNER_REVIEW {"verdict":"pass","reason":"Checked"}'], { noWeb: true });
  const { conversation } = await start(f);
  const task = parents(await settle(f.workspace, conversation.id))[0]!;
  assert.equal(task.review?.status, 'passed');
  assert.equal(task.review?.factCheck, undefined);
  const checker = f.calls.find((call) => call.input.verifierOf)!;
  assert.equal(checker.target.provider, 'claude');
  assert.match(checker.input.prompt, /写代码、改配置、处理文件/);
  assert.equal(f.queries.length, 0);
});

test('profile completion check skips same-vendor candidate and retains ordered verifier effort', async (t) => {
  const f = fixture(t, [checked()], { tool: 'WebFetch' });
  const { conversation, sent } = await start(f, { review: undefined }, true);
  assert.equal(sent.workflow.input.review, true);
  const task = parents(await settle(f.workspace, conversation.id))[0]!;
  assert.equal(task.review?.status, 'passed');
  const checker = f.calls.find((call) => call.input.verifierOf)!;
  assert.equal(checker.route.runtimeId, 'claude');
  assert.equal(checker.route.effort, 'high');
  assert.match(checker.route.reasons.join('\n'), /核验候选 1 不可用/);
});

test('single vendor uses the same model with different effort and a fresh session', async (t) => {
  const f = fixture(t, [checked()], { singleVendor: true });
  const { conversation } = await start(f);
  const task = parents(await settle(f.workspace, conversation.id))[0]!;
  assert.equal(task.review?.status, 'passed');
  const worker = f.calls[0]!;
  const checker = f.calls.find((call) => call.input.verifierOf)!;
  assert.equal(checker.route.runtimeId, worker.route.runtimeId);
  assert.equal(checker.route.model, worker.route.model);
  assert.notEqual(checker.route.effort, worker.route.effort);
  assert.equal(checker.nativeSessionId, undefined);
  assert.match(checker.route.reasons.join('\n'), /核验降级/);
});

test('/search triggers checking without an executor web tool, using the original question', async (t) => {
  const f = fixture(t, [checked()], { noWeb: true, noClaims: true });
  const { conversation } = await start(f, {
    searchAlreadyPerformed: true,
    intentText: question,
    content: 'SEARCH_WRAPPER_PRIVATE + search results',
  });
  const task = parents(await settle(f.workspace, conversation.id))[0]!;
  assert.equal(task.review?.status, 'passed');
  const checker = f.calls.find((call) => call.input.verifierOf)!;
  assert.doesNotMatch(checker.input.prompt, /SEARCH_WRAPPER_PRIVATE/);
  assert.match(checker.input.prompt, /最多 12 条/);
  assert.match(checker.input.prompt, /ANSWER_PRIVATE_EXPLANATION/);
  assert.equal(checker.input.searchAlreadyPerformed, undefined, 'checker may independently search again');
});

test('a stuck checker is cancelled after its persisted deadline and leaves an incomplete result', async (t) => {
  const f = fixture(t, [checked()], { hang: true });
  const { conversation } = await start(f);
  for (let n = 0; n < 400 && !f.calls.some((call) => call.input.verifierOf); n++) {
    await f.workspace.tickQueue();
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  assert.ok(f.calls.some((call) => call.input.verifierOf));
  f.advance();
  await f.workspace.tickQueue();
  const task = parents(await settle(f.workspace, conversation.id))[0]!;
  assert.match(html(task), /核验未完成/);
  assert.match(task.review!.factCheck!.reason!, /超时/);
});

test('/search redo keeps the original question out of previous review context', async (t) => {
  const f = fixture(t, [checked('wrong'), checked('verified', 'Retention is 60 days')], { noWeb: true });
  const { conversation } = await start(f, {
    searchAlreadyPerformed: true,
    intentText: question,
    content: 'PRIVATE_SEARCH_WRAPPER',
  });
  const tasks = parents(await settle(f.workspace, conversation.id));
  assert.equal(tasks.length, 2);
  assert.match(html(tasks[1]!), /已更正 1 条/);
  const checkers = f.calls.filter((call) => call.input.factCheck);
  assert.equal(checkers.length, 2);
  for (const checker of checkers) {
    const payload = JSON.parse(checker.input.prompt.split('输入数据：')[1]!.split('\n')[0]!);
    assert.equal(payload.question, question);
    assert.deepEqual(Object.keys(payload), ['question', 'claims', 'sources']);
    assert.doesNotMatch(checker.input.prompt, /PRIVATE_SEARCH_WRAPPER|审核员认为|父任务已有结果/);
  }
});

test('two correction rounds count unique corrected claims and retain the bounded redo loop', async (t) => {
  const f = fixture(t, [checked('wrong', 'First wrong fact'), checked('wrong', 'Second wrong fact'), checked()]);
  const { conversation } = await start(f);
  const tasks = parents(await settle(f.workspace, conversation.id));
  assert.equal(tasks.length, 3);
  assert.match(html(tasks[2]!), /已更正 2 条/);
});

test('a checker cannot certify facts without independently using a web tool', async (t) => {
  const f = fixture(t, [checked()], { skipCheckerSearch: true });
  const { conversation } = await start(f);
  const task = parents(await settle(f.workspace, conversation.id))[0]!;
  assert.match(html(task), /核验未完成/);
  assert.match(task.review!.factCheck!.reason!, /没有独立检索来源/);
});

test('web research done by a child triggers checking of the parent answer', async (t) => {
  const f = fixture(t, [checked()], { noWeb: true, childWeb: true });
  const { conversation } = await start(f);
  const task = parents(await settle(f.workspace, conversation.id))[0]!;
  assert.equal(task.review?.status, 'passed');
  assert.match(html(task), /核验：已核实 1 条/);
  assert.ok(f.calls.some((call) => call.input.factCheck));
  assert.equal(
    task.runIds.some((id) => f.controller.run(id)?.webInformationUsed),
    false,
  );
});
