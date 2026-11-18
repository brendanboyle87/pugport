import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { contextFromEvent } from '../src/shared/context-usage.ts';
import { mkdtemp, readdir, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCursorAdapter,
  cursorAccountFingerprint,
  cursorModels,
  cursorParameterizedModels,
  cursorResultUsage,
  cursorBridgeServers,
  cursorExecutionArgs,
  readCursorIdentity,
  sessionModel,
} from '../src/server/adapters/cursor.ts';
import { captureTarget, spawnTarget } from '../src/server/adapters/process.ts';
import { route, RouteUnavailableError } from '../src/server/routing.ts';
import type { CursorUsageIdentity } from '../src/server/cursor-usage.ts';
import { supportsImageInput } from '../src/shared/image-input.ts';
import type { ExecuteContext, RunEvent, RuntimeTarget, Settings } from '../src/shared/types.ts';

// Production deadlines (10 s CLI metadata, 20 s ACP requests) bound a real Cursor CLI, but a fixture process
// on a busy machine can need longer than that just to start. Tests wait for the fixture's own exit or reply;
// this guard only ends a genuine hang.
const FIXTURE_GUARD_MS = 60_000;
const fixtureCapture: typeof captureTarget = (t, args, options = {}) =>
  captureTarget(t, args, { ...options, timeoutMs: FIXTURE_GUARD_MS });
const fixtureAdapter = (overrides: Parameters<typeof createCursorAdapter>[0] = {}) =>
  createCursorAdapter({ capture: fixtureCapture, requestTimeoutMs: FIXTURE_GUARD_MS, ...overrides });
const cursorAdapter = fixtureAdapter();

