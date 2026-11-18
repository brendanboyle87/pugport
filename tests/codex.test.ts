import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { contextFromEvent } from '../src/shared/context-usage.ts';
import { mkdtemp, realpath, writeFile, readFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodexAdapter, parseCodexQuota, codexAppServerArgs } from '../src/server/adapters/codex.js';
import { redactError, spawnTarget, terminateProcess, windowsWrapperCommand } from '../src/server/adapters/process.js';
import type { ApprovalKey, ExecuteContext, RunEvent, RuntimeTarget } from '../src/shared/types.js';

let directory: string;
const codexAdapter = createCodexAdapter({
  sandboxStatus: async () => ({ available: false, reason: 'sdk-missing', message: '沙箱组件未安装' }),
});
let fixture: string;
const extensionTool = 'mcp_0123456789abcdef__create_issue_with_long_na_0123456789ab';
before(async () => {
  // A child canonicalizes cwd: macOS /var temp aliases must identify the same strict sandbox root.
  directory = await realpath(await mkdtemp(join(tmpdir(), 'agent-studio-codex-test-')));
  fixture = join(directory, 'mock.mjs');
  await writeFile(
    fixture,
    `
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const mode = process.argv[2];
const automatic = mode.startsWith('auto-');
const writable = mode === 'auto-write' || mode.endsWith('bridge-write');
if(mode.includes('bridge-')) {
  const args=process.argv.slice(3);
  if(!args.includes('mcp_servers.pugport.default_tools_approval_mode=approve'))process.exit(26);
  const perTool=args.filter(arg=>arg.startsWith('mcp_servers.pugport.tools.'));
  const expected=!automatic&&writable?['mcp_servers.pugport.tools.${extensionTool}.approval_mode=auto']:[];
  if(JSON.stringify(perTool)!==JSON.stringify(expected))process.exit(27);
  if(perTool.some(arg=>args[args.indexOf(arg)-1]!=='-c'))process.exit(28);
}
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
const notify = (method,params) => send({method,params});
let initialized=false;
let resumed=false;
const threadId='thread-test';
const turnId='turn-test';
const finish=()=>{
  notify('item/completed',{threadId,turnId,item:{id:'message-test',type:'agentMessage',text:'hello 世界'}});
  notify('thread/tokenUsage/updated',{threadId,turnId,tokenUsage:{total:{totalTokens:12,inputTokens:8,outputTokens:4},last:{totalTokens:10,inputTokens:7,cachedInputTokens:5,outputTokens:3,reasoningOutputTokens:2},modelContextWindow:200000,privateToken:'secret-should-not-leak'}});
  notify('turn/completed',{threadId,turn:{id:turnId,status:'completed'}});
};
const input=createInterface({input:process.stdin});
input.on('line',line=>{
  const message=JSON.parse(line);
  const p=message.params||{};
  if(message.id==='elicitation-test') {
    const expected=mode==='mcp-approve'?'accept':'decline';
    if(message.result?.action!==expected)process.exit(29);
    if(expected==='accept'&&(JSON.stringify(message.result.content)!=='{}'||message.result._meta!==null))process.exit(30);
    finish(); return;
  }
  if(message.id==='approval-test') {
    if((mode==='approve'||mode==='file-approve') && message.result?.decision!=='accept') process.exit(8);
    if(mode==='decline' && message.result?.decision!=='decline') process.exit(9);
    if(message.result?.decision==='acceptForSession') process.exit(10);
    if(automatic && mode!=='auto-permissions' && message.result?.decision!=='decline')process.exit(20);
    if(mode==='auto-permissions' && (JSON.stringify(message.result?.permissions)!=='{}'||message.result?.scope!=='turn'))process.exit(21);
    finish(); return;
  }
  if(message.method==='initialize'){initialized=true;send({id:message.id,result:{}});return;}
  if(message.method==='initialized') return;
  if(!initialized) process.exit(7);
  if(message.method==='account/read') {
    if(p.refreshToken!==false)process.exit(18);
    if(mode==='account-unknown')send({id:message.id,error:{code:-32601,message:'Unsupported account mode token=secret-should-not-leak'}});
    else if(mode==='account-missing')send({id:message.id,result:{account:null,requiresOpenaiAuth:true}});
    else send({id:message.id,result:{account:{type:mode==='api-key'?'apiKey':mode==='other-auth'?'amazonBedrock':'chatgpt',planType:'pro',email:'private-email-must-not-leak@example.test'},requiresOpenaiAuth:true}});
    return;
  }
  if(message.method==='model/list') {
    send({id:message.id,result:{data:[{model:p.cursor?'model-two':'model-one',isDefault:!p.cursor,displayName:'Mock',supportedReasoningEfforts:[{reasoningEffort:'low'}],defaultReasoningEffort:'low'}],nextCursor:p.cursor?null:'second'}});return;
  }
  if(message.method==='account/rateLimits/read') {
    if(mode==='api-key')process.exit(19);
    if(mode==='auth') send({id:message.id,error:{code:-32600,message:'Authentication required token=secret-should-not-leak'}});
    else send({id:message.id,result:{rateLimitsByLimitId:{codex:{primary:{usedPercent:0,resetsAt:2000000000,windowDurationMins:300},secondary:{usedPercent:null}}}}});
    return;
  }
  if(message.method==='thread/resume'||message.method==='thread/start') {
    if(p.sandbox!==(writable?'workspace-write':'read-only')||p.approvalPolicy!==(automatic?'never':'on-request')||p.approvalsReviewer!=='user') process.exit(11);
    if(mode==='resume'&&message.method!=='thread/resume')process.exit(12);
    if(mode==='resume-missing'){send({id:message.id,error:{code:-32602,message:'Synthetic missing thread'}});return;}
    resumed=message.method==='thread/resume';
    send({id:message.id,result:{thread:{id:threadId}}});return;
  }
  if(message.method==='turn/start'){
    if(p.sandboxPolicy?.type!==(writable?'workspaceWrite':'readOnly')||p.sandboxPolicy?.networkAccess!==false)process.exit(13);
    if(writable && (p.sandboxPolicy.writableRoots?.[0]!==process.cwd()||p.sandboxPolicy.writableRoots?.[1]!==process.env.TMPDIR||p.sandboxPolicy.writableRoots?.length!==2||!p.sandboxPolicy.excludeTmpdirEnvVar||!p.sandboxPolicy.excludeSlashTmp))process.exit(22);
    if(p.approvalPolicy!==(automatic?'never':'on-request')||p.approvalsReviewer!=='user')process.exit(14);
    if(p.model!=='model-one'||p.effort!=='low')process.exit(15);
    if(p.input?.[0]?.text!=='safe $() & | prompt')process.exit(16);
    if(mode==='auto-image'&&(p.input?.length!==2||p.input[1]?.type!=='localImage'||p.input[1]?.path!=='C:/managed/image.png'))process.exit(23);
    notify('turn/started',{threadId,turn:{id:turnId,status:'inProgress'}});
    send({id:message.id,result:{turn:{id:turnId,status:'inProgress'}}});
    if(mode==='cancel')return;
    if(mode==='failure'){
      notify('turn/completed',{threadId,turn:{id:turnId,status:'failed',error:{message:'Unauthorized bearer secret-should-not-leak'}}});return;
    }
    notify('item/agentMessage/delta',{threadId:'foreign-thread',turnId,delta:'must-not-appear'});
    notify('item/agentMessage/delta',{threadId,turnId,itemId:'message-test',delta:'hello '});
    if(mode==='tool-results'){
      notify('item/completed',{threadId,turnId,item:{id:'command-ok',type:'commandExecution',status:'completed',exitCode:0,command:'echo token=SECRET_COMMAND',cwd:'project',aggregatedOutput:'Visible command output'}});
      notify('item/completed',{threadId,turnId,item:{id:'command-bad',type:'commandExecution',status:'completed',exitCode:1}});
      notify('item/completed',{threadId,turnId,item:{id:'read-bad',type:'mcpToolCall',status:'failed',server:'pugport',tool:'read_document',error:{message:'private-raw-error'}}});
      notify('item/completed',{threadId,turnId,item:{id:'mcp-error-result',type:'mcpToolCall',status:'completed',server:'pugport',tool:'find_files',result:{isError:true,content:[]}}});
      notify('item/started',{threadId,turnId,item:{id:'subagent-no-status',type:'collabAgentToolCall'}});
      notify('item/completed',{threadId,turnId,item:{id:'subagent-no-status',type:'collabAgentToolCall'}});
      finish();return;
    }
    if(mode.startsWith('steer'))return;
    if(mode.includes('mcp-')){
      send({id:'elicitation-test',method:'mcpServer/elicitation/request',params:{threadId,turnId,
        serverName:mode==='mcp-other-server'?'other':'pugport',mode:mode==='mcp-url'?'url':'form',
        _meta:{...(mode==='mcp-form'?{}:{codex_approval_kind:'mcp_tool_call'}),persist:['session','always'],
          tool_description:'[Synthetic extension] Write a test marker.',tool_params:{marker:'m-1'},
          tool_params_display:[{name:'marker',value:'m-1',display_name:'marker'}]},
        message:'Allow the pugport MCP server to run tool "synthetic_write"?',
        requestedSchema:{type:'object',properties:mode==='mcp-fields'?{answer:{type:'string'}}:{}}}});return;
    }
    if(mode==='file-approve'||mode==='auto-file-approve'||mode.startsWith('file-context-')){
      notify('item/started',{threadId,turnId,item:{id:'file-item',type:'fileChange',changes:[{path:'workspace-created.txt',kind:{type:'add'},diff:'+WORKSPACE_BUILD_OK'}]}});
      const extra=mode==='file-context-grant'?{grantRoot:process.cwd()}:mode==='file-context-network'?{networkApprovalContext:{host:'fixture.invalid'}}:{};
      send({id:'approval-test',method:'item/fileChange/requestApproval',params:{threadId,turnId,itemId:'file-item',reason:'File change',...extra}});return;
    }
    if(mode==='auto-permissions'||mode==='permissions'){
      send({id:'approval-test',method:'item/permissions/requestApproval',params:{threadId,turnId,reason:'Needs network',permissions:{network:{enabled:true}}}});return;
    }
    if(mode==='duplicate-approve')notify('item/started',{threadId,turnId,item:{id:'command-item',type:'commandExecution',command:'echo hello',cwd:process.cwd()}});
    if(mode==='approve'||mode==='decline'||mode==='auto-approve'||mode==='duplicate-approve'||mode==='command-context-network'){
      send({id:'approval-test',method:'item/commandExecution/requestApproval',params:{threadId,turnId,itemId:mode==='duplicate-approve'?'command-item':undefined,reason:'Test approval',command:'echo hello',cwd:process.cwd(),...(mode==='command-context-network'?{networkApprovalContext:{host:'fixture.invalid'}}:{})}});return;
    }
    finish();return;
  }
  if(message.method==='turn/steer'){
    if(p.threadId!==threadId||p.expectedTurnId!==turnId||p.input?.[0]?.type!=='text'||p.input?.[0]?.text!=='Actually focus on tests 世界 $() & |')process.exit(24);
    if(Object.keys(p).sort().join(',')!=='expectedTurnId,input,threadId')process.exit(25);
    if(mode==='steer-reject')send({id:message.id,error:{code:-32601,message:'Unsupported steer token=secret-should-not-leak'}});
    else send({id:message.id,result:{turnId:mode==='steer-mismatch'?'other-turn':turnId}});
    finish();return;
  }
  if(message.method==='turn/interrupt'){
    if(p.threadId!==threadId||p.turnId!==turnId)process.exit(17);
    writeFileSync(fileURLToPath(new URL('./interrupt-marker',import.meta.url)), JSON.stringify(p));
    send({id:message.id,result:{}});
    notify('turn/completed',{threadId,turn:{id:turnId,status:'interrupted'}});return;
  }
});
input.on('close',()=>process.exit(0));
`,
  );
});
after(async () => {
  await unlink(fixture);
  await unlink(join(directory, 'interrupt-marker')).catch(() => {});
  await rmdir(directory);
});

