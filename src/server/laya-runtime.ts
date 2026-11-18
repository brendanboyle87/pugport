import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { LayaChoices, LayaInference, LayaSettings, LayaState, LayaStatus } from '../shared/laya.ts';
import { windowsTreeKill } from './adapters/process.ts';
import { sanitizeLayaCloudValue } from './laya-cloud-privacy.ts';
import { underTest } from './platform/under-test.ts';

const MODEL_VERSION = 'pugport-laya-v4';
const MODEL_SHA256 = '4445f9401b321a94ebc3614d231847dc08beaa0c9ccc3fded8dc39f90e8bb4b9';
const REQUEST_BYTES = 64 * 1024;
const RESPONSE_BYTES = 256 * 1024;
// Laya now decides reply vs task: cloud answers took up to ~2.7 s (p90), so 3 s cut off too many. Execution waits, sending does not.
// Suites keep the old 3 s so their real-time timeout cases stay fast; the deadline itself is what they check.
const PREDICT_MS = underTest() ? 3000 : 8000;
const LATE_RESULT_MS = 30_000;
const STARTUP_MS = 120_000;
const COOLDOWN_MS = 30_000;
const CLOUD_URL = 'https://laya.pugport.com/v1/judge';
const CHOICES: { [K in keyof LayaChoices]: readonly LayaChoices[K][] } = {
  task_type: [
    'conversation',
    'coding',
    'research',
    'writing',
    'translation',
    'data_analysis',
    'media',
    'automation',
    'mixed',
    'unclear',
  ],
  difficulty: ['simple', 'standard', 'complex', 'unclear'],
  web_search: ['yes', 'no', 'unclear'],
  input_modality: ['text', 'image', 'audio', 'video', 'mixed', 'unclear'],
  document_read: ['yes', 'no', 'unclear'],
  media_output: [
    'none',
    'image_create',
    'image_edit',
    'speech',
    'music',
    'video_generate',
    'video_render',
    'mixed',
    'unclear',
  ],
  project_access: ['none', 'read', 'write', 'unclear'],
  run_commands: ['yes', 'no', 'unclear'],
  browser_use: ['yes', 'no', 'unclear'],
  executor_intent: ['none', 'assign', 'exclude', 'reassign', 'mention_only', 'unclear'],
};

type Worker = {
  child: ChildProcessWithoutNullStreams;
  stdout: Buffer;
  stderrBytes: number;
  startup: NodeJS.Timeout;
  stopped: boolean;
  closed: Promise<void>;
};
type Pending = {
  id: string;
  started: number;
  timer: NodeJS.Timeout;
  timedOut?: boolean;
  removeAbort: () => void;
  resolve: (result: LayaInference) => void;
  waiters: Set<() => void>;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max;
}

function validState(state: LayaState): boolean {
  return (
    record(state) &&
    Object.keys(state).length === 5 &&
    text(state.message, 32_768) &&
    text(state.recent_context, 32_768) &&
    text(state.reference_text, 32_768) &&
    Array.isArray(state.attachments) &&
    state.attachments.length <= 32 &&
    state.attachments.every(
      (item) =>
        record(item) &&
        Object.keys(item).every((key) => ['kind', 'name', 'mime_type'].includes(key)) &&
        text(item.kind, 64) &&
        text(item.name, 512) &&
        (item.mime_type === undefined || text(item.mime_type, 256)),
    ) &&
    Array.isArray(state.candidate_executors) &&
    state.candidate_executors.length <= 32 &&
    state.candidate_executors.every((item) => text(item, 128))
  );
}

function finiteTree(value: unknown, depth = 0): boolean {
  if (depth > 20) return false;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => finiteTree(item, depth + 1));
  if (record(value)) return Object.values(value).every((item) => finiteTree(item, depth + 1));
  return true;
}

function choicesFromRaw(raw: unknown): LayaChoices | undefined {
  if (!record(raw) || !record(raw.answers) || !finiteTree(raw)) return;
  if (Object.keys(raw.answers).length !== Object.keys(CHOICES).length) return;
  const choices: Record<string, string> = {};
  for (const [key, allowed] of Object.entries(CHOICES)) {
    const answer = raw.answers[key];
    if (!record(answer) || answer.type !== 'choice' || answer.abstention === 'abstained') return;
    if (typeof answer.choice !== 'string' || !(allowed as readonly string[]).includes(answer.choice)) return;
    if (!record(answer.probabilities) || Object.keys(answer.probabilities).length !== allowed.length) return;
    let total = 0;
    for (const choice of allowed) {
      const probability = answer.probabilities[choice];
      if (typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1)
        return;
      total += probability;
    }
    if (Math.abs(total - 1) > 0.02) return;
    choices[key] = answer.choice;
  }
  return choices as LayaChoices;
}