let directory: string, fixture: string;
const identity = {
  status: 'authenticated',
  isAuthenticated: true,
  userInfo: { userId: 'fixture-user', email: 'private@example.test' },
};
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'comborunner-cursor-test-'));
  fixture = join(directory, 'cursor-mock.mjs');
  await writeFile(
    fixture,
    `
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const [mode,...args]=process.argv.slice(2);
const identity={status:'authenticated',isAuthenticated:true,userInfo:{userId:'fixture-user',email:'private@example.test'}};
const marker=(name,value)=>writeFileSync(join(fileURLToPath(new URL('.',import.meta.url)),mode+'-'+name),JSON.stringify(value));
if(args[0]==='status'){console.log(JSON.stringify(mode==='auth'?{status:'unauthenticated',isAuthenticated:false}:mode==='no-identity'?{status:'authenticated',isAuthenticated:true}:identity));process.exit(0);}
if(args[0]==='about'){console.log(JSON.stringify({cliVersion:'2026.10.01-fixture',subscriptionTier:'Pro',userEmail:'private@example.test',privateToken:'secret-should-not-leak'}));process.exit(0);}
if(args[0]==='models'){console.log('Available models\\n\\nauto - Auto (default)\\ngrok-4.7-high - Grok 4.7 High\\ngrok-4.7-high-fast - Grok 4.7 High Fast\\ncomposer-2.5 - Composer 2.5\\n\\nTip: use --model <id>');process.exit(0);}
if(args.at(-1)!=='acp')process.exit(20);
marker('args',args);
if(mode==='reject-mode-ask'&&args.includes('--mode')){process.stderr.write("fixture banner\\nerror: unknown option '--mode ask'\\n");process.exit(1);}
const send=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n');
const notify=(update,sessionId='fixture-session')=>send({method:'session/update',params:{sessionId,update}});
const modes={currentModeId:'agent',availableModes:mode==='no-ask'? [{id:'agent'}]:[{id:'agent'},{id:'ask'},{id:'plan'}]};
const parameterized=mode.startsWith('params-');
const option=(id,category,currentValue,values)=>({id,category,type:'select',currentValue,options:values.map(value=>({value}))});
const catalog=[
 {value:'grok-4.7',name:'Grok 4.7',configOptions:[option('reasoning_effort','thought_level','medium',['low','medium','high']),option('fast','model_config','true',['false','true']),option('context','model_config','256k',['128k','256k'])]},
 {value:'gpt-5.6-sol',name:'GPT-5.6 Sol',configOptions:[option('reasoning','thought_level','medium',['none','low','medium','high','xhigh','max']),option('fast','model_config','true',['false','true']),option('context','model_config','272k',['272k','1m'])]},
 {value:'claude-opus-5',name:'Claude Opus 5',configOptions:[option('effort','thought_level','medium',['low','medium','high','max']),option('thinking','thought_level',mode.startsWith('params-thinking-default')?'true':'false',['false','true'])]},
 {value:'composer-2.5',name:'Composer 2.5',configOptions:[]},
];
const modelOption=value=>({...option('model','model',value,catalog.map(row=>row.value))});
let configOptions=parameterized?[modelOption('composer-2.5')]:mode.startsWith('bracket-')?[{id:'model',category:'model',type:'select',currentValue:'composer-2.5[fast=true]',options:[{value:'grok-4.7[context=256k,reasoning_effort=medium,fast=true]',name:'grok-4.7'},...(mode==='bracket-exact'?[{value:'grok-4.7[context=256k,reasoning_effort=high,fast=false]'}]:[]),{value:'composer-2.5[fast=true]',name:'composer-2.5'}]}]:[{id:'model',category:'model',type:'select',currentValue:'composer-2.5',options:[{value:'grok-4.7-high'},{value:'grok-4.7-high-fast'},{value:'composer-2.5'},{value:'auto'}]}];
let promptId,permissions=0;
const finish=()=>{
 notify({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'世界'}});
 notify({sessionUpdate:'usage_update',used:9000,size:256000,cost:{amount:0.04,currency:'USD'},token:'secret-should-not-leak'});
 if(mode==='failure')send({id:promptId,error:{code:-32603,message:'Unauthorized bearer secret-should-not-leak'}});
 else if(mode==='quota-failure')send({id:promptId,error:{code:-32000,message:'Usage limit exceeded token=secret-should-not-leak'}});
 else if(mode==='network-failure')send({id:promptId,error:{code:-32000,message:'Network connection failed token=secret-should-not-leak'}});
 else send({id:promptId,result:{stopReason:mode==='limit'?'max_tokens':'end_turn',usage:{inputTokens:8,outputTokens:4,totalTokens:12,cachedReadTokens:0,cachedWriteTokens:2,thoughtTokens:1,token:'secret-should-not-leak'}}});
};
const requestPermission=(id,kind,details={})=>send({id,method:'session/request_permission',params:{sessionId:'fixture-session',toolCall:{kind,title:'Cursor '+kind,token:'secret-should-not-leak',...details},options:[{optionId:'allow',kind:'allow_once'},{optionId:'always',kind:'allow_always'},{optionId:'deny',kind:'reject_once'}]}});
const input=createInterface({input:process.stdin});
input.on('line',line=>{
 const msg=JSON.parse(line),p=msg.params||{};
 marker('last-rpc',msg.method??msg.id);
 if(msg.jsonrpc!=='2.0')process.exit(21);
 if(typeof msg.id==='string'){
   marker(msg.id,msg.result??msg.error);
   if(msg.id==='block')return;
   if(mode==='readonly-denials') {if(++permissions===7)finish();return;}
   if(mode==='readonly-host') {if(++permissions===9)finish();return;}
   if(msg.id==='question'){send({id:'plan',method:'cursor/create_plan',params:{sessionId:'fixture-session',plan:'Test plan'}});return;}
   if(msg.id==='plan'){finish();return;}
   if(msg.id==='permission'){finish();return;}
   return;
 }
 if(msg.method==='initialize'){
  marker('initialize',p);
  if(mode==='invalid-json'){process.stdout.write('not json\\n');process.exit(1);}
  const promptCapabilities=mode==='missing-image-capability'?{}:{image:mode==='no-image-capability'?false:mode==='invalid-image-capability'?'true':true};
  send({id:msg.id,result:{protocolVersion:mode==='bad-version'?99:1,agentCapabilities:{loadSession:mode!=='no-resume',mcpCapabilities:{http:mode!=='no-http'},promptCapabilities},authMethods:[{id:'cursor_login'}]}});return;
 }
 if(msg.method==='authenticate')process.exit(22);
 if(msg.method==='cursor/list_available_models'){
  marker('catalog',p);
  if(mode==='params-bad-catalog'){send({id:msg.id,error:{code:-32602,message:'invalid catalog request'}});return;}
  if(parameterized){send({id:msg.id,result:{models:catalog}});return;}
  send({id:msg.id,error:{code:-32601,message:'Unsupported'}});return;
 }
 if(msg.method==='session/new'||msg.method==='session/load'){
  marker('session',p);
  if(mode==='resume-missing'){send({id:msg.id,error:{code:-32602,message:'Synthetic missing session'}});return;}
  if(msg.method==='session/load')notify({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'old-history-must-not-appear'}});
  send({id:msg.id,result:{...(msg.method==='session/new'?{sessionId:'fixture-session'}:{}),modes,configOptions}});return;
 }
 if(msg.method==='session/set_mode'){
  marker('mode',p);
  if(p.modeId!==(args.includes('--mode')?args[args.indexOf('--mode')+1]:'agent'))process.exit(23);
  notify({sessionUpdate:'current_mode_update',currentModeId:p.modeId});send({id:msg.id,result:{}});return;
 }
 if(msg.method==='session/set_config_option'){
  marker('config-'+p.configId,p);
  if(p.configId==='model')marker('model',p);
  if(parameterized){
   if(p.configId==='model'){
    const selected=catalog.find(row=>row.value===p.value);
    if(!selected){send({id:msg.id,error:{code:-32602,message:'invalid model'}});return;}
    configOptions=[modelOption(p.value),...structuredClone(selected.configOptions)];
   }else{
    const selected=configOptions.find(row=>row.id===p.configId);
    if(!selected?.options.some(o=>o.value===p.value)){send({id:msg.id,error:{code:-32602,message:'invalid setting'}});return;}
    selected.currentValue=mode==='params-refuses-effort'?'medium':p.value;
    if(mode==='params-resets-effort'&&p.configId==='fast')configOptions.find(o=>o.category==='thought_level').currentValue='medium';
   }
   send({id:msg.id,result:{configOptions}});return;
  }
  send({id:msg.id,result:{configOptions:configOptions.map(o=>({...o,currentValue:mode==='model-mismatch'?'wrong':p.value}))}});return;
 }
 if(msg.method==='session/cancel'){
  marker('cancel',p);
  if(mode!=='cancel-hang')send({id:promptId,result:{stopReason:'cancelled'}});return;
 }
 if(msg.method==='session/prompt'){
  promptId=msg.id;marker('prompt',p);
  process.stderr.write('Authorization: Bearer secret-should-not-leak\\n');
  notify({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'foreign-must-not-appear'}},'foreign-session');
  notify({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'hello '}});
  const thinking=Buffer.from(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'fixture-session',update:{sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'推理'}}}})+'\\n');
  const boundary=thinking.indexOf(Buffer.from('推'))+1;process.stdout.write(thinking.subarray(0,boundary));process.stdout.write(thinking.subarray(boundary));
  notify({sessionUpdate:'tool_call',toolCallId:'tool-1',kind:'read',title:'Read token=secret-should-not-leak',status:'pending',rawInput:{path:'README.md',token:'secret-should-not-leak'}});
  notify({sessionUpdate:'tool_call_update',toolCallId:'tool-1',status:'completed',rawOutput:{text:'File result',system_prompt:'PRIVATE_NATIVE_PROMPT'}});
  if(mode==='readonly-denials') {for(const [i,kind] of ['edit','execute','delete','move','switch_mode','other','unknown'].entries())requestPermission('deny-'+i,kind);return;}
  if(mode==='readonly-host') {
   for(const [i,kind,details] of [
    [0,'other',{toolName:'mcp__pugport__delegate'}],
    [1,'other',{rawInput:{tool_name:'mcp__pugport__list_swarm'}}],
    [2,'other',{_meta:{'x.ai/tool':{name:'mcp__pugport__message_agent'}}}],
    [3,'other',{title:'mcp__pugport__delegate'}],
    [4,'other',{toolName:'mcp__foreign__delegate'}],
    [5,'other',{toolName:'mcp__pugport__organize_files'}],
    [6,'edit',{toolName:'mcp__pugport__delegate'}],
    [7,'other',{toolName:'mcp__pugport__delegate-suffix'}],
    [8,'other',{toolName:'mcp__pugport__git'}],
   ])requestPermission('host-'+i,kind,details);
   return;
  }
  if(mode==='permit'||mode==='decline'||mode==='auto-permit') {requestPermission('permission','read');return;}
  if(mode==='cancel'||mode==='cancel-hang') {requestPermission('block','execute');return;}
  if(mode==='extensions') {send({id:'question',method:'cursor/ask_question',params:{sessionId:'fixture-session',questions:[{id:'q',prompt:'Choose',options:[{id:'a',label:'A'}]}]}});return;}
  if(mode==='mode-upgrade'){notify({sessionUpdate:'current_mode_update',currentModeId:'agent'});return;}
  finish();return;
 }
 send({id:msg.id,error:{code:-32601,message:'Unsupported token=secret-should-not-leak'}});
});
input.on('close',()=>process.exit(0));
`,
  );
});
after(async () => {
  // Only individual files within this newly generated test directory are removed.
  for (const name of await readdir(directory)) await unlink(join(directory, name));
  await rmdir(directory);
});

function target(mode = 'normal'): RuntimeTarget {
  return {
    id: 'cursor-mock',
    provider: 'cursor',
    label: 'Cursor mock',
    command: process.execPath,
    args: [fixture, mode],
    environment: 'native',
    enabled: true,
  };
}
function context(mode = 'normal', signal: AbortSignal = new AbortController().signal) {
  const events: RunEvent[] = [],
    approvals: string[] = [];
  const ctx: ExecuteContext = {
    target: target(mode),
    input: { projectPath: directory, prompt: 'safe $() & | prompt 世界', kind: 'general', permissionMode: 'read-only' },
    route: {
      runtimeId: 'cursor-mock',
      model: 'grok-4.7-high',
      kind: 'general',
      reasons: [],
      warnings: [],
      accountFingerprint: cursorAccountFingerprint(identity),
    },
    signal,
    emit: (event) => {
      events.push(event);
    },
    approve: async (tool) => {
      approvals.push(tool);
      return mode === 'permit';
    },
  };
  return { ctx, events, approvals };
}
const marker = async (mode: string, key: string) =>
  JSON.parse(await readFile(join(directory, mode + '-' + key), 'utf8'));
