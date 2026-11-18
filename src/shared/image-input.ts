import { providerSpec } from './provider-registry.ts';
import type { RuntimeSnapshot } from './types.ts';

/** Describes this adapter's connected input channel, not the model vendor's general vision support. */
export function supportsImageInput(
  runtime: Pick<RuntimeSnapshot, 'provider' | 'environment' | 'gateway' | 'capabilities'> | undefined,
): boolean {
  if (!runtime) return false;
  if (typeof runtime.capabilities.imageInput === 'boolean') return runtime.capabilities.imageInput;
  // Keep saved Codex/Claude discoveries compatible; other channels must report verified support.
  return runtime.environment === 'native' && !runtime.gateway && !!providerSpec(runtime.provider)?.nativeVision;
}
