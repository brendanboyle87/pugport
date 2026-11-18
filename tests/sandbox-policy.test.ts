import assert from 'node:assert/strict';
import test from 'node:test';
import { win32 as path } from 'node:path';
import {
  buildSandboxRequest,
  type SandboxHost,
  type SandboxPolicyInput,
} from '../src/server/sandbox/policy-builder.ts';
import { commandLine, windowsWrapperCommand } from '../src/server/sandbox/command-line.ts';
import { shouldLearn } from '../src/server/sandbox/execution.ts';
import type { RuntimeTarget, RunInput, Settings } from '../src/shared/types.ts';

const host: SandboxHost = {
  home: 'C:\\Users\\fixture',
  dataDir: 'D:\\data',
  secrets: 'C:\\private\\secrets',
  environment: { SystemRoot: 'C:\\Windows', APPDATA: 'C:\\Users\\fixture\\AppData\\Roaming' },
  readExecutePaths: [
    'C:\\Windows',
    'C:\\Tools',
    'D:\\app\\node_modules',
    'C:\\private\\secrets',
    'C:\\Users\\fixture\\.aws',
  ],
  protectedDataPaths: ['D:\\data\\settings.json', 'D:\\data\\accounts\\other', 'D:\\data\\sandbox'],
  realpath: (p) => (p === 'D:\\app\\node_modules' ? 'E:\\packages' : path.resolve(p)),
};
const input: SandboxPolicyInput = {
  provider: 'pi',
  taskKind: 'write',
  projectPath: 'D:\\project',
  runTemp: 'C:\\Temp\\pugport-pi-fixture',
};
test('project modes, canonical tools, private temp, own profile, and fixed permissive capture policy', () => {
  for (const taskKind of ['write', 'read-only', 'tool-less'] as const) {
    const request = buildSandboxRequest({ ...input, taskKind }, host);
    assert.equal(request.filesystem?.readwritePaths?.includes(input.projectPath), taskKind === 'write');
    assert.equal(request.filesystem?.readonlyPaths?.includes(input.projectPath), taskKind === 'read-only');
    assert.equal(request.workingDirectory, taskKind === 'tool-less' ? input.runTemp : input.projectPath);
    assert.ok(request.filesystem?.readwritePaths?.includes(input.runTemp));
    assert.ok(request.filesystem?.readwritePaths?.includes('D:\\data\\pi\\sessions'));
    assert.ok(request.filesystem?.readonlyPaths?.includes('E:\\packages'));
    assert.equal(request.environment?.TEMP, input.runTemp);
    assert.equal(request.inheritDefaultEnvironment, false);
    assert.deepEqual(request.network?.egress, { default: 'allow' });
    assert.deepEqual(request.fallback, { allowDaclMutation: false });
    assert.equal(request.containment?.type, 'processcontainer');
    if (request.containment?.type === 'processcontainer') {
      assert.equal(request.containment.config?.captureDenials?.mode, 'allow');
      assert.equal(request.containment.config?.captureDenials?.retainEtl, false);
      assert.equal(request.containment.config?.learningMode, undefined);
    }
    assert.deepEqual(request.ui, { disable: false, clipboard: 'none', allowInputInjection: false });
  }
});
test('sensitive paths and other CLI profiles are denied; never grant secrets even when supplied as a project', () => {
  const request = buildSandboxRequest({ ...input, projectPath: host.secrets }, host);
  const denied = request.filesystem!.deniedPaths!;
  for (const name of ['.ssh', '.aws', '.azure', '.gnupg', '.kube', '.codex', '.gemini', '.claude', '.grok', '.cursor'])
    assert.ok(denied.includes(path.join(host.home, name)), name);
  assert.ok(denied.includes(host.secrets));
  assert.ok(denied.some((p) => p.endsWith('Google\\Chrome\\User Data')));
  assert.ok(denied.some((p) => p.endsWith('Microsoft\\Credentials')));
  assert.ok(denied.includes('D:\\data\\accounts\\other'));
  assert.ok(!request.filesystem?.readwritePaths?.includes(host.secrets));
  assert.ok(!request.filesystem?.readonlyPaths?.includes(host.secrets));
});
test('host loopback requires an issued nonempty bridge token', () => {
  for (const bridgeToken of [undefined, '', 'synthetic-bridge']) {
    const request = buildSandboxRequest({ ...input, bridgeToken }, host);
    assert.deepEqual(request.network?.ingress, {
      default: bridgeToken ? 'allow' : 'deny',
      hostLoopback: bridgeToken ? 'allow' : 'deny',
    });
  }
});