function target(mode = 'normal'): RuntimeTarget {
  return {
    id: 'codex-mock',
    provider: 'codex',
    label: 'Mock Codex',
    command: process.execPath,
    args: [fixture, mode],
    environment: 'native',
    enabled: true,
  };
}
function context(mode = 'normal', signal = new AbortController().signal) {
  const events: RunEvent[] = [];
  const approvals: string[] = [];
  const approvalKeys: Array<ApprovalKey | undefined> = [];
  const ctx: ExecuteContext = {
    target: target(mode),
    input: { prompt: 'safe $() & | prompt', projectPath: directory, kind: 'general', permissionMode: 'read-only' },
    route: { runtimeId: 'codex-mock', model: 'model-one', effort: 'low', kind: 'general', reasons: [], warnings: [] },
    signal,
    emit: (event) => {
      events.push(event);
    },
    approve: async (tool, description, key) => {
      approvals.push(tool + description);
      approvalKeys.push(key);
      return mode === 'approve' || mode === 'file-approve' || mode === 'mcp-approve';
    },
  };
  return { ctx, events, approvals, approvalKeys };
}

test('native tool outcomes expose exit codes and sanitized MCP failure messages', async () => {
  const { ctx, events } = context('tool-results');
  await codexAdapter.execute(ctx);
  const tools = events.filter((event) => event.type === 'tool');
  assert.equal(tools.find((event) => event.data?.itemId === 'command-ok')?.data?.exitCode, 0);
  assert.equal(tools.find((event) => event.data?.itemId === 'command-bad')?.data?.exitCode, 1);
  assert.equal(tools.find((event) => event.data?.itemId === 'read-bad')?.data?.server, 'pugport');
  assert.equal(tools.find((event) => event.data?.itemId === 'read-bad')?.data?.isError, true);
  assert.equal(tools.find((event) => event.data?.itemId === 'mcp-error-result')?.data?.isError, true);
  const failedRead = tools.find((event) => event.data?.itemId === 'read-bad' && event.data?.status === 'failed')?.data;
  assert.equal(failedRead?.failureMessage, 'private-raw-error');
  assert.ok(!String(failedRead?.failureDetail).includes('private-raw-error'));
  const command = tools.find((event) => event.data?.itemId === 'command-ok')?.data;
  assert.equal(command?.command, 'echo token=[redacted]');
  assert.equal(command?.cwd, 'project');
  assert.equal(command?.output, 'Visible command output');
  assert.ok(!JSON.stringify(events).includes('SECRET_COMMAND'));
  // Items without a status of their own are in progress when started and finished when completed.
  assert.deepEqual(
    tools.filter((event) => event.data?.itemId === 'subagent-no-status').map((event) => event.data?.status),
    ['inProgress', 'completed'],
  );
});

