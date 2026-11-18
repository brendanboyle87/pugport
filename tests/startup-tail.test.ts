import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCursorAdapter, cursorAccountFingerprint } from '../src/server/adapters/cursor.ts';
import { StartupTail, runtimeError, captureTarget } from '../src/server/adapters/process.ts';
import type { ExecuteContext, RuntimeTarget } from '../src/shared/types.ts';

const sentence = "error: option '--mode <mode>' argument 'agent' is invalid. Allowed choices are plan, ask.";

for (const scenario of ['resume', 'between requests'] as const) {
  test(`cursor ${scenario} exit retains startup diagnostics`, async (t) => {
    const { spawn } = await import('node:child_process');
    const dir = await mkdtemp(join(tmpdir(), 'startup-gap-'));
    const script = join(dir, 'cursor.mjs');
    t.after(async () => {
      await unlink(script);
      await rmdir(dir);
    });
    await writeFile(
      script,
      `
import { createInterface } from 'node:readline';
const args = process.argv.slice(2);
if (args.includes('status')) console.log(JSON.stringify({status:'authenticated',isAuthenticated:true,userInfo:{userId:'fixture',email:'fixture@example.test'}}));
else if (args.includes('about')) console.log(JSON.stringify({cliVersion:'fixture',userEmail:'fixture@example.test'}));
else if (args.includes('models')) console.log('auto - Auto');
else createInterface({input:process.stdin}).on('line', line => {
  const msg=JSON.parse(line);
  if (msg.method==='initialize') console.log(JSON.stringify({jsonrpc:'2.0',id:msg.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true}}}));
  else if (msg.method==='cursor/list_available_models') {
    console.log(JSON.stringify({jsonrpc:'2.0',id:msg.id,error:{code:-32601,message:'Unsupported'}}));
    if (${JSON.stringify(scenario)} === 'between requests') setTimeout(() => { process.stderr.write('SYNTHETIC_GAP_FAILURE\\n'); process.exit(1); }, 50);
  } else if (msg.method==='session/load') { process.stderr.write('SYNTHETIC_RESUME_FAILURE\\n'); process.exit(1); }
});
`,
    );
    let closed: Promise<void> | undefined;
    const spawnFixture: typeof import('../src/server/adapters/process.ts').spawnTarget = async () => {
      const child = spawn(process.execPath, [script], { stdio: 'pipe' });
      closed = new Promise((resolve) => child.once('close', () => resolve()));
      return child;
    };
    const capture: typeof captureTarget = async (target, args, options) => {
      const result = await captureTarget(target, args, options);
      if (scenario === 'between requests' && args.includes('models') && closed) await closed;
      return result;
    };
    const target: RuntimeTarget = {
      id: 'cursor-gap',
      provider: 'cursor',
      label: 'Cursor',
      command: process.execPath,
      args: [script],
      environment: 'native',
      enabled: true,
    };
    const ctx: ExecuteContext = {
      target,
      input: { projectPath: dir, prompt: 'synthetic prompt', kind: 'general', permissionMode: 'read-only' },
      route: {
        runtimeId: target.id,
        model: 'auto',
        kind: 'general',
        reasons: [],
        warnings: [],
        accountFingerprint: cursorAccountFingerprint({
          status: 'authenticated',
          isAuthenticated: true,
          userInfo: { userId: 'fixture', email: 'fixture@example.test' },
        }),
      },
      signal: new AbortController().signal,
      emit: () => {},
      approve: async () => false,
      ...(scenario === 'resume' ? { nativeSessionId: 'synthetic-session' } : {}),
    };
    const adapter = createCursorAdapter({ spawn: spawnFixture, capture, terminate: async () => {} });
    const error = await adapter.execute(ctx).then(
      () => undefined,
      (failure: Error & { detail?: string; startup?: unknown }) => failure,
    );
    assert.ok(error, 'execution must fail');
    if (scenario === 'resume') assert.equal(error.message, 'native-session-unavailable');
    assert.ok(error.startup, 'startup diagnostics must survive');
    assert.match(error.detail ?? '', scenario === 'resume' ? /SYNTHETIC_RESUME_FAILURE/ : /SYNTHETIC_GAP_FAILURE/);
  });
}

