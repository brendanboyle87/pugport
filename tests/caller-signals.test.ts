import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inferCaller, type CallerProbeInput, type CallerContext } from '../src/shared/caller-signals.ts';

const cwd = 'C:\\work\\project';
function infer(client: string, args: string[] = [], config?: CallerProbeInput['config']) {
  return inferCaller({ chain: [{ exe: `${client}.exe`, args }], envNames: [], cwd, config });
}
const settings = (defaultMode: string) =>
  JSON.stringify({ permissions: { defaultMode, additionalDirectories: ['C:\\extra'] } });

const cases: [string, string[], CallerProbeInput['config'], CallerContext['mode']][] = [
  ['claude', [], undefined, 'write'],
  ['claude', ['--permission-mode', 'plan'], undefined, 'read-only'],
  ['claude', [], { claudeSettings: [settings('plan')] }, 'read-only'],
  ['claude', [], { claudeSettings: [settings('bypassPermissions')] }, 'write-anywhere'],
  ['claude', ['--permission-mode=default'], { claudeSettings: [settings('bypassPermissions')] }, 'write'],
  ['claude', ['--dangerously-skip-permissions'], { claudeSettings: [settings('plan')] }, 'read-only'],
  ['claude', ['--permission-mode', 'plan', '--dangerously-skip-permissions'], undefined, 'read-only'],
  ['claude', ['--dangerously-skip-permissions'], undefined, 'write-anywhere'],
  ['codex', [], undefined, 'read-only'],
  ['codex', ['-s', 'workspace-write'], undefined, 'write'],
  ['codex', [], { codexToml: 'sandbox_mode = "workspace-write"' }, 'write'],
  ['codex', [], { codexToml: 'sandbox_mode = "danger-full-access"' }, 'write-anywhere'],
  ['codex', ['--sandbox=read-only'], { codexToml: 'sandbox_mode = "danger-full-access"' }, 'read-only'],
  ['codex', ['--sandbox', 'danger-full-access'], { codexToml: 'sandbox_mode = "read-only"' }, 'read-only'],
  ['codex', ['-s', 'workspace-write'], { codexToml: 'sandbox_mode = "danger-full-access"' }, 'write'],
  ['codex', ['--dangerously-bypass-approvals-and-sandbox'], undefined, 'write-anywhere'],
  ['codex', ['exec', 'fixture prompt'], { codexToml: 'sandbox_mode = "workspace-write"' }, 'read-only'],
  ['codex', ['exec'], undefined, 'read-only'],
  ['codex', ['exec', '--full-auto'], undefined, 'write'],
  ['codex', ['exec', '-s', 'workspace-write'], undefined, 'write'],
  ['codex', ['exec', '-c', 'sandbox_mode=workspace-write'], undefined, 'write'],
  ['codex', ['exec', '--config=sandbox_mode="danger-full-access"'], undefined, 'write-anywhere'],
  ['codex', ['-c', "sandbox_mode='read-only'", '--sandbox', 'danger-full-access'], undefined, 'read-only'],
  [
    'codex',
    ['exec', '--profile', 'full'],
    { codexToml: '[profiles.full]\nsandbox_mode = "danger-full-access"' },
    'write-anywhere',
  ],
  [
    'codex',
    ['--profile=full'],
    { codexToml: 'sandbox_mode = "read-only"\n[profiles."full"]\nsandbox_mode = "danger-full-access"' },
    'write-anywhere',
  ],
  ['codex', ['exec', '--dangerously-bypass-approvals-and-sandbox'], undefined, 'write-anywhere'],
  ['gemini', [], undefined, 'write'],
  ['gemini', ['--approval-mode', 'plan'], undefined, 'read-only'],
  ['gemini', ['--approval-mode=plan', '--yolo'], undefined, 'read-only'],
  ['gemini', ['--approval-mode', 'yolo'], undefined, 'write-anywhere'],
  ['gemini', ['-y'], undefined, 'write-anywhere'],
  ['grok', [], undefined, 'write'],
  ['grok', ['--permission-mode', 'plan'], undefined, 'read-only'],
  ['grok', [], { grokToml: 'permission_mode = "plan"' }, 'read-only'],
  ['grok', [], { grokToml: 'yolo = true' }, 'write-anywhere'],
  ['grok', ['--permission-mode', 'default'], { grokToml: 'yolo = true' }, 'write'],
  ['grok', ['--permission-mode=bypassPermissions'], { grokToml: 'permission_mode = "plan"' }, 'read-only'],
  ['grok', ['--permission-mode', 'bypassPermissions'], undefined, 'write-anywhere'],
  ['cursor-agent', [], undefined, 'write'],
  ['cursor-agent', [], { grokToml: 'yolo = true', claudeSettings: [settings('plan')] }, 'write'],
  ['cursor-agent', ['--mode', 'plan'], undefined, 'read-only'],
  ['cursor-agent', ['--plan', '--force'], undefined, 'read-only'],
  ['cursor-agent', ['--yolo'], undefined, 'write-anywhere'],
  ['cursor-agent', ['-f'], undefined, 'write-anywhere'],
];
for (const [index, [client, args, config, mode]] of cases.entries())
  test(`${index}: ${client} ${args.join(' ')} -> ${mode}`, () => assert.equal(infer(client, args, config).mode, mode));