test('quota uses multi-bucket view, preserves zero and unknown, converts Unix seconds', () => {
  const quota = parseCodexQuota({
    rateLimitsByLimitId: { first: { primary: { usedPercent: 0, resetsAt: 2000000000 }, secondary: {} } },
    rateLimits: { primary: { usedPercent: 99 } },
  });
  assert.equal(quota.windows[0]?.usedPercent, 0);
  assert.equal(quota.windows[0]?.resetsAt, new Date(2000000000000).toISOString());
  assert.equal(quota.windows.length, 1);
  assert.equal(parseCodexQuota({}).status, 'unknown');
  assert.equal(parseCodexQuota({ rateLimits: { primary: { usedPercent: null } } }).windows[0]?.usedPercent, null);
});

test('discovery paginates models and reads quota without starting a turn', async () => {
  const result = await codexAdapter.discover(target());
  assert.equal(result.status, 'ready');
  assert.equal(result.defaultModel, 'model-one');
  assert.deepEqual(
    result.models.map((model) => model.id),
    ['model-one', 'model-two'],
  );
  assert.equal(result.quota.status, 'known');
  assert.equal(result.authMode, 'chatgpt');
  assert.equal(result.subscription?.label, 'Pro');
  assert.ok(!JSON.stringify(result).includes('private-email-must-not-leak'));
});

