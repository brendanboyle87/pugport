import { appDirs } from './dirs.ts';
import { searchDirs } from './executables.ts';
import { currentHost, type Host } from './host.ts';

/*
 * Keeping a headless device node running: a systemd user service on Linux, a LaunchAgent on macOS.
 */

export type NodeServiceSpec = {
  /** The Node runtime and the backend bundle it runs. */
  runtime: string;
  script: string;
  workingDirectory: string;
  dataDir?: string;
  /** Folders for PATH, in order; services start with almost nothing on PATH. */
  path: string[];
  /** The runtime is the PugPort (Electron) executable, which acts as Node only with ELECTRON_RUN_AS_NODE=1. */
  electron?: boolean;
  /** Further variables, e.g. PUGPORT_PEER_PORT. */
  env?: Record<string, string>;
};

/** The first line of every file written here: uninstall removes only a file that starts with it. */
export const serviceMarker = '# Written by `pugport node install`; `pugport node uninstall` removes it.';
export const systemdUnitName = 'pugport-node.service';
export const launchAgentLabel = 'com.pugport.node';

export function systemdUnitPath(host: Host = currentHost()) {
  return host.path.join(appDirs(host).userConfig, 'systemd', 'user', systemdUnitName);
}
export function launchAgentPath(host: Host = currentHost()) {
  return host.path.join(host.home, 'Library', 'LaunchAgents', `${launchAgentLabel}.plist`);
}
export function launchAgentLog(host: Host = currentHost()) {
  return host.path.join(host.home, 'Library', 'Logs', 'PugPort', 'node.log');
}

const unsafe = /[\0\r\n]/;
function checked(value: string, what: string) {
  if (unsafe.test(value)) throw new Error(`${what} 里有换行或空字符，不能写进服务文件。`);
  return value;
}

/**
 * One systemd word: always double-quoted, with backslashes and quotes escaped, `%` doubled (specifiers) and, in
 * command lines, `$` doubled (variable expansion), so a path is passed exactly as it is.
 */
export function systemdWord(value: string, command = false) {
  let text = checked(value, '路径').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%');
  if (command) text = text.replace(/\$/g, '$$$$');
  return `"${text}"`;
}

/** A setting that takes the rest of the line as a path, unquoted (WorkingDirectory=). */
function systemdPath(value: string) {
  if (checked(value, '路径') !== value.trim()) throw new Error('路径首尾不能有空格。');
  return value.replace(/%/g, '%%');
}

const variableName = /^[A-Za-z_][A-Za-z0-9_]*$/;
function environment(spec: NodeServiceSpec): [string, string][] {
  const pairs: [string, string][] = [
    ['PUGPORT_ROLE', 'node'],
    ...(spec.dataDir !== undefined ? ([['COMBORUNNER_DATA_DIR', spec.dataDir]] as [string, string][]) : []),
    ['PATH', spec.path.join(':')],
    ...(spec.electron ? ([['ELECTRON_RUN_AS_NODE', '1']] as [string, string][]) : []),
    ...Object.entries(spec.env ?? {}),
  ];
  for (const [name, value] of pairs) {
    if (!variableName.test(name)) throw new Error(`环境变量名不对：${name}`);
    checked(value, name);
  }
  return pairs;
}

/** PATH for the service: the runtime's own folder, PATH as it is now, the usual tool folders, then the system's. */
export function servicePath(runtime: string, host: Host = currentHost()): string[] {
  const current = (host.env.PATH ?? '').split(':');
  const system = ['/usr/local/bin', '/usr/bin', '/bin'];
  return [
    ...new Set(
      [host.path.dirname(runtime), ...current, ...searchDirs(host), ...system].filter(
        (dir) => dir && host.path.isAbsolute(dir) && !dir.includes(':') && !unsafe.test(dir),
      ),
    ),
  ];
}

export function systemdUnit(spec: NodeServiceSpec): string {
  const env = environment(spec)
    .map(([name, value]) => `Environment=${systemdWord(`${name}=${value}`)}`)
    .join('\n');
  return `${serviceMarker}
[Unit]
Description=PugPort device node
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${systemdPath(spec.workingDirectory)}
ExecStart=${systemdWord(spec.runtime, true)} ${systemdWord(spec.script, true)}
${env}
Restart=on-failure
RestartSec=10
# The whole cgroup (backend and every CLI, even detached ones) stops together: no orphaned CLIs on the node.
KillMode=control-group
# Covers the backend's ~40 s graceful shutdown.
TimeoutStopSec=60
SyslogIdentifier=pugport-node

[Install]
WantedBy=default.target
`;
}

const xml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const plistString = (value: string) => `<string>${xml(checked(value, '路径'))}</string>`;

