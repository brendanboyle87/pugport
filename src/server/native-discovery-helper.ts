import { createGrokAdapter } from './adapters/grok.ts';
import { createClaudeAdapter } from './adapters/claude.ts';
import { createCodexAdapter } from './adapters/codex.ts';
import { discoverCursorMetadata } from './adapters/cursor.ts';
import { captureTarget, spawnTarget, redactError, shutdownOwnedProcesses } from './adapters/process.ts';
import { readGrokQuota } from './grok-quota.ts';
import type { DiscoveryOptions, RuntimeTarget } from '../shared/types.ts';
import type { NativeDiscoveryReply, NativeDiscoveryResult } from './native-discovery-client.ts';

let started = false;
let finishing = false;
let deadlineTimer: NodeJS.Timeout | undefined;
async function finish(result?: NativeDiscoveryResult, error?: unknown) {
  if (finishing) return;
  finishing = true;
  clearTimeout(deadlineTimer);
  let cleaned = false;
  try {
    // Close the spawn gate before awaiting children so cancellation cannot launch a later quota probe.
    await shutdownOwnedProcesses();
    cleaned = true;
  } catch {
    error = new Error('owned-processes-still-running');
  }
  const reply: NativeDiscoveryReply = error ? { error: redactError(error) } : result!;
  process.stdout.write(JSON.stringify(reply) + '\n', () => {
    // On cleanup failure keep the owned helper alive for the parent's existing process-tree termination.
    if (cleaned) process.exit(0);
  });
}

process.on('uncaughtException', (error) => {
  void finish(undefined, error);
});
process.on('unhandledRejection', (error) => {
  void finish(undefined, error);
});
process.on('SIGTERM', () => {
  void finish(undefined, new Error('operation-cancelled'));
});
process.on('SIGINT', () => {
  void finish(undefined, new Error('operation-cancelled'));
});
process.stdin.on('end', () => {
  void finish(undefined, new Error('operation-cancelled'));
});
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  if (started || finishing) return;
  input += chunk;
  if (input.length > 1_048_576) return void finish(undefined, new Error('runtime-protocol-incompatible'));
  const at = input.indexOf('\n');
  if (at < 0) return;
  started = true;
  try {
    const { target, options, expiresAt } = JSON.parse(input.slice(0, at)) as {
      target: RuntimeTarget;
      options?: DiscoveryOptions;
      expiresAt: number;
    };
    if (!['grok', 'claude', 'codex', 'cursor'].includes(target.provider) || !Number.isFinite(expiresAt))
      throw new Error('runtime-protocol-incompatible');
    if (Date.now() >= expiresAt) throw new Error('runtime-timeout');
    // A delayed parent event loop/EOF must not grant a fresh budget to this helper.
    deadlineTimer = setTimeout(() => void finish(undefined, new Error('runtime-timeout')), expiresAt - Date.now());
    // Drain a queued EOF before starting: the parent may have cancelled while this module was loading.
    setImmediate(() => {
      if (finishing) return;
      if (Date.now() >= expiresAt) return void finish(undefined, new Error('runtime-timeout'));
      // Explicit dependencies retain discovery without recursively launching another helper.
      const result =
        target.provider === 'cursor'
          ? discoverCursorMetadata(target, options)
          : (target.provider === 'claude'
              ? createClaudeAdapter({ capture: captureTarget })
              : target.provider === 'codex'
                ? createCodexAdapter({ spawn: spawnTarget })
                : createGrokAdapter({ capture: captureTarget, quota: readGrokQuota })
            )
              .discover(target, options)
              .then((snapshot) => ({ snapshot }));
      void result.then(
        (value) => finish(value),
        (error) => finish(undefined, error),
      );
    });
  } catch (error) {
    void finish(undefined, error);
  }
});