test('cursor exit before handshake retains the diagnostic', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'startup-tail-'));
  const script = join(dir, 'cursor.mjs');
  t.after(async () => {
    await unlink(script);
    await rmdir(dir);
  });
  await writeFile(
    script,
    `
const args = process.argv.slice(2);
if (args.includes('status')) console.log(JSON.stringify({status:'authenticated',isAuthenticated:true,userInfo:{userId:'fixture',email:'fixture@example.test'}}));
else if (args.includes('about')) console.log(JSON.stringify({cliVersion:'fixture',userEmail:'fixture@example.test'}));
else if (args.includes('models')) console.log('auto - Auto');
else { process.stderr.write(${JSON.stringify(sentence)} + '\\n'); process.exit(1); }
`,
  );
  const target: RuntimeTarget = {
    id: 'cursor-fixture',
    provider: 'cursor',
    label: 'Cursor',
    command: process.execPath,
    args: [script],
    environment: 'native',
    enabled: true,
  };
  const ctx: ExecuteContext = {
    target,
    input: { projectPath: dir, prompt: 'synthetic prompt', kind: 'general', permissionMode: 'read-only' },
    route: {
      runtimeId: target.id,
      model: 'auto',
      kind: 'general',
      reasons: [],
      warnings: [],
      accountFingerprint: cursorAccountFingerprint({
        status: 'authenticated',
        isAuthenticated: true,
        userInfo: { userId: 'fixture', email: 'fixture@example.test' },
      }),
    },
    signal: new AbortController().signal,
    emit: () => {},
    approve: async () => false,
  };
  await assert.rejects(
    createCursorAdapter().execute(ctx),
    (error: Error & { detail?: string; startup?: { exitCode: number | null; firstLine?: string } }) => {
      assert.equal(error.message, 'runtime-protocol-incompatible');
      assert.ok(error.detail?.includes(sentence));
      assert.equal(error.startup?.exitCode, 1);
      assert.ok(error.startup?.firstLine?.startsWith('error: option'));
      return true;
    },
  );
});

test('tail excludes JSON and keeps at most 20 lines and 4 KB', () => {
  const tail = new StartupTail();
  tail.write('stdout', '{"json":"excluded"}\n');
  for (let i = 0; i < 25; i++) tail.write('stderr', `${i} ${'界'.repeat(200)}\n`);
  assert.ok(!tail.text().includes('excluded'));
  assert.ok(tail.text().split('\n').length <= 20);
  assert.ok(Buffer.byteLength(tail.text(), 'utf8') <= 4096);
});

test('truncated JSON stdout is excluded from startup diagnostics', () => {
  const tail = new StartupTail();
  tail.write('stdout', '  {"private":"TRUNCATED_SENTINEL');
  const error = tail.failure('fixture', 1);
  assert.deepEqual(
    [tail.text(), error.detail ?? '', error.startup.firstLine ?? ''].map((value) =>
      value.includes('TRUNCATED_SENTINEL'),
    ),
    [false, false, false],
  );
});

test('JSON stdout split across two chunks is excluded from startup diagnostics', () => {
  const tail = new StartupTail();
  tail.write('stdout', '  [');
  tail.write('stdout', '{"private":"SPLIT_SENTINEL"}');
  const error = tail.failure('fixture', 1);
  assert.deepEqual(
    [tail.text(), error.detail ?? '', error.startup.firstLine ?? ''].map((value) => value.includes('SPLIT_SENTINEL')),
    [false, false, false],
  );
});

test('startup error redacts token and prompt in detail and first line, and survives wrapping', () => {
  const prompt = 'PRIVATE_SYNTHETIC_PROMPT';
  const tail = new StartupTail();
  tail.write('stderr', `token=SECRET_SENTINEL ${prompt}\n`);
  const error = tail.failure('fixture', 1, { prompt });
  for (const value of [error.detail, error.startup.firstLine]) {
    assert.ok(value);
    assert.doesNotMatch(value, /SECRET_SENTINEL|PRIVATE_SYNTHETIC_PROMPT/);
  }
  assert.deepEqual(runtimeError(error).startup, error.startup);
});

test('invalid_grant remains an authentication error', () => {
  const tail = new StartupTail();
  tail.write('stderr', 'invalid_grant\n');
  assert.equal(tail.failure('fixture', 1).message, 'authentication-required');
});

test('startup diagnostics distinguish system arguments from CLI options', () => {
  const system = new StartupTail();
  system.write('stderr', "EINVAL: invalid argument, open 'fixture'\n");
  assert.equal(system.failure('fixture', 1).message, 'runtime-process-closed');
  const cli = new StartupTail();
  cli.write('stderr', sentence);
  assert.equal(cli.failure('fixture', 1).message, 'runtime-protocol-incompatible');
});