/** Cloud inference or one local CUDA worker, under the same request deadline. */
export class LayaRuntime {
  private current: LayaStatus = { state: 'disabled', modelVersion: MODEL_VERSION, reason: 'disabled' };
  private configKey = '';
  private generation = 0;
  private cooldownUntil = 0;
  private restartTimer?: NodeJS.Timeout;
  private worker?: Worker;
  private pending?: Pending;
  private readonly owned = new Set<Worker>();
  private readonly stopping = new Set<Promise<void>>();
  private closed = false;
  private mode: LayaSettings['mode'];
  private region?: LayaStatus['region'];
  private readonly cloudRequests = new Set<AbortController>();

  constructor(
    private readonly options: {
      settings: () => LayaSettings | undefined;
      root: string;
      fetch?: typeof fetch;
      initialRegion?: LayaStatus['region'];
      onRegion?: (region: NonNullable<LayaStatus['region']>) => void;
    },
  ) {
    this.region = options.initialRegion;
    this.update();
  }

  status(): LayaStatus {
    return { ...this.current, ...(this.region ? { region: this.region } : {}) };
  }

  update(): void {
    if (this.closed) return;
    let settings: LayaSettings | undefined;
    try {
      settings = this.options.settings();
    } catch {
      this.fail('invalid_settings');
      return;
    }
    const mode = settings?.mode ?? 'cloud';
    const python = settings?.pythonPath;
    const checkpoint = settings?.checkpointPath;
    const key = JSON.stringify([mode, python, checkpoint, process.env.LAYA_CLOUD_URL]);
    const changed = key !== this.configKey;
    if (!changed && (this.current.state !== 'error' || Date.now() < this.cooldownUntil)) return;
    this.configKey = key;
    this.mode = mode;
    const generation = ++this.generation;
    this.stop('configuration_changed');
    if (changed) this.cooldownUntil = 0;
    if (mode === 'cloud') {
      this.current = { state: 'ready', modelVersion: MODEL_VERSION, device: 'cloud' };
      return;
    }
    if (mode !== 'local') {
      this.current = { state: 'disabled', modelVersion: MODEL_VERSION, reason: 'disabled' };
      return;
    }
    if (
      !text(python, 4096) ||
      !python ||
      !isAbsolute(python) ||
      !text(checkpoint, 4096) ||
      !checkpoint ||
      !isAbsolute(checkpoint)
    ) {
      this.fail('explicit_paths_required');
      return;
    }
    const workerPath = [
      join(this.options.root, 'dist/server/laya-worker.py'),
      join(this.options.root, 'scripts/laya-worker.py'),
    ].find(existsSync);
    try {
      if (!statSync(python).isFile() || !statSync(checkpoint).isDirectory() || !workerPath) {
        this.fail('local_files_missing');
        return;
      }
    } catch {
      this.fail('local_files_missing');
      return;
    }
    this.current = { state: 'starting', modelVersion: MODEL_VERSION, reason: 'warming' };
    // A replacement never loads while the preceding worker still owns GPU memory.
    void Promise.all([...this.owned].map((worker) => worker.closed).concat([...this.stopping])).then(() => {
      if (this.closed || generation !== this.generation) return;
      this.start(python, checkpoint, workerPath!);
    });
  }

