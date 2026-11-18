import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SHARE_ENV, Worker } from 'node:worker_threads';
import type { DiscoveryOptions, RuntimeSnapshot, RuntimeTarget } from '../shared/types.ts';
import type { CursorUsageIdentity } from './cursor-usage.ts';
import { spawnTarget, terminateProcess, redactError } from './adapters/process.ts';
import { managedNodeRuntime } from './platform/node-runtime.ts';
export { managedNodeRuntime as nativeDiscoveryRuntime } from './platform/node-runtime.ts';

export type NativeDiscoveryResult = { snapshot: RuntimeSnapshot; usageIdentity?: CursorUsageIdentity };
export type NativeDiscoveryReply = Partial<NativeDiscoveryResult> & { error?: string };

export type NativeDiscoveryRequest = { timeoutMs?: number; discovery?: DiscoveryOptions };
type WorkerRequest = { id: string; target: RuntimeTarget; options: NativeDiscoveryRequest } | { type: 'shutdown' };
type WorkerReply =
  { id: string; result?: NativeDiscoveryResult; error?: { message: string; code?: string } } | { type: 'closed' };

/**
 * Creating a process holds the calling thread until the system lets it start. With real-time virus scanning that
 * is the size of the program: about 0.7 s for node.exe on a scanned Windows PC, seven times a minute for seven cards,
 * which stalled every request the backend was serving. The helpers are therefore launched from this one thread.
 */
class DiscoveryHost {
  private worker?: Worker;
  private pending = new Map<string, { resolve: (value: NativeDiscoveryResult) => void; reject: (e: Error) => void }>();
  private closed?: () => void;

  run(target: RuntimeTarget, options: NativeDiscoveryRequest): Promise<NativeDiscoveryResult> {
    const worker = (this.worker ??= this.start());
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      this.pending.set(id, { resolve, reject });
      worker.ref();
      worker.postMessage({ id, target, options } satisfies WorkerRequest);
    });
  }

  private start(): Worker {
    const source = import.meta.filename.endsWith('.ts');
    const entry = new URL(source ? './native-discovery-worker.ts' : './native-discovery-worker.js', import.meta.url)
      .href;
    // An installed PugPort module; the target travels as data.
    const worker = new Worker(
      `const { workerData } = require('node:worker_threads');
      (async () => {
        if (workerData.source) {
          const { tsImport } = await import('tsx/esm/api');
          await tsImport(workerData.entry, workerData.parent);
        } else await import(workerData.entry);
      })().catch(error => { throw error; });`,
      { eval: true, env: SHARE_ENV, workerData: { source, entry, parent: import.meta.url } },
    );
    const lost = () => {
      if (this.worker !== worker) return;
      this.worker = undefined;
      // The helpers see their pipes close and stop by themselves; the next refresh starts a new thread.
      for (const waiting of this.pending.values()) waiting.reject(new Error('runtime-process-closed'));
      this.pending.clear();
      this.closed?.();
    };
    worker.on('message', (reply: WorkerReply) => {
      if ('type' in reply) return void this.closed?.();
      const waiting = this.pending.get(reply.id);
      if (!waiting) return;
      this.pending.delete(reply.id);
      if (!this.pending.size) worker.unref();
      if (reply.result) waiting.resolve(reply.result);
      else
        waiting.reject(
          Object.assign(new Error(reply.error?.message ?? 'runtime-protocol-incompatible'), {
            ...(reply.error?.code ? { code: reply.error.code } : {}),
          }),
        );
    });
    worker.on('error', lost);
    worker.on('exit', lost);
    worker.unref();
    return worker;
  }

  /** Stops the helpers this thread still owns, then the thread. */
  async close(): Promise<void> {
    const worker = this.worker;
    if (!worker) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 10_000);
      this.closed = () => {
        clearTimeout(timer);
        resolve();
      };
      worker.postMessage({ type: 'shutdown' } satisfies WorkerRequest);
    });
    this.closed = undefined;
    if (this.worker === worker) this.worker = undefined;
    await worker.terminate();
  }
}