const noPrompt = (mode: string) => assert.rejects(readFile(join(directory, mode + '-prompt')), { code: 'ENOENT' });
const imageRoutingSettings: Settings = {
  refreshSeconds: 60,
  reservePercent: 10,
  maxQuotaAgeSeconds: 180,
  preferCli: true,
  designProvider: 'claude',
  architectureProvider: 'codex',
  routineProvider: 'codex',
  unknownQuotaPolicy: 'manual-only',
  defaultProjectPath: '',
  maxConcurrentRuns: 2,
};

test('discovery reads only CLI metadata and ACP initialize, keeps balances unknown and identities private', async () => {
  const result = await cursorAdapter.discover(target('discover'));
  assert.equal(result.status, 'ready');
  assert.equal(result.version, '2026.10.01-fixture');
  assert.equal(result.subscription?.label, 'Pro');
  assert.equal(result.accountFingerprint, cursorAccountFingerprint(identity));
  assert.equal(result.quota.status, 'unknown');
  assert.equal(result.quota.observedAt, null);
  assert.deepEqual(result.quota.windows, []);
  assert.equal(result.capabilities.resume, true);
  assert.equal(result.capabilities.steer, false);
  assert.equal(result.capabilities.imageInput, true);
  assert.deepEqual(
    result.models.map((row) => row.id),
    ['auto', 'grok-4.7-high', 'grok-4.7-high-fast', 'composer-2.5'],
  );
  assert.ok(!JSON.stringify(result).includes('private@example.test'));
  assert.ok(!JSON.stringify(result).includes('secret-should-not-leak'));
  assert.deepEqual(await marker('discover', 'args'), ['--model', 'auto', '--mode', 'ask', 'acp']);
  await noPrompt('discover');
  await assert.rejects(readFile(join(directory, 'discover-session')), { code: 'ENOENT' });
});

test('discovery detects rejected execution flags and recovers with a compatible CLI', async () => {
  const rejected = await cursorAdapter.discover(target('reject-mode-ask'));
  assert.equal(rejected.status, 'error');
  assert.equal(rejected.note, 'runtime-protocol-incompatible');
  assert.match(rejected.errorDetail ?? '', /^error: unknown option '--mode ask'/);
  const fixed = await cursorAdapter.discover(target('fixed-mode-ask'));
  assert.equal(fixed.status, 'ready');
  assert.deepEqual(await marker('fixed-mode-ask', 'args'), ['--model', 'auto', '--mode', 'ask', 'acp']);
});

test('unauthenticated CLI is visible without logging in, and missing executable is missing', async () => {
  const result = await cursorAdapter.discover(target('auth'));
  assert.equal(result.status, 'auth-required');
  assert.equal(result.accountFingerprint, undefined);
  assert.equal(result.capabilities.execute, false);
  assert.equal(result.capabilities.imageInput, false);
  const missing = await cursorAdapter.discover({ ...target(), command: join(directory, 'does-not-exist') });
  assert.equal(missing.status, 'missing');
  assert.equal(missing.installed, false);
  assert.equal(missing.capabilities.imageInput, false);
});

test('authenticated status without an identity is never ready or executable', async () => {
  const result = await cursorAdapter.discover(target('no-identity'));
  assert.equal(result.status, 'unknown');
  assert.deepEqual(result.capabilities, {
    execute: false,
    resume: false,
    cancel: false,
    approvals: false,
    steer: false,
    imageInput: false,
  });
  assert.equal(result.accounting?.mode, 'unknown');
  await assert.rejects(cursorAdapter.execute(context('no-identity').ctx), /native-session-identity-unverified/);
  const { ctx } = context('new-unverified');
  ctx.route.accountFingerprint = undefined;
  await assert.rejects(cursorAdapter.execute(ctx), /native-session-identity-unverified/);
  await noPrompt('no-identity');
  await noPrompt('new-unverified');
});

test('discovery rejects identity changes, missing final identity and mismatched about account before matching balances', async () => {
  for (const scenario of ['changed', 'missing', 'logged-out', 'about-mismatch', 'status-failed']) {
    let statusReads = 0;
    let usageIdentity: CursorUsageIdentity | undefined;
    const adapter = fixtureAdapter({
      usage: async (_snapshot, observed) => {
        usageIdentity = observed;
      },
      capture: async (t, args, options) => {
        if (args[0] === 'status') {
          statusReads++;
          if (statusReads === 2) {
            if (scenario === 'status-failed') throw new Error('runtime-network-error');
            if (scenario === 'changed')
              return {
                stdout: JSON.stringify({
                  ...identity,
                  userInfo: { userId: 'changed-user', email: 'changed@example.test' },
                }),
                exitCode: 0,
              };
            if (scenario === 'missing') return { stdout: JSON.stringify({ isAuthenticated: true }), exitCode: 0 };
            if (scenario === 'logged-out') return { stdout: JSON.stringify({ isAuthenticated: false }), exitCode: 0 };
          }
        }
        if (args[0] === 'about' && scenario === 'about-mismatch')
          return {
            stdout: JSON.stringify({
              cliVersion: '2026.10.01-fixture',
              subscriptionTier: 'Pro',
              userEmail: 'other@example.test',
            }),
            exitCode: 0,
          };
        return fixtureCapture(t, args, options);
      },
    });
    const mode = 'discover-' + scenario;
    const result = await adapter.discover(target(mode));
    assert.equal(statusReads, 2);
    assert.equal(result.status, scenario === 'logged-out' ? 'auth-required' : 'unknown');
    assert.equal(result.accountFingerprint, undefined);
    assert.equal(result.subscription, undefined);
    assert.equal(result.accounting?.mode, 'unknown');
    assert.deepEqual(result.capabilities, {
      execute: false,
      resume: false,
      cancel: false,
      approvals: false,
      steer: false,
      imageInput: false,
    });
    assert.equal(result.quota.status, 'unknown');
    assert.deepEqual(usageIdentity, { state: 'unverified' });
    assert.deepEqual(result.quota.windows, []);
    assert.match(result.note ?? '', /刷新/);
    await noPrompt(mode);
  }
});

test('usage receives the final verified identity; absent CLI and failed metadata are distinct', async () => {
  for (const scenario of ['verified', 'no-email', 'not-found', 'failed']) {
    let observed: CursorUsageIdentity | undefined;
    const adapter = fixtureAdapter({
      usage: async (_snapshot, value) => {
        observed = value;
      },
      capture: async (t, args, options) => {
        if (scenario === 'not-found') throw new Error('runtime-not-found');
        if (scenario === 'failed') throw new Error('runtime-network-error');
        if (scenario === 'no-email' && args[0] === 'status')
          return { stdout: JSON.stringify({ ...identity, userInfo: { userId: 'fixture-user' } }), exitCode: 0 };
        if (scenario === 'no-email' && args[0] === 'about')
          return { stdout: JSON.stringify({ cliVersion: 'fixture', subscriptionTier: 'Pro' }), exitCode: 0 };
        return fixtureCapture(t, args, options);
      },
    });
    await adapter.discover(target('usage-' + scenario));
    assert.deepEqual(
      observed,
      scenario === 'verified'
        ? { state: 'verified', email: 'private@example.test', userId: 'fixture-user' }
        : { state: scenario === 'not-found' ? 'missing' : 'unverified' },
    );
  }
});