test('roots combine cwd, repeated flags, and only the named config keys', () => {
  assert.deepEqual(
    infer('claude', ['--add-dir', 'C:\\extra', 'C:\\second'], { claudeSettings: [settings('default')] }).roots,
    [cwd, 'C:\\extra', 'C:\\second'],
  );
  assert.deepEqual(
    infer('codex', ['--cd', 'C:\\repo', '-s', 'workspace-write', '--add-dir=../extra'], {
      codexToml: '[sandbox_workspace_write]\nwritable_roots = [\n "C:\\\\more", # comment\n \'C:\\last\',\n]',
    }).roots,
    ['C:\\repo', 'C:\\extra', 'C:\\more', 'C:\\last'],
  );
  assert.deepEqual(infer('gemini', ['--include-directories', 'C:\\a,C:\\b']).roots, [cwd, 'C:\\a', 'C:\\b']);
  assert.deepEqual(infer('cursor-agent', ['--workspace', 'C:\\repo', '--add-dir', 'C:\\more']).roots, [
    cwd,
    'C:\\repo',
    'C:\\more',
  ]);
  assert.deepEqual(infer('grok').roots, [cwd]);
});

test('trusted Codex TUI cwd, including --cd, grants workspace writes; an untrusted one does not', () => {
  const config = { codexToml: '[projects."C:\\\\work\\\\project"]\ntrust_level = "trusted"' };
  assert.equal(infer('codex', [], config).mode, 'write');
  assert.equal(infer('codex', ['-C', 'C:\\other'], config).mode, 'read-only');
  assert.equal(infer('codex', ['exec'], config).mode, 'read-only');
});

test('identity precedence, conflict, metadata, node CLI launchers, and unknown identity', () => {
  const base: CallerProbeInput = { chain: [{ exe: 'codex.exe', args: ['--full-auto'] }], envNames: [], cwd };
  assert.equal(inferCaller({ ...base, pugportCaller: 'claude' }).client, 'claude');
  assert.equal(inferCaller({ ...base, pugportCaller: 'claude' }).mode, 'unknown');
  assert.equal(inferCaller({ ...base, clientInfo: { name: 'claude-code', version: '1' } }).mode, 'unknown');
  assert.equal(inferCaller({ ...base, clientInfo: { name: '@openai/codex/client', version: '2' } }).version, '2');
  assert.equal(inferCaller({ ...base, chain: [], clientInfo: { name: 'claude-code', version: '1' } }).client, 'claude');
  assert.equal(
    inferCaller({
      ...base,
      chain: [{ exe: '/usr/bin/node', args: ['/opt/node_modules/@openai/codex/bin/codex.js', '--full-auto'] }],
    }).mode,
    'write',
  );
  assert.equal(inferCaller({ ...base, chain: [{ exe: 'node', args: ['other.js', 'codex'] }] }).client, 'unknown');
  assert.equal(inferCaller({ chain: [], envNames: ['CLAUDECODE'] }).verified, false);
  assert.equal(infer('claude').verified, true);
  for (const config of [
    undefined,
    { codexToml: 'sandbox_mode = "read-only"' },
    { codexToml: 'sandbox_mode = "danger-full-access"' },
  ])
    assert.equal(
      inferCaller({ chain: [], envNames: [], cwd, config, clientInfo: { name: 'codex', version: '1' } }).mode,
      'unknown',
    );
});

