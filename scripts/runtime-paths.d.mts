export function userRuntimeRoot(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, home?: string): string;
export function runtimeRoot(appRoot: string, env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): string;
export function runtimeDirectories(
  appRoot: string,
  component: string,
  env?: NodeJS.ProcessEnv,
  platform?: NodeJS.Platform,
): string[];
