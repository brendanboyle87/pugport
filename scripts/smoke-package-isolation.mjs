import { createServer } from 'node:net';
import { join, parse } from 'node:path';

/** Reserve only long enough to choose a port. The backend must still bind exclusively. */
export async function chooseSmokePort(value) {
  const port = value === undefined || value === '' ? 0 : Number(value);
  if (port !== 0 && (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(port) || port < 1 || port > 65535))
    throw new Error('COMBORUNNER_SMOKE_PORT must be a TCP port between 1 and 65535.');
  if (value !== undefined && value !== '' && port === 0)
    throw new Error('COMBORUNNER_SMOKE_PORT must be a TCP port between 1 and 65535.');
  return new Promise((done, reject) => {
    const server = createServer();
    server.once('error', (cause) =>
      reject(
        new Error(`Port ${port || '(automatic)'} is occupied or unavailable; refusing to reuse a service.`, { cause }),
      ),
    );
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      const selected = server.address().port;
      server.close((error) => (error ? reject(error) : done(selected)));
    });
  });
}

export function smokeTargets() {
  return [
    ['codex-native', 'codex', 'native'],
    ['claude-native', 'claude', 'native'],
    ['grok-native', 'grok', 'native'],
    ['cursor-native', 'cursor', 'native'],
    ['codex-wsl', 'codex', 'wsl'],
    ['pi-local', 'pi', 'native'],
    ['dsh-local', 'dsh', 'native'],
  ].map(([id, provider, environment]) => ({
    id,
    provider,
    environment,
    label: id,
    command: 'disabled',
    commandDiscovery: 'fixed',
    enabled: false,
  }));
}

/** Build an allowlisted child environment: no provider keys, CLI paths or user config are inherited. */
export function smokeEnvironment(directory, port, source = process.env) {
  const environment = {};
  for (const [key, value] of Object.entries(source))
    if (
      /^(?:SystemRoot|windir|ComSpec|PATHEXT|SystemDrive|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|PROCESSOR_IDENTIFIER)$/i.test(
        key,
      )
    )
      environment[key] = value;
  const windows = source.SystemRoot || source.SYSTEMROOT || source.windir || 'C:\\Windows';
  const home = join(directory, 'home');
  return {
    ...environment,
    SystemRoot: windows,
    PATH: [join(windows, 'System32'), windows].join(';'),
    HOME: home,
    USERPROFILE: home,
    HOMEDRIVE: parse(home).root.replace(/[\\/]$/, ''),
    HOMEPATH: home.slice(parse(home).root.length - 1),
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    TEMP: join(directory, 'temp'),
    TMP: join(directory, 'temp'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_CACHE_HOME: join(home, '.cache'),
    CODEX_HOME: join(home, '.codex'),
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    PUGPORT_RUNTIME_DIR: join(directory, 'runtime'),
    COMBORUNNER_DATA_DIR: join(directory, 'data'),
    COMBORUNNER_SMOKE_DIR: join(directory, 'smoke-output'),
    COMBORUNNER_PORT: String(port),
    COMBORUNNER_DESKTOP_USER_DATA_DIR: join(directory, 'profile'),
    COMBORUNNER_MEMORY_DIR: join(directory, 'memory'),
    COMBORUNNER_MEMORY_VECTORS_DIR: join(directory, 'memory-vectors'),
    COMBORUNNER_IMAGE_INDEX_DIR: join(directory, 'image-index'),
    COMBORUNNER_EXTENSIONS_DIR: join(directory, 'extensions'),
    COMBORUNNER_MEMORY_BACKGROUND: '0',
    COMBORUNNER_IMAGE_BACKGROUND: '0',
  };
}
