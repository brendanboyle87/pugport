import { underTest, UnderTestError } from '../platform/under-test.ts';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { ContainerRequest } from '@microsoft/mxc-sdk/v1';
import type { MxcDriver } from './mxc-child.ts';
import { filterHostRequest, omitEmptyOptionalArrays } from './host-request.ts';
import { mxcExecutionEnvironment } from './execution-environment.ts';
import {
  captureDenialsStreamingSupported,
  captureDenialsStreamingUnavailableReason,
} from '../../shared/sandbox-capabilities.ts';

export const reviewedSdkVersion = '1.0.0';
let sdkVersion: Promise<string> | undefined;

/** Package metadata only; the backend receives this value through the helper probe. */
export function installedMxcSdkVersion(): Promise<string> {
  return (sdkVersion ??= readFile(fileURLToPath(import.meta.resolve('@microsoft/mxc-sdk/package.json')), 'utf8').then(
    (text) => {
      const version: unknown = JSON.parse(text).version;
      if (typeof version !== 'string') throw new Error('sandbox-sdk-version-invalid');
      return version;
    },
  ));
}

/** Only the dedicated helper process may call these in-process SDK APIs. */
export async function probeMxc() {
  const sdkVersion = await installedMxcSdkVersion();
  const sdk = await import('@microsoft/mxc-sdk/v1');
  const result = sdk.probe();
  return {
    sdkVersion,
    tier: result.tier,
    probes: { baseContainerSupportsDenyPaths: result.probes?.baseContainerSupportsDenyPaths === true },
  };
}

/** The reviewed SDK's public mapper drops fallback. Its private wire mapper is needed
 * only to set fallback.allowDaclMutation=false; the version pin is tested, not a runtime gate. */
export async function prepareMxcRequest(request: ContainerRequest) {
  const filtered = await filterHostRequest({
    ...request,
    environment: mxcExecutionEnvironment(request.environment ?? {}),
  });
  const entry = import.meta.resolve('@microsoft/mxc-sdk/v1');
  const mapper = await import(new URL('./container.js', entry).href);
  const wire = mapper.prepareContainerRequest(filtered, { enabled: false });
  wire.fallback = { allowDaclMutation: false };
  return omitEmptyOptionalArrays<typeof wire>(wire);
}

export async function spawnMxcProcess(request: ContainerRequest): Promise<MxcDriver> {
  if (request.containment?.type === 'processcontainer' && request.containment.config?.captureDenials !== undefined) {
    const version = await installedMxcSdkVersion();
    if (!captureDenialsStreamingSupported(version))
      throw Object.assign(new Error(captureDenialsStreamingUnavailableReason(version)), {
        code: 'sandbox-learning-unavailable',
      });
  }
  if (underTest()) throw new UnderTestError('native sandbox process');
  const wire = await prepareMxcRequest(request);
  const entry = import.meta.resolve('@microsoft/mxc-sdk/v1');
  const streaming = await import(new URL('../bindings/streaming.js', entry).href);
  return streaming.spawnBindingSandboxProcess(wire, false);
}
