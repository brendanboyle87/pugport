export function underTest(): boolean;
export function testDirectory(): string;
export function allowTestTool(file: string | undefined): void;
export function testProcessEnv(command: string, env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function testProcessArgs(command: string, args: readonly string[], env?: NodeJS.ProcessEnv): string[];
export function insideDirectory(file: string, directory: string): boolean;
export function canonicalTestPath(file: string): string;
export function testPath(file: string): boolean;
export function isolatedUserPath(file: string): string;
export class UnderTestError extends Error {
  constructor(kind: string);
}
export function assertTestProcess(
  command: string,
  args?: readonly string[],
  launcher?: boolean,
  env?: NodeJS.ProcessEnv,
): string;
export function assertTestUrl(input: string | URL): void;