test('startup diagnostics find the first nonempty line and retain exactly 20 short lines', () => {
  const tail = new StartupTail();
  tail.write('stderr', '\nerror: first diagnostic\n');
  assert.match(tail.failure('fixture', 1).startup.firstLine ?? '', /error: first diagnostic/);
  const capped = new StartupTail();
  for (let index = 0; index < 25; index++) capped.write('stderr', `line ${index}\n`);
  assert.deepEqual(
    capped.text().split('\n'),
    Array.from({ length: 20 }, (_, index) => `line ${index + 5}`),
  );
});

test('claude preserves authentication classification after long startup stderr', async (t) => {
  const { spawn } = await import('node:child_process');
  const { createClaudeAdapter } = await import('../src/server/adapters/claude.ts');
  const dir = await mkdtemp(join(tmpdir(), 'startup-claude-auth-'));
  const script = join(dir, 'fake.mjs');
  t.after(async () => {
    await unlink(script);
    await rmdir(dir);
  });
  await writeFile(script, "process.stderr.write('Not logged in\\n' + 'ordinary log\\n'.repeat(25)); process.exit(1);");
  const target: RuntimeTarget = {
    id: 'claude-auth',
    provider: 'claude',
    label: 'Claude',
    command: process.execPath,
    args: [script],
    environment: 'native',
    enabled: true,
  };
  const ctx: ExecuteContext = {
    target,
    input: { projectPath: dir, prompt: 'synthetic prompt', kind: 'general', permissionMode: 'read-only' },
    route: { runtimeId: target.id, model: 'auto', kind: 'general', reasons: [], warnings: [] },
    signal: new AbortController().signal,
    emit: () => {},
    approve: async () => false,
  };
  const adapter = createClaudeAdapter({
    spawn: async () => spawn(process.execPath, [script], { stdio: 'pipe' }),
    terminate: async () => {},
  });
  await assert.rejects(adapter.execute(ctx), (error: Error & { startup?: unknown }) => {
    assert.equal(error.message, 'authentication-required');
    assert.ok(error.startup);
    return true;
  });
});

for (const provider of ['codex', 'grok-legacy', 'grok-acp', 'claude', 'pi'] as const) {
  test(`${provider} exit before handshake retains startup failure`, async (t) => {
    const { spawn } = await import('node:child_process');
    const { createCodexAdapter } = await import('../src/server/adapters/codex.ts');
    const { createGrokAdapter } = await import('../src/server/adapters/grok.ts');
    const { createClaudeAdapter } = await import('../src/server/adapters/claude.ts');
    const { createPiAdapter } = await import('../src/server/adapters/pi.ts');
    const dir = await mkdtemp(join(tmpdir(), 'startup-adapter-'));
    const script = join(dir, 'fake.mjs');
    t.after(async () => {
      await unlink(script);
      await rmdir(dir);
    });
    await writeFile(
      script,
      `setTimeout(() => { process.stderr.write(${JSON.stringify(sentence)} + '\\n'); process.exit(1); }, 300);`,
    );
    let spawned = false;
    let observedExit: number | null | undefined;
    let closed: Promise<void> | undefined;
    const spawnFixture: typeof import('../src/server/adapters/process.ts').spawnTarget = async () => {
      spawned = true;
      const child = spawn(process.execPath, [script], { stdio: 'pipe' });
      closed = new Promise((resolve) =>
        child.once('close', (code) => {
          observedExit = code;
          resolve();
        }),
      );
      return child;
    };
    const terminate = async () => {};
    const actualProvider = provider === 'grok-acp' || provider === 'grok-legacy' ? 'grok' : provider;
    const target: RuntimeTarget = {
      id: `${provider}-fixture`,
      provider: actualProvider,
      label: provider,
      command: process.execPath,
      args: [script],
      environment: 'native',
      enabled: true,
    };
    const fingerprint = 'synthetic-account';
    const ctx: ExecuteContext = {
      target,
      input: {
        projectPath: dir,
        prompt: 'synthetic prompt',
        kind: 'general',
        permissionMode: 'read-only',
        untrustedContent: provider === 'pi',
      },
      route: {
        runtimeId: target.id,
        model: provider === 'pi' ? 'test/model' : 'auto',
        kind: 'general',
        reasons: [],
        warnings: [],
        accountFingerprint: fingerprint,
      },
      signal: new AbortController().signal,
      emit: () => {},
      approve: async () => false,
      ...(provider === 'grok-acp' ? { registerSteer: () => {} } : {}),
    };
    const adapter =
      provider === 'codex'
        ? createCodexAdapter({ spawn: spawnFixture, terminate })
        : provider.startsWith('grok')
          ? createGrokAdapter({ spawn: spawnFixture, terminate })
          : provider === 'claude'
            ? createClaudeAdapter({ spawn: spawnFixture, terminate })
            : createPiAdapter({ spawn: spawnFixture, terminate, version: async () => '0.87.1' });
    const error = await adapter.execute(ctx).then(
      () => undefined,
      (failure: Error & { detail?: string; startup?: { exitCode: number | null } }) => failure,
    );
    assert.ok(spawned, 'fixture process must start');
    await closed;
    assert.equal(observedExit, 1, 'fixture must exit with code 1');
    assert.ok(error, 'execution must fail');
    assert.equal(error.message, 'runtime-protocol-incompatible');
    assert.ok(error.detail?.includes(sentence));
    assert.equal(error.startup?.exitCode, 1);
  });
}

