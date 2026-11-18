import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { AgentBridge, type AgentBridgeTiming } from '../src/server/agent-bridge.ts';
import type { Controller } from '../src/server/controller.ts';
import type { Workspace } from '../src/server/workspace.ts';

const short: AgentBridgeTiming = { toolTimeoutMs: 150, returnMarginMs: 10, restoreMarginMs: 40, pollMs: 5 };
function fixture(t: TestContext, provider = 'grok', timing: AgentBridgeTiming = short) {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'pugport-bridge-deadline-')));
  const runAbort = new AbortController();
  const childAbort = new AbortController();
  const parent = {
    run: { id: 'parent-run', workflowId: 'parent', status: 'running' },
    target: { id: 'parent', provider },
    signal: runAbort.signal,
    child: false,
    delegate: true,
    write: true,
    recycle: false,
  };
  const workflows = new Map<string, any>([
    ['a', { id: 'a', status: 'running', runIds: [], delegation: { parentId: 'parent', agent: { label: 'Agent A' } } }],
    ['b', { id: 'b', status: 'queued', runIds: [], delegation: { parentId: 'parent', agent: { label: 'Agent B' } } }],
  ]);
  const cancelled: string[] = [],
    delivered: string[] = [],
    checks: string[] = [];
  const resumes: Array<{ id: string; deadline?: number; at: number }> = [];
  let suspensions = 0,
    checking: (id: string) => Promise<unknown> = async () => {},
    hold = false,
    onSuspend: (() => void) | undefined;
  let resumeEntered!: () => void;
  const enteringResume = new Promise<void>((resolve) => {
    resumeEntered = resolve;
  });
  const controller = Object.assign(new EventEmitter(), {
    dataDir: join(directory, 'data'),
    recordRunEvent() {},
    returnExecution: () => async () => {},
    agentBridgeCaller: (token: string) =>
      token === 'parent'
        ? parent
        : {
            ...parent,
            run: { id: 'a-run', workflowId: 'a', status: 'running' },
            child: true,
            signal: childAbort.signal,
            delegate: false,
          },
    activeRunFor: () => 'parent-run',
    steerInterrupts: () => true,
    canSteer: () => false,
    suspendExecution: (id: string) => {
      suspensions++;
      onSuspend?.();
      let pending: Promise<void> | undefined, rejectResume!: (error: Error) => void;
      let deadline = Infinity,
        settled = false,
        timer: NodeJS.Timeout | undefined;
      return (options: { deadline?: number } = {}) => {
        resumes.push({ id, deadline: options.deadline, at: Date.now() });
        resumeEntered();
        if (!hold) return Promise.resolve();
        if (!pending)
          pending = new Promise<void>((_resolve, reject) => {
            rejectResume = reject;
          });
        if (!settled && options.deadline !== undefined && options.deadline < deadline) {
          deadline = options.deadline;
          clearTimeout(timer);
          const expire = () => {
            if (settled) return;
            settled = true;
            cancelled.push(id);
            const error = new Error('恢复执行资源超时，已停止当前运行。');
            rejectResume(error);
            (id === 'parent-run' ? runAbort : childAbort).abort(error);
          };
          if (deadline <= Date.now()) expire();
          else timer = setTimeout(expire, deadline - Date.now());
        }
        return pending;
      };
    },
  }) as unknown as Controller;
  const workspace = {
    store: { get: (_kind: string, id: string) => workflows.get(id) },
    scopeChecked: async (id: string) => {
      checks.push(id);
      await checking(id);
    },
    markResultDelivered: (id: string) => delivered.push(id),
    queueNotice: () => {},
    // The parent is running, so a notice is queued for its next tool result: delivered.
    notifyRun: async () => true,
    takeNotices: () => [],
    cancel: () => {
      throw new Error('A bridge timeout must never cancel a workflow or its children.');
    },
  } as unknown as Workspace;
  const bridge = new AgentBridge(workspace, controller, 'unused', timing);
  t.after(async () => {
    runAbort.abort();
    childAbort.abort();
    await bridge.close();
    controller.removeAllListeners();
    assert.equal(dirname(directory).toLowerCase(), realpathSync.native(tmpdir()).toLowerCase());
    assert.ok(basename(directory).startsWith('pugport-bridge-deadline-'));
    rmSync(directory, { recursive: true, force: true });
  });
  const call = async (name: string, args: Record<string, unknown>, token = 'parent', signal?: AbortSignal) => {
    const response = await bridge.handle(
      `Bearer ${token}`,
      { id: 1, method: 'tools/call', params: { name, arguments: args } },
      signal,
    );
    return (response.body as any).result as { isError?: boolean; content: Array<{ text: string }> };
  };
  return {
    bridge,
    call,
    workflows,
    runAbort,
    childAbort,
    cancelled,
    delivered,
    checks,
    resumes,
    enteringResume,
    get suspensions() {
      return suspensions;
    },
    holdResume() {
      hold = true;
    },
    onSuspend(fn: () => void) {
      onSuspend = fn;
    },
    scopeCheck(fn: (id: string) => Promise<unknown>) {
      checking = fn;
    },
  };
}