test('explicit API-key discovery records usage accounting without querying ChatGPT quota or retaining account details', async () => {
  const result = await codexAdapter.discover(target('api-key'));
  assert.equal(result.subscription, undefined);
  assert.equal(result.status, 'ready');
  assert.equal(result.authMode, 'apiKey');
  assert.equal(result.accounting?.mode, 'usage');
  assert.equal(result.quota.status, 'unknown');
  assert.deepEqual(result.quota.windows, []);
  assert.ok(!JSON.stringify(result).includes('private-email-must-not-leak'));
});

test('unknown, unavailable and unauthenticated account responses are never inferred to be API key mode', async () => {
  for (const mode of ['account-unknown', 'other-auth', 'account-missing']) {
    const result = await codexAdapter.discover(target(mode));
    assert.equal(result.authMode, 'unknown');
    assert.notEqual(result.accounting?.mode, 'usage');
    assert.ok(!JSON.stringify(result).includes('secret-should-not-leak'));
    if (mode === 'account-missing') assert.equal(result.status, 'auth-required');
  }
});

test('authentication errors do not leak diagnostics or become zero quota', async () => {
  const result = await codexAdapter.discover(target('auth'));
  assert.equal(result.status, 'auth-required');
  assert.equal(result.quota.status, 'unknown');
  assert.equal(result.quota.note, 'authentication-required');
  assert.ok(!JSON.stringify(result).includes('secret-should-not-leak'));
});

