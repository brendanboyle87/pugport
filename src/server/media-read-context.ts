import { AsyncLocalStorage } from 'node:async_hooks';
import { stat } from 'node:fs/promises';
import type { MediaDecoder } from './media-decoder.ts';

async function stamp(path: string) {
  const info = await stat(path, { bigint: true });
  if (!info.isFile()) throw new Error('Staged media is not a regular file.');
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
}
type Route = { path: string; stamp: string; originalStamp?: string };

/** Redirect only physical frame reads. Checkpoint keys and evidence still use the original paths. */
export class MediaReadContext {
  private routes = new AsyncLocalStorage<ReadonlyMap<string, Route>>();
  async run<T>(
    original: readonly string[],
    local: readonly string[],
    read: () => Promise<T>,
    trustedIdentities?: readonly string[],
    trustedOriginalIdentities?: readonly string[],
  ) {
    if (original.length !== local.length) throw new Error('Invalid staged media routes.');
    const routes = new Map<string, Route>();
    for (const [index, path] of original.entries()) {
      const target = local[index]!;
      if (target !== path || trustedOriginalIdentities) {
        const current = await stamp(target);
        if (trustedIdentities && trustedIdentities[index] !== current)
          throw new Error('Staged media changed before frame routing.');
        routes.set(path, {
          path: target,
          stamp: trustedIdentities?.[index] ?? current,
          originalStamp: trustedOriginalIdentities?.[index],
        });
      }
    }
    return this.routes.run(routes, read);
  }
  expectedOriginalIdentity(path: string) {
    return this.routes.getStore()?.get(path)?.originalStamp;
  }
  decoder(base: MediaDecoder): MediaDecoder {
    return {
      description: base.description,
      cacheIdentity: base.cacheIdentity,
      image: (path, signal) => base.image(path, signal),
      probe: (path, signal) => base.probe(path, signal),
      frame: async (path, time, signal) => {
        const route = this.routes.getStore()?.get(path);
        if (!route || route.path === path) return base.frame(path, time, signal);
        signal.throwIfAborted();
        if ((await stamp(route.path)) !== route.stamp) throw new Error('Staged media changed before frame read.');
        const frame = await base.frame(route.path, time, signal);
        signal.throwIfAborted();
        if ((await stamp(route.path)) !== route.stamp) throw new Error('Staged media changed during frame read.');
        return frame;
      },
      ...(base.compareImages
        ? { compareImages: (a: string, b: string, signal: AbortSignal) => base.compareImages!(a, b, signal) }
        : {}),
    };
  }
}