test('malformed optional plan metadata does not hide a verified account or working ACP connection', async () => {
  let observed: CursorUsageIdentity | undefined;
  let maxCacheAgeMs: number | undefined;
  const adapter = fixtureAdapter({
    usage: async (_snapshot, value, options) => {
      observed = value;
      maxCacheAgeMs = options?.maxCacheAgeMs;
    },
    capture: async (t, args, options) =>
      args[0] === 'about' ? { stdout: 'temporarily unavailable', exitCode: 0 } : fixtureCapture(t, args, options),
  });
  const mode = 'params-malformed-about';
  const result = await adapter.discover(target(mode), { quotaMaxAgeMs: 15_000 });
  assert.equal(result.status, 'ready');
  assert.equal(result.accountFingerprint, cursorAccountFingerprint(identity));
  assert.equal(result.subscription, undefined);
  assert.equal(result.accounting?.mode, 'unknown');
  assert.deepEqual(observed, { state: 'verified', email: 'private@example.test', userId: 'fixture-user' });
  assert.equal(maxCacheAgeMs, 15_000, 'active-account freshness reaches the quota reader');
  await noPrompt(mode);
});

test('ACP handshake and catalog errors preserve their cause while independently verifying usage identity', async () => {
  for (const mode of ['bad-version', 'params-bad-catalog']) {
    let statusReads = 0;
    let observed: CursorUsageIdentity | undefined;
    const adapter = fixtureAdapter({
      usage: async (_snapshot, value) => {
        observed = value;
      },
      capture: async (t, args, options) => {
        if (args[0] === 'status') statusReads++;
        return fixtureCapture(t, args, options);
      },
    });
    const result = await adapter.discover(target(mode));
    assert.equal(statusReads, 2);
    assert.equal(result.status, 'error');
    assert.equal(result.note, 'runtime-protocol-incompatible');
    assert.equal(result.accountFingerprint, cursorAccountFingerprint(identity));
    assert.equal(result.subscription?.label, 'Pro');
    assert.deepEqual(result.capabilities, {
      execute: false,
      resume: false,
      cancel: false,
      approvals: false,
      steer: false,
      imageInput: false,
    });
    assert.deepEqual(observed, { state: 'verified', email: 'private@example.test', userId: 'fixture-user' });
    await noPrompt(mode);
    await assert.rejects(readFile(join(directory, mode + '-session')), { code: 'ENOENT' });
  }
});

test('the parameterized catalog can replace a failed legacy listing, but two unavailable catalogs disable execution', async () => {
  for (const mode of ['params-models-failed', 'both-models-failed']) {
    let observed: CursorUsageIdentity | undefined;
    const adapter = fixtureAdapter({
      usage: async (_snapshot, value) => {
        observed = value;
      },
      capture: async (t, args, options) => {
        if (args[0] === 'models') throw new Error('runtime-network-error');
        return fixtureCapture(t, args, options);
      },
    });
    const result = await adapter.discover(target(mode));
    const supported = mode.startsWith('params-');
    assert.equal(result.status, supported ? 'ready' : 'error');
    assert.equal(result.capabilities.execute, supported);
    if (supported)
      assert.ok(result.models.some((model) => model.id === 'gpt-5.6-sol' && model.efforts.includes('high')));
    else {
      assert.equal(result.note, 'runtime-network-error');
      assert.deepEqual(result.models, []);
    }
    assert.deepEqual(observed, { state: 'verified', email: 'private@example.test', userId: 'fixture-user' });
    await marker(mode, 'catalog');
    await noPrompt(mode);
  }
});

test('execution starts a legacy model listing only after ACP reports the catalog method unsupported', async () => {
  for (const mode of ['params-no-legacy-catalog', 'legacy-catalog-fallback', 'params-bad-catalog']) {
    let modelListings = 0;
    let identityChecks = 0;
    const adapter = fixtureAdapter({
      capture: async (t, args, options) => {
        if (args[0] === 'status') identityChecks++;
        if (args[0] === 'models') {
          modelListings++;
          await marker(mode, 'catalog');
        }
        return fixtureCapture(t, args, options);
      },
    });
    if (mode === 'params-bad-catalog') {
      await assert.rejects(adapter.execute(context(mode).ctx), /runtime-protocol-incompatible/);
      await noPrompt(mode);
      assert.equal(identityChecks, 1);
    } else {
      const result = await adapter.execute(context(mode).ctx);
      assert.equal(result.output, 'hello 世界');
      assert.equal(result.effectiveModel?.model, 'grok-4.7');
      assert.equal(result.effectiveModel?.effort, 'high');
      assert.equal(identityChecks, 2, 'both fresh account identity checks remain');
    }
    assert.equal(modelListings, mode === 'legacy-catalog-fallback' ? 1 : 0, mode);
  }
});

test('execution uses a verified parameterized model without a legacy listing and rejects unsupported selections before prompting', async () => {
  const adapter = fixtureAdapter({
    capture: async (t, args, options) => {
      if (args[0] === 'models') throw new Error('runtime-network-error');
      return fixtureCapture(t, args, options);
    },
  });
  const supported = context('params-execution-models-failed');
  const result = await adapter.execute(supported.ctx);
  assert.equal(result.output, 'hello 世界');
  assert.equal(result.effectiveModel?.model, 'grok-4.7');
  assert.equal(result.effectiveModel?.effort, 'high');
  await marker('params-execution-models-failed', 'prompt');

  for (const mode of [
    'execution-both-models-failed',
    'params-execution-unknown-model',
    'params-execution-unknown-effort',
  ]) {
    const unsupported = context(mode);
    if (mode.endsWith('unknown-model')) unsupported.ctx.route.model = 'unknown-model';
    if (mode.endsWith('unknown-effort')) {
      unsupported.ctx.route.model = 'grok-4.7';
      unsupported.ctx.route.effort = 'ultra';
    }
    await assert.rejects(
      adapter.execute(unsupported.ctx),
      mode.startsWith('params-') ? /runtime-protocol-incompatible/ : /runtime-network-error/,
    );
    await marker(mode, 'catalog');
    await noPrompt(mode);
    await assert.rejects(readFile(join(directory, mode + '-session')), { code: 'ENOENT' });
  }
});