test('execute streams root messages, reconciles final text, emits numeric usage and session', async () => {
  const { ctx, events } = context();
  const result = await codexAdapter.execute(ctx);
  assert.equal(result.output, 'hello 世界');
  assert.equal(result.nativeSessionId, 'thread-test');
  assert.equal(
    events
      .filter((event) => event.type === 'text')
      .map((event) => event.text)
      .join(''),
    'hello 世界',
  );
  assert.ok(events.some((event) => event.type === 'session'));
  assert.ok(events.some((event) => event.type === 'usage'));
  const usage = events.find((event) => event.type === 'usage')!;
  assert.deepEqual(contextFromEvent('codex', ctx.route.model, usage), { tokens: 8, window: 200000, at: usage.at });
  assert.ok(!JSON.stringify(events).includes('secret-should-not-leak'));
});

test('cleanup timing separates synchronous quota event processing from RPC close', async (t) => {
  const { ctx, events } = context();
  ctx.route.accountFingerprint = 'synthetic-account-fingerprint';
  let clock = 100;
  let closed = false;
  let closedWhenReported: boolean | undefined;
  t.mock.method(performance, 'now', () => clock);
  const emit = ctx.emit;
  ctx.emit = (event) => {
    emit(event);
    if (event.data?.kind === 'post-turn-quota-read') clock += 17;
    if (event.data?.kind === 'post-turn-cleanup-timing') {
      closedWhenReported = closed;
      clock += 29;
    }
  };
  const adapter = createCodexAdapter({
    terminate: async (child) => {
      await terminateProcess(child);
      clock += 83;
      closed = true;
    },
  });
  const result = await adapter.execute(ctx);
  assert.equal(result.output, 'hello 世界');
  assert.equal(result.nativeSessionId, 'thread-test');
  assert.equal(result.postTurnQuota, undefined);
  assert.equal(closedWhenReported, true);
  assert.deepEqual(
    events.filter((event) => event.data?.kind === 'post-turn-cleanup-timing').map((event) => event.data),
    [
      {
        source: 'pugport',
        kind: 'post-turn-cleanup-timing',
        quotaEventEmitMs: 17,
        rpcCloseMs: 83,
        closeOutcome: 'completed',
      },
    ],
  );
});

test('cleanup timing preserves quota event failures and still closes the RPC', async (t) => {
  const { ctx, events } = context();
  ctx.route.accountFingerprint = 'synthetic-account-fingerprint';
  let clock = 100;
  let closed = false;
  t.mock.method(performance, 'now', () => clock);
  const emit = ctx.emit;
  ctx.emit = (event) => {
    emit(event);
    if (event.data?.kind === 'post-turn-quota-read') {
      clock += 11;
      throw new Error('runtime-timeout');
    }
  };
  const adapter = createCodexAdapter({
    terminate: async (child) => {
      await terminateProcess(child);
      closed = true;
      clock += 7;
    },
  });
  await assert.rejects(adapter.execute(ctx), /runtime-timeout/);
  assert.equal(closed, true);
  const timing = events.find((event) => event.data?.kind === 'post-turn-cleanup-timing');
  assert.equal(timing?.data?.quotaEventEmitMs, 11);
  assert.equal(timing?.data?.rpcCloseMs, 7);
  assert.equal(timing?.data?.closeOutcome, 'completed');
});