/** Advances the mocked clock 1 ms at a time, letting each step's callbacks run, until `pending` settles. */
async function settle<T>(t: TestContext, pending: Promise<T>): Promise<T> {
  let done = false;
  pending.then(
    () => (done = true),
    () => (done = true),
  );
  while (!done) {
    await new Promise((resolve) => setImmediate(resolve));
    if (!done) t.mock.timers.tick(1);
  }
  return pending;
}

test('bridge wait leaves restoration time and stops only its run when recovery misses the MCP deadline', async (t) => {
  // The margins below are tens of milliseconds. A virtual clock checks the bridge's deadline arithmetic exactly;
  // with real timers a busy machine can fire the last poll past the restore margin.
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.now() });
  const h = fixture(t);
  h.holdResume();
  const started = Date.now();
  const result = await settle(t, h.call('get_result', { task_id: 'a', wait_seconds: 50 }));
  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /恢复执行资源超时/);
  assert.equal(h.suspensions, 1);
  assert.ok(h.resumes[0]!.deadline! >= started + 140);
  assert.ok(h.resumes[0]!.deadline! - h.resumes[0]!.at >= 15, 'Waiting must preserve time to reacquire the lease.');
  assert.deepEqual(h.cancelled, ['parent-run']);
  assert.equal(h.workflows.get('a').status, 'running');
  assert.equal(h.workflows.get('b').status, 'queued');
});

test('transport abort during pending recovery tightens the same resume deadline and preserves the original abort', async (t) => {
  const h = fixture(t, 'grok', { ...short, toolTimeoutMs: 1000 });
  h.holdResume();
  const transport = new AbortController();
  const pending = h.call('get_result', { task_id: 'a', wait_seconds: 0.001 }, 'parent', transport.signal);
  await h.enteringResume;
  assert.equal(h.resumes.length, 1);
  transport.abort(new Error('fixture disconnected during restore'));
  const result = await pending;
  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /fixture disconnected during restore/);
  assert.equal(h.resumes.length, 2);
  assert.ok(h.resumes[1]!.deadline! < h.resumes[0]!.deadline!);
  assert.ok(h.resumes[1]!.deadline! <= Date.now());
  assert.deepEqual(h.cancelled, ['parent-run']);
  assert.equal(h.workflows.get('a').status, 'running');
});

test('child questions share the wait/recovery budget without cancelling the parent or sibling workflows', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.now() });
  const h = fixture(t);
  h.holdResume();
  const result = await settle(t, h.call('message_parent', { text: 'Need a decision' }, 'child'));
  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /恢复执行资源超时/);
  assert.deepEqual(h.cancelled, ['a-run']);
  assert.equal(h.runAbort.signal.aborted, false);
  assert.equal(h.childAbort.signal.aborted, true);
  assert.equal(h.resumes[0]!.id, 'a-run');
  assert.equal(h.workflows.get('b').status, 'queued');
});

