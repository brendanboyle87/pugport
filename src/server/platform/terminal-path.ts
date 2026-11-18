import { currentHost, type Host } from './host.ts';
import { underTest, UnderTestError } from './under-test.ts';
import { powerShellValue, runPowerShell } from './powershell.ts';

type Action = 'status' | 'add' | 'remove';
export type RegistryPath = { raw: string; kind: 'String' | 'ExpandString'; exists: boolean };
export type TerminalPathInfo = {
  folder: string;
  installed: boolean;
  automatic: boolean;
  manualLine?: string;
};
const shellQuote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
export const profileLine =
  'case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) export PATH="$HOME/.local/bin:$PATH";; esac # added by PugPort';

export function registryPathChange(state: RegistryPath, folder: string, action: Action, env: NodeJS.ProcessEnv) {
  const variables = new Map(Object.entries(env).map(([key, value]) => [key.toLowerCase(), value]));
  const key = (value: string) =>
    value
      .replace(/%([^%]+)%/g, (raw, name: string) => variables.get(name.toLowerCase()) ?? raw)
      .replace(/\\+$/, '')
      .toLowerCase();
  const entries = state.raw.split(';');
  const installed = entries.some((entry) => key(entry) === key(folder));
  const value =
    action === 'add' && !installed
      ? state.raw + (state.raw && !state.raw.endsWith(';') ? ';' : '') + folder
      : action === 'remove' && installed
        ? entries.filter((entry) => key(entry) !== key(folder)).join(';')
        : state.raw;
  return {
    value,
    kind: state.exists ? state.kind : ('ExpandString' as const),
    installed,
    changed: value !== state.raw,
  };
}

export const terminalPathReadScript = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
$key = Get-Item HKCU:\\Environment
$raw = [string]$key.GetValue('Path','','DoNotExpandEnvironmentNames')
$exists = $key.GetValueNames() -contains 'Path'
$kind = if ($exists) { $key.GetValueKind('Path') } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }
@{ raw = $raw; kind = $kind.ToString(); exists = $exists } | ConvertTo-Json -Compress
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
`;

export function terminalPathWriteScript(state: RegistryPath, value: string, kind: RegistryPath['kind']) {
  return `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
$writable = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
try {
  $raw = [string]$writable.GetValue('Path','','DoNotExpandEnvironmentNames')
  $exists = $writable.GetValueNames() -contains 'Path'
  $kind = if ($exists) { $writable.GetValueKind('Path').ToString() } else { 'ExpandString' }
  if ($raw -cne ${powerShellValue(state.raw)} -or $exists -ne $${state.exists} -or $kind -cne ${powerShellValue(state.exists ? state.kind : 'ExpandString')}) {
    @{ changedMeanwhile = $true } | ConvertTo-Json -Compress
  } else {
    $writable.SetValue('Path', ${powerShellValue(value)}, [Microsoft.Win32.RegistryValueKind]${powerShellValue(kind)})
    [Environment]::SetEnvironmentVariable('PUGPORT_REFRESH',$null,'User')
    @{ changedMeanwhile = $false } | ConvertTo-Json -Compress
  }
} finally { $writable.Dispose() }
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
`;
}

export function terminalProfile(host: Host = currentHost()) {
  const shell = host.path.basename(host.env.SHELL ?? '');
  const home = host.home;
  if (shell === 'zsh') return host.path.join(home, host.platform === 'darwin' ? '.zprofile' : '.zshrc');
  if (shell === 'bash') {
    if (host.platform !== 'darwin') return host.path.join(home, '.bashrc');
    const bash = host.path.join(home, '.bash_profile');
    return host.fs.existsSync(bash) ? bash : host.path.join(home, '.profile');
  }
}

export function terminalWrapper(root: string, host: Host = currentHost()) {
  return `#!/bin/sh\nexec ${shellQuote(host.path.join(root, 'dist', 'bin', 'pugport'))} "$@"\n`;
}

function readText(file: string, host: Host) {
  try {
    return host.fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

export async function terminalPath(
  root: string,
  action: Action = 'status',
  host: Host = currentHost(),
  powershell = runPowerShell,
): Promise<TerminalPathInfo> {
  // Block readers too: a GET during tests must never reach a real registry or profile.
  if (underTest() && host === currentHost()) throw new UnderTestError('terminal PATH access');
  const folder = host.path.join(root, 'dist', 'bin');
  const target = host.path.join(folder, host.platform === 'win32' ? 'pugport.cmd' : 'pugport');
  const available = host.fs.existsSync(target);
  if (action === 'add' && !available) throw new Error('pugport 终端命令还没有构建。');
  const info = { folder, installed: false, automatic: true };
  if (host.platform === 'win32') {
    const result: RegistryPath = JSON.parse(
      await powershell(terminalPathReadScript, '无法修改 PATH{0}', undefined, 15_000, host),
    );
    const change = registryPathChange(result, folder, action, host.env);
    if (change.changed) {
      const written = JSON.parse(
        await powershell(
          terminalPathWriteScript(result, change.value, change.kind),
          '无法修改 PATH{0}',
          undefined,
          15_000,
          host,
        ),
      );
      if (written.changedMeanwhile) throw new Error('PATH 已被其他程序修改，请重试。');
    }
    return { ...info, installed: available && (action === 'status' ? change.installed : action === 'add') };
  }
  const profile = terminalProfile(host);
  if (!profile)
    return {
      ...info,
      automatic: false,
      manualLine:
        host.path.basename(host.env.SHELL ?? '') === 'fish'
          ? `fish_add_path -- ${shellQuote(folder)}`
          : `export PATH=${shellQuote(folder)}:"$PATH"`,
    };
  const wrapper = host.path.join(host.home, '.local', 'bin', 'pugport');
  const expected = terminalWrapper(root, host);
  const contents = readText(profile, host);
  const marked = contents.split(/\r?\n/).includes(profileLine);
  const wrapperContents = readText(wrapper, host);
  const ownWrapper = /^#!\/bin\/sh\nexec '.*\/dist\/bin\/pugport' "\$@"\n$/.test(wrapperContents);
  if (action === 'add') {
    if (!ownWrapper && host.fs.existsSync(wrapper)) throw new Error('pugport 命令已被其他安装占用。');
    await host.fs.promises.mkdir(host.path.dirname(wrapper), { recursive: true });
    // Unlink first so even a dangling symlink cannot redirect the write.
    await host.fs.promises.unlink(wrapper).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    await host.fs.promises.writeFile(wrapper, expected, { mode: 0o755 });
    await host.fs.promises.chmod(wrapper, 0o755);
    if (!marked)
      await host.fs.promises.appendFile(profile, `${contents && !contents.endsWith('\n') ? '\n' : ''}${profileLine}\n`);
  } else if (action === 'remove') {
    if (ownWrapper) await host.fs.promises.unlink(wrapper);
    if (marked)
      await host.fs.promises.writeFile(
        profile,
        contents
          .split(/(?<=\n)/)
          .filter((line) => line.replace(/\r?\n$/, '') !== profileLine)
          .join(''),
      );
  }
  return {
    ...info,
    installed: available && (action === 'status' ? wrapperContents === expected && marked : action === 'add'),
  };
}