for (const closeFails of [false, true]) {
  test(`cleanup timing cannot replace ${closeFails ? 'a close failure' : 'a completed reply'} when its emit fails`, async () => {
    const { ctx, events } = context();
    const closeError = new Error('synthetic-close-failure');
    let closed = false;
    const emit = ctx.emit;
    ctx.emit = (event) => {
      emit(event);
      if (event.data?.kind === 'post-turn-cleanup-timing') throw new Error('synthetic-diagnostic-failure');
    };
    const adapter = createCodexAdapter({
      terminate: async (child) => {
        await terminateProcess(child);
        closed = true;
        if (closeFails) throw closeError;
      },
    });
    if (closeFails) await assert.rejects(adapter.execute(ctx), (error) => error === closeError);
    else assert.equal((await adapter.execute(ctx)).output, 'hello 世界');
    assert.equal(closed, true);
    const timing = events.find((event) => event.data?.kind === 'post-turn-cleanup-timing');
    assert.equal(timing?.data?.quotaEventEmitMs, undefined);
    assert.equal(timing?.data?.closeOutcome, closeFails ? 'failed' : 'completed');
    assert.ok(typeof timing?.data?.rpcCloseMs === 'number' && Number.isFinite(timing.data.rpcCloseMs));
    assert.ok(timing.data.rpcCloseMs >= 0);
  });
}

test(
  'Codex steering targets the active native turn and unregisters when it completes',
  { timeout: 60_000 },
  async () => {
    const { ctx } = context('steer');
    let current: ((prompt: string) => Promise<void>) | undefined;
    let ready!: (handler: (prompt: string) => Promise<void>) => void;
    const registered = new Promise<(prompt: string) => Promise<void>>((resolve) => {
      ready = resolve;
    });
    ctx.registerSteer = (handler) => {
      current = handler;
      if (handler) ready(handler);
    };
    const executing = codexAdapter.execute(ctx);
    const steer = await registered;
    assert.equal(current, steer);
    await steer('Actually focus on tests 世界 $() & |');
    assert.equal((await executing).output, 'hello 世界');
    assert.equal(current, undefined);
    await assert.rejects(steer('No further turn'), /steering-unavailable/);
  },
);

for (const mode of ['steer-reject', 'steer-mismatch'])
  test(`Codex ${mode} reports failed delivery without creating another turn`, { timeout: 60_000 }, async () => {
    const { ctx } = context(mode);
    let ready!: (handler: (prompt: string) => Promise<void>) => void;
    const registered = new Promise<(prompt: string) => Promise<void>>((resolve) => {
      ready = resolve;
    });
    ctx.registerSteer = (handler) => {
      if (handler) ready(handler);
    };
    const executing = codexAdapter.execute(ctx);
    await assert.rejects((await registered)('Actually focus on tests 世界 $() & |'), (error: Error) => {
      assert.ok(!error.message.includes('secret-should-not-leak'));
      assert.match(error.message, mode === 'steer-reject' ? /protocol-incompatible/ : /steer-turn-mismatch/);
      return true;
    });
    assert.equal((await executing).output, 'hello 世界');
  });

test(
  'Codex cancellation immediately unregisters steering and rejects retained handlers',
  { timeout: 60_000 },
  async () => {
    const abort = new AbortController();
    const { ctx } = context('steer-cancel', abort.signal);
    let current: ((prompt: string) => Promise<void>) | undefined;
    let ready!: (handler: (prompt: string) => Promise<void>) => void;
    const registered = new Promise<(prompt: string) => Promise<void>>((resolve) => {
      ready = resolve;
    });
    ctx.registerSteer = (handler) => {
      current = handler;
      if (handler) ready(handler);
    };
    const executing = codexAdapter.execute(ctx);
    const rejected = assert.rejects(executing, /cancelled/);
    const steer = await registered;
    abort.abort();
    assert.equal(current, undefined);
    await assert.rejects(steer('Should not send'), /steering-unavailable/);
    await rejected;
  },
);

test('file approval includes the matching item paths and diff when request has only itemId', async () => {
  const { ctx, approvals, approvalKeys } = context('file-approve');
  await codexAdapter.execute(ctx);
  assert.equal(approvals.length, 1);
  assert.ok(approvals[0]!.includes('workspace-created.txt'));
  assert.ok(approvals[0]!.includes('+WORKSPACE_BUILD_OK'));
  assert.deepEqual(approvalKeys, [{ tool: 'Codex file change', paths: [join(directory, 'workspace-created.txt')] }]);
});