test('isolated APPDATA still denies host browser, credential and configured sibling CLI homes', () => {
  const request = buildSandboxRequest(
    { ...input, provider: 'cursor' },
    {
      ...host,
      environment: { APPDATA: 'D:\\account\\roaming' },
      hostEnvironment: {
        APPDATA: 'E:\\roaming',
        LOCALAPPDATA: 'E:\\local',
        CODEX_HOME: 'E:\\codex',
        CLAUDE_CONFIG_DIR: 'E:\\claude',
      },
    },
  );
  for (const denied of [
    'E:\\roaming\\Microsoft\\Credentials',
    'E:\\local\\Google\\Chrome\\User Data',
    'E:\\codex',
    'E:\\claude',
  ])
    assert.ok(request.filesystem?.deniedPaths?.includes(denied), denied);
});
test('each executor receives only its own configured account and login paths', () => {
  for (const provider of ['pi', 'claude', 'grok', 'cursor'] as const) {
    const request = buildSandboxRequest(
      { ...input, provider, accountHome: 'D:\\data\\accounts\\own' },
      {
        ...host,
        environment: {
          ...host.environment,
          CLAUDE_CONFIG_DIR: 'D:\\claude',
          GROK_HOME: 'D:\\grok',
          GROK_AUTH_PATH: 'D:\\grok\\auth.json',
          CURSOR_CONFIG_DIR: 'D:\\cursor',
        },
      },
    );
    assert.ok(request.filesystem?.readwritePaths?.includes('D:\\data\\accounts\\own'));
    if (provider !== 'pi') assert.ok(request.filesystem?.readwritePaths?.includes(`D:\\${provider}`));
    assert.ok(!request.filesystem?.readwritePaths?.includes('D:\\data'));
  }
});
test('only trusted native execute contexts with learn enabled qualify; enforce is inactive', () => {
  const target = { provider: 'pi', environment: 'native' } as RuntimeTarget;
  const run = { untrustedContent: false } as RunInput;
  for (const mode of ['off', 'learn', 'enforce'] as const)
    assert.equal(shouldLearn(target, run, { sandbox: { pi: mode } } as Settings), mode === 'learn');
  assert.equal(
    shouldLearn(target, { ...run, untrustedContent: true }, { sandbox: { pi: 'learn' } } as Settings),
    false,
  );
  assert.equal(shouldLearn({ ...target, provider: 'codex' }, run, { sandbox: { codex: 'learn' } } as Settings), false);
});
test('Windows command serialization preserves empty arguments, quotes and trailing slashes; wrappers retain strict checks', () => {
  assert.equal(
    commandLine('C:\\node.exe', ['', 'a"b', 'C:\\space dir\\']),
    '"C:\\node.exe" "" "a\\"b" "C:\\space dir\\\\"',
  );
  // Plain arguments stay unquoted: cmd.exe does not recognise a quoted "/c".
  assert.equal(
    commandLine('C:\\Windows\\System32\\cmd.exe', ['/d', '/c', 'echo MXC_OK', 'C:\\dir\\']),
    '"C:\\Windows\\System32\\cmd.exe" /d /c "echo MXC_OK" C:\\dir\\',
  );
  assert.equal(
    commandLine('C:\\tool.cmd', ['safe']),
    '"C:\\Windows\\System32\\cmd.exe" /d /s /c ' + windowsWrapperCommand('C:\\tool.cmd', ['safe']),
  );
  for (const bad of ['a&b', '%TEMP%', 'a"b', 'a\nb'])
    assert.throws(() => commandLine('tool.cmd', [bad]), /unsafe-wrapper/);
  assert.throws(() => commandLine('tool.ps1', []), /unsupported-runtime-wrapper/);
});
