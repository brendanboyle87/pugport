import { stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ContainerRequest } from '@microsoft/mxc-sdk/v1';

const pathLists = ['readonlyPaths', 'readwritePaths', 'deniedPaths'] as const;
type PathMetadata = (path: string) => Promise<{ isDirectory(): boolean }>;

/** SDK 1.0.0 creation-request arrays are optional; its mapper recreates some as [].
 * Apply only to creation requests/wire payloads, never results with required arrays. */
export function omitEmptyOptionalArrays<T>(request: T): T {
  if (Array.isArray(request)) return request.map((item) => omitEmptyOptionalArrays(item)) as T;
  if (!request || typeof request !== 'object') return request;
  return Object.fromEntries(
    Object.entries(request)
      .filter(([, value]) => !Array.isArray(value) || value.length > 0)
      .map(([key, value]) => [key, omitEmptyOptionalArrays(value)]),
  ) as T;
}

/** Metadata only. Missing optional paths cannot be submitted to the native path mapper. */
export async function filterHostRequest<T extends ContainerRequest>(
  request: T,
  metadata: PathMetadata = stat,
): Promise<T> {
  const requireDirectory = async (path: string, reason: string) => {
    try {
      if (path && (await metadata(path)).isDirectory()) return;
    } catch {
      // Reject unreadable required locations without exposing host paths in the error.
    }
    throw Object.assign(new Error(reason), { code: reason });
  };
  if (request.workingDirectory !== undefined)
    await requireDirectory(request.workingDirectory, 'sandbox-invalid-working-directory');
  const outputPath =
    request.containment?.type === 'processcontainer'
      ? request.containment.config?.captureDenials?.outputPath
      : undefined;
  if (outputPath !== undefined)
    await requireDirectory(outputPath ? dirname(outputPath) : '', 'sandbox-invalid-denial-output-parent');
  if (!request.filesystem) return omitEmptyOptionalArrays(request);
  const filesystem = { ...request.filesystem };
  for (const key of pathLists) {
    if (filesystem[key] === undefined) continue;
    const existing: string[] = [];
    for (const path of filesystem[key]) {
      try {
        await metadata(path);
        existing.push(path);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR')
          throw Object.assign(new Error('sandbox-path-metadata-failed'), { code: 'sandbox-path-metadata-failed' });
      }
    }
    filesystem[key] = existing;
  }
  return omitEmptyOptionalArrays({ ...request, filesystem });
}
