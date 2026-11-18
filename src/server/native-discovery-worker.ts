import { parentPort } from 'node:worker_threads';
import type { RuntimeTarget } from '../shared/types.ts';
import { shutdownOwnedProcesses } from './adapters/process.ts';
import { launchNativeDiscoveryHelper, type NativeDiscoveryRequest } from './native-discovery-client.ts';

// The thread that launches discovery helpers, so creating those processes never holds the backend's event loop.
type Request = { id: string; target: RuntimeTarget; options: NativeDiscoveryRequest } | { type: 'shutdown' };

parentPort!.on('message', (request: Request) => {
  if ('type' in request) {
    // Also closes the spawn gate, so a request already queued cannot launch after shutdown.
    const closed = () => parentPort!.postMessage({ type: 'closed' });
    void shutdownOwnedProcesses().then(closed, closed);
    return;
  }
  void launchNativeDiscoveryHelper(request.target, request.options).then(
    (result) => parentPort!.postMessage({ id: request.id, result }),
    (error: unknown) =>
      parentPort!.postMessage({
        id: request.id,
        error: {
          message: error instanceof Error ? error.message : String(error),
          code: (error as NodeJS.ErrnoException | undefined)?.code,
        },
      }),
  );
});
