export interface UiReleaseStatus {
  buildId: string;
  compatibility: string;
  enabled: boolean;
  previousBuildId?: string;
}

export interface UiReleaseFallback extends UiReleaseStatus {
  url: string;
}

export interface UiReleaseManifest {
  schema: 1;
  buildId: string;
  compatibility: string;
  previousBuildId?: string;
  assets: string[];
}

export const uiBuildIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;

export function safeUiAsset(path: string): boolean {
  return (
    path.length > 0 &&
    path.length < 1024 &&
    !/[\\:%\x00-\x1f\x7f?#]/.test(path) &&
    path.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..' && !part.startsWith('.'))
  );
}
