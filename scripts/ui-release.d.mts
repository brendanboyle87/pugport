import type { InlineConfig } from 'vite';
import type { UiReleaseManifest } from '../src/shared/ui-release.ts';

type Release = Pick<UiReleaseManifest, 'buildId' | 'compatibility' | 'previousBuildId'>;
export function newUiBuildId(): string;
export function checkedUiStaging(root: string, staging: string, buildId: string): Promise<string>;
export function uiCompatibility(root: string): Promise<string>;
export function writeJsonAtomic(path: string, value: unknown): Promise<void>;
export function requireUiBaseline(
  root: string,
  compatibility: string,
): Promise<Release & { runtimeHashes: Record<string, string> }>;
export function uiBootstrap(buildId: string, compatibility: string): void;
export function finishUiDirectory(directory: string, release: Release): Promise<UiReleaseManifest>;
export function saveUiBaseline(root: string, release: Release, staging: string): Promise<void>;
export function buildUiOnly(root: string, viteBuild: (options: InlineConfig) => Promise<unknown>): Promise<Release>;
