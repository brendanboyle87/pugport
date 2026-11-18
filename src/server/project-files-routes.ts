import { opendir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { Express } from 'express';
const ignored = new Set(
  [
    'node_modules',
    '.git',
    '.svn',
    '.hg',
    '__pycache__',
    '.pytest_cache',
    '.mypy_cache',
    '.venv',
    '.next',
    '.nuxt',
    '.turbo',
    '.parcel-cache',
    '.gradle',
    '.cache',
    '$Recycle.Bin',
  ].map((name) => name.toLowerCase()),
);

export type ProjectFile = { path: string; kind: 'file' | 'folder' };
const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};
function score(path: string, query: string): number {
  const value = path.toLowerCase();
  const direct = value.indexOf(query);
  if (direct >= 0) return direct;
  let position = -1;
  for (const char of query) {
    position = value.indexOf(char, position + 1);
    if (position < 0) return Infinity;
  }
  return value.length + 100;
}

/** Bounded traversal, without following symlinks/junctions, including links back into the root. */
async function walkProjectFiles(root: string): Promise<ProjectFile[]> {
  const pending = [{ path: root, depth: 0 }];
  const found: ProjectFile[] = [];
  let visited = 0;
  // shortcut: scan at most 10000 entries in 1.5s; use an index if larger trees need complete coverage.
  const deadline = Date.now() + 1500;
  while (pending.length && visited < 10000 && Date.now() < deadline) {
    const directory = pending.shift()!;
    try {
      if (!inside(root, await realpath(directory.path))) continue;
      const entries = await opendir(directory.path);
      const children: typeof pending = [];
      for await (const entry of entries) {
        if (++visited > 10000 || Date.now() >= deadline) break;
        if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) continue;
        const absolute = join(directory.path, entry.name);
        const path = relative(root, absolute).split(sep).join('/');
        if (
          entry.isDirectory() &&
          (ignored.has(entry.name.toLowerCase()) ||
            /(?:^|\/)\.claude\/worktrees$/i.test(path) ||
            /\/AppData\/Local\/Temp$/i.test(absolute.split(sep).join('/')))
        )
          continue;
        found.push({ path, kind: entry.isDirectory() ? 'folder' : 'file' });
        if (entry.isDirectory() && directory.depth < 32) children.push({ path: absolute, depth: directory.depth + 1 });
      }
      // Directory enumeration order varies by filesystem. Keep the bounded breadth-first scan deterministic.
      pending.push(...children.sort((a, b) => a.path.localeCompare(b.path)));
    } catch {
      // Unreadable or concurrently removed directories do not break the picker.
    }
  }
  return found;
}

const listings = new Map<string, { until: number; files: Promise<ProjectFile[]> }>();
export async function listProjectFiles(rootPath: string, query = ''): Promise<ProjectFile[]> {
  const root = await realpath(rootPath);
  const now = Date.now();
  for (const [key, entry] of listings) if (entry.until <= now) listings.delete(key);
  let cached = listings.get(root);
  if (!cached) {
    if (listings.size >= 32) listings.delete(listings.keys().next().value!);
    cached = { until: now + 5000, files: walkProjectFiles(root) };
    listings.set(root, cached);
  }
  const wanted = query.slice(0, 200).toLowerCase().replaceAll('\\', '/');
  return (await cached.files)
    .map((entry) => ({ ...entry, score: score(entry.path, wanted) }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((a, b) => a.score - b.score || a.path.localeCompare(b.path))
    .slice(0, 50)
    .map(({ score: _score, ...entry }) => entry);
}

export function registerProjectFilesRoutes(app: Express, project: (id: string) => { path: string } | undefined) {
  app.get('/api/projects/:id/files', async (req, res) => {
    const selected = project(req.params.id);
    if (!selected) return void res.status(404).json({ error: 'Project not found' });
    try {
      res.json(await listProjectFiles(selected.path, typeof req.query.q === 'string' ? req.query.q : ''));
    } catch {
      res.status(400).json({ error: 'Project directory unavailable' });
    }
  });
}
