import express, { type Express } from 'express';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { safeUiAsset, uiBuildIdPattern, type UiReleaseManifest, type UiReleaseStatus } from '../shared/ui-release.ts';

declare const __PUGPORT_UI_COMPATIBILITY__: string;
declare const __PUGPORT_UI_BASELINE_BUILD_ID__: string;

const compiledCompatibility = typeof __PUGPORT_UI_COMPATIBILITY__ === 'string' ? __PUGPORT_UI_COMPATIBILITY__ : '';
const compiledBaseline = typeof __PUGPORT_UI_BASELINE_BUILD_ID__ === 'string' ? __PUGPORT_UI_BASELINE_BUILD_ID__ : '';
const manifestSchema = z.object({
  schema: z.literal(1),
  buildId: z.string().regex(uiBuildIdPattern),
  compatibility: z.string().regex(/^[a-f0-9]{64}$/),
  previousBuildId: z.string().regex(uiBuildIdPattern).optional(),
  assets: z.array(z.string().refine(safeUiAsset)).min(1).max(20000),
});

function containedFile(directory: string, path: string): string | undefined {
  if (!safeUiAsset(path)) return;
  try {
    const root = realpathSync(directory);
    const file = realpathSync(join(root, path));
    const child = relative(root, file);
    if (!child || child.startsWith('..') || isAbsolute(child) || !statSync(file).isFile()) return;
    return file;
  } catch {
    return;
  }
}

/** A running backend accepts only the contract that was compiled into that process. */
export class UiReleases {
  readonly directory: string;
  readonly legacyDirectory: string;

  constructor(
    root: string,
    readonly compatibility = compiledCompatibility,
    readonly baselineBuildId = compiledBaseline,
  ) {
    this.directory = resolve(root, 'dist/ui-releases');
    this.legacyDirectory = resolve(root, 'dist/ui');
  }

  release(buildId: string): { manifest: UiReleaseManifest; directory: string } | undefined {
    if (!this.compatibility || !uiBuildIdPattern.test(buildId)) return;
    const versioned = join(this.directory, buildId);
    const directory = buildId === this.baselineBuildId && !existsSync(versioned) ? this.legacyDirectory : versioned;
    try {
      if (directory !== this.legacyDirectory) {
        const actual = realpathSync(directory);
        const child = relative(realpathSync(this.directory), actual);
        if (!child || child.startsWith('..') || isAbsolute(child)) return;
      }
      const path = containedFile(directory, 'ui-release.json');
      if (!path || statSync(path).size > 2_000_000) return;
      const manifest = manifestSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
      if (
        manifest.buildId !== buildId ||
        manifest.compatibility !== this.compatibility ||
        !manifest.assets.includes('index.html') ||
        !containedFile(directory, 'index.html')
      )
        return;
      return { manifest, directory };
    } catch {
      return;
    }
  }

  active() {
    try {
      const path = join(this.directory, 'active.json');
      if (statSync(path).size < 1024) {
        const active = JSON.parse(readFileSync(path, 'utf8')) as { buildId: string };
        const release = typeof active.buildId === 'string' ? this.release(active.buildId) : undefined;
        if (release) return release;
      }
    } catch {}
    return this.release(this.baselineBuildId);
  }

  status(): UiReleaseStatus {
    const release = this.active();
    return release
      ? {
          buildId: release.manifest.buildId,
          compatibility: release.manifest.compatibility,
          previousBuildId: release.manifest.previousBuildId,
          enabled: true,
        }
      : { buildId: 'legacy', compatibility: this.compatibility || 'development', enabled: false };
  }

  fallback(buildId: string) {
    const current = this.release(buildId);
    if (!current || buildId === this.baselineBuildId) return;
    const previous = current.manifest.previousBuildId;
    const fallback = previous && previous !== buildId ? this.release(previous) : undefined;
    return fallback ?? this.release(this.baselineBuildId);
  }

  asset(buildId: string, asset: string) {
    const release = this.release(buildId);
    if (!release || !release.manifest.assets.includes(asset) || asset === 'ui-release.json') return;
    return containedFile(release.directory, asset);
  }
}

// Register after the existing host/origin/session-token middleware and JSON parser.
export function uiReleaseRoutes(app: Express, releases: UiReleases) {
  app.get('/api/ui-release', (_req, res) => res.set('Cache-Control', 'no-store').json(releases.status()));
  app.post('/api/ui-release/fallback', (req, res) => {
    const { buildId } = z
      .object({ buildId: z.string().regex(uiBuildIdPattern) })
      .strict()
      .parse(req.body);
    const fallback = releases.fallback(buildId);
    if (!fallback) {
      res.status(409).json({ error: 'No compatible earlier UI is available.' });
      return;
    }
    const { compatibility, previousBuildId } = fallback.manifest;
    const fallbackId = fallback.manifest.buildId;
    res.set('Cache-Control', 'no-store').json({
      buildId: fallbackId,
      compatibility,
      previousBuildId,
      enabled: true,
      url: `/?uiBuild=${fallbackId}`,
    });
  });
}

export function serveUiReleases(app: Express, releases: UiReleases) {
  app.use('/ui-releases', (req, res) => {
    let path: string;
    try {
      path = decodeURIComponent(req.path);
    } catch {
      res.sendStatus(400);
      return;
    }
    const [buildId, ...parts] = path.slice(1).split('/');
    const asset = parts.join('/');
    const file =
      ['GET', 'HEAD'].includes(req.method) && safeUiAsset(asset) ? releases.asset(buildId, asset) : undefined;
    if (!file || asset === 'index.html') {
      res.sendStatus(404);
      return;
    }
    res.set('Cache-Control', 'public, max-age=31536000, immutable').sendFile(file);
  });
  app.get(['/', '/index.html'], (req, res, next) => {
    const requested = req.query.uiBuild;
    if (requested !== undefined && (typeof requested !== 'string' || !uiBuildIdPattern.test(requested))) {
      res.status(400).send('Invalid UI release.');
      return;
    }
    const release = typeof requested === 'string' ? releases.release(requested) : releases.active();
    if (requested !== undefined && !release) {
      res.status(404).send('UI release is unavailable.');
      return;
    }
    res.set('Cache-Control', 'no-store');
    if (release) res.sendFile(join(release.directory, 'index.html'));
    else if (releases.compatibility) res.status(503).send('No compatible UI build is available. Run npm run build.');
    else next();
  });
  // Old windows keep their baseline asset URLs while newer windows use immutable release URLs.
  app.use(express.static(releases.legacyDirectory, { index: false }));
  app.get('/', (_req, res) => {
    const legacy = containedFile(releases.legacyDirectory, 'index.html');
    if (legacy) res.set('Cache-Control', 'no-store').sendFile(legacy);
    else res.status(503).send('UI has not been built. Run npm run build.');
  });
}
