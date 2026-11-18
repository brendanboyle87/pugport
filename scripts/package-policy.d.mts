export type PackageTarget = { platform: string; arch: string };
export function packageTarget(argv?: string[], host?: { platform: string; arch: string }): PackageTarget;
export function packageLayout(directory: string): {
  platform: 'darwin' | 'win32';
  bundle: string | undefined;
  resources: string;
  app: string;
  executable: string;
  electronLicense: string;
  chromiumLicense: string;
};
export function packageIgnore(path: string, target?: PackageTarget): boolean;
export function localComponentsRequested(argv?: string[]): boolean;
export function copyLocalComponents(root: string, output: string, options?: { includeComponents?: boolean }): string[];