for (const mode of ['approve', 'decline'])
  test(`approval ${mode} sends only an individual decision`, async () => {
    const { ctx, approvals, approvalKeys } = context(mode);
    await codexAdapter.execute(ctx);
    assert.equal(approvals.length, 1);
    assert.deepEqual(approvalKeys, [undefined]);
  });

test('Codex grants, network context and permissions never carry a remember key, including cached file items', async () => {
  for (const mode of ['file-context-grant', 'file-context-network', 'command-context-network', 'permissions']) {
    const { ctx, approvalKeys } = context(mode);
    await codexAdapter.execute(ctx);
    assert.deepEqual(approvalKeys, [undefined], mode);
  }
});

for (const mode of [
  'mcp-approve',
  'mcp-decline',
  'mcp-other-server',
  'mcp-form',
  'mcp-url',
  'mcp-fields',
  'auto-mcp-approve',
])
  test(`Codex ${mode} only approves an individual bridge tool call`, async () => {
    const { ctx, approvals, approvalKeys } = context(mode);
    if (mode.startsWith('auto-')) ctx.approvalMode = 'auto';
    assert.equal((await codexAdapter.execute(ctx)).output, 'hello 世界');
    if (mode === 'mcp-approve' || mode === 'mcp-decline') {
      assert.deepEqual(approvals, [
        'Codex MCP toolAllow the pugport MCP server to run tool "synthetic_write"?\n' +
          '[Synthetic extension] Write a test marker.\n{"marker":"m-1"}',
      ]);
      assert.deepEqual(approvalKeys, [undefined]);
    } else assert.deepEqual(approvals, []);
  });

for (const mode of ['bridge-write', 'auto-bridge-write', 'bridge-read'])
  test(`Codex ${mode} wires bridge approval rules through execute`, async () => {
    const { ctx } = context(mode);
    ctx.approvalMode = mode.startsWith('auto-') ? 'auto' : 'ask';
    if (mode.endsWith('bridge-write')) ctx.input.permissionMode = 'workspace-write';
    ctx.agentBridge = {
      url: 'http://127.0.0.1:1234/mcp',
      token: 'synthetic-token',
      extraTools: [extensionTool, 'use_skill', 'github_create_issue', 'connector_mail_send'],
      askTools: mode.endsWith('bridge-write') ? [extensionTool] : undefined,
    };
    assert.equal((await codexAdapter.execute(ctx)).output, 'hello 世界');
  });

test('resume uses the native thread ID without rewriting history', async () => {
  const { ctx } = context('resume');
  ctx.nativeSessionId = 'thread-test';
  assert.equal((await codexAdapter.execute(ctx)).nativeSessionId, 'thread-test');
});

test('Codex configures an isolated Windows account sandbox without persistent config changes', () => {
  assert.deepEqual(codexAppServerArgs(target(), 'win32'), [
    'app-server',
    '--stdio',
    '-c',
    "mcp_servers.pugport-app={enabled=false,command='pugport-app'}",
    '-c',
    "windows.sandbox='elevated'",
  ]);
  const args = ['app-server', '--stdio', '-c', "mcp_servers.pugport-app={enabled=false,command='pugport-app'}"];
  assert.deepEqual(codexAppServerArgs(target(), 'linux'), args);
  assert.deepEqual(codexAppServerArgs({ ...target(), environment: 'wsl' }, 'win32'), args);
  assert.doesNotThrow(() => windowsWrapperCommand('codex.cmd', codexAppServerArgs(target(), 'win32')));
});

test('Codex disables only pugport-app and retains the authenticated per-run host bridge', () => {
  const args = codexAppServerArgs(target(), 'win32', {
    url: 'http://127.0.0.1:1234/mcp',
    askTools: [extensionTool],
  });
  assert.ok(args.includes("mcp_servers.pugport-app={enabled=false,command='pugport-app'}"));
  assert.ok(args.includes('mcp_servers.pugport.url=http://127.0.0.1:1234/mcp'));
  assert.ok(args.includes('mcp_servers.pugport.default_tools_approval_mode=approve'));
  assert.ok(args.includes('mcp_servers.pugport.tool_timeout_sec=660'));
  assert.ok(args.includes(`mcp_servers.pugport.tools.${extensionTool}.approval_mode=auto`));
  assert.doesNotThrow(() => windowsWrapperCommand('codex.cmd', args));
  assert.ok(!args.includes('mcp_servers={}'));
});