test('cursor crash after session handshake stays a non-startup process error', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'startup-after-'));
  const script = join(dir, 'cursor.mjs');
  const marker = join(dir, 'handshake');
  t.after(async () => {
    await unlink(script);
    await unlink(marker);
    await rmdir(dir);
  });
  await writeFile(
    script,
    `
import {createInterface} from 'node:readline';
import {writeFileSync} from 'node:fs';
const args=process.argv.slice(2);
if(args.includes('status')) console.log(JSON.stringify({status:'authenticated',isAuthenticated:true,userInfo:{userId:'fixture',email:'fixture@example.test'}}));
else if(args.includes('models')) console.log('auto - Auto');
else if(args.includes('about')) console.log(JSON.stringify({cliVersion:'fixture',userEmail:'fixture@example.test'}));
else createInterface({input:process.stdin}).on('line', line => {
  const msg=JSON.parse(line);
  if(msg.method==='initialize') console.log(JSON.stringify({jsonrpc:'2.0',id:msg.id,result:{protocolVersion:1,agentCapabilities:{}}}));
  else if(msg.method==='cursor/list_available_models') console.log(JSON.stringify({jsonrpc:'2.0',id:msg.id,error:{code:-32601,message:'Unsupported'}}));
  else if(msg.method==='session/new') { writeFileSync(${JSON.stringify(marker)},'done'); console.log(JSON.stringify({jsonrpc:'2.0',id:msg.id,result:{sessionId:'fixture',modes:{currentModeId:'ask',availableModes:[{id:'ask'}]},configOptions:[{id:'model',category:'model',type:'select',currentValue:'auto',options:[{value:'auto'}]}]}})); setTimeout(()=>process.exit(1),300); }
});
`,
  );
  const target: RuntimeTarget = {
    id: 'cursor-after',
    provider: 'cursor',
    label: 'Cursor',
    command: process.execPath,
    args: [script],
    environment: 'native',
    enabled: true,
  };
  const ctx: ExecuteContext = {
    target,
    input: { projectPath: dir, prompt: 'synthetic prompt', kind: 'general', permissionMode: 'read-only' },
    route: {
      runtimeId: target.id,
      model: 'auto',
      kind: 'general',
      reasons: [],
      warnings: [],
      accountFingerprint: cursorAccountFingerprint({
        status: 'authenticated',
        isAuthenticated: true,
        userInfo: { userId: 'fixture', email: 'fixture@example.test' },
      }),
    },
    signal: new AbortController().signal,
    emit: () => {},
    approve: async () => false,
  };
  await assert.rejects(createCursorAdapter().execute(ctx), (error: Error & { startup?: unknown }) => {
    assert.equal(error.message, 'runtime-process-closed');
    assert.equal(error.startup, undefined);
    return true;
  });
});

test('split large JSON stdout is excluded and multiline prompt first line is redacted', () => {
  const tail = new StartupTail();
  tail.write('stdout', '"' + 'secret-output'.repeat(500));
  tail.write('stdout', 'rest"\n');
  const prompt = 'PRIVATE_PROMPT_FIRST_LINE\nPRIVATE_PROMPT_SECOND_LINE';
  tail.write('stderr', `prefix ${prompt.split('\n')[0]}\nintervening log\n${prompt.split('\n')[1]}\n`);
  const error = tail.failure('fixture', 1, { prompt });
  assert.doesNotMatch(tail.text(), /secret-output|rest/);
  assert.doesNotMatch(error.detail ?? '', /PRIVATE_PROMPT/);
  assert.doesNotMatch(error.startup.firstLine ?? '', /PRIVATE_PROMPT/);
  tail.done();
  assert.equal(tail.text(), '');
});