test('an ACP failure never permits usage association when the final identity changes, disappears or logs out', async () => {
  for (const scenario of ['changed', 'missing', 'logged-out', 'status-failed', 'about-mismatch']) {
    let statusReads = 0;
    let observed: CursorUsageIdentity | undefined;
    const adapter = fixtureAdapter({
      usage: async (_snapshot, value) => {
        observed = value;
      },
      spawn: async () => {
        throw new Error('runtime-network-error');
      },
      capture: async (t, args, options) => {
        if (args[0] === 'status' && ++statusReads === 2) {
          if (scenario === 'status-failed') throw new Error('runtime-timeout');
          if (scenario === 'changed')
            return {
              stdout: JSON.stringify({ ...identity, userInfo: { userId: 'other', email: 'other@example.test' } }),
              exitCode: 0,
            };
          if (scenario === 'missing') return { stdout: JSON.stringify({ isAuthenticated: true }), exitCode: 0 };
          if (scenario === 'logged-out') return { stdout: JSON.stringify({ isAuthenticated: false }), exitCode: 0 };
        }
        if (args[0] === 'about' && scenario === 'about-mismatch')
          return { stdout: JSON.stringify({ subscriptionTier: 'Pro', userEmail: 'other@example.test' }), exitCode: 0 };
        return fixtureCapture(t, args, options);
      },
    });
    const result = await adapter.discover(target('failed-acp-identity-' + scenario));
    assert.equal(statusReads, 2);
    assert.equal(result.status, scenario === 'logged-out' ? 'auth-required' : 'error');
    assert.equal(result.note, 'runtime-network-error');
    assert.equal(result.capabilities.execute, false);
    assert.equal(result.accountFingerprint, undefined);
    assert.equal(result.subscription, undefined);
    assert.deepEqual(observed, { state: 'unverified' });
  }
});

test('legacy about without account email retains verified identity but no unverified plan', async () => {
  const adapter = fixtureAdapter({
    capture: async (t, args, options) =>
      args[0] === 'about'
        ? { stdout: JSON.stringify({ cliVersion: 'legacy-fixture', subscriptionTier: 'Pro' }), exitCode: 0 }
        : fixtureCapture(t, args, options),
  });
  const result = await adapter.discover(target('legacy-about'));
  assert.equal(result.status, 'ready');
  assert.equal(result.accountFingerprint, cursorAccountFingerprint(identity));
  assert.equal(result.subscription, undefined);
  assert.equal(result.accounting?.mode, 'unknown');
  await noPrompt('legacy-about');
});

test('fresh identity lookup uses only official status and supports safe integer account IDs', async () => {
  const numeric = { ...identity, userInfo: { userId: 987654, email: 'first@example.test' } };
  assert.equal(
    cursorAccountFingerprint(numeric),
    cursorAccountFingerprint({ ...numeric, userInfo: { userId: '987654', email: 'changed@example.test' } }),
  );
  assert.equal(cursorAccountFingerprint({ ...numeric, userInfo: { userId: Number.MAX_SAFE_INTEGER + 1 } }), undefined);
  assert.equal(cursorAccountFingerprint({ ...numeric, isAuthenticated: false }), undefined);
  assert.equal(
    await readCursorIdentity(target('identity-read'), { capture: fixtureCapture }),
    cursorAccountFingerprint(identity),
  );
  assert.equal(await readCursorIdentity(target('auth'), { capture: fixtureCapture }), undefined);
  assert.equal(
    await readCursorIdentity({ ...target(), accountHome: directory }, { capture: fixtureCapture }),
    undefined,
  );
  await noPrompt('identity-read');
  await assert.rejects(readFile(join(directory, 'identity-read-initialize')), { code: 'ENOENT' });
});

test('member CLI child environment cannot inherit API identity overrides or native-account isolation', async () => {
  const original = { api: process.env.CURSOR_API_KEY, token: process.env.CURSOR_AUTH_TOKEN };
  process.env.CURSOR_API_KEY = 'fixture-api-key';
  process.env.CURSOR_AUTH_TOKEN = 'fixture-auth-token';
  let captures = 0,
    spawns = 0;
  const check = (env: NodeJS.ProcessEnv | undefined) => {
    assert.ok(env);
    assert.equal(env.CURSOR_API_KEY, undefined);
    assert.equal(env.CURSOR_AUTH_TOKEN, undefined);
  };
  const adapter = fixtureAdapter({
    capture: async (t, args, options) => {
      captures++;
      check(options?.env);
      return fixtureCapture(t, args, options);
    },
    spawn: async (t, args, options) => {
      spawns++;
      check(options?.env);
      return spawnTarget(t, args, options);
    },
  });
  try {
    assert.equal((await adapter.discover(target('safe-env'))).status, 'ready');
    await adapter.execute(context('safe-env-execute').ctx);
    assert.equal(captures, 7);
    assert.equal(spawns, 2);
    for (const change of [
      { accountId: 'isolated' },
      { accountHome: directory },
      { args: ['--api-key=external-key'] },
      { args: ['--force'] },
    ]) {
      const { ctx } = context('unsafe-identity');
      ctx.target = { ...ctx.target, ...change };
      await assert.rejects(adapter.execute(ctx), /native-session-identity-unverified/);
    }
    assert.equal(captures, 7);
  } finally {
    if (original.api === undefined) delete process.env.CURSOR_API_KEY;
    else process.env.CURSOR_API_KEY = original.api;
    if (original.token === undefined) delete process.env.CURSOR_AUTH_TOKEN;
    else process.env.CURSOR_AUTH_TOKEN = original.token;
  }
});

test('exact model variants are retained, canonical effort is allowed and conflicting effort is rejected', () => {
  assert.equal(
    cursorAccountFingerprint({ ...identity, userInfo: { ...identity.userInfo, email: 'new@example.test' } }),
    cursorAccountFingerprint(identity),
  );
  assert.equal(cursorAccountFingerprint({ status: 'unauthenticated', userInfo: identity.userInfo }), undefined);
  assert.deepEqual(
    cursorModels(
      'bad & slug - Nope\nAvailable models\ngrok-4.7-low-fast - Grok Low Fast\ngrok-4.7-low-fast - duplicate',
    ),
    [{ id: 'grok-4.7-low-fast', label: 'Grok Low Fast', efforts: [], lightweight: false, quotaPool: 'cursor' }],
  );
  const { ctx } = context();
  assert.deepEqual(cursorExecutionArgs(ctx), ['--model', 'grok-4.7-high', '--mode', 'ask', 'acp']);
  assert.deepEqual(cursorExecutionArgs({ ...ctx, route: { ...ctx.route, model: 'grok-4.7', effort: 'high' } }), [
    '--model',
    'grok-4.7',
    '--mode',
    'ask',
    'acp',
  ]);
  assert.throws(() => cursorExecutionArgs({ ...ctx, route: { ...ctx.route, effort: 'low' } }));
  assert.throws(() => cursorExecutionArgs({ ...ctx, route: { ...ctx.route, model: 'safe & whoami' } }));
});

test('real mock process streams text, split UTF8 thinking, sanitized tools and genuine usage fields', async () => {
  const { ctx, events } = context();
  let steer: unknown;
  ctx.registerSteer = (handler, state) => {
    steer = state;
    assert.equal(handler, undefined);
  };
  const result = await cursorAdapter.execute(ctx);
  assert.equal(result.output, 'hello 世界');
  assert.equal(result.nativeSessionId, 'fixture-session');
  assert.equal(
    events
      .filter((event) => event.type === 'reasoning')
      .map((event) => event.text)
      .join(''),
    '推理',
  );
  assert.deepEqual(await marker('normal', 'prompt'), {
    sessionId: 'fixture-session',
    prompt: [{ type: 'text', text: ctx.input.prompt }],
  });
  assert.equal((await marker('normal', 'mode')).modeId, 'ask');
  assert.equal((await marker('normal', 'model')).value, 'grok-4.7-high');
  assert.equal(events.find((event) => event.data?.totalTokens === 12)?.data?.cacheReadTokens, 0);
  assert.equal(events.find((event) => event.data?.contextTokens === 9000)?.type, 'status');
  const contextEvent = events.find((event) => event.data?.contextTokens === 9000)!;
  assert.deepEqual(contextFromEvent('cursor', ctx.route.model, contextEvent), {
    tokens: 9000,
    window: 256000,
    at: contextEvent.at,
  });
  assert.ok(!JSON.stringify(events).includes('secret-should-not-leak'));
  const tools = events.filter((event) => event.type === 'tool' && event.data?.toolCallId === 'tool-1');
  assert.deepEqual(tools[0].data?.input, { path: 'README.md', token: '[redacted]' });
  assert.deepEqual(tools[1].data?.output, { text: 'File result' });
  assert.ok(!JSON.stringify(tools).includes('PRIVATE_NATIVE_PROMPT'));
  assert.deepEqual(steer, { state: 'unsupported', reason: 'Cursor ACP 当前没有已验证的同轮 steer 协议。' });
});