for (const mode of [
  'auto-read',
  'auto-write',
  'auto-resume',
  'auto-approve',
  'auto-file-approve',
  'auto-permissions',
]) {
  test(`Codex ${mode} keeps native sandbox enforcement without host approval`, async () => {
    const { ctx, approvals, events } = context(mode);
    ctx.approvalMode = 'auto';
    if (mode === 'auto-write') ctx.input.permissionMode = 'workspace-write';
    if (mode === 'auto-resume') ctx.nativeSessionId = 'thread-test';
    const result = await codexAdapter.execute(ctx);
    assert.equal(result.output, 'hello 世界');
    assert.deepEqual(approvals, []);
    if (['auto-approve', 'auto-file-approve', 'auto-permissions'].includes(mode))
      assert.ok(
        events.some(
          (event) => event.data?.decision === 'deny' && event.data.kind === 'native-denied' && event.data.reason,
        ),
      );
  });
}

test('Codex preserves image attachment input in read-only automatic execution', async () => {
  const { ctx } = context('auto-image');
  ctx.approvalMode = 'auto';
  ctx.input.attachments = [
    { id: 'image', name: 'image.png', mimeType: 'image/png', kind: 'image', size: 9, path: 'C:/managed/image.png' },
    {
      id: 'notes',
      name: 'notes.txt',
      mimeType: 'text/plain',
      kind: 'file',
      size: 3,
      path: 'C:/managed/notes.txt',
      text: 'abc',
    },
  ];
  assert.equal((await codexAdapter.execute(ctx)).output, 'hello 世界');
});

test('Codex ask-mode command preview does not repeat the cached command and directory', async () => {
  const { ctx, approvals } = context('duplicate-approve');
  ctx.approvalMode = 'ask';
  await codexAdapter.execute(ctx);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0]!.split('echo hello').length - 1, 1);
  assert.equal(approvals[0]!.split(directory).length - 1, 1);
});

test('abort interrupts the active native turn and settles the run', async () => {
  const controller = new AbortController();
  const { ctx } = context('cancel', controller.signal);
  const oldEmit = ctx.emit;
  ctx.emit = (event) => {
    oldEmit(event);
    if (event.type === 'session') setTimeout(() => controller.abort(), 50);
  };
  await assert.rejects(codexAdapter.execute(ctx), { name: 'AbortError' });
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'interrupt-marker'), 'utf8')), {
    threadId: 'thread-test',
    turnId: 'turn-test',
  });
});

test('failed turn errors are classified and never expose original diagnostics', async () => {
  const { ctx } = context('failure');
  await assert.rejects(codexAdapter.execute(ctx), { message: 'authentication-required' });
});

test('CMD wrapper quoting rejects expansion and shell metacharacters', () => {
  assert.equal(
    windowsWrapperCommand('C:\\Program Files\\Claude\\claude.cmd', ['--model', 'claude-opus']),
    '""C:\\Program Files\\Claude\\claude.cmd" "--model" "claude-opus""',
  );
  for (const value of ['a&b', '%PATH%', '!TOKEN!', 'a"b', 'a\nb', 'a|b', '^escape']) {
    assert.throws(() => windowsWrapperCommand('claude.cmd', [value]), /unsafe-wrapper-argument/);
  }
  assert.equal(redactError(new Error('Authentication required bearer secret')), 'authentication-required');
  assert.equal(redactError(new Error('authentication-required')), 'authentication-required');
});

test('owned process shutdown closes stdin and reaps the child', async () => {
  const child = await spawnTarget(target(), []);
  await terminateProcess(child);
  assert.notEqual(child.exitCode, null);
});

test('a rejected thread/resume is classified before requesting a turn', async () => {
  const { ctx, events } = context('resume-missing');
  ctx.nativeSessionId = 'missing-session';
  await assert.rejects(codexAdapter.execute(ctx), /native-session-unavailable/);
  assert.equal(
    events.some((event) => event.type === 'text' || event.type === 'tool'),
    false,
  );
  assert.equal(redactError(new Error('native-session-unavailable')), 'native-session-unavailable');
});
