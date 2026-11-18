import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { fork } from '../src/server/platform/test-process.ts';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store } from '../src/server/store.ts';
import type {
  AppState,
  Conversation,
  LocalMemorySettings,
  Project,
  RuntimeTarget,
  Workflow,
} from '../src/shared/types.ts';

test(
  'HTTP one-for-all creates private chats, resolves intent and requires the current route proposal before CLI execution',
  // Multiple real subprocesses and durable memory exports share the Windows test runner.
  // Individual HTTP requests and workflow waits remain bounded independently below.
  { timeout: 60_000 },
  async (t) => {
    const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'one-for-all-http-'))),
      // Development keeps its data in ".data"; files served from there must still load.
      dataDir = join(directory, '.data');
    const cli = join(directory, 'mock-codex.mjs'),
      log = join(directory, 'turns.jsonl');
    // Only this protocol fixture executes. It never contacts a provider or reads user credentials.
    writeFileSync(
      cli,
      `
import { createInterface } from 'node:readline';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const log = ${JSON.stringify(log)};
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const notify = (method, params) => send({ method, params });
const threadId = 'fixture-thread-' + process.pid, turnId = 'fixture-turn';
const input = createInterface({ input: process.stdin });
input.on('line', line => {
  const message = JSON.parse(line), p = message.params || {};
  if (message.method === 'initialize') return send({ id: message.id, result: {} });
  if (message.method === 'initialized') return;
  if (message.method === 'account/read') return send({ id: message.id, result: { account: { type: 'chatgpt' }, requiresOpenaiAuth: true } });
  if (message.method === 'model/list') return send({ id: message.id, result: { data: [{ model: 'fixture-model', displayName: 'Fixture', supportedReasoningEfforts: ['low','medium','high'], defaultReasoningEffort: 'medium' }] } });
  if (message.method === 'account/rateLimits/read') return send({ id: message.id, result: { rateLimitsByLimitId: { fixture: { primary: { usedPercent: 10, resetsAt: Math.floor(Date.now()/1000)+3600, windowDurationMins: 300 } } } } });
  if (message.method === 'thread/start' || message.method === 'thread/resume') return send({ id: message.id, result: { thread: { id: threadId } } });
  if (message.method === 'turn/start') {
    appendFileSync(log, JSON.stringify({ cwd: p.cwd, model: p.model, effort: p.effort, permission: p.sandboxPolicy?.type, imageCount: p.input?.filter(item=>item.type==='localImage').length, prompt: p.input?.find(item=>item.type==='text')?.text, approvalPolicy: p.approvalPolicy }) + '\\n');
    notify('turn/started', { threadId, turn: { id: turnId, status: 'inProgress' } });
    send({ id: message.id, result: { turn: { id: turnId, status: 'inProgress' } } });
    if (p.sandboxPolicy?.type === 'workspaceWrite' && p.input?.some(item => item.type === 'text' && item.text.includes('Fix the typo "recieve" to "receive" in README.md.'))) {
      const path = join(p.cwd, 'README.md');
      writeFileSync(path, 'receive\\n');
      notify('item/completed', { threadId, turnId, item: { id: 'readme-edit', type: 'fileChange', status: 'completed', changes: [{ path, kind: { type: 'update' }, diff: '-recieve\\n+receive' }] } });
    }
    notify('item/completed', { threadId, turnId, item: { id: 'reply', type: 'agentMessage', text: 'Fixture completed without network.' } });
    notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } });
  }
});
input.on('close', () => process.exit(0));
`,
    );
    const targets: RuntimeTarget[] = ['fixture-a', 'fixture-b'].map((id) => ({
      id,
      provider: 'codex',
      label: id,
      command: process.execPath,
      args: [cli],
      environment: 'native',
      enabled: true,
      commandDiscovery: 'fixed',
    }));
    targets.push({
      id: 'pi-local',
      provider: 'pi',
      label: 'Disabled Pi',
      command: 'unused',
      environment: 'native',
      enabled: false,
    });
    targets.push({
      id: 'cursor-native',
      provider: 'cursor',
      label: 'Disabled fixture Cursor',
      command: 'unused',
      environment: 'native',
      enabled: false,
      commandDiscovery: 'fixed',
    });
    targets.push({
      id: 'gemini-native',
      provider: 'gemini',
      label: 'Disabled fixture Gemini',
      command: 'unused',
      environment: 'native',
      enabled: false,
      commandDiscovery: 'fixed',
    });
    const store = new Store(dataDir);
    store.setConfig('targets', targets);
    store.setConfig('freeSourcesDismissed', { ollama: true, lmstudio: true });
    store.setConfig('settings', { architectureProvider: 'codex', designProvider: 'codex', routineProvider: 'codex' });
    store.close();
    const compiled = process.env.COMBORUNNER_TEST_BUILD === '1';
    const launcher = join(directory, 'server-fixture.mjs');
    if (!compiled)
      writeFileSync(
        launcher,
        `
import { Controller } from ${JSON.stringify(pathToFileURL(join(sourceRoot, 'src/server/controller.ts')).href)};
Controller.prototype.machineReading = () => ({ totalBytes: 32 * 1024 ** 3, cpus: 8, cpuPercent: 20, availableMemoryBytes: 16 * 1024 ** 3, sampledAt: Date.now() });
await import(${JSON.stringify(pathToFileURL(join(sourceRoot, 'src/server/main.ts')).href)});
`,
      );
    const child = fork(compiled ? join(sourceRoot, 'dist/server/main.js') : launcher, [], {
      cwd: sourceRoot,
      execArgv: compiled ? [] : ['--import', 'tsx'],
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
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        exited,
        new Promise<void>((done) => {
          timer = setTimeout(() => {
            child.kill();
            done();
          }, 5000);
        }),
      ]);
      clearTimeout(timer);
      const absolute = resolve(directory);
      assert.ok(
        absolute.startsWith(realpathSync.native(tmpdir()) + sep) && basename(absolute).startsWith('one-for-all-http-'),
      );
      rmSync(absolute, { recursive: true, force: true });
    });
    let token = '';
    let owner = '';
    const port = await new Promise<number>((done, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`Server exited ${code}: ${output}`)));
      child.on('message', (message) => {
        const value = message as { type?: string; token?: string; owner?: string; port?: number };
        if (value.type === 'session') {
          token = value.token ?? '';
          owner = value.owner ?? '';
        }
        if (value.type === 'ready' && value.port) done(value.port);
      });
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    const session = { token };
    const request = async <T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => {
      const response = await fetch(baseUrl + path, {
        method,
        headers: { 'Content-Type': 'application/json', 'x-agent-token': session.token, 'x-pugport-owner': owner },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(5000),
      });
      const value = await response.json();
      assert.equal(response.status >= 200 && response.status < 300, true, JSON.stringify(value));
      return value as T;
    };
    const getState = () => request<AppState>('/api/state');
    const waitState = async (predicate: (state: AppState) => boolean, readState = getState) => {
      let last: AppState | undefined;
      const deadline = Date.now() + 25_000;
      while (Date.now() < deadline) {
        const state = await readState();
        last = state;
        if (predicate(state)) return state;
        assert.ok((state.workflows ?? []).every((workflow) => workflow.machineLoadChoice !== 'pending'));
        await new Promise((done) => setTimeout(done, 30));
      }
      throw new Error(
        `HTTP fixture state timeout: ${JSON.stringify({ refreshing: last?.refreshing, runtimes: last?.runtimes.map(({ id, status }) => ({ id, status })), workflows: last?.workflows?.map(({ status, scheduling }) => ({ status, scheduling })) })}`,
      );
    };
    const turns = () =>
      existsSync(log)
        ? readFileSync(log, 'utf8')
            .trim()
            .split('\n')
            .filter(Boolean)
            .map(
              (line) =>
                JSON.parse(line) as {
                  cwd: string;
                  permission: string;
                  model: string;
                  effort: string;
                  imageCount: number;
                  prompt: string;
                  approvalPolicy: string;
                },
            )
        : [];
    const initial = await waitState(
      (state) => state.runtimes.filter((runtime) => runtime.status === 'ready').length === 2,
    );
    assert.equal(initial.settings.decisionMode, 'auto');
    await t.test('settings patch validates and persists personal instructions without truncation', async () => {
      const instructions = '好'.repeat(4000);
      const saved = await request<AppState>('/api/settings', { globalInstructions: instructions }, 'PATCH');
      assert.equal(saved.settings.globalInstructions, instructions);
      await request('/api/settings', { notifyOnFinish: 'never' }, 'PATCH');
      assert.equal((await getState()).settings.globalInstructions, instructions);
      for (const invalid of ['x'.repeat(4001), 42, null, ['instructions']]) {
        const response = await fetch(baseUrl + '/api/settings', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'x-agent-token': session.token, 'x-pugport-owner': owner },
          body: JSON.stringify({ globalInstructions: invalid }),
          signal: AbortSignal.timeout(5000),
        });
        assert.equal(response.status, 400);
        await response.json();
        assert.equal((await getState()).settings.globalInstructions, instructions);
      }
      const cleared = await request<AppState>('/api/settings', { globalInstructions: '' }, 'PATCH');
      assert.equal(cleared.settings.globalInstructions, '');
    });
    const conversation = await request<Conversation>('/api/conversations', {});
    const project = (await getState()).projects!.find((project) => project.id === conversation.projectId)!;
    await t.test('HTTP cannot grant trust or widen caller settings; narrowing remains allowed', async () => {
      const refused = async (endpoint: string, body: unknown) => {
        const response = await fetch(baseUrl + endpoint, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'x-agent-token': session.token, 'x-pugport-owner': owner },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(5000),
        });
        assert.equal(response.status, 400, await response.text());
      };
      await refused(`/api/projects/${project.id}`, { trusted: true });
      await request(`/api/projects/${project.id}`, { trusted: false }, 'PATCH');
      await refused('/api/settings', { externalCallers: { codex: 'write' } });
      const narrowed = await request<AppState>('/api/settings', { externalCallers: { codex: 'read-only' } }, 'PATCH');
      assert.equal(narrowed.settings.externalCallers?.codex, 'read-only');
      await refused('/api/settings', { externalCallers: {} });
      await refused('/api/settings', { externalCallers: { codex: 'inherit' } });
      assert.equal((await getState()).projects!.find((item) => item.id === project.id)?.trusted, false);
    });
    assert.equal(project.scope, 'chat');
    assert.ok(project.path.startsWith(join(dataDir, 'workspaces') + sep));
    assert.notEqual(project.path, sourceRoot);
    const memoryEndpoint = `/api/projects/${project.id}/local-memory`;
    const memory = await request<LocalMemorySettings>(memoryEndpoint);
    assert.equal(memory.exportEnabled, true);
    assert.equal(memory.cliEnabled, false);
    assert.equal(existsSync(join(project.path, 'AGENTS.md')), false);
    const invalidMemorySetting = await fetch(baseUrl + memoryEndpoint, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-agent-token': session.token, 'x-pugport-owner': owner },
      body: JSON.stringify({ cliEnabled: true, injected: true }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(invalidMemorySetting.status, 400);
    assert.equal(existsSync(join(project.path, 'AGENTS.md')), false);
    const enrolled = await request<LocalMemorySettings>(memoryEndpoint, { cliEnabled: true }, 'PATCH');
    assert.equal(enrolled.cliEnabled, true, enrolled.warnings.join('\n'));
    assert.ok(enrolled.files.includes(join(project.path, 'AGENTS.md')));
    assert.doesNotMatch(readFileSync(join(project.path, 'AGENTS.md'), 'utf8'), /sync-memory\.cmd/);
    assert.equal(existsSync(join(project.path, 'CLAUDE.md')), false);
    const disabled = await request<LocalMemorySettings>(memoryEndpoint, { cliEnabled: false }, 'PATCH');
    assert.equal(disabled.cliEnabled, false);
    assert.ok(disabled.files.includes(join(project.path, 'AGENTS.md')));
    assert.equal(existsSync(join(project.path, 'AGENTS.md')), false);
    const question = await request<{ workflow: Workflow }>(`/api/conversations/${conversation.id}/messages`, {
      content: '解释如何修改 README.md',
      mode: 'auto',
      permissionMode: 'workspace-write',
    });
    await waitState(
      (state) =>
        state.workflows?.some((flow) => flow.id === question.workflow.id && flow.status === 'completed') === true,
    );
    assert.equal(turns().length, 1);
    // A question gets a direct reply, still with the writable permission the user chose.
    assert.equal(turns()[0]!.permission, 'workspaceWrite');
    assert.equal(turns()[0]!.cwd, project.path);
    const build = await request<{ workflow: Workflow }>(`/api/conversations/${conversation.id}/messages`, {
      content: 'Fix the typo "recieve" to "receive" in README.md.',
      mode: 'auto',
      permissionMode: 'workspace-write',
    });
    await waitState(
      (state) => state.workflows?.some((flow) => flow.id === build.workflow.id && flow.status === 'completed') === true,
    );
    assert.equal(turns().at(-1)!.permission, 'workspaceWrite');
    assert.equal(readFileSync(join(project.path, 'README.md'), 'utf8'), 'receive\n');
    await request('/api/settings', { decisionMode: 'confirm' }, 'PATCH');
    const review = await request<{ workflow: Workflow }>(`/api/conversations/${conversation.id}/messages`, {
      content: 'Explain the design',
      mode: 'auto',
      permissionMode: 'workspace-write',
    });
    const waiting = await waitState(
      (state) =>
        state.workflows?.some((flow) => flow.id === review.workflow.id && flow.status === 'waiting-confirmation') ===
        true,
    );
    const original = waiting.workflows!.find((flow) => flow.id === review.workflow.id)!.routingReview!;
    const priorTurns = turns().length;
    const wrong = await fetch(baseUrl + `/api/workflows/${review.workflow.id}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-agent-token': session.token, 'x-pugport-owner': owner },
      body: JSON.stringify({ proposalId: randomUUID() }),
    });
    assert.equal(wrong.status, 400);
    assert.equal(turns().length, priorTurns);
    await request(`/api/targets/${original.proposal.runtimeId}`, { enabled: false }, 'PATCH');
    // Other discovery can remain active; only the route's disabled and remaining targets matter here.
    await waitState(
      (state) =>
        !state.runtimes.some((runtime) => runtime.id === original.proposal.runtimeId) &&
        state.runtimes.some(
          (runtime) =>
            runtime.id !== original.proposal.runtimeId &&
            runtime.id.startsWith('fixture-') &&
            runtime.status === 'ready',
        ),
    );
    let updated = await request<Workflow>(`/api/workflows/${review.workflow.id}/confirm`, {
      proposalId: original.id,
    });
    if (updated.status === 'waiting-resource') {
      // Completion can precede the post-run quota refresh releasing its reservation; wait for the new review.
      assert.equal(turns().length, priorTurns);
      const ready = await waitState(
        (state) =>
          state.workflows?.some(
            (flow) =>
              flow.id === review.workflow.id &&
              flow.status === 'waiting-confirmation' &&
              flow.routingReview?.id !== original.id,
          ) === true,
      );
      updated = ready.workflows!.find((flow) => flow.id === review.workflow.id)!;
    }
    assert.equal(updated.status, 'waiting-confirmation');
    assert.notEqual(updated.routingReview!.id, original.id);
    assert.notEqual(updated.routingReview!.proposal.runtimeId, original.proposal.runtimeId);
    const stale = await fetch(baseUrl + `/api/workflows/${review.workflow.id}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-agent-token': session.token, 'x-pugport-owner': owner },
      body: JSON.stringify({ proposalId: original.id }),
    });
    assert.equal(stale.status, 400);
    assert.equal(turns().length, priorTurns);
    await request(`/api/workflows/${review.workflow.id}/confirm`, { proposalId: updated.routingReview!.id });
    const completed = await waitState(
      (state) =>
        state.workflows?.some((flow) => flow.id === review.workflow.id && flow.status === 'completed') === true,
    );
    const run = completed.runs.find((run) => run.workflowId === review.workflow.id)!;
    assert.equal(run.route.runtimeId, updated.routingReview!.proposal.runtimeId);
    assert.equal(turns().length, priorTurns + 1);
    await request('/api/settings', { decisionMode: 'auto', toolApprovalMode: 'auto' }, 'PATCH');
    // Attachments arrive as raw bytes with the name in a header, exactly as the composer sends them.
    const upload = async <T>(name: string, mimeType: string, bytes: Buffer) => {
      const response = await fetch(baseUrl + `/api/conversations/${conversation.id}/attachments`, {
        method: 'POST',
        headers: {
          'Content-Type': mimeType,
          'x-attachment-name': encodeURIComponent(name),
          'x-agent-token': session.token,
          'x-pugport-owner': owner,
        },
        body: new Uint8Array(bytes),
        signal: AbortSignal.timeout(5000),
      });
      const value = await response.json();
      assert.equal(response.status >= 200 && response.status < 300, true, JSON.stringify(value));
      return value as T;
    };
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l2kAAAAASUVORK5CYII=';
    const image = await upload<{ id: string; kind: string }>('test.png', 'image/png', Buffer.from(png, 'base64'));
    assert.equal(image.kind, 'image');
    assert.equal('path' in image, false);
    const document = await upload<{ id: string }>(
      'spec.md',
      'text/markdown',
      Buffer.from('HTTP_ATTACHMENT_TEXT\n' + 'a'.repeat(300_000)),
    );
    const download = await fetch(baseUrl + `/api/conversations/${conversation.id}/attachments/${image.id}/content`, {
      headers: { 'x-agent-token': token, 'x-pugport-owner': owner },
    });
    assert.equal(download.headers.get('content-type'), 'image/png');
    assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(Buffer.from(await download.arrayBuffer()).toString('base64'), png);
    const other = await request<Conversation>('/api/conversations', {});
    const forbidden = await fetch(baseUrl + `/api/conversations/${other.id}/attachments/${image.id}/content`, {
      headers: { 'x-agent-token': token, 'x-pugport-owner': owner },
    });
    assert.equal(forbidden.status, 400);
    // Requests without a body (closing a background task) pass the JSON check; a non-JSON body never does.
    const closed = await fetch(baseUrl + '/api/background-tasks/no-such-task', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', 'x-agent-token': session.token, 'x-pugport-owner': owner },
    });
    assert.equal(closed.status, 200);
    const plain = await fetch(baseUrl + '/api/background-tasks/no-such-task/pause', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'x-agent-token': session.token, 'x-pugport-owner': owner },
      body: 'x',
    });
    assert.equal(plain.status, 415);
    const attached = await request<{ workflow: Workflow }>(`/api/conversations/${conversation.id}/messages`, {
      content: 'Describe the image and document',
      attachmentIds: [image.id, document.id],
      mode: 'chat',
    });
    const final = await waitState(
      (state) =>
        state.workflows?.some((flow) => flow.id === attached.workflow.id && flow.status === 'completed') === true,
    );
    assert.equal(turns().at(-1)!.imageCount, 1);
    assert.match(turns().at(-1)!.prompt, /HTTP_ATTACHMENT_TEXT/);
    assert.equal(turns().at(-1)!.approvalPolicy, 'never');
    assert.equal(
      final.conversationMessages?.find(
        (message) => message.workflowId === attached.workflow.id && message.role === 'user',
      )?.attachments?.length,
      2,
    );
    const delegationRequest = { role: 'reviewer', task: 'Review fixture output', requestId: randomUUID() };
    const ordinaryDelegation = await fetch(baseUrl + `/api/workflows/${attached.workflow.id}/delegate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-agent-token': session.token, 'x-pugport-owner': owner },
      body: JSON.stringify(delegationRequest),
    });
    assert.equal(ordinaryDelegation.status, 400);
    assert.match(await ordinaryDelegation.text(), /请先开启这条对话的协作/);
    const afterRefusal = await getState();
    assert.ok(!afterRefusal.workflows?.some((flow) => flow.delegation?.parentId === attached.workflow.id));

    const managedProject = await request<Project>('/api/projects', {
      path: join(directory, 'managed-project'),
      name: 'Fixture project',
      createDirectory: true,
    });
    assert.notEqual(managedProject.scope, 'chat');
    assert.equal(managedProject.path, join(directory, 'managed-project'));
    const projectConversation = await request<Conversation>('/api/conversations', { projectId: managedProject.id });
    const projectParent = await request<{ workflow: Workflow }>(
      `/api/conversations/${projectConversation.id}/messages`,
      { content: 'Explain the project', mode: 'chat' },
    );
    await waitState(
      (state) =>
        state.workflows?.some((flow) => flow.id === projectParent.workflow.id && flow.status === 'completed') === true,
    );
    const delegated = await request<{ workflow: Workflow }>(
      `/api/workflows/${projectParent.workflow.id}/delegate`,
      delegationRequest,
    );
    const repeated = await request<{ workflow: Workflow }>(
      `/api/workflows/${projectParent.workflow.id}/delegate`,
      delegationRequest,
    );
    assert.equal(delegated.workflow.id, repeated.workflow.id);
    const childFinal = await waitState(
      (state) =>
        state.workflows?.some((flow) => flow.id === delegated.workflow.id && flow.status === 'completed') === true,
      async () => ({
        ...(await getState()),
        // Settled children leave live state; the family endpoint retains their completed records.
        ...(await request<{ workflows: Workflow[] }>(`/api/conversations/${projectConversation.id}/swarm`)),
      }),
    );
    assert.equal(
      childFinal.workflows?.find((flow) => flow.id === delegated.workflow.id)?.delegation?.parentId,
      projectParent.workflow.id,
    );
    assert.equal(delegated.workflow.conversationId, projectConversation.id);
    assert.equal(delegated.workflow.projectId, managedProject.id);
    assert.equal(turns().at(-1)!.permission, 'readOnly');
    const renamed = await request<Conversation>(
      `/api/conversations/${other.id}`,
      { title: 'Renamed fixture' },
      'PATCH',
    );
    assert.equal(renamed.title, 'Renamed fixture');
    await request(`/api/conversations/${other.id}`, {}, 'DELETE');
    const afterDelete = await request<AppState>('/api/state');
    assert.ok(!afterDelete.conversations?.some((item) => item.id === other.id));
    const deletedRead = await fetch(baseUrl + `/api/conversations/${other.id}`, {
      headers: { 'x-agent-token': token, 'x-pugport-owner': owner },
    });
    assert.equal(deletedRead.status, 400);
  },
);