  async predict(state: LayaState, options: { signal?: AbortSignal } = {}): Promise<LayaInference> {
    this.update();
    if (options.signal?.aborted) return this.fallback('cancelled');
    if (!this.closed && this.mode === 'cloud' && this.current.state === 'ready') {
      if (underTest() && !this.options.fetch && !process.env.LAYA_CLOUD_URL)
        return this.fallback('test_transport_required');
      return this.predictCloud(state, options.signal);
    }
    if (this.current.state !== 'ready' || !this.worker) {
      return this.fallback(
        this.current.state === 'error' && Date.now() < this.cooldownUntil
          ? 'cooldown'
          : (this.current.reason ?? this.current.state),
      );
    }
    const started = performance.now();
    const worker = this.worker;
    while (this.pending) {
      const pending = this.pending;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          pending.waiters.delete(done);
          options.signal?.removeEventListener('abort', done);
          resolve();
        };
        const timer = setTimeout(done, Math.max(0, PREDICT_MS - (performance.now() - started)));
        pending.waiters.add(done);
        options.signal?.addEventListener('abort', done, { once: true });
      });
      if (options.signal?.aborted) return this.fallback('cancelled');
      if (this.worker !== worker) return this.fallback(this.current.reason ?? this.current.state);
      if (performance.now() - started >= PREDICT_MS) return this.fallback('busy', performance.now() - started);
    }
    const id = randomUUID();
    let line: string;
    try {
      if (!validState(state)) return this.fallback('invalid_state');
      line = JSON.stringify({ type: 'predict', id, state }) + '\n';
      if (Buffer.byteLength(line) > REQUEST_BYTES) return this.fallback('input_too_large');
    } catch {
      return this.fallback('invalid_state');
    }
    return new Promise((resolve) => {
      const abort = () => this.fail('cancelled');
      const timer = setTimeout(
        () => {
          const pending = this.pending;
          if (!pending || pending.id !== id) return;
          pending.timedOut = true;
          pending.removeAbort();
          const result = this.fallback('timeout', performance.now() - started);
          this.current.lastLatencyMs = result.latencyMs;
          resolve(result);
          pending.timer = setTimeout(() => this.fail('timeout'), LATE_RESULT_MS);
          pending.timer.unref();
        },
        Math.max(0, PREDICT_MS - (performance.now() - started)),
      );
      this.pending = {
        id,
        started,
        timer,
        resolve,
        waiters: new Set(),
        removeAbort: () => options.signal?.removeEventListener('abort', abort),
      };
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) {
        abort();
        return;
      }
      worker.child.stdin.write(line, (error) => {
        if (error && this.worker === worker) this.fail('worker_write_failed');
      });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.generation++;
    this.stop('closed');
    this.current = { state: 'disabled', modelVersion: MODEL_VERSION, reason: 'closed' };
    await Promise.all([...this.owned].map((worker) => worker.closed).concat([...this.stopping]));
  }

  private fallback(reason: string, latencyMs = 0): LayaInference {
    return { status: 'fallback', reason, modelVersion: MODEL_VERSION, latencyMs };
  }

  private async predictCloud(state: LayaState, signal?: AbortSignal): Promise<LayaInference> {
    let body: string;
    try {
      if (!validState(state)) return this.fallback('invalid_state');
      body = JSON.stringify({ state });
      if (Buffer.byteLength(body) > REQUEST_BYTES) return this.fallback('input_too_large');
      const safe = sanitizeLayaCloudValue(state);
      safe.attachments = safe.attachments.map((item) => ({
        kind: item.kind.slice(0, 64),
        name: item.name.slice(0, 512),
        ...(item.mime_type === undefined ? {} : { mime_type: item.mime_type.slice(0, 256) }),
      }));
      safe.candidate_executors = safe.candidate_executors.map((value) => value.slice(0, 128));
      body = JSON.stringify({ state: safe });
      if (Buffer.byteLength(body) > REQUEST_BYTES) return this.fallback('input_too_large');
    } catch {
      return this.fallback('invalid_state');
    }
    const started = performance.now();
    const generation = this.generation;
    const controller = new AbortController();
    this.cloudRequests.add(controller);
    const abort = () => controller.abort('cancelled');
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort('timeout'), PREDICT_MS);
    let failure = 'cloud_unavailable';
    let removeAbort = () => {};
    try {
      const cancelled = new Promise<never>((_resolve, reject) => {
        const rejectAbort = () => reject(new Error('cloud_aborted'));
        controller.signal.addEventListener('abort', rejectAbort, { once: true });
        removeAbort = () => controller.signal.removeEventListener('abort', rejectAbort);
      });
      if (signal?.aborted) abort();
      const { inference: result, region } = await Promise.race([
        cancelled,
        (async () => {
          const endpoint = process.env.LAYA_CLOUD_URL
            ? new URL('/v1/judge', process.env.LAYA_CLOUD_URL).href
            : CLOUD_URL;
          const response = await (this.options.fetch ?? fetch)(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
            signal: controller.signal,
            redirect: 'error',
          });
          failure = response.ok ? 'invalid_response' : `cloud_http_${response.status}`;
          if (!response.ok) throw new Error('cloud_http_error');
          if (Number(response.headers.get('content-length')) > RESPONSE_BYTES) {
            failure = 'output_too_large';
            throw new Error(failure);
          }
          const reader = response.body?.getReader();
          if (!reader) throw new Error('empty_response');
          const chunks: Uint8Array[] = [];
          let size = 0;
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              size += value.byteLength;
              if (size > RESPONSE_BYTES) {
                failure = 'output_too_large';
                throw new Error(failure);
              }
              chunks.push(value);
            }
          } finally {
            reader.releaseLock();
          }
          const message: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (
            !record(message) ||
            message.modelVersion !== MODEL_VERSION ||
            message.modelSha256 !== MODEL_SHA256 ||
            typeof message.device !== 'string' ||
            !/^(?:cpu|mps|cuda(?::\d+)?)$/.test(message.device) ||
            typeof message.latencyMs !== 'number' ||
            !Number.isFinite(message.latencyMs) ||
            message.latencyMs < 0 ||
            (message.region !== 'eu' && message.region !== 'other')
          ) {
            throw new Error('invalid_cloud_response');
          }
          const choices = choicesFromRaw(message.raw);
          if (!choices) {
            failure = 'invalid_prediction';
            throw new Error(failure);
          }
          const inference: LayaInference = {
            status: 'ok',
            reason: 'cloud',
            modelVersion: MODEL_VERSION,
            modelSha256: MODEL_SHA256,
            device: `cloud:${message.device}`,
            latencyMs: performance.now() - started,
            choices,
            raw: message.raw as Record<string, unknown>,
          };
          const region: NonNullable<LayaStatus['region']> = message.region;
          return { inference, region };
        })(),
      ]);
      if (controller.signal.aborted || generation !== this.generation) throw new Error('cloud_aborted');
      if (result.latencyMs >= PREDICT_MS) {
        failure = 'timeout';
        throw new Error(failure);
      }
      const regionChanged = this.region !== region;
      this.region = region;
      this.current = {
        state: 'ready',
        modelVersion: MODEL_VERSION,
        device: result.device,
        lastLatencyMs: result.latencyMs,
      };
      try {
        if (regionChanged) this.options.onRegion?.(region);
      } catch {
        // A local persistence failure cannot invalidate a completed prediction.
      }
      return result;
    } catch {
      const reason = controller.signal.aborted ? String(controller.signal.reason) : failure;
      const result = this.fallback(reason, performance.now() - started);
      if (generation === this.generation && reason !== 'cancelled') {
        this.current.lastLatencyMs = result.latencyMs;
        this.fail(reason);
      }
      return result;
    } finally {
      clearTimeout(timer);
      removeAbort();
      signal?.removeEventListener('abort', abort);
      this.cloudRequests.delete(controller);
      controller.abort('completed');
    }
  }

  private settle(result: LayaInference): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    clearTimeout(pending.timer);
    pending.removeAbort();
    this.current.lastLatencyMs = result.latencyMs;
    pending.resolve(result);
    for (const done of pending.waiters) done();
  }

  private stop(reason: string): void {
    for (const controller of this.cloudRequests) controller.abort(reason);
    clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    this.worker = undefined;
    if (this.pending) this.settle(this.fallback(reason, performance.now() - this.pending.started));
    for (const worker of this.owned) {
      if (worker.stopped) continue;
      worker.stopped = true;
      clearTimeout(worker.startup);
      worker.child.stdin.destroy();
      const termination = this.terminate(worker).finally(() => this.stopping.delete(termination));
      this.stopping.add(termination);
    }
  }

  private async terminate(worker: Worker): Promise<void> {
    const child = worker.child;
    if (process.platform === 'win32' && child.pid && child.exitCode === null && child.signalCode === null) {
      // A Windows venv launcher owns the real Python child; preserve that tree until taskkill runs.
      const tree = windowsTreeKill(child.pid);
      try {
        const killer = spawn(tree.file, tree.args, { windowsHide: true, shell: false, stdio: 'ignore' });
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(() => {
            killer.kill();
            done();
          }, 3000);
          killer.once('error', done);
          killer.once('close', done);
        });
      } catch {
        // Keep the direct child handle as a fallback if Windows denies the tree helper.
      }
    }
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill();
    const force = setTimeout(() => child.kill('SIGKILL'), 250);
    force.unref();
    void worker.closed.then(() => clearTimeout(force));
  }

  private fail(reason: string): void {
    // Only a worker that was serving restarts by itself; a startup or configuration failure waits for the next
    // request, so a broken setup never reloads the model every cooldown while idle.
    const wasServing = this.current.state === 'ready' && this.worker !== undefined;
    this.generation++;
    this.stop(reason);
    this.cooldownUntil = Date.now() + COOLDOWN_MS;
    this.current = { state: 'error', modelVersion: MODEL_VERSION, reason, lastLatencyMs: this.current.lastLatencyMs };
    if (wasServing && reason !== 'cancelled') {
      // A timer can fire a moment before Date.now() passes cooldownUntil; the cooldown is over when it fires.
      this.restartTimer = setTimeout(() => {
        this.cooldownUntil = 0;
        this.update();
      }, COOLDOWN_MS);
      this.restartTimer.unref();
    }
  }

  private start(python: string, checkpoint: string, workerPath: string): void {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(python, [workerPath, '--checkpoint', checkpoint], {
        cwd: this.options.root,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PYTHONUNBUFFERED: '1',
          PYTHONUTF8: '1',
          PYTHONDONTWRITEBYTECODE: '1',
          HF_HUB_OFFLINE: '1',
          TRANSFORMERS_OFFLINE: '1',
          HF_HUB_DISABLE_TELEMETRY: '1',
          TOKENIZERS_PARALLELISM: 'false',
          OMP_NUM_THREADS: '2',
          MKL_NUM_THREADS: '2',
          USE_TF: '0',
        },
      });
    } catch {
      this.fail('worker_start_failed');
      return;
    }
    let resolveClosed!: () => void;
    const worker: Worker = {
      child,
      stdout: Buffer.alloc(0),
      stderrBytes: 0,
      stopped: false,
      closed: new Promise((resolve) => (resolveClosed = resolve)),
      startup: setTimeout(() => {
        if (this.worker === worker) this.fail('startup_timeout');
      }, STARTUP_MS),
    };
    worker.startup.unref();
    this.worker = worker;
    this.owned.add(worker);
    // Full redaction: discard dependency logs and stop a worker that exceeds the log cap.
    child.stderr.on('data', (chunk: Buffer) => {
      worker.stderrBytes += chunk.length;
      if (this.worker === worker && worker.stderrBytes > 16 * 1024) this.fail('stderr_limit');
    });
    child.stdin.on('error', () => {
      if (this.worker === worker) this.fail('worker_write_failed');
    });
    child.on('error', () => {
      if (this.worker === worker) this.fail('worker_start_failed');
    });
    child.on('close', () => {
      clearTimeout(worker.startup);
      this.owned.delete(worker);
      resolveClosed();
      if (this.worker === worker) this.fail('worker_exited');
    });
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.worker !== worker) return;
      if (worker.stdout.length + chunk.length > RESPONSE_BYTES) {
        this.fail('output_too_large');
        return;
      }
      worker.stdout = Buffer.concat([worker.stdout, chunk]);
      let newline: number;
      while (this.worker === worker && (newline = worker.stdout.indexOf(10)) !== -1) {
        const line = worker.stdout.subarray(0, newline).toString('utf8');
        worker.stdout = worker.stdout.subarray(newline + 1);
        try {
          this.receive(JSON.parse(line));
        } catch {
          this.fail('invalid_response');
        }
      }
    });
  }

  private receive(message: unknown): void {
    if (!record(message)) return this.fail('invalid_response');
    if (message.type === 'unsupported') return this.fail('cuda_unsupported');
    if (message.type === 'error') return this.fail('worker_error');
    if (message.type === 'ready' && this.current.state === 'starting') {
      if (
        message.modelVersion !== MODEL_VERSION ||
        message.modelSha256 !== MODEL_SHA256 ||
        typeof message.device !== 'string' ||
        !/^cuda(?::\d+)?$/.test(message.device)
      ) {
        return this.fail('invalid_model_identity');
      }
      clearTimeout(this.worker!.startup);
      this.current = { state: 'ready', modelVersion: MODEL_VERSION, device: message.device };
      return;
    }
    const pending = this.pending;
    if (message.type !== 'result' || !pending || message.id !== pending.id) return this.fail('invalid_response_id');
    const latencyMs = performance.now() - pending.started;
    if (pending.timedOut || latencyMs >= PREDICT_MS) {
      this.settle(this.fallback('timeout', latencyMs));
      return;
    }
    const choices = choicesFromRaw(message.raw);
    if (!choices) return this.fail('invalid_prediction');
    this.settle({
      status: 'ok',
      reason: 'local_cuda',
      modelVersion: MODEL_VERSION,
      modelSha256: MODEL_SHA256,
      device: this.current.device,
      latencyMs,
      choices,
      raw: message.raw as Record<string, unknown>,
    });
  }
}
