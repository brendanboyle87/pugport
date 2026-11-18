import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { AgentBridge } from '../src/server/agent-bridge.ts';
import { memberResultText, memberSummary, saveMemberResult, summaryLimit } from '../src/server/member-results.ts';
import type { Controller } from '../src/server/controller.ts';
import type { Workspace } from '../src/server/workspace.ts';

const longReply = (ending: string) => `${'详细过程，逐条核对每个文件。\n'.repeat(160)}\n${ending}`;

test('result pointers are preserved for both readers and oversized paths are ignored', () => {
  const pointer = 'docs/result.md';
  const text = `Full result: ${pointer}\n${'detail\n'.repeat(300)}\n结论：完成。`;
  for (const reader of ['get_result', 'read_document'] as const) {
    assert.match(
      memberResultText(text, false, () => 'saved.md', reader),
      /详细结果：docs\/result\.md/,
    );
    const oversized = `Full result: /${'a'.repeat(512)}\n${'detail\n'.repeat(300)}\n结论：完成。`;
    assert.equal(memberSummary(oversized).artifact, undefined);
    assert.doesNotMatch(
      memberResultText(oversized, false, () => 'saved.md', reader),
      /详细结果：/,
    );
  }
  assert.equal(memberSummary(`Full result: /${'a'.repeat(511)}`).artifact?.length, 512);
});

