import { win32 } from 'node:path';

const CMD_UNSAFE = /[&|<>^%!"\r\n\0]/;
export function windowsWrapperCommand(command: string, args: string[]): string {
  const parts = [command, ...args];
  if (parts.some((part) => CMD_UNSAFE.test(part))) throw new Error('unsafe-wrapper-argument');
  return `"${parts.map((part) => `"${part}"`).join(' ')}"`;
}
/** Windows CommandLineToArgvW quoting. CMD wrappers retain the existing stricter validation. */
export function commandLine(command: string, args: string[], systemRoot = 'C:\\Windows'): string {
  if ([command, ...args].some((part) => /[\0\r\n]/.test(part))) throw new Error('unsafe-wrapper-argument');
  if (/\.ps1$/i.test(command)) throw new Error('unsupported-runtime-wrapper');
  if (/\.(cmd|bat)$/i.test(command))
    return `"${win32.join(systemRoot, 'System32', 'cmd.exe')}" /d /s /c ${windowsWrapperCommand(command, args)}`;
  // Quote only where needed, as Node does: programs with their own parsing (cmd.exe /c) ignore quoted switches.
  const quote = (part: string) =>
    part && !/[\s"]/.test(part) ? part : `"${part.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
  return [`"${command}"`, ...args.map(quote)].join(' ');
}
