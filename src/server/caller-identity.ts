import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
let warned = false;
export const chainHasExecutor = (chain: number[], selfPid: number, owns: (pid: number) => boolean) =>
  chain.some((pid) => pid === selfPid || owns(pid));
// Every process holding the client end counts: a socket shared after fork is listed under each of them.
const candidates = (values: number[]) => [...new Set(values.filter((pid) => Number.isSafeInteger(pid) && pid > 0))];
/** `netstat -ano -p tcp`: the client end of the loopback connection (each one is listed in both directions). */
export function parseNetstat(output: string, client: string, remotePort: number, localPort: number): number[] {
  return candidates(
    output
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/))
      .filter(
        (fields) =>
          fields[0] === 'TCP' && fields[1] === `${client}:${remotePort}` && fields[2] === `127.0.0.1:${localPort}`,
      )
      .map((fields) => Number(fields[4])),
  );
}
export function parseSs(output: string, client: string, remotePort: number, localPort: number): number[] {
  const matches: number[] = [];
  for (const line of output.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields[2] === `${client}:${remotePort}` && fields[3] === `127.0.0.1:${localPort}`)
      for (const match of line.matchAll(/pid=(\d+)/g)) matches.push(Number(match[1]));
  }
  return candidates(matches);
}
export function parseLsof(output: string, client: string, remotePort: number, localPort: number): number[] {
  let pid: number | undefined;
  const matches: number[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (/^p\d+$/.test(line)) pid = Number(line.slice(1));
    if (pid && line === `n${client}:${remotePort}->127.0.0.1:${localPort}`) matches.push(pid);
  }
  return candidates(matches);
}
/**
 * Up to 8 ancestors from a "pid ppid" table. Only processes still in the table join the chain (an exited parent's
 * pid may already belong to someone else), except the peer itself, which holds the live connection.
 */
export function walkTable(table: string, pid: number): number[] {
  const parents = new Map<number, number>();
  for (const line of table.split(/\r?\n/)) {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    if (Number.isSafeInteger(child) && Number.isSafeInteger(parent)) parents.set(child!, parent!);
  }
  const chain = [pid];
  for (let current = parents.get(pid); current && parents.has(current) && chain.length < 8;) {
    chain.push(current);
    current = parents.get(current);
  }
  return chain;
}
type Run = (file: string, args: string[]) => Promise<string>;
// One CIM query for every process is much faster here than one per ancestor (each start costs about a second).
const windowsTable =
  'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }';

/**
 * Whether the program on the other end of this loopback connection descends from this backend or from one of its
 * executors. Only ever narrows access: any failure, missing tool or timeout answers undefined, so callers treat it as
 * not an executor without remembering that answer.
 */
export async function executorCaller(options: {
  remotePort?: number;
  localPort?: number;
  /** The client's own address: it may bind any 127.x address, while the backend listens on 127.0.0.1. */
  remoteAddress?: string;
  owns: (pid: number) => boolean;
  run?: Run;
  timeoutMs?: number;
  platform?: NodeJS.Platform;
}): Promise<boolean | undefined> {
  const { remotePort, localPort, owns } = options;
  const platform = options.platform ?? process.platform;
  const timeoutMs = options.timeoutMs ?? 5000;
  const run: Run =
    options.run ?? (async (file, args) => (await exec(file, args, { timeout: timeoutMs, windowsHide: true })).stdout);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const valid = (port?: number) => Number.isInteger(port) && port! > 0 && port! < 65536;
    if (!valid(remotePort) || !valid(localPort)) throw new Error('invalid socket ports');
    const client = options.remoteAddress ?? '';
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(client) || client.split('.').some((part) => Number(part) > 255))
      throw new Error(`unexpected peer address: ${client}`);
    const found = (peers: number[]) => {
      if (!peers.length) throw new Error('peer not found');
      return peers;
    };
    const work = async (): Promise<number[][]> => {
      if (platform === 'win32') {
        const system32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
        const [connections, table] = await Promise.all([
          run(join(system32, 'netstat.exe'), ['-ano', '-p', 'tcp']),
          run(join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            windowsTable,
          ]),
        ]);
        return found(parseNetstat(connections, client, remotePort!, localPort!)).map((pid) => walkTable(table, pid));
      }
      if (platform === 'darwin') {
        const [connections, table] = await Promise.all([
          run('lsof', ['-nP', '-iTCP', '-sTCP:ESTABLISHED', '-Fpn']),
          run('ps', ['-axo', 'pid=,ppid=']),
        ]);
        return found(parseLsof(connections, client, remotePort!, localPort!)).map((pid) => walkTable(table, pid));
      }
      const peers = found(
        parseSs(
          await run('ss', ['-tnpH', 'state', 'established', `( sport = :${remotePort} and dport = :${localPort} )`]),
          client,
          remotePort!,
          localPort!,
        ),
      );
      return Promise.all(
        peers.map(async (peer) => {
          const chain: number[] = [];
          for (let pid: number | undefined = peer; pid && pid > 0 && chain.length < 8;) {
            const stat: string = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
            if (!stat) break;
            chain.push(pid);
            const parent: string | undefined = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1];
            pid = /^\d+$/.test(parent ?? '') ? Number(parent) : undefined;
          }
          return chain;
        }),
      );
    };
    const chains = await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      }),
    ]);
    return chains.some((chain) => chainHasExecutor(chain, process.pid, owns));
  } catch (error) {
    if (!warned) {
      warned = true;
      console.warn('Could not identify external caller:', error);
    }
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Asks once per connection and keeps a definite answer; a failed lookup answers false and is asked again next time. */
export function perConnection<T extends object>(lookup: (connection: T) => Promise<boolean | undefined>) {
  const answers = new WeakMap<T, Promise<boolean>>();
  return (connection: T) => {
    let answer = answers.get(connection);
    if (!answer) {
      answer = lookup(connection)
        .catch(() => undefined)
        .then((found) => {
          if (found === undefined) answers.delete(connection);
          return found === true;
        });
      answers.set(connection, answer);
    }
    return answer;
  };
}