test('pending scoped validation is bounded, warns honestly, and remains eligible for its later result', async (t) => {
  const h = fixture(t);
  const child = h.workflows.get('a');
  child.status = 'completed';
  child.delegation.scope = ['src/a.ts'];
  let checked!: () => void;
  const scope = new Promise<void>((resolve) => {
    checked = resolve;
  });
  h.scopeCheck(() => scope);
  const first = await h.call('get_result', { task_id: 'a' });
  assert.equal(first.isError, undefined);
  assert.match(first.content[0]!.text, /文件范围校验仍在进行，尚未确认通过/);
  assert.deepEqual(h.delivered, []);
  assert.equal(h.suspensions, 0);
  child.delegation.outOfScope = ['outside.ts'];
  checked();
  const second = await h.call('get_result', { task_id: 'a', wait_seconds: 0 });
  assert.match(second.content[0]!.text, /outside\.ts/);
  assert.doesNotMatch(second.content[0]!.text, /仍在进行/);
  assert.deepEqual(h.delivered, ['a']);
});

test('zero waits never park and ordinary read-only results never pretend a scope check is pending', async (t) => {
  const h = fixture(t);
  h.workflows.get('a').status = 'completed';
  h.scopeCheck(() => new Promise(() => {}));
  const result = await h.call('get_result', { task_ids: ['a', 'b'], wait_seconds: 0 });
  assert.equal(result.isError, undefined);
  assert.equal(h.suspensions, 0);
  assert.deepEqual(h.checks, []);
  assert.match(result.content[0]!.text, /Agent A 已完成/);
  assert.match(result.content[0]!.text, /Agent B 仍在处理/);
  assert.doesNotMatch(result.content[0]!.text, /范围校验/);
});

test('default provider budgets reserve MCP response time while an early child result returns promptly', async (t) => {
  for (const [provider, remaining] of [
    ['grok', 48000],
    ['codex', 238000],
  ] as const) {
    const h = fixture(t, provider, {});
    h.onSuspend(() => {
      h.workflows.get('a').status = 'completed';
    });
    const before = Date.now();
    const result = await h.call('get_result', { task_id: 'a' });
    const after = Date.now();
    assert.equal(result.isError, undefined);
    assert.ok(h.resumes[0]!.deadline! >= before + remaining);
    assert.ok(h.resumes[0]!.deadline! <= after + remaining);
  }
});

test('batch waits stop for any child question even when a sibling is still queued', async (t) => {
  // Virtual time: the bound below separates "returned on the question" from "waited out the 500 ms deadline",
  // which real timers on a busy machine cannot resolve.
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.now() });
  const h = fixture(t, 'grok', { ...short, toolTimeoutMs: 750, restoreMarginMs: 200, returnMarginMs: 50 });
  let childSettled = false;
  const started = Date.now();
  const parent = h.call('get_result', { task_ids: ['a', 'b'] });
  const question = h.call('message_parent', { text: 'Which option should A use?' }, 'child');
  void question.then(() => {
    childSettled = true;
  });
  const result = await settle(t, parent);
  assert.match(result.content[0]!.text, /Which option should A use\?/);
  assert.match(result.content[0]!.text, /Agent B 仍在处理/);
  assert.equal(childSettled, false);
  assert.ok(Date.now() - started < 300, 'The queued sibling must not hide the question until the wait deadline.');
  const reply = await settle(t, h.call('message_task', { task_id: 'a', text: 'Use option one' }));
  assert.equal(reply.isError, undefined);
  assert.match((await settle(t, question)).content[0]!.text, /Use option one/);
  assert.equal(h.suspensions, 2);
  assert.equal(h.resumes.length, 2);
});

test('batch result IDs are validated before waiting or parking', async (t) => {
  const h = fixture(t);
  h.workflows.set('foreign', { id: 'foreign', status: 'running', delegation: { parentId: 'other' } });
  for (const args of [{ task_ids: ['a', 'foreign'] }, { task_ids: [] }, { task_id: 'a', task_ids: ['b'] }]) {
    const result = await h.call('get_result', args);
    assert.equal(result.isError, true);
  }
  assert.equal(h.suspensions, 0);
  assert.deepEqual(h.resumes, []);
});