test('system and home working directories are unknown even with bypass flags', () => {
  for (const path of [
    'C:\\Windows\\System32',
    'C:\\Program Files\\PugPort',
    'C:\\Program Files (x86)',
    'C:\\Users\\fixture',
    '/home/fixture',
    '/Users/fixture',
    '/root',
  ]) {
    const result = inferCaller({
      chain: [{ exe: 'claude', args: ['--dangerously-skip-permissions'] }],
      envNames: [],
      cwd: path,
    });
    assert.equal(result.mode, 'unknown', path);
    assert.equal(result.verified, false);
  }
});

test('WSL drive paths normalize and proc observations stay unverified', () => {
  const result = inferCaller({
    chain: [{ exe: '/mnt/c/tools/codex', args: ['--full-auto', '--add-dir', '/mnt/d/data'] }],
    envNames: [],
    cwd: '/mnt/c/work/project',
  });
  assert.deepEqual(result.roots, [cwd, 'D:\\data']);
  assert.equal(result.cwd, cwd);
  assert.equal(result.mode, 'unknown');
  assert.equal(result.verified, false);
  assert.equal(
    inferCaller({ chain: [{ exe: '/usr/bin/claude', args: [] }], envNames: [], cwd: '/work' }).verified,
    true,
  );
});

test('config scans ignore unrelated tables, keys, nested values, and malformed JSON', () => {
  const result = infer('codex', [], {
    codexToml:
      '# sandbox_mode = "danger-full-access"\nsecret = "fixture-private"\n[unrelated]\nsandbox_mode = "danger-full-access"\nwritable_roots = ["C:\\\\secret"]\ntrust_level = "trusted"',
  });
  assert.equal(result.mode, 'read-only');
  assert.deepEqual(result.roots, [cwd]);
  assert.ok(!JSON.stringify(result).includes('fixture-private'));
  assert.equal(infer('grok', [], { grokToml: '[unrelated]\nyolo = true\npermission_mode = "plan"' }).mode, 'write');
  assert.equal(
    infer('claude', [], { claudeSettings: ['{"unrelated":{"permissions":{"defaultMode":"plan"}}}', '{broken'] }).mode,
    'write',
  );
});

test('readonly remains sticky across duplicate flags, ancestor matches, and settings layers', () => {
  assert.equal(infer('codex', ['-s', 'read-only', '-s', 'danger-full-access']).mode, 'read-only');
  assert.equal(
    infer('claude', [], { claudeSettings: [settings('plan'), settings('bypassPermissions')] }).mode,
    'read-only',
  );
  assert.equal(
    inferCaller({
      chain: [
        { exe: 'claude', args: ['--dangerously-skip-permissions'] },
        { exe: 'claude', args: ['--permission-mode', 'plan'] },
      ],
      envNames: [],
      cwd,
    }).mode,
    'read-only',
  );
  assert.equal(infer('claude', ['--', '--permission-mode', 'plan']).mode, 'write');
});

test('separate process argument boundaries cannot hide read-only evidence', () => {
  assert.equal(
    inferCaller({
      chain: [
        { exe: 'codex', args: ['--profile', 'restricted'] },
        { exe: 'codex', args: ['--profile', 'full'] },
      ],
      envNames: [],
      cwd,
      config: {
        codexToml:
          '[profiles.restricted]\nsandbox_mode = "read-only"\n[profiles.full]\nsandbox_mode = "danger-full-access"',
      },
    }).mode,
    'read-only',
  );
  assert.equal(
    inferCaller({
      chain: [
        { exe: 'claude', args: ['--', 'prompt'] },
        { exe: 'claude', args: ['--permission-mode', 'plan'] },
      ],
      envNames: [],
      cwd,
    }).mode,
    'read-only',
  );
  assert.equal(
    inferCaller({
      chain: [
        { exe: 'codex', args: ['exec'] },
        { exe: 'codex', args: ['--full-auto'] },
      ],
      envNames: [],
      cwd,
    }).mode,
    'read-only',
  );
});