let host: DiscoveryHost | undefined;
/** The backend turns this on once; tests and the helper thread itself launch helpers directly. */
export function useNativeDiscoveryThread(): void {
  host ??= new DiscoveryHost();
}
export async function closeNativeDiscoveryThread(): Promise<void> {
  const current = host;
  host = undefined;
  await current?.close();
}

/** One fresh helper keeps native CLI metadata launches off the HTTP/event loop. */
export function discoverNativeInHelper(
  target: RuntimeTarget,
  options: NativeDiscoveryRequest = {},
): Promise<NativeDiscoveryResult> {
  return host ? host.run(target, options) : launchNativeDiscoveryHelper(target, options);
}

/** Launches the helper on the calling thread. */
export async function launchNativeDiscoveryHelper(
  target: RuntimeTarget,
  options: NativeDiscoveryRequest = {},
): Promise<NativeDiscoveryResult> {
  if (!['grok', 'claude', 'codex', 'cursor'].includes(target.provider))
    throw new Error('runtime-protocol-incompatible');
  const expiresAt = Date.now() + (options.timeoutMs ?? 90_000);
  const appRoot = fileURLToPath(new URL('../../', import.meta.url));
  const source = import.meta.filename.endsWith('.ts');
  const entry = new URL(source ? './native-discovery-helper.ts' : './native-discovery-helper.js', import.meta.url).href;
  // Only an installed module is executable. The target is sent separately as data, never shell/source text.
  const load = source
    ? `import('tsx/esm/api').then(({tsImport}) => tsImport(${JSON.stringify(entry)}, ${JSON.stringify(import.meta.url)}))`
    : `import(${JSON.stringify(entry)})`;
  const helper = await spawnTarget(
    {
      id: 'native-discovery-helper',
      provider: target.provider,
      label: 'Native metadata',
      command: managedNodeRuntime(appRoot),
      environment: 'native',
      enabled: true,
    },
    ['-e', `${load}.catch(() => { process.exitCode = 1; process.stdin.destroy(); });`],
    { cwd: appRoot, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } },
  );
  let timer: NodeJS.Timeout | undefined;
  try {
    // Process creation and module loading consume the same request budget.
    if (Date.now() >= expiresAt) throw new Error('runtime-timeout');
    return await new Promise<NativeDiscoveryResult>((resolve, reject) => {
      let output = '';
      let settled = false;
      const finish = (error?: Error, result?: NativeDiscoveryResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        error ? reject(error) : resolve(result!);
      };
      timer = setTimeout(() => finish(new Error('runtime-timeout')), Math.max(0, expiresAt - Date.now()));
      helper.stdout.setEncoding('utf8');
      helper.stdout.on('data', (chunk: string) => {
        if (settled) return;
        if (Date.now() >= expiresAt) return finish(new Error('runtime-timeout'));
        output += chunk;
        if (output.length > 1_048_576) return finish(new Error('runtime-protocol-incompatible'));
        const at = output.indexOf('\n');
        if (at < 0) return;
        try {
          const reply = JSON.parse(output.slice(0, at)) as NativeDiscoveryReply;
          if (reply.error) finish(new Error(redactError(reply.error)));
          else if (reply.snapshot?.id === target.id && reply.snapshot.provider === target.provider)
            finish(undefined, { snapshot: reply.snapshot, usageIdentity: reply.usageIdentity });
          else finish(new Error('runtime-protocol-incompatible'));
        } catch {
          finish(new Error('runtime-protocol-incompatible'));
        }
      });
      helper.stderr.resume();
      helper.once('error', (error) => finish(new Error(redactError(error))));
      helper.stdin.once('error', () => finish(new Error('runtime-process-closed')));
      helper.once('close', () => finish(new Error('runtime-process-closed')));
      // Keep stdin open: EOF means cancellation from the existing owned-process shutdown path.
      helper.stdin.write(JSON.stringify({ target, options: options.discovery, expiresAt }) + '\n');
    });
  } finally {
    clearTimeout(timer);
    await terminateProcess(helper);
    if (helper.exitCode === null && helper.signalCode === null)
      throw Object.assign(new Error('owned-processes-still-running'), { code: 'owned-processes-still-running' });
  }
}
