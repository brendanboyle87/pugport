import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Project } from '../shared/types.ts';
import type { RemoteJobResult } from '../shared/project-cli-context.ts';
import { ProjectCliContextService, sanitized } from './project-cli-context.ts';
import { spawnTarget, terminateProcess } from './adapters/process.ts';
import {
  cancelScript,
  pushRemoteJob,
  spawnJobScript,
  startScript,
  statusScript,
  substituteParams,
} from './remote-job-scripts.ts';
import type { WorkspaceStore } from './workspace-store.ts';

type JobRecord = RemoteJobResult & { projectId: string; timeoutSeconds: number; remoteStarted: boolean };
type Dependencies = {
  launch: typeof spawnTarget;
  terminate: typeof terminateProcess;
  clock: () => number;
  sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
};
const defaults: Dependencies = {
  launch: spawnTarget,
  terminate: terminateProcess,
  clock: Date.now,
  sleep: async (milliseconds, signal) => {
    await sleep(milliseconds, undefined, { signal });
  },
};
const kind = 'remote-job';
const outputLimit = 256 * 1024;

function tailBytes(text: string, bytes: number) {
  const data = Buffer.from(text);
  if (data.length <= bytes) return text;
  let offset = data.length - bytes;
  while (offset < data.length && (data[offset]! & 0xc0) === 0x80) offset++;
  return data.subarray(offset).toString('utf8');
}

export function parseStatus(output: string): Pick<RemoteJobResult, 'exitCode' | 'resultLines' | 'outputTail'> {
  const match = /^([^\n]*\n)?---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(output.replaceAll('\r\n', '\n'));
  if (!match || ((match[1] ?? '').trim() && !/^\d{1,3}$/.test((match[1] ?? '').trim())))
    throw new Error('Invalid remote job status response.');
  const exitCode = (match[1] ?? '').trim() ? Number((match[1] ?? '').trim()) : undefined;
  if (exitCode !== undefined && exitCode > 255) throw new Error('Invalid remote job exit code.');
  let remaining = 4000;
  const resultLines: string[] = [];
  for (const line of match[2]!
    .split('\n')
    .filter((line) => line.startsWith('RESULT:'))
    .slice(0, 50)) {
    const separator = resultLines.length ? 1 : 0;
    const value = sanitized(line).slice(0, Math.max(0, remaining - separator));
    if (!value) break;
    remaining -= value.length + separator;
    resultLines.push(value);
  }
  return {
    ...(exitCode === undefined ? {} : { exitCode }),
    resultLines,
    outputTail: tailBytes(sanitized(tailBytes(match[3]!, 32768)), 32768),
  };
}

/** Jobs are recovered by ID from the store. No timer exists outside an explicit SSH call or wait. */
export class RemoteJobs {
  private readonly deps: Dependencies;
  private readonly operations = new Map<string, Promise<unknown>>();
  private waiting = 0;
  constructor(
    private readonly context: ProjectCliContextService,
    private readonly store: Pick<WorkspaceStore, 'get' | 'save'>,
    deps: Partial<Dependencies> = {},
  ) {
    this.deps = { ...defaults, ...deps };
  }