test('verified Cursor image discovery reaches routing and sends complete ACP pixels without changing the model or mode', async () => {
  const mode = 'image-prompt';
  const pixels = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=',
    'base64',
  );
  const imagePath = join(directory, 'synthetic.png');
  await writeFile(imagePath, pixels);
  const snapshot = await cursorAdapter.discover(target(mode));
  assert.equal(snapshot.capabilities.imageInput, true);
  assert.equal(supportsImageInput(snapshot), true);
  await noPrompt(mode);
  const { ctx, events } = context(mode);
  ctx.input = {
    ...ctx.input,
    runtimeId: snapshot.id,
    model: 'grok-4.7-high',
    allowUnknownQuota: true,
    attachments: [
      {
        id: 'synthetic-image',
        name: 'synthetic.png',
        mimeType: 'image/png',
        size: pixels.length,
        kind: 'image',
        path: imagePath,
      },
    ],
  };
  const selected = route(ctx.input, [snapshot], imageRoutingSettings);
  assert.equal(selected.runtimeId, snapshot.id);
  assert.equal(selected.model, 'grok-4.7-high');
  ctx.route = selected;
  assert.equal((await cursorAdapter.execute(ctx)).output, 'hello 世界');
  assert.deepEqual(await marker(mode, 'prompt'), {
    sessionId: 'fixture-session',
    prompt: [
      { type: 'text', text: ctx.input.prompt },
      { type: 'image', data: pixels.toString('base64'), mimeType: 'image/png' },
    ],
  });
  assert.deepEqual(Buffer.from((await marker(mode, 'prompt')).prompt[1].data, 'base64'), pixels);
  assert.equal((await marker(mode, 'model')).value, 'grok-4.7-high');
  assert.equal((await marker(mode, 'mode')).modeId, 'ask');
  assert.ok(!JSON.stringify(events).includes(pixels.toString('base64')));
});

test('Cursor image capability must be explicit and execution rechecks it before reading or sending attachments', async () => {
  for (const mode of ['no-image-capability', 'missing-image-capability', 'invalid-image-capability']) {
    const snapshot = await cursorAdapter.discover(target(mode));
    assert.equal(snapshot.status, 'ready');
    assert.equal(snapshot.capabilities.execute, true);
    assert.equal(snapshot.capabilities.imageInput, false);
    assert.equal(supportsImageInput(snapshot), false);
    const { ctx } = context(mode);
    ctx.input = {
      ...ctx.input,
      runtimeId: snapshot.id,
      model: ctx.route.model,
      allowUnknownQuota: true,
      attachments: [
        {
          id: 'unread-image',
          name: 'must-not-be-read.png',
          mimeType: 'image/png',
          size: 1,
          kind: 'image',
          path: join(directory, 'must-not-be-read.png'),
        },
      ],
    };
    assert.throws(() => route(ctx.input, [snapshot], imageRoutingSettings), RouteUnavailableError);
    await assert.rejects(cursorAdapter.execute(ctx), /runtime-image-input-unavailable/);
    await noPrompt(mode);
    await assert.rejects(readFile(join(directory, mode + '-session')), { code: 'ENOENT' });
  }
});

test('Cursor rejects invalid image files before creating a session or sending a prompt', async () => {
  const emptyPath = join(directory, 'empty.png');
  const largePath = join(directory, 'oversized.png');
  await writeFile(emptyPath, Buffer.alloc(0));
  await writeFile(largePath, Buffer.alloc(5 * 1024 * 1024 + 1));
  for (const [name, path, mimeType] of [
    ['unsupported', join(directory, 'synthetic.png'), 'image/bmp'],
    ['missing', join(directory, 'missing.png'), 'image/png'],
    ['directory', directory, 'image/png'],
    ['empty', emptyPath, 'image/png'],
    ['oversized', largePath, 'image/png'],
  ] as const) {
    const mode = 'invalid-image-' + name;
    const { ctx } = context(mode);
    ctx.input.attachments = [{ id: name, name: name + '.png', path, mimeType, kind: 'image', size: 1 }];
    await assert.rejects(cursorAdapter.execute(ctx), { message: 'runtime-image-input-invalid' });
    await noPrompt(mode);
    await assert.rejects(readFile(join(directory, mode + '-session')), { code: 'ENOENT' });
  }
});

test('resuming ignores replayed history and requires a verified matching account', async () => {
  const { ctx } = context('resume');
  ctx.nativeSessionId = 'fixture-session';
  assert.equal((await cursorAdapter.execute(ctx)).output, 'hello 世界');
  assert.equal((await marker('resume', 'session')).sessionId, 'fixture-session');
  const unverified = context('resume-unverified').ctx;
  unverified.nativeSessionId = 'fixture-session';
  unverified.route.accountFingerprint = undefined;
  await assert.rejects(cursorAdapter.execute(unverified), /native-session-identity-unverified/);
  await noPrompt('resume-unverified');
  const changed = context('resume-changed').ctx;
  changed.nativeSessionId = 'fixture-session';
  changed.route.accountFingerprint = 'another-account';
  await assert.rejects(cursorAdapter.execute(changed), /native-session-identity-changed/);
  await noPrompt('resume-changed');
});

test('identity is checked again immediately before prompting, and a changed account never receives the prompt', async () => {
  let reads = 0;
  const adapter = fixtureAdapter({
    capture: async (t, args, options) => {
      if (args[0] === 'status' && ++reads === 2)
        return { stdout: JSON.stringify({ ...identity, userInfo: { userId: 'switched' } }), exitCode: 0 };
      return fixtureCapture(t, args, options);
    },
  });
  const { ctx } = context('identity-late');
  await assert.rejects(adapter.execute(ctx), /native-session-identity-changed/);
  await noPrompt('identity-late');
});

test('read-only rejects edits, commands, deletion, moves, mode switches and unclassified MCP tools even in auto', async () => {
  const { ctx, approvals } = context('readonly-denials');
  ctx.approvalMode = 'auto';
  ctx.agentBridge = { url: 'http://127.0.0.1:5555/agent', token: 'run-token' };
  await createCursorAdapter({ bridgeTools: async () => ['list_swarm'] }).execute(ctx);
  for (let i = 0; i < 7; i++)
    assert.deepEqual(await marker('readonly-denials', 'deny-' + i), {
      outcome: { outcome: 'selected', optionId: 'deny' },
    });
  assert.equal(approvals.length, 0);
  assert.deepEqual((await marker('readonly-denials', 'session')).mcpServers, cursorBridgeServers(ctx.agentBridge));
});

