// Explicit live validation: sends a few small real model tasks to existing configured accounts.
import { fork } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
if (!process.argv.includes('--live'))
  throw new Error('Pass --live to authorize real model requests. Optional: cli, pi.');
const selected = process.argv.slice(2).filter((x) => !x.startsWith('--'));
if (selected.some((x) => !['cli', 'pi'].includes(x)))
  throw new Error('Only cli and pi are active in the core runtime.');
const root = process.cwd(),
  port = 4321,
  base = `http://127.0.0.1:${port}`;
const directory = resolve('reports/unified-workspace'),
  dataDir = resolve('.data/unified-validation');
await mkdir(directory, { recursive: true });
const child = fork(resolve('src/server/main.ts'), [], {
  execArgv: ['--import', 'tsx'],
  env: { ...process.env, AGENT_STUDIO_PORT: String(port), AGENT_STUDIO_DATA_DIR: dataDir },
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
});
child.stdout.resume();
child.stderr.resume();
const results = [];
let token;
let owner;
const get = (path) =>
  fetch(base + path, { headers: { 'x-agent-token': token, 'x-pugport-owner': owner } }).then((r) => r.json());
async function request(path, body, method = 'POST') {
  const r = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-agent-token': token, 'x-pugport-owner': owner },
    body: JSON.stringify(body),
  });
  const value = await r.json();
  if (!r.ok) throw new Error(value.error);
  return value;
}
async function refresh() {
  return request('/api/refresh', {});
}
// HTTP can only deny; allowing goes through the desktop permission channel, as the Electron shell does.
let permissionRequest = 0;
function allowApproval(id) {
  const requestId = ++permissionRequest;
  return new Promise((resolveAllow, rejectAllow) => {
    const onMessage = (message) => {
      if (message?.type !== 'permission-change-result' || message.requestId !== requestId) return;
      child.off('message', onMessage);
      if (message.error) rejectAllow(new Error(message.error));
      else resolveAllow();
    };
    child.on('message', onMessage);
    child.send({
      type: 'permission-change',
      requestId,
      change: { kind: 'approval', id, allow: true },
      apply: true,
      expected: '',
    });
  });
}
async function message(conversationId, input, { approveFile } = {}) {
  const { workflow } = await request(`/api/conversations/${conversationId}/messages`, {
    autoEscalate: false,
    allowUnknownQuota: true,
    mode: 'chat',
    permissionMode: 'read-only',
    executionPolicy: 'cli-only',
    ...input,
  });
  console.log(JSON.stringify({ started: workflow.id, runtime: input.runtimeId, mode: input.mode || 'chat' }));
  const deadline = Date.now() + 180000;
  let state, flow;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
    state = await get('/api/state');
    flow = state.workflows.find((w) => w.id === workflow.id);
    for (const approval of state.approvals.filter((a) =>
      state.runs.some((r) => r.id === a.runId && r.workflowId === workflow.id),
    )) {
      const allow = Boolean(
        approveFile && approval.description.includes(approveFile) && !/bash|powershell|shell|pwsh/i.test(approval.tool),
      );
      console.log(JSON.stringify({ approval: approval.tool, allow }));
      if (allow) await allowApproval(approval.id);
      else await request('/api/approvals/' + approval.id, { allow: false });
    }
    if (['completed', 'blocked', 'failed', 'cancelled'].includes(flow.status)) break;
  }
  if (!['completed', 'blocked', 'failed', 'cancelled'].includes(flow.status))
    await request('/api/workflows/' + workflow.id + '/cancel', {});
  const runs = state.runs.filter((r) => r.workflowId === workflow.id);
  const answer = state.conversationMessages.find((m) => m.id === flow.finalMessageId)?.content || '';
  const result = {
    id: workflow.id,
    status: flow.status,
    error: flow.error,
    steps: flow.plan.map((s) => ({ title: s.title, status: s.status, attempts: s.runIds.length })),
    answer,
    runs: runs.map((r) => ({
      id: r.id,
      model: r.route.model,
      runtimeId: r.route.runtimeId,
      status: r.status,
      error: r.error,
      verification: r.verification,
      toolEvents: r.events.filter((e) => e.type === 'tool').length,
    })),
  };
  results.push(result);
  console.log(JSON.stringify(result));
  assert.equal(flow.status, 'completed');
  return result;
}
try {
  await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error('startup timeout')), 30000);
    child.on('message', (message) => {
      if (message?.type === 'session') {
        token = message.token;
        owner = message.owner;
      }
      if (message.type !== 'ready') return;
      clearTimeout(timer);
      done();
    });
    child.once('exit', () => reject(new Error('startup exited')));
  });
  const project = await request('/api/projects', { path: directory, name: '统一工作流验证' });
  const memory = await get(`/api/projects/${project.id}/memory`);
  await request(
    `/api/projects/${project.id}/memory`,
    { content: '项目备忘代码：MONO_2026。请保持测试任务简短，只操作明确指定的文件。', revision: memory.revision },
    'PATCH',
  );
  let state = await refresh();
  if (!selected.length || selected.includes('cli')) {
    const runtime =
      state.runtimes
        .filter(
          (r) =>
            r.provider === 'codex' &&
            r.status === 'ready' &&
            r.quota.status === 'known' &&
            r.quota.windows.every((w) => w.usedPercent < 85),
        )
        .sort((a, b) => (a.environment === 'native' ? -1 : 1))[0] ||
      state.runtimes.find((r) => r.provider === 'claude' && r.status === 'ready');
    if (!runtime) throw new Error('No available CLI account for smoke');
    const model = runtime.models.find((m) => /luna|haiku/.test(m.id)) || runtime.models[0];
    const selection = {
      runtimeId: runtime.id,
      model: model.id,
      effort: model.efforts.includes('low') ? 'low' : model.efforts[0],
    };
    const conversation = await request('/api/conversations', { projectId: project.id, title: '项目记忆与连续问答' });
    await message(conversation.id, { ...selection, content: '不要调用任何工具。请回复记住这段测试短语：纸船过桥。' });
    const followup = await message(conversation.id, {
      ...selection,
      content: '不要调用工具。请只回复项目备忘代码和上一条测试短语。',
    });
    assert.ok(followup.answer.includes('MONO_2026') && followup.answer.includes('纸船过桥'));
    const build = await request('/api/conversations', { projectId: project.id, title: '实际规划与文件创建' });
    const built = await message(
      build.id,
      {
        ...selection,
        mode: 'build',
        permissionMode: 'workspace-write',
        content:
          '只创建一个 workspace-created.txt 文件，内容为 WORKSPACE_BUILD_OK 和换行。最多拆成一个执行步骤。不要执行命令、联网、git 或修改其他文件。完成后说明该文件。',
      },
      { approveFile: 'workspace-created.txt' },
    );
    assert.ok(built.runs.some((r) => r.status === 'completed'));
    assert.equal((await readFile(resolve(directory, 'workspace-created.txt'), 'utf8')).trim(), 'WORKSPACE_BUILD_OK');
  }
  for (const provider of ['pi']) {
    if (selected.length && !selected.includes(provider)) continue;
    state = await refresh();
    const runtime = state.runtimes.find(
      (r) =>
        r.provider === provider && r.installed && r.capabilities.execute && ['ready', 'unknown'].includes(r.status),
    );
    if (!runtime) throw new Error(`${provider} is not ready`);
    const model =
      runtime.models.find((m) => m.id === 'openai/gpt-4.1-nano') ||
      runtime.models.find((m) => /gpt-4.1-mini/.test(m.id));
    if (!model) throw new Error(`${provider} has no expected test model`);
    const conversation = await request('/api/conversations', {
      projectId: project.id,
      title: `${provider.toUpperCase()} 工具审批与创建`,
    });
    const filename = `${provider}-created.txt`,
      content = `${provider.toUpperCase()}_WORKSPACE_OK`;
    await message(
      conversation.id,
      {
        runtimeId: runtime.id,
        model: model.id,
        effort: model.efforts[0],
        executionPolicy: 'api-only',
        permissionMode: 'workspace-write',
        content: `请直接使用 write 文件工具在当前目录创建 ${filename}，内容为 ${content} 和换行。不要使用 bash 或 shell，不要联网，也不要改其他文件。结束后回答文件名。`,
      },
      { approveFile: filename },
    );
    assert.equal((await readFile(resolve(directory, filename), 'utf8')).trim(), content);
  }
} finally {
  await writeFile(
    resolve(`reports/local-unified-${selected.join('-') || 'all'}-smoke.json`),
    JSON.stringify({ at: new Date().toISOString(), selected, results }, null, 2),
  );
  if (child.connected) {
    child.send('shutdown');
    await new Promise((done) => {
      const timer = setTimeout(() => {
        child.kill();
        done();
      }, 15000);
      child.once('exit', () => {
        clearTimeout(timer);
        done();
      });
    });
  }
}