test('malformed writable_roots never includes unrelated string values', () => {
  const result = infer('codex', ['--full-auto'], {
    codexToml: '[sandbox_workspace_write]\nwritable_roots = [\n unrelated = "C:\\\\private"\n]',
  });
  assert.deepEqual(result.roots, [cwd]);
});

test('dotted trust keys and Windows case differences identify the same trusted project', () => {
  assert.equal(infer('codex', [], { codexToml: `projects.'c:\\WORK\\PROJECT'.trust_level = "trusted"` }).mode, 'write');
});

test('caller network: Codex workspace-write reads the top-level sandbox_workspace_write table; -c overrides it', () => {
  const net = (args: string[], codexToml?: string) => infer('codex', args, { codexToml }).network;
  const base = 'sandbox_mode = "workspace-write"\n';
  const on = `${base}[sandbox_workspace_write]\nnetwork_access = true`;
  assert.equal(net([], on), true);
  assert.equal(net([], `${base}[sandbox_workspace_write]\nnetwork_access = false`), false);
  assert.equal(net([], base), false);
  assert.equal(net([], `${base}network_access = true`), false);
  assert.equal(net([], `${base}[profiles.dev.sandbox_workspace_write]\nnetwork_access = true`), false);
  assert.equal(net(['-c', 'sandbox_workspace_write.network_access=true'], base), true);
  assert.equal(net(['-c', 'sandbox_workspace_write.network_access=false'], on), false);
  assert.equal(
    net(
      ['-c', 'sandbox_workspace_write.network_access=false', '--config=sandbox_workspace_write.network_access=true'],
      base,
    ),
    true,
  );
  assert.equal(net(['-s', 'workspace-write'], '[sandbox_workspace_write]\nnetwork_access = true'), true);
});

test('caller network: other clients follow their write modes; read-only and unknown are off', () => {
  const table = '[sandbox_workspace_write]\nnetwork_access = true';
  assert.equal(infer('codex', ['--dangerously-bypass-approvals-and-sandbox']).network, true);
  assert.equal(infer('codex', ['-s', 'read-only'], { codexToml: table }).network, false);
  assert.equal(infer('claude').network, true);
  assert.equal(infer('claude', ['--dangerously-skip-permissions']).network, true);
  assert.equal(infer('claude', ['--permission-mode', 'plan']).network, false);
  for (const client of ['cursor', 'gemini', 'grok']) assert.equal(infer(client).network, true, client);
  assert.equal(infer('cursor', ['--plan']).network, false);
  assert.equal(infer('somethingelse').network, false);
});

test('name alone never verifies a caller', () => {
  const context = inferCaller({
    chain: [],
    envNames: [],
    cwd: 'C:/synthetic/repo',
    clientInfo: { name: 'claude-code', version: '1' },
  });
  assert.equal(context.mode, 'unknown');
  assert.equal(context.verified, false);
  assert.ok(context.evidence.includes('identity: not verified'));
});

test('identity requires observed chain and WSL comes from environment', () => {
  const base = { chain: [], envNames: [], cwd: 'C:/synthetic/repo' };
  for (const input of [
    { ...base, pugportCaller: 'claude' },
    { ...base, clientInfo: { name: 'claude-code', version: '1' } },
  ]) {
    const result = inferCaller(input);
    assert.equal(result.client, 'claude');
    assert.equal(result.mode, 'unknown');
    assert.equal(result.verified, false);
    assert.ok(result.evidence.includes('identity: not verified'));
  }
  const partial = inferCaller({
    ...base,
    chain: [{ exe: 'Code.exe', args: [] }],
    timedOut: true,
    clientInfo: { name: 'claude-code', version: '1' },
  });
  assert.equal(partial.mode, 'unknown');
  assert.ok(!partial.evidence.includes('probe: timeout'));
  assert.ok(partial.evidence.includes('identity: not verified'));
  const linux = { chain: [{ exe: '/usr/bin/claude', args: [] }], envNames: [], cwd: '/work' };
  const observed = inferCaller(linux);
  assert.equal(observed.mode, 'write');
  assert.equal(observed.verified, true);
  assert.equal(observed.network, true);
  const wsl = inferCaller({ ...linux, envNames: ['WSL_DISTRO_NAME'] });
  assert.equal(wsl.verified, false);
  assert.equal(wsl.mode, 'unknown');
});