  private record(projectId: string, id: string): JobRecord {
    this.context.get(projectId);
    const record = this.store.get<JobRecord>(kind, id);
    if (!record || record.projectId !== projectId) throw new Error('Remote job is not authorized for this project.');
    return record;
  }
  private save(record: JobRecord): RemoteJobResult {
    this.store.save(kind, record.jobId, record.projectId, record);
    const { projectId: _project, timeoutSeconds: _timeout, remoteStarted: _started, ...result } = record;
    return result;
  }
  private exclusive<T>(id: string, action: () => Promise<T>): Promise<T> {
    const operation = (this.operations.get(id) ?? Promise.resolve()).catch(() => {}).then(action);
    this.operations.set(id, operation);
    void operation
      .finally(() => {
        if (this.operations.get(id) === operation) this.operations.delete(id);
      })
      .catch(() => {});
    return operation;
  }
  private async ssh(host: string, script: string, cwd: string, signal?: AbortSignal) {
    const controller = new AbortController();
    const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
    const timer = setTimeout(() => controller.abort(), 20_000);
    let child: Awaited<ReturnType<typeof spawnTarget>> | undefined;
    let stdout = '',
      stderr = '',
      size = 0;
    let removeAbort = () => {};
    try {
      combined.throwIfAborted();
      child = await spawnJobScript(host, script, { cwd, signal: combined }, this.deps.launch);
      return await new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
        const abort = () => reject(new Error('Remote job SSH was cancelled or timed out.'));
        const fail = (error: Error) => reject(error);
        const output = (target: 'stdout' | 'stderr', chunk: Buffer) => {
          size += chunk.length;
          if (size > outputLimit) {
            reject(new Error('Remote job SSH output limit exceeded.'));
            return;
          }
          if (target === 'stdout') stdout += chunk.toString('utf8');
          else stderr += chunk.toString('utf8');
        };
        // Streams decode incrementally so a UTF-8 character split between chunks survives.
        child!.stdout.setEncoding('utf8');
        child!.stderr.setEncoding('utf8');
        child!.stdout.on('data', (chunk: string) => {
          size += Buffer.byteLength(chunk);
          if (size > outputLimit) {
            reject(new Error('Remote job SSH output limit exceeded.'));
            return;
          }
          stdout += chunk;
        });
        child!.stderr.on('data', (chunk: string) => output('stderr', Buffer.from(chunk)));
        child!.once('error', fail);
        child!.stdin.once('error', fail);
        const close = (code: number | null) => {
          if (code !== 0 && !/^(BUSY|NOTOOLS)\s*$/.test(stdout.trim()))
            reject(new Error('Remote job SSH failed: ' + sanitized(stderr || String(code))));
          else resolve({ code, stdout });
        };
        child!.once('close', close);
        combined.addEventListener('abort', abort, { once: true });
        removeAbort = () => combined.removeEventListener('abort', abort);
        if (combined.aborted) abort();
        else if (child!.exitCode !== null) close(child!.exitCode);
      });
    } finally {
      clearTimeout(timer);
      removeAbort();
      if (child) await this.deps.terminate(child);
    }
  }

  async start(
    projectId: string,
    name: string,
    params: unknown,
    caller: { write: boolean },
    signal?: AbortSignal,
  ): Promise<RemoteJobResult> {
    const config = this.context.get(projectId);
    const query = config.sshQueries.find((query) => query.name === name);
    if (!query) throw new Error('Remote job is not authorized for this project.');
    if (!query.readOnly && !caller.write) throw new Error('This remote job requires write access.');
    const { argv } = substituteParams(query, params);
    signal?.throwIfAborted();
    const project = this.store.get<Project>('project', projectId)!;
    const started = this.deps.clock();
    const record: JobRecord = {
      jobId:
        'rj-' + new Date(started).toISOString().slice(0, 10).replaceAll('-', '') + '-' + randomBytes(4).toString('hex'),
      projectId,
      name,
      host: query.host,
      timeoutSeconds: query.timeoutSeconds ?? 30,
      startedAt: new Date(started).toISOString(),
      status: 'running',
      resultLines: [],
      outputTail: '',
      remoteStarted: false,
    };
    try {
      await pushRemoteJob(project.path, query, params, signal, this.deps.launch, this.deps.terminate);
    } catch (error) {
      record.status = 'push-failed';
      record.error = sanitized(String(error));
      record.endedAt = new Date(this.deps.clock()).toISOString();
      return this.save(record);
    }
    // A push can await IO; a removed project or changed definition must not start an old command.
    const current = this.context.get(projectId);
    if (JSON.stringify(current.sshQueries.find((item) => item.name === name)) !== JSON.stringify(query))
      throw new Error('Remote job authorization changed before start.');
    signal?.throwIfAborted();
    record.startedAt = new Date(this.deps.clock()).toISOString();
    record.remoteStarted = true;
    record.remoteMayContinue = true;
    this.save(record);
    try {
      const result = await this.ssh(
        query.host,
        startScript(record.jobId, record.timeoutSeconds, query.cwd, argv),
        project.path,
        signal,
      );
      if (result.code === 3 && result.stdout.trim() === 'BUSY') {
        record.status = 'busy';
        record.remoteStarted = false;
        delete record.remoteMayContinue;
      } else if (result.code === 5 && result.stdout.trim() === 'NOTOOLS') {
        record.status = 'failed';
        record.remoteStarted = false;
        delete record.remoteMayContinue;
        record.error = 'Remote server requires flock, setsid and timeout (NOTOOLS).';
      } else if (result.code !== 0 || result.stdout.trim() !== 'STARTED') {
        throw new Error('Remote job start could not be confirmed.');
      } else {
        delete record.remoteMayContinue;
      }
    } catch (error) {
      record.status = 'failed';
      record.error = sanitized(String(error));
    }
    if (record.status !== 'running') record.endedAt = new Date(this.deps.clock()).toISOString();
    return this.save(record);
  }

  status(projectId: string, id: string, signal?: AbortSignal): Promise<RemoteJobResult> {
    return this.exclusive(id, async () => {
      const record = this.record(projectId, id);
      if (!record.remoteStarted) return this.save(record);
      try {
        const project = this.store.get<Project>('project', projectId)!;
        const result = await this.ssh(record.host, statusScript(id), project.path, signal);
        if (result.code !== 0) throw new Error('Remote job status SSH failed.');
        const parsed = parseStatus(result.stdout);
        delete record.exitCode;
        Object.assign(record, parsed);
        delete record.error;
        if (record.exitCode !== undefined) {
          if (record.status !== 'cancelled')
            record.status =
              record.exitCode === 0 ? 'completed' : [124, 137].includes(record.exitCode) ? 'timed-out' : 'failed';
          record.endedAt ??= new Date(this.deps.clock()).toISOString();
          delete record.remoteMayContinue;
        } else if (this.deps.clock() > Date.parse(record.startedAt) + (record.timeoutSeconds + 60) * 1000) {
          if (record.status !== 'cancelled') record.status = 'timed-out';
          record.endedAt ??= new Date(this.deps.clock()).toISOString();
          record.remoteMayContinue = true;
        } else if (record.status !== 'cancelled') {
          record.status = 'running';
          delete record.endedAt;
          delete record.remoteMayContinue;
        }
      } catch (error) {
        record.error = sanitized(String(error));
      }
      return this.save(record);
    });
  }

  cancel(projectId: string, id: string, signal?: AbortSignal): Promise<RemoteJobResult> {
    return this.exclusive(id, async () => {
      const record = this.record(projectId, id);
      if (
        !record.remoteStarted ||
        ['completed', 'cancelled', 'busy', 'push-failed'].includes(record.status) ||
        (record.status === 'failed' && !record.remoteMayContinue)
      )
        return this.save(record);
      try {
        const project = this.store.get<Project>('project', projectId)!;
        const result = await this.ssh(record.host, cancelScript(id), project.path, signal);
        if (result.code !== 0) throw new Error('Remote job cancellation failed.');
        record.status = 'cancelled';
        record.remoteMayContinue = true;
        record.endedAt = new Date(this.deps.clock()).toISOString();
        delete record.error;
      } catch (error) {
        record.error = sanitized(String(error));
      }
      return this.save(record);
    });
  }

  async wait(projectId: string, id: string, seconds: number, signal?: AbortSignal): Promise<RemoteJobResult> {
    if (!Number.isInteger(seconds) || seconds < 0 || seconds > 300)
      throw new Error('wait_seconds must be an integer from 0 to 300.');
    let result = this.record(projectId, id);
    if (this.waiting >= 3) throw new Error('At most three remote jobs can wait at once.');
    this.waiting++;
    try {
      for (let elapsed = 5000; elapsed <= seconds * 1000 && result.status === 'running'; elapsed += 5000) {
        await this.deps.sleep(5000, signal);
        result = { ...result, ...(await this.status(projectId, id, signal)) };
      }
      const { projectId: _project, timeoutSeconds: _timeout, remoteStarted: _started, ...publicResult } = result;
      return publicResult;
    } finally {
      this.waiting--;
    }
  }
}