test('read-only Cursor supports exactly the authenticated host catalogue while native and foreign writes remain denied', async () => {
  const { ctx, events, approvals } = context('readonly-host');
  ctx.approvalMode = 'auto';
  ctx.agentBridge = { url: 'http://127.0.0.1:5555/agent', token: 'per-run-readonly' };
  const adapter = createCursorAdapter({
    bridgeTools: async (bridge, signal) => {
      assert.equal(bridge.token, 'per-run-readonly');
      assert.equal(signal, ctx.signal);
      return ['delegate', 'list_swarm', 'message_agent', 'git'];
    },
  });
  await adapter.execute(ctx);
  for (let index = 0; index < 9; index++)
    assert.deepEqual(await marker('readonly-host', `host-${index}`), {
      outcome: { outcome: 'selected', optionId: index < 3 || index === 8 ? 'allow' : 'deny' },
    });
  assert.equal(approvals.length, 0);
  assert.equal((await marker('readonly-host', 'mode')).modeId, 'ask');
  assert.deepEqual((await marker('readonly-host', 'session')).mcpServers, cursorBridgeServers(ctx.agentBridge));
  assert.ok(!JSON.stringify(await marker('readonly-host', 'args')).includes('per-run-readonly'));
  assert.ok(
    events.some((event) => event.data?.kind === 'host-tool-bridge' && event.data.permissionMode === 'read-only'),
  );
});

test('Cursor host catalogue failure stops before dispatch and temporary visual assistants receive no host tools', async () => {
  const failed = context('host-catalog-failed');
  failed.ctx.agentBridge = { url: 'http://127.0.0.1:5555/agent', token: 'run-token' };
  await assert.rejects(
    createCursorAdapter({
      bridgeTools: async () => {
        throw new Error('runtime-permission-or-sandbox-error');
      },
    }).execute(failed.ctx),
    /runtime-permission-or-sandbox-error/,
  );
  await noPrompt('host-catalog-failed');
  const visual = context('visual-no-host');
  visual.ctx.input.visualAssistant = true;
  visual.ctx.agentBridge = failed.ctx.agentBridge;
  await createCursorAdapter({
    bridgeTools: async () => {
      assert.fail('A visual helper cannot fetch host tools.');
    },
  }).execute(visual.ctx);
  assert.deepEqual((await marker('visual-no-host', 'session')).mcpServers, []);
});

test('ask mode permission approvals use allow_once, while rejection is explicit', async () => {
  const yes = context('permit');
  await cursorAdapter.execute(yes.ctx);
  assert.equal(yes.approvals.length, 1);
  assert.deepEqual(await marker('permit', 'permission'), { outcome: { outcome: 'selected', optionId: 'allow' } });
  const no = context('decline');
  await cursorAdapter.execute(no.ctx);
  assert.deepEqual(await marker('decline', 'permission'), { outcome: { outcome: 'selected', optionId: 'deny' } });
});

test('workspace execution wires HTTP MCP in session params without persisting its bearer token to launch args', async () => {
  const { ctx } = context('auto-permit');
  ctx.input.permissionMode = 'workspace-write';
  ctx.approvalMode = 'auto';
  ctx.agentBridge = { url: 'http://127.0.0.1:5555/agent', token: 'per-run-secret' };
  await createCursorAdapter({ bridgeTools: async () => ['delegate'] }).execute(ctx);
  assert.deepEqual((await marker('auto-permit', 'session')).mcpServers, cursorBridgeServers(ctx.agentBridge));
  assert.ok(!JSON.stringify(await marker('auto-permit', 'args')).includes('per-run-secret'));
  assert.equal((await marker('auto-permit', 'mode')).modeId, 'agent');
  assert.deepEqual(await marker('auto-permit', 'permission'), { outcome: { outcome: 'selected', optionId: 'allow' } });
  assert.throws(() => cursorBridgeServers({ url: 'https://example.test', token: 'x' }));
});

test('unsupported HTTP bridge, resume, read-only mode and mismatched model fail closed before prompt', async () => {
  for (const mode of ['no-http', 'no-resume', 'no-ask', 'model-mismatch']) {
    const { ctx } = context(mode);
    if (mode === 'no-http') {
      ctx.input.permissionMode = 'workspace-write';
      ctx.agentBridge = { url: 'http://127.0.0.1:5555/agent', token: 'run-token' };
    }
    if (mode === 'no-resume') ctx.nativeSessionId = 'fixture-session';
    await assert.rejects(
      createCursorAdapter({ bridgeTools: async () => ['delegate'] }).execute(ctx),
      mode === 'no-resume'
        ? /native-session-unavailable/
        : /runtime-(?:protocol-incompatible|permission-or-sandbox-error)/,
    );
    await noPrompt(mode);
  }
});

test('live read-only mode escalation is cancelled instead of accepted', async () => {
  const { ctx } = context('mode-upgrade');
  await assert.rejects(cursorAdapter.execute(ctx), /runtime-permission-or-sandbox-error/);
  assert.equal((await marker('mode-upgrade', 'cancel')).sessionId, 'fixture-session');
});

test('cancelling a pending approval returns ACP cancelled and sends session/cancel', async () => {
  const controller = new AbortController(),
    { ctx } = context('cancel', controller.signal);
  ctx.input.permissionMode = 'workspace-write';
  ctx.approve = async () => {
    setTimeout(() => controller.abort(), 10);
    return new Promise<boolean>(() => {});
  };
  await assert.rejects(cursorAdapter.execute(ctx), { name: 'AbortError' });
  assert.equal((await marker('cancel', 'cancel')).sessionId, 'fixture-session');
  assert.deepEqual(await marker('cancel', 'block'), { outcome: { outcome: 'cancelled' } });
});

test('cancel also terminates a peer that ignores session/cancel', async () => {
  const controller = new AbortController(),
    { ctx } = context('cancel-hang', controller.signal);
  ctx.input.permissionMode = 'workspace-write';
  ctx.approve = async () => {
    setTimeout(() => controller.abort(), 10);
    return new Promise<boolean>(() => {});
  };
  await assert.rejects(cursorAdapter.execute(ctx), { name: 'AbortError' });
  assert.equal((await marker('cancel-hang', 'cancel')).sessionId, 'fixture-session');
});

test('blocking Cursor extensions are answered without silently choosing an answer or approving a read-only plan', async () => {
  await cursorAdapter.execute(context('extensions').ctx);
  assert.equal((await marker('extensions', 'question')).outcome.outcome, 'skipped');
  assert.equal((await marker('extensions', 'plan')).outcome.outcome, 'rejected');
});

test('native failure diagnostics are redacted and token limits do not masquerade as successful completion', async () => {
  await assert.rejects(cursorAdapter.execute(context('failure').ctx), /authentication-required/);
  await assert.rejects(cursorAdapter.execute(context('quota-failure').ctx), /quota-or-rate-limit/);
  await assert.rejects(cursorAdapter.execute(context('network-failure').ctx), /runtime-network-error/);
  const { ctx, events } = context('limit');
  await assert.rejects(cursorAdapter.execute(ctx), /runtime-request-failed/);
  assert.ok(events.some((event) => event.type === 'usage' && event.data?.totalTokens === 12));
});

