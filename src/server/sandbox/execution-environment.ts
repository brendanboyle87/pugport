import { homedir } from 'node:os';
import { win32 as path } from 'node:path';
import { environmentValue } from './provider-profiles.ts';

/** Fill only Windows system variables; never restore removed account/provider credentials. */
export function mxcExecutionEnvironment(
  source: NodeJS.ProcessEnv,
  hostEnvironment: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): NodeJS.ProcessEnv {
  const env = { ...source };
  const value = (values: NodeJS.ProcessEnv, name: string) => environmentValue(values, name)?.trim() || undefined;
  const existing = (name: string) => value(source, name);
  const host = (name: string) => value(hostEnvironment, name);
  const systemRoot =
    existing('SystemRoot') ?? existing('WINDIR') ?? host('SystemRoot') ?? host('WINDIR') ?? 'C:\\Windows';
  const userProfile = existing('USERPROFILE') ?? host('USERPROFILE') ?? home;
  const localAppData = existing('LOCALAPPDATA') ?? host('LOCALAPPDATA') ?? path.join(userProfile, 'AppData', 'Local');
  const explicitTemp = existing('TEMP') ?? existing('TMP') ?? existing('TMPDIR');
  const temp = explicitTemp ?? host('TEMP') ?? host('TMP') ?? host('TMPDIR') ?? path.join(localAppData, 'Temp');
  const defaults: NodeJS.ProcessEnv = {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    LOCALAPPDATA: localAppData,
    APPDATA: host('APPDATA') ?? path.join(userProfile, 'AppData', 'Roaming'),
    USERPROFILE: userProfile,
    HOMEDRIVE: host('HOMEDRIVE') ?? path.parse(userProfile).root.replace(/\\$/, ''),
    HOMEPATH: host('HOMEPATH') ?? userProfile.slice(path.parse(userProfile).root.length - 1),
    COMSPEC: host('COMSPEC') ?? path.join(systemRoot, 'System32', 'cmd.exe'),
    PATH:
      host('PATH') ??
      [path.join(systemRoot, 'System32'), systemRoot, path.join(systemRoot, 'System32', 'Wbem')].join(';'),
    PATHEXT: host('PATHEXT') ?? '.COM;.EXE;.BAT;.CMD',
    TEMP: explicitTemp ?? host('TEMP') ?? temp,
    TMP: explicitTemp ?? host('TMP') ?? temp,
    TMPDIR: explicitTemp ?? host('TMPDIR') ?? temp,
  };
  for (const [name, fallback] of Object.entries(defaults)) {
    if (existing(name)) continue;
    for (const key of Object.keys(env)) if (key.toLowerCase() === name.toLowerCase()) delete env[key];
    env[name] = fallback;
  }
  return env;
}