test('a member’s reply reaches its caller as the conclusion, with the full text kept as a file', (t) => {
  const short = '结论：没有问题。';
  assert.deepEqual(memberSummary(short), { summary: short, whole: true });
  const withHeading = memberSummary(longReply('## 结论\n- 有两处重复\n- 测试缺一个分支\n详细结果：docs/review.md'));
  assert.equal(withHeading.whole, false);
  assert.match(withHeading.summary, /^## 结论\n- 有两处重复/);
  assert.doesNotMatch(withHeading.summary, /详细过程/);
  assert.equal(withHeading.artifact, 'docs/review.md');
  const plain = memberSummary(longReply('最后：一切正常。'));
  assert.ok(plain.summary.startsWith('…') && plain.summary.endsWith('最后：一切正常。'));
  assert.ok(plain.summary.length <= summaryLimit + 1);
  assert.equal(memberSummary(longReply('全文：见上')).artifact, undefined, 'only a path counts as a result file');
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'pugport-member-results-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const text = longReply('结论：发现三处问题。');
  const reply = memberResultText(text, false, () => saveMemberResult(directory, 'conversation-1', 'task-1', text));
  const path = join(directory, 'member-results', 'conversation-1', 'task-1.md');
  assert.match(reply, /^结论：发现三处问题。/);
  assert.match(reply, new RegExp(`全文 ${text.length.toLocaleString('en-US')} 字，已存到 .*task-1\\.md`));
  assert.match(reply, /get_result 加 full=true/);
  assert.equal(readFileSync(path, 'utf8'), text);
  assert.equal(
    memberResultText(text, true, () => assert.fail('a full read needs no file')),
    text,
  );
  assert.equal(
    memberResultText(short, false, () => assert.fail('a short reply needs no file')),
    short,
  );
  assert.equal(saveMemberResult(directory, '../escape', 'task', text), undefined, 'names never leave the folder');
  assert.equal(saveMemberResult(undefined, 'conversation', 'task', text), undefined);
});

type Child = {
  id: string;
  status: string;
  runIds: string[];
  conversationId: string;
  finalMessageId?: string;
  delegation: any;
};

function fixture(t: TestContext) {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'pugport-swarm-fanout-')));
  const runAbort = new AbortController();
  const caller = {
    run: { id: 'parent-run', workflowId: 'parent', status: 'running' },
    target: { id: 'parent-runtime', provider: 'codex', label: 'Codex A' },
    signal: runAbort.signal,
    child: false,
    delegate: true,
    write: true,
    recycle: false,
  };
  const records = new Map<string, any>([
    [
      'parent',
      {
        id: 'parent',
        status: 'running',
        conversationId: 'conversation',
        projectId: 'project',
        input: { swarm: false },
      },
    ],
    ['conversation', { id: 'conversation', projectId: 'project' }],
    ['project', { id: 'project', scope: 'project', path: directory }],
  ]);
  const delegated: Array<{ agent: any; task: string; options: any }> = [];
  const delivered = new Set<string>();
  const controller = Object.assign(new EventEmitter(), {
    dataDir: join(directory, 'data'),
    targets: [
      { id: 'codex-b', provider: 'codex', label: 'Codex B', enabled: true, environment: 'native', command: 'unused' },
    ],
    snapshots: [],
    recordRunEvent() {},
    returnExecution: () => async () => {},
    agentBridgeCaller: (token: string) => (token === 'parent' ? caller : undefined),
    activeRunFor: () => 'parent-run',
    steerInterrupts: () => false,
    canSteer: () => true,
    suspendExecution: () => async () => {},
    run: () => undefined,
  }) as unknown as Controller;
  const workspace = {
    store: { get: (_kind: string, id: string) => records.get(id) },
    scopeChecked: async () => {},
    markResultDelivered: (id: string) => delivered.add(id),
    resultDelivered: (id: string) => delivered.has(id),
    queueNotice: () => {},
    takeNotices: () => [],
    delegateToAgent: async (_parentId: string, agent: any, task: string, options: any) => {
      if (task === 'refuse me') throw new Error('这一项被路由规则拒绝。');
      delegated.push({ agent, task, options });
      const child: Child = {
        id: `child-${delegated.length}`,
        status: 'running',
        runIds: [],
        conversationId: 'conversation',
        delegation: {
          parentId: 'parent',
          agent: { label: agent.label === '自动选择' ? `成员 ${delegated.length}` : agent.label },
        },
      };
      records.set(child.id, child);
      return { workflow: { ...child, input: { content: task, permissionMode: 'read-only' } } };
    },
  } as unknown as Workspace;
  const bridge = new AgentBridge(workspace, controller, 'unused', { toolTimeoutMs: 20_000, pollMs: 5 });
  t.after(async () => {
    runAbort.abort();
    await bridge.close();
    controller.removeAllListeners();
    assert.equal(dirname(directory).toLowerCase(), realpathSync.native(tmpdir()).toLowerCase());
    assert.ok(basename(directory).startsWith('pugport-swarm-fanout-'));
    rmSync(directory, { recursive: true, force: true });
  });
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await bridge.handle('Bearer parent', {
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    });
    const result = (response.body as any).result as { isError?: boolean; content: Array<{ text: string }> };
    return { error: result.isError === true, text: result.content.map((block) => block.text).join('\n') };
  };
  const finish = (id: string, content: string, status = 'completed') => {
    records.set(`message-${id}`, { id: `message-${id}`, content });
    Object.assign(records.get(id), { status, finalMessageId: `message-${id}` });
  };
  return { call, records, delegated, delivered, finish, directory };
}

test('delegate_many creates every independent sub-task in one call and reports any it could not create', async (t) => {
  const f = fixture(t);
  const reply = await f.call('delegate_many', {
    tasks: [
      { task: 'Read the routing code', plan_id: 'read' },
      {
        agent: 'Codex B',
        task: 'Rewrite the allocation',
        write: true,
        files: ['src/server/routing.ts'],
        tier: 'strong',
      },
      { task: 'refuse me' },
      { agent: '自动', task: 'Check the docs', effort: 'low' },
    ],
  });
  assert.equal(reply.error, false);
  assert.match(reply.text, /1\. 成员 1（task_id: child-1，plan_id: read）已派出/);
  assert.match(reply.text, /2\. Codex B（task_id: child-2）已派出/);
  assert.match(reply.text, /3\. 没有派出：这一项被路由规则拒绝。/);
  assert.match(reply.text, /4\. 成员 3（task_id: child-3）已派出/);
  assert.match(reply.text, /wait=any/);
  assert.deepEqual(
    f.delegated.map(({ agent, options }) => [
      agent.label,
      agent.runtimeId,
      options.planItem,
      options.tier,
      options.write,
      options.effort,
    ]),
    [
      ['自动选择', undefined, 'read', undefined, false, undefined],
      ['Codex B', 'codex-b', undefined, 'strong', true, undefined],
      ['自动选择', undefined, undefined, undefined, false, 'low'],
    ],
  );
  assert.deepEqual(f.delegated[1]!.options.files, ['src/server/routing.ts']);
  const none = await f.call('delegate_many', { tasks: [{ task: 'refuse me' }] });
  assert.equal(none.error, true, 'nothing created is an error');
  const tooMany = await f.call('delegate_many', { tasks: Array.from({ length: 17 }, () => ({ task: 'x' })) });
  assert.match(tooMany.text, /一次最多派出 16 个子任务/);
});