test('incompatible JSONRPC peers cannot start a session or prompt', async () => {
  for (const mode of ['invalid-json', 'bad-version']) {
    await assert.rejects(
      cursorAdapter.execute(context(mode).ctx),
      mode === 'invalid-json' ? /runtime-process-closed/ : /runtime-protocol-incompatible/,
    );
    await noPrompt(mode);
  }
});

test('context occupancy and missing usage are never fabricated as consumption', () => {
  assert.equal(cursorResultUsage({ used: 500, size: 1000, cost: { amount: 0.1, currency: 'USD' } }), undefined);
  assert.equal(cursorResultUsage({ stopReason: 'end_turn' }), undefined);
  const data = cursorResultUsage({
    usage: { inputTokens: 0, totalTokens: -1, outputTokens: NaN, privateToken: 'secret' },
  });
  assert.equal(data?.inputTokens, 0);
  assert.equal(data?.totalTokens, undefined);
  assert.ok(!JSON.stringify(data).includes('privateToken'));
});

test('legacy bracket peers select an exact match and never silently downgrade effort or switch speed', async () => {
  await assert.rejects(cursorAdapter.execute(context('bracket-models').ctx), /runtime-protocol-incompatible/);
  await noPrompt('bracket-models');
  const result = await cursorAdapter.execute(context('bracket-exact').ctx);
  assert.equal(
    (await marker('bracket-exact', 'model')).value,
    'grok-4.7[context=256k,reasoning_effort=high,fast=false]',
  );
  assert.equal(result.effectiveModel?.model, 'grok-4.7');
  assert.equal(result.effectiveModel?.effort, 'high');
  assert.equal(result.effectiveModel?.parameters?.fast, 'false');
  assert.equal(sessionModel(['composer-2.5'], 'composer-2.5-fast'), undefined);
  assert.equal(sessionModel(['grok-4.7[reasoning_effort=high]'], 'grok-4.7-high-fast'), undefined);
  assert.equal(
    sessionModel(['claude-opus-5[effort=high,thinking=false,fast=false]'], 'claude-opus-5-thinking-high'),
    undefined,
  );
  assert.equal(sessionModel(['grok-4.7[reasoning_effort=high, fast=true]'], 'grok-4.7-high'), undefined);
});

test('parameterized discovery advertises real efforts without creating a session or sending a prompt', async () => {
  const result = await cursorAdapter.discover(target('params-discover'));
  assert.equal(result.status, 'ready');
  assert.equal((await marker('params-discover', 'initialize')).clientCapabilities._meta.parameterizedModelPicker, true);
  assert.deepEqual(result.models.find((model) => model.id === 'gpt-5.6-sol')?.efforts, [
    'none',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ]);
  assert.equal(result.models.find((model) => model.id === 'grok-4.7')?.defaultEffort, 'medium');
  assert.deepEqual(result.models.find((model) => model.id === 'claude-opus-5')?.efforts, [
    'low',
    'medium',
    'high',
    'max',
  ]);
  assert.ok(result.models.every((model) => !/-high$/.test(model.id)));
  await noPrompt('params-discover');
  await assert.rejects(readFile(join(directory, 'params-discover-session')), { code: 'ENOENT' });
  assert.deepEqual(
    cursorParameterizedModels({ models: [{ value: 'invalid & model', name: 'Bad', configOptions: [] }] }),
    [],
  );
});

test('canonical model plus effort is configured and confirmed before a prompt, with standard speed and unchanged context', async () => {
  const { ctx, events } = context('params-canonical');
  ctx.route.model = 'gpt-5.6-sol';
  ctx.route.effort = 'max';
  const result = await cursorAdapter.execute(ctx);
  assert.equal((await marker('params-canonical', 'model')).value, 'gpt-5.6-sol');
  assert.equal((await marker('params-canonical', 'config-reasoning')).value, 'max');
  assert.equal((await marker('params-canonical', 'config-fast')).value, 'false');
  await assert.rejects(readFile(join(directory, 'params-canonical-config-context')), { code: 'ENOENT' });
  assert.equal(result.effectiveModel?.model, 'gpt-5.6-sol');
  assert.equal(result.effectiveModel?.effort, 'max');
  assert.deepEqual(result.effectiveModel?.parameters, { reasoning: 'max', fast: 'false', context: '272k' });
  assert.deepEqual(events.find((event) => event.type === 'session')?.data?.effectiveModel, result.effectiveModel);
});

test('saved fast and thinking slugs retain their requested settings on parameterized peers', async () => {
  const fast = context('params-fast');
  fast.ctx.route.model = 'grok-4.7-high-fast';
  const fastResult = await cursorAdapter.execute(fast.ctx);
  assert.equal(fastResult.effectiveModel?.effort, 'high');
  assert.equal(fastResult.effectiveModel?.parameters?.fast, 'true');
  const thinking = context('params-thinking');
  thinking.ctx.route.model = 'claude-opus-5-thinking-high';
  const thinkingResult = await cursorAdapter.execute(thinking.ctx);
  assert.equal(thinkingResult.effectiveModel?.effort, 'high');
  assert.equal(thinkingResult.effectiveModel?.parameters?.thinking, 'true');
});

test('canonical Claude preserves its thinking default while an explicit non-thinking variant confirms false', async () => {
  const canonical = context('params-thinking-default');
  canonical.ctx.route.model = 'claude-opus-5';
  canonical.ctx.route.effort = 'high';
  const canonicalResult = await cursorAdapter.execute(canonical.ctx);
  assert.equal(canonicalResult.effectiveModel?.parameters?.thinking, 'true');
  await assert.rejects(readFile(join(directory, 'params-thinking-default-config-thinking')), { code: 'ENOENT' });
  const explicit = context('params-thinking-default-disabled');
  explicit.ctx.route.model = 'claude-opus-5-high';
  const explicitResult = await cursorAdapter.execute(explicit.ctx);
  assert.equal(explicitResult.effectiveModel?.parameters?.thinking, 'false');
  assert.equal((await marker('params-thinking-default-disabled', 'config-thinking')).value, 'false');
});

test('unsupported or unconfirmed parameter settings stop before a prompt, and catalog errors do not trigger legacy fallback', async () => {
  for (const mode of ['params-refuses-effort', 'params-resets-effort', 'params-bad-catalog']) {
    await assert.rejects(cursorAdapter.execute(context(mode).ctx), /runtime-protocol-incompatible/);
    await noPrompt(mode);
  }
  const unsupported = context('params-unsupported');
  unsupported.ctx.route.effort = 'ultra';
  unsupported.ctx.route.model = 'grok-4.7';
  await assert.rejects(cursorAdapter.execute(unsupported.ctx), /runtime-protocol-incompatible/);
  await noPrompt('params-unsupported');
});

test('a failed session/load is native-session-unavailable and never sends a prompt', async () => {
  const { ctx } = context('resume-missing');
  ctx.nativeSessionId = 'fixture-session';
  await assert.rejects(cursorAdapter.execute(ctx), /native-session-unavailable/);
  await noPrompt('resume-missing');
});
