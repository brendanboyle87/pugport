import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { defaultTargets } from '../src/server/discovery.js';
import { claudeAdapter } from '../src/server/adapters/claude.js';
import { grokAdapter } from '../src/server/adapters/grok.js';
import { redactError, shutdownOwnedProcesses } from '../src/server/adapters/process.js';
import type { RunEvent } from '../src/shared/types.js';

const projectPath = resolve('reports/native-cli-check');
await mkdir(projectPath, { recursive: true });
const result: Record<string, unknown> = { capturedAt: new Date().toISOString(), permissionMode: 'read-only' };
try {
  for (const target of defaultTargets().filter((t) => t.provider === 'claude' || t.provider === 'grok')) {
    const adapter = target.provider === 'claude' ? claudeAdapter : grokAdapter;
    const model = target.provider === 'claude' ? 'haiku' : 'grok-4.7-build-fast';
    const marker = target.provider === 'claude' ? 'CLAUDE_NATIVE_READY' : 'GROK_NATIVE_READY';
    const signal = AbortSignal.timeout(90000);
    const usage: RunEvent[] = [];
    const startedAt = Date.now();
    try {
      const snapshot = await adapter.discover(target);
      const run = await adapter.execute({
        target,
        input: {
          projectPath,
          kind: 'routine',
          permissionMode: 'read-only',
          prompt: `Reply with exactly ${marker}. Do not use tools. Do not read or modify any files.`,
        },
        route: {
          runtimeId: target.id,
          model,
          ...(target.provider === 'grok' ? { effort: 'low' } : {}),
          kind: 'routine',
          reasons: [],
          warnings: [],
        },
        signal,
        approve: async () => false,
        emit: (event) => {
          if (event.type === 'usage') usage.push(event);
        },
      });
      result[target.provider] = {
        model,
        native: target.environment === 'native',
        status: run.output.trim() === marker ? 'passed' : 'unexpected-response',
        connectionStatus: snapshot.status,
        accounting: snapshot.accounting,
        quotaStatus: snapshot.quota.status,
        // Only the known validation marker is persisted, not arbitrary model text.
        output: run.output.trim() === marker ? marker : '[unexpected response omitted]',
        hasNativeSession: Boolean(run.nativeSessionId),
        durationMs: Date.now() - startedAt,
        usage,
      };
    } catch (error) {
      result[target.provider] = {
        model,
        status: 'failed',
        error: redactError(error),
        durationMs: Date.now() - startedAt,
      };
    }
  }
  await writeFile('reports/native-cli-verification.json', `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
} finally {
  await shutdownOwnedProcesses();
}
