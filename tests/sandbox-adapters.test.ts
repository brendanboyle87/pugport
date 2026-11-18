import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createClaudeAdapter } from '../src/server/adapters/claude.ts';
import { createGrokAdapter } from '../src/server/adapters/grok.ts';
import { executeGrokAcp } from '../src/server/adapters/grok-acp.ts';
import { createPiAdapter } from '../src/server/adapters/pi.ts';
import { createCursorAdapter, cursorAccountFingerprint } from '../src/server/adapters/cursor.ts';
import type { ExecuteContext } from '../src/shared/types.ts';
import type { TargetSpawnOptions } from '../src/server/adapters/process.ts';
import type { SandboxRequest } from '../src/server/sandbox/policy-builder.ts';

for (const provider of ['pi', 'claude', 'grok', 'cursor'] as const)
  test(`${provider} execute forwards sandbox, uses run temp, and keeps metadata probes plain`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sandbox-adapter-test-'));
    const sandbox: SandboxRequest = {
      provider,
      runTemp: directory,
      reportDirectory: directory,
      fallback: { allowDaclMutation: false },
    };
    const identity = {
      status: 'authenticated',
      isAuthenticated: true,
      userInfo: { userId: 'fixture-user', email: 'fixture@example.test' },
    };
    const ctx: ExecuteContext = {
      target: { id: 'synthetic', provider, label: provider, command: 'fixture', enabled: true, environment: 'native' },
      input: { prompt: 'Synthetic input', projectPath: directory, kind: 'general', permissionMode: 'read-only' },
      route: {
        runtimeId: 'synthetic',
        model: 'fixture',
        kind: 'general',
        reasons: [],
        warnings: [],
        accountFingerprint: cursorAccountFingerprint(identity),
      },
      sandbox,
      runTemp: directory,
      signal: new AbortController().signal,
      emit() {},
      approve: async () => false,
      ...(provider === 'claude' ? { agentBridge: { url: 'http://127.0.0.1:1', token: 'synthetic' } } : {}),
    };
    let spawned = false,
      tempFile: string | undefined;
    const deps = {
      spawn: async (
        _target: ExecuteContext['target'],
        args: string[],
        options?: TargetSpawnOptions,
      ): Promise<never> => {
        spawned = true;
        assert.equal(options?.sandbox, sandbox);
        assert.equal(options?.runTemp, directory);
        const flag = provider === 'claude' ? '--mcp-config' : provider === 'grok' ? '--prompt-file' : '';
        if (flag) {
          tempFile = args[args.indexOf(flag) + 1];
          assert.ok(tempFile && !relative(directory, tempFile).startsWith('..'));
          const content = await readFile(tempFile, 'utf8');
          assert.ok(content.includes(provider === 'claude' ? 'synthetic' : ctx.input.prompt));
        }
        throw new Error('synthetic-spawn-stop');
      },
      capture: async (_target: ExecuteContext['target'], args: string[], options?: TargetSpawnOptions) => {
        assert.equal(options?.sandbox, undefined);
        return { stdout: args[0] === 'status' ? JSON.stringify(identity) : 'fixture', exitCode: 0 };
      },
      targetPath: async (_target: ExecuteContext['target'], value: string) => value,
      terminate: async () => {},
    };
    try {
      const adapter =
        provider === 'claude'
          ? createClaudeAdapter(deps)
          : provider === 'grok'
            ? createGrokAdapter(deps)
            : provider === 'cursor'
              ? createCursorAdapter(deps)
              : createPiAdapter({ ...deps, environment: () => ({}) });
      await assert.rejects(adapter.execute(ctx));
      assert.ok(spawned, 'must reach the execution spawn');
      if (tempFile) await assert.rejects(access(tempFile));
      if (provider === 'grok') {
        let acpSpawned = false;
        await assert.rejects(
          executeGrokAcp(ctx, {
            ...deps,
            spawn: async (_target, _args, options) => {
              acpSpawned = true;
              assert.equal(options?.sandbox, sandbox);
              throw new Error('synthetic-spawn-stop');
            },
          }),
        );
        assert.ok(acpSpawned);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