/**
 * A LaunchAgent, not a LaunchDaemon: Keychain, Shortcuts and Automation need the logged-in GUI session. Restarted
 * after a crash (not after a clean exit), at most every 10 s.
 */
export function launchAgentPlist(spec: NodeServiceSpec, host: Host = currentHost()): string {
  const log = launchAgentLog(host);
  const env = environment(spec)
    .map(([name, value]) => `\t\t<key>${xml(name)}</key>\n\t\t${plistString(value)}`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- ${serviceMarker.slice(2)} -->
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${launchAgentLabel}</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t${plistString(spec.runtime)}
\t\t${plistString(spec.script)}
\t</array>
\t<key>WorkingDirectory</key>
\t${plistString(spec.workingDirectory)}
\t<key>EnvironmentVariables</key>
\t<dict>
${env}
\t</dict>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<dict>
\t\t<key>SuccessfulExit</key>
\t\t<false/>
\t</dict>
\t<key>ThrottleInterval</key>
\t<integer>10</integer>
\t<key>ExitTimeOut</key>
\t<integer>60</integer>
\t<key>ProcessType</key>
\t<string>Standard</string>
\t<key>LimitLoadToSessionType</key>
\t<string>Aqua</string>
\t<key>StandardOutPath</key>
\t${plistString(log)}
\t<key>StandardErrorPath</key>
\t${plistString(log)}
</dict>
</plist>
`;
}

/** Whether a file at the service path is one this command wrote (and may replace or remove). */
export function ownServiceFile(text: string) {
  return text.startsWith(serviceMarker) || text.includes(`<!-- ${serviceMarker.slice(2)} -->`);
}

/** Read only the environment syntax we write; never guess at shell or systemd expansions. */
export function serviceEnvironment(text: string, mac: boolean, warn: (line: string) => void): Record<string, string> {
  const values: Record<string, string> = {};
  const setting = /PUGPORT_|COMBORUNNER_DATA_DIR/;
  if (mac) {
    const decode = (value: string) =>
      value.replace(
        /&(amp|lt|gt|quot|apos);/g,
        (_, entity: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[entity]!,
      );
    const block = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(text)?.[1];
    if (block === undefined) {
      for (const line of text.split('\n')) if (setting.test(line)) warn(line.trim());
      return values;
    }
    const read = /<key>([^<]*)<\/key>\s*<string>([^<]*)<\/string>/g;
    let match: RegExpExecArray | null;
    let rest = block;
    while ((match = read.exec(block))) {
      if (/&(?!amp;|lt;|gt;|quot;|apos;)/.test(match[0])) continue;
      values[decode(match[1]!)] = decode(match[2]!);
      rest = rest.replace(match[0], '');
    }
    for (const line of rest.split('\n')) if (setting.test(line)) warn(line.trim());
  } else {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('Environment=')) {
        if (setting.test(line) && !line.trimStart().startsWith('#')) warn(line);
        continue;
      }
      const match = /^Environment="((?:[^"\\%]|\\\\|\\"|%%)*)"$/.exec(line);
      if (!match) {
        if (setting.test(line)) warn(line);
        continue;
      }
      const value = match[1]!.replace(/\\([\\"])|%%/g, (word, escaped: string | undefined) => escaped ?? '%');
      const equals = value.indexOf('=');
      if (equals > 0) values[value.slice(0, equals)] = value.slice(equals + 1);
    }
  }
  return values;
}

export const launchAgentHint = 'Mac 必须登录桌面（可设置自动登录）；损坏的 plist 也可能导致同样错误。';

/** Detached POSIX executor CLIs escape launchd; the backend must stop them during its graceful shutdown. */
export async function stopLaunchAgent(
  host: Host,
  pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
) {
  const target = `gui/${host.uid()}/${launchAgentLabel}`;
  const loaded = () =>
    host.run('launchctl', ['print', target], { timeout: 10_000 }).then(
      () => true,
      (error: unknown) => {
        const failure = error as { stdout?: string; stderr?: string; message?: string };
        if (
          /could not find (service|domain)|service not found/i.test(
            `${failure.stdout} ${failure.stderr} ${failure.message}`,
          )
        )
          return false;
        throw error;
      },
    );
  if (!(await loaded())) return;
  // bootout may report "Operation now in progress" while graceful shutdown is still running.
  await host.run('launchctl', ['bootout', target], { timeout: 70_000 }).catch(() => {});
  const deadline = Date.now() + 70_000;
  for (let attempt = 0; attempt <= 70; attempt++) {
    if (Date.now() >= deadline) break;
    if (!(await loaded())) return;
    if (attempt < 70) await pause(1000);
  }
  throw new Error('LaunchAgent 70 秒后仍未停止。');
}
