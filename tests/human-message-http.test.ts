import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fork } from '../src/server/platform/test-process.ts';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store } from '../src/server/store.ts';
import type { AppState, RuntimeTarget } from '../src/shared/types.ts';

test(
  'a message typed into a running agent conversation is supplemented live and makes the conversation the owner’s',
  { timeout: 60_000 },
  async (t) => {
    const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'human-message-http-'))),
      dataDir = join(directory, '.data');
    const cli = join(directory, 'mock-codex.mjs'),
      log = join(directory, 'steers.jsonl');
    // Only this protocol fixture executes. It never contacts a provider or reads user credentials.
    writeFileSync(
      cli,
      `
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const notify = (method, params) => send({ method, params });
const threadId = 'fixture-thread-' + process.pid, turnId = 'fixture-turn';
const finish = () => {
  notify('item/completed', { threadId, turnId, item: { id: 'reply', type: 'agentMessage', text: 'Fixture completed without network.' } });
  notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } });
};
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line), p = message.params || {};
  if (message.method === 'initialize') return send({ id: message.id, result: {} });
  if (message.method === 'initialized') return;
  if (message.method === 'account/read') return send({ id: message.id, result: { account: { type: 'chatgpt' }, requiresOpenaiAuth: true } });
  if (message.method === 'model/list') return send({ id: message.id, result: { data: [{ model: 'fixture-model', displayName: 'Fixture', supportedReasoningEfforts: ['low','medium','high'], defaultReasoningEffort: 'medium' }] } });
  if (message.method === 'account/rateLimits/read') return send({ id: message.id, result: { rateLimitsByLimitId: { fixture: { primary: { usedPercent: 10, resetsAt: Math.floor(Date.now()/1000)+3600, windowDurationMins: 300 } } } } });
  if (message.method === 'thread/start' || message.method === 'thread/resume') return send({ id: message.id, result: { thread: { id: threadId } } });
  if (message.method === 'turn/start') {
    notify('turn/started', { threadId, turn: { id: turnId, status: 'inProgress' } });
    return send({ id: message.id, result: { turn: { id: turnId, status: 'inProgress' } } });
  }
  if (message.method === 'turn/steer') {
    appendFileSync(${JSON.stringify(log)}, JSON.stringify({ text: p.input?.[0]?.text }) + '\\n');
    send({ id: message.id, result: { turnId } });
    return finish();
  }
  if (message.method === 'turn/interrupt') {
    send({ id: message.id, result: {} });
    return notify('turn/completed', { threadId, turn: { id: turnId, status: 'interrupted' } });
  }
  if (message.id !== undefined) send({ id: message.id, result: {} });
});
`,
    );
    const targets: RuntimeTarget[] = [
      {
        id: 'fixture-a',
        provider: 'codex',
        label: 'fixture-a',
        command: process.execPath,
        args: [cli],
        environment: 'native',
        enabled: true,
        commandDiscovery: 'fixed',
      },
      ...(['claude', 'grok', 'pi', 'cursor', 'gemini'] as const).map<RuntimeTarget>((provider) => ({
        id: provider + '-native',
        provider,
        label: 'Disabled fixture',
        command: 'unused',
        environment: 'native',
        enabled: false,
        commandDiscovery: 'fixed',
      })),
    ];
    const store = new Store(dataDir);
    store.setConfig('targets', targets);
    store.setConfig('settings', { architectureProvider: 'codex', designProvider: 'codex', routineProvider: 'codex' });
    store.close();
    const launcher = join(directory, 'server-fixture.mjs');
    writeFileSync(
      launcher,
      `
import { Controller } from ${JSON.stringify(pathToFileURL(join(sourceRoot, 'src/server/controller.ts')).href)};
Controller.prototype.machineReading = () => ({ totalBytes: 32 * 1024 ** 3, cpus: 8, cpuPercent: 20, availableMemoryBytes: 16 * 1024 ** 3, sampledAt: Date.now() });
await import(${JSON.stringify(pathToFileURL(join(sourceRoot, 'src/server/main.ts')).href)});
`,
    );
    const child = fork(launcher, [], {
      cwd: sourceRoot,
      execArgv: ['--import', 'tsx'],
      windowsHide: true,
      env: {
        ...process.env,
        COMBORUNNER_ROOT: sourceRoot,
        COMBORUNNER_DATA_DIR: dataDir,
        COMBORUNNER_SECRETS_DIR: join(directory, 'synthetic-secrets'),
        COMBORUNNER_MEMORY_DIR: join(directory, 'private-memory'),
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
    const exited = new Promise<number | null>((done) => child.once('exit', done));
    t.after(async () => {
      if (child.exitCode === null && child.connected) child.send('shutdown');
      const timer = setTimeout(() => child.kill(), 5000);
      await exited;
      clearTimeout(timer);
      const absolute = resolve(directory);
      assert.ok(
        absolute.startsWith(realpathSync.native(tmpdir()) + sep) &&
          basename(absolute).startsWith('human-message-http-'),
      );
      rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    let token = '';
    let owner = '';
    const port = await new Promise<number>((done, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`Server exited ${code}: ${output}`)));
      child.on('message', (message: { type?: string; token?: string; owner?: string; port?: number }) => {
        if (message.type === 'session') {
          token = message.token ?? '';
          owner = message.owner ?? '';
        }
        if (message.type === 'ready' && message.port) done(message.port);
      });
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    const session = { token };
    const request = async <T>(path: string, body?: unknown) => {
      const response = await fetch(baseUrl + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json', 'x-agent-token': session.token, 'x-pugport-owner': owner },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(5000),
      });
      const value = await response.json();
      assert.equal(response.status >= 200 && response.status < 300, true, JSON.stringify(value));
      return value as T;
    };
    const waitState = async (predicate: (state: AppState) => boolean) => {
      let last: AppState | undefined;
      for (let i = 0; i < 300; i++) {
        last = await request<AppState>('/api/state');
        if (predicate(last)) return last;
        assert.ok((last.workflows ?? []).every((workflow) => workflow.machineLoadChoice !== 'pending'));
        await new Promise((done) => setTimeout(done, 30));
      }
      throw new Error(
        `HTTP fixture state timeout: ${JSON.stringify({ runtimes: last?.runtimes.map(({ id, status }) => ({ id, status })), workflows: last?.workflows?.map(({ status }) => status), runs: last?.runs.map(({ status, steeringStatus }) => ({ status, steeringStatus })) })}`,
      );
    };
    await waitState((state) =>
      state.runtimes.some((runtime) => runtime.id === 'fixture-a' && runtime.status === 'ready'),
    );

    const dispatched = await request<{ taskId: string; conversationId: string }>('/api/external/tasks', {
      task: 'Summarize the synthetic notes',
      caller: 'Claude Code',
      agent: 'fixture-a',
      projectPath: directory,
    });
    const running = await waitState((state) =>
      state.runs.some((run) => run.workflowId === dispatched.taskId && run.steeringStatus?.state === 'ready'),
    );
    assert.ok(running.agentConversationIds?.includes(dispatched.conversationId));

    const typed = await request<{ steered?: boolean; message: { id: string } }>(
      `/api/conversations/${dispatched.conversationId}/messages`,
      { content: 'Leave the README alone.' },
    );
    assert.equal(typed.steered, true, 'the running task took the message as a live supplement');
    assert.match(readFileSync(log, 'utf8'), /Leave the README alone\./);
    const after = await waitState(
      (state) =>
        state.workflows?.some((workflow) => workflow.id === dispatched.taskId && workflow.status === 'completed') ??
        false,
    );
    assert.equal(after.agentConversationIds?.includes(dispatched.conversationId), false);
    await t.test('owner message claims the dispatched project through HTTP', () => {
      const projectId = after.conversations!.find((item) => item.id === dispatched.conversationId)!.projectId;
      assert.equal(after.projects!.find((item) => item.id === projectId)!.origin, undefined);
    });
    await t.test('creating an owner conversation claims the dispatched project through HTTP', async () => {
      const projectPath = join(directory, 'second-project');
      mkdirSync(projectPath);
      const external = await request<{ conversationId: string }>('/api/external/tasks', {
        task: 'Inspect the second synthetic folder',
        projectPath,
        agent: 'fixture-a',
      });
      const state = await request<AppState>('/api/state');
      const projectId = state.conversations!.find((item) => item.id === external.conversationId)!.projectId;
      assert.equal(state.projects!.find((item) => item.id === projectId)!.origin, 'dispatch');
      const side = await request<{ id: string }>(`/api/conversations/${external.conversationId}/side-chat`, {
        requestId: '00000000-0000-4000-8000-000000000001',
        selection: { executionPolicy: 'cli-first' },
      });
      await request(`/api/conversations/${side.id}/messages`, { content: 'Synthetic side chat message' });
      const afterSide = await request<AppState>('/api/state');
      assert.equal(afterSide.projects!.find((item) => item.id === projectId)!.origin, 'dispatch');
      await request('/api/conversations', { projectId, title: 'Owner notes' });
      const claimed = await request<AppState>('/api/state');
      assert.equal(claimed.projects!.find((item) => item.id === projectId)!.origin, undefined);
    });
  },
);
