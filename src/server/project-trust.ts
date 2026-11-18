import { isAbsolute, relative, resolve, sep, parse, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { realpathSync } from 'node:fs';
import { z } from 'zod';
import type { Project } from '../shared/types.ts';
import { trustedDirectory } from './platform/trusted-path.ts';
import { userFolders } from './platform/dirs.ts';

export const projectMcpServersSchema = z
  .array(z.string().min(1).max(128))
  .max(256)
  .refine((ids) => new Set(ids).size === ids.length);

export const projectPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    trusted: z.literal(false).optional(),
    mcpServers: projectMcpServersSchema.nullable().optional(),
  })
  .strict()
  .refine((patch) => patch.name !== undefined || patch.trusted !== undefined || patch.mcpServers !== undefined);

function canonical(path: string) {
  let result = resolve(path);
  try {
    result = realpathSync.native(result);
  } catch {
    // A not-yet-created project keeps a lexical boundary, below the real location of its parent (macOS /var).
    try {
      result = trustedDirectory(result);
    } catch {
      /* An unreadable parent keeps the lexical path. */
    }
  }
  return process.platform === 'win32' ? result.toLowerCase() : result;
}

export function canTrustPath(path: string, dataDir?: string): boolean {
  return canTrustCanonicalPath(path, dataDir, canonical);
}

function canTrustCanonicalPath(
  path: string,
  dataDir: string | undefined,
  canonical: (path: string) => string,
): boolean {
  const target = canonical(path);
  return (
    target !== canonical(parse(target).root) &&
    [homedir(), ...(dataDir ? [dataDir] : [])].every((protectedPath) => {
      const child = relative(target, canonical(protectedPath));
      return child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child);
    })
  );
}

function contains(base: string, target: string) {
  const child = relative(base, target);
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

export function projectTrusted(project: Project, dataDir?: string): boolean {
  return projectTrustedWith(project, dataDir, canonical);
}

/** Share filesystem resolutions within one display snapshot, never across authorization checks. */
export function projectTrustReader(dataDir?: string) {
  const paths = new Map<string, string>();
  return (project: Project) =>
    projectTrustedWith(project, dataDir, (path) => {
      if (!paths.has(path)) paths.set(path, canonical(path));
      return paths.get(path)!;
    });
}

function projectTrustedWith(
  project: Project,
  dataDir: string | undefined,
  canonical: (path: string) => string,
): boolean {
  if (project.scope === 'chat' || project.trusted === false) return false;
  if (!canTrustCanonicalPath(project.path, dataDir, canonical)) return false;
  if (project.trusted === true) return true;
  const target = canonical(project.path);
  const home = canonical(homedir());
  const segment = relative(home, target).split(sep)[0]?.toLowerCase() ?? '';
  if (contains(home, target) && (segment.startsWith('.') || segment === 'appdata')) return false;
  if (
    [userFolders().documents, ...(process.env.OneDrive ? [join(process.env.OneDrive, 'Documents')] : [])].some(
      (path) => canonical(path) === target,
    )
  )
    return false;
  return ![userFolders().downloads, tmpdir(), ...(dataDir ? [dataDir] : [])].some((path) =>
    contains(canonical(path), target),
  );
}

/** The most specific registered project owns the trust decision. */
export function isTrustedPath(path: string, projects: readonly Project[], dataDir?: string): boolean {
  const candidate = canonical(path);
  let best: Project | undefined;
  let length = -1;
  for (const project of projects) {
    // A project removed from PugPort neither grants trust nor shields a folder.
    if (project.removedAt) continue;
    const root = canonical(project.path);
    if (root.length > length && contains(root, candidate)) {
      best = project;
      length = root.length;
    }
  }
  return !!best && projectTrusted(best, dataDir);
}
