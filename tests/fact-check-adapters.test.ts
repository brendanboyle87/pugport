import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExecuteContext } from '../src/shared/types.ts';
import { syntheticCodex } from './helpers/codex-rpc.ts';
import { claudeExecutionArgs } from '../src/server/adapters/claude.ts';
import { createPiAdapter } from '../src/server/adapters/pi.ts';
import { createGrokAdapter } from '../src/server/adapters/grok.ts';
import { grokAcpMcpServers, grokAcpSessionMeta } from '../src/server/adapters/grok-acp.ts';

function context(provider: ExecuteContext['target']['provider']): ExecuteContext {
  return {
    target: {
      id: 'synthetic-checker',
      provider,
      label: 'Synthetic',
      command: 'unused',
      environment: 'native',
      enabled: true,
    },
    input: {
      prompt: 'Check a synthetic fact',
      projectPath: process.cwd(),
      kind: 'general',
      permissionMode: 'read-only',
      factCheck: true,
      prohibitCommands: true,
      skills: [],
    },
    route: {
      runtimeId: 'synthetic-checker',
      model: 'fixture-model',
      effort: 'high',
      kind: 'general',
      reasons: [],
      warnings: [],
    },
    agentBridge: { url: 'http://127.0.0.1:1/mcp', token: 'synthetic-token', extraTools: ['web_search', 'web_fetch'] },
    signal: new AbortController().signal,
    emit: () => {},
    approve: async () => false,
  };
}

test('Codex checker starts a fresh thread with native instruction files and memory disabled', async () => {
  const requests: Array<Record<string, unknown>> = [];
  await syntheticCodex(
    {
      onLaunch: (args) => {
        assert.ok(args.includes('project_doc_max_bytes=0'));
        assert.ok(args.includes('features.memory_tool=false'));
        assert.ok(args.includes('features.shell_tool=false'));
      },
    },
    requests,
  ).execute(context('codex'));
  const thread = requests.find((request) => request.method === 'thread/start')!;
  assert.ok(thread);
  assert.equal(
    requests.some((request) => request.method === 'thread/resume'),
    false,
  );
  assert.equal((thread.params as Record<string, unknown>).developerInstructions, '');
  assert.match(String((thread.params as Record<string, unknown>).baseInstructions), /independent web fact checker/);
});

test('Claude checker skips native notes and hooks while retaining the search bridge', () => {
  const args = claudeExecutionArgs(context('claude'), '/synthetic/mcp.json');
  assert.ok(args.includes('--safe-mode'));
  assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(args.includes('--mcp-config'));
  assert.equal(args.includes('--resume'), false);
  assert.ok(args[args.indexOf('--allowedTools') + 1]!.includes('web_search'));
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Glob,Grep');
});

test('Pi checker disables native context files while retaining independently searchable host tools', async () => {
  let started = false;
  const adapter = createPiAdapter({
    permissionExtension: async () => '/synthetic/permission-extension.mjs',
    bridgeTools: async () => ['web_search', 'web_fetch'],
    environment: () => ({}),
    spawn: async (_target, args) => {
      started = true;
      assert.ok(args.includes('--no-context-files'));
      assert.ok(args.includes('--no-skills'));
      assert.ok(args[args.indexOf('--tools') + 1]!.includes('pugport_web_search'));
      assert.equal(args.includes('--session'), false);
      throw new Error('synthetic-stop-before-launch');
    },
  });
  await assert.rejects(adapter.execute(context('pi')), /synthetic-stop-before-launch/);
  assert.equal(started, true);
});

test('Grok checker disables cross-session memory and retains only host-gated MCP with no shell', async () => {
  const ctx = context('grok');
  assert.equal(grokAcpMcpServers(ctx).length, 1);
  const profile = grokAcpSessionMeta(ctx).agentProfile as { disallowedTools: string[]; permissionMode: string };
  assert.equal(profile.permissionMode, 'default');
  assert.ok(profile.disallowedTools.includes('Bash'));
  assert.equal(profile.disallowedTools.includes('MCPTool'), false);
  let started = false;
  await assert.rejects(
    createGrokAdapter({
      spawn: async (_target, _args, options) => {
        started = true;
        assert.equal(options?.env?.GROK_MEMORY, '0');
        throw new Error('synthetic-stop-before-launch');
      },
      terminate: async () => {},
    }).execute(ctx),
    /synthetic-stop-before-launch/,
  );
  assert.equal(started, true);
});