test('get_result with wait=any returns as soon as one member finishes, and never hands back the same result twice', async (t) => {
  const f = fixture(t);
  await f.call('delegate_many', { tasks: [{ task: 'A' }, { task: 'B' }, { task: 'C' }] });
  setTimeout(() => f.finish('child-2', '结论：B 做完了。'), 60);
  const started = Date.now();
  const first = await f.call('get_result', {
    task_ids: ['child-1', 'child-2', 'child-3'],
    wait: 'any',
    wait_seconds: 10,
  });
  assert.ok(Date.now() - started < 5_000, 'it does not wait for the others');
  assert.match(first.text, /成员 2 已完成（task_id: child-2）：\n\n结论：B 做完了。/);
  assert.match(first.text, /成员 1（task_id: child-1）仍在处理/);
  assert.match(first.text, /还有 2 个在进行/);
  setTimeout(() => f.finish('child-1', '结论：A 做完了。'), 60);
  const second = await f.call('get_result', {
    task_ids: ['child-1', 'child-2', 'child-3'],
    wait: 'any',
    wait_seconds: 10,
  });
  assert.match(second.text, /成员 1 已完成（task_id: child-1）/);
  assert.match(second.text, /成员 2（task_id: child-2）的结果之前已经交给你，不再重复/);
  assert.match(second.text, /还有 1 个在进行/);
  f.finish('child-3', '结论：C 做完了。');
  const all = await f.call('get_result', { task_ids: ['child-1', 'child-2', 'child-3'] });
  assert.match(all.text, /成员 1 已完成[\s\S]*成员 2 已完成[\s\S]*成员 3 已完成/, 'wait=all still gives every result');
  assert.doesNotMatch(all.text, /还有/);
  const invalid = await f.call('get_result', { task_ids: ['child-1'], wait: 'first' });
  assert.equal(invalid.error, true);
  const many = Array.from({ length: 17 }, (_, index) => `child-${index + 1}`);
  assert.match((await f.call('get_result', { task_ids: many })).text, /请指定 1 到 16 个/);
});

test('long results come back as the conclusion and a file; full=true gives the whole reply', async (t) => {
  const f = fixture(t);
  await f.call('delegate', { task: 'Review everything', wait_seconds: 0 });
  const text = longReply('结论：发现两处问题。\n详细结果：docs/review.md');
  f.finish('child-1', text);
  const summary = await f.call('get_result', { task_id: 'child-1' });
  assert.match(summary.text, /成员 1 已完成（task_id: child-1）：\n\n结论：发现两处问题。\n详细结果：docs\/review\.md/);
  assert.doesNotMatch(summary.text, /详细过程/);
  const saved = join(f.directory, 'data', 'member-results', 'conversation', 'child-1.md');
  assert.ok(summary.text.includes(saved));
  assert.ok(existsSync(saved));
  assert.equal(readFileSync(saved, 'utf8'), text);
  const full = await f.call('get_result', { task_id: 'child-1', full: true });
  assert.ok(full.text.includes(text));
  assert.doesNotMatch(full.text, /只列了结论/);
  f.records.set('child-1', { ...f.records.get('child-1'), status: 'failed', error: undefined });
  assert.match((await f.call('get_result', { task_id: 'child-1' })).text, /未完成[\s\S]*结论：发现两处问题。/);
});
