import { z } from 'zod';
import type { InstaboxMachineView, InstaboxView, RemoteServerLive } from '../shared/remote-servers.ts';
import { currentHost, type Host } from './platform/host.ts';
import { isDirectExecutable } from './platform/executables.ts';
import { remoteCheckIntervalMs } from './remote-servers.ts';

export function findInstabox(host: Host = currentHost()): string | undefined {
  const dirs = [
    ...(host.env.PATH ?? host.env.Path ?? '').split(host.path.delimiter).map((dir) => dir.replace(/^"|"$/g, '')),
    // Static folders only: discovery runs on a page refresh and must start no process (no login shell, no npm).
    ...[host.path.join(host.home, '.local', 'bin'), host.path.join(host.home, 'bin')],
    ...(host.platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin'] : []),
    ...(host.platform === 'linux' ? ['/usr/local/bin', '/home/linuxbrew/.linuxbrew/bin'] : []),
    ...(host.platform === 'win32' && host.env.LOCALAPPDATA
      ? [host.path.join(host.env.LOCALAPPDATA, 'Programs', 'instabox')]
      : []),
  ];
  for (const dir of dirs.filter(Boolean)) {
    const file = host.path.join(dir, host.platform === 'win32' ? 'instabox.exe' : 'instabox');
    if (isDirectExecutable(file, host)) return file;
  }
  return undefined;
}

const machineSchema = z.object({
  id: z.string().regex(/^m_[a-z0-9]+$/),
  name: z.string().min(1),
  state: z.string().min(1),
  desiredState: z.string().optional(),
  operationId: z.string().nullable().optional(),
  spec: z
    .object({
      vcpus: z.number().finite().nonnegative().optional(),
      memMiB: z.number().finite().nonnegative().optional(),
      persistentDiskGiB: z.number().finite().nonnegative().optional(),
    })
    .optional(),
  template: z.object({ id: z.string(), version: z.string().optional() }).optional(),
  free: z.boolean().optional(),
  autoSuspendAfterSeconds: z.number().finite().nonnegative().optional(),
  runStartedAt: z.string().nullable().optional(),
  maxRunMinutes: z.number().finite().optional(),
  cooldownUntil: z.string().datetime({ offset: true }).nullable().optional().catch(undefined),
});
export const instaboxActionSchema = z
  .object({
    machineId: z.string().regex(/^m_[a-z0-9]+$/),
    action: z.enum(['pause', 'resume', 'wake']),
  })
  .strict();

export function instaboxState(
  machine: Pick<z.infer<typeof machineSchema>, 'state' | 'desiredState' | 'operationId'>,
): string {
  const target = machine.desiredState;
  if (machine.operationId || (target && target !== machine.state)) {
    if (target === 'running') return 'starting';
    if (target === 'suspended' || target === 'paused') return 'pausing';
    if (target === 'stopped') return 'stopping';
  }
  return machine.state === 'suspended' ? 'paused' : machine.state === 'resuming' ? 'starting' : machine.state;
}

/** Automatic reads use the control plane; writes enter through owner routes. */
export class InstaboxMonitor {
  private cached?: InstaboxView;
  private checked = -Infinity;
  private listing?: Promise<void>;
  private acting?: Promise<void>;
  private executable?: string;
  private readonly waking = new Map<string, Promise<void>>();
  private readonly cancelledWakes = new Set<string>();
  private readonly metrics = new Map<string, { at: number; live?: RemoteServerLive; work?: Promise<void> }>();
  private readonly pending = new Map<string, { action: 'pause' | 'resume'; at: number }>();
  constructor(
    private readonly host: Host = currentHost(),
    private readonly clock = () => Date.now(),
    private readonly pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  ) {}

  async view(refresh: boolean, metrics = false): Promise<InstaboxView | undefined> {
    if (this.acting) await this.acting.catch(() => undefined);
    if (refresh) await this.poll();
    if (refresh && metrics) await this.readMetrics();
    return this.cached;
  }

  async fresh(): Promise<InstaboxView | undefined> {
    if (this.acting) await this.acting.catch(() => undefined);
    await this.listing;
    await this.poll(true);
    return this.cached;
  }

  private poll(force = false, timeout = 20_000): Promise<void> {
    if (this.listing) return this.listing;
    if (!force && this.clock() - this.checked < remoteCheckIntervalMs) return Promise.resolve();
    this.listing = this.read(timeout).finally(() => {
      this.listing = undefined;
    });
    return this.listing;
  }

  private async read(timeout: number): Promise<void> {
    this.checked = this.clock();
    try {
      this.executable = findInstabox(this.host);
      if (!this.executable) {
        this.cached = undefined;
        this.pending.clear();
        return;
      }
      const { stdout } = await this.run(['ls', '--json'], timeout);
      const rows = z.array(machineSchema).parse(JSON.parse(stdout));
      const machines = rows
        .filter((row) => row.state !== 'deleted')
        .map((row): InstaboxMachineView => {
          const state = instaboxState(row);
          const pending = this.pending.get(row.id);
          let pendingAction = pending?.action;
          const settled = !row.operationId && (!row.desiredState || row.desiredState === row.state);
          if (
            (pendingAction === 'pause' && state === 'paused') ||
            (pendingAction === 'resume' && state === 'running') ||
            // A box that resumed and paused itself again between two lists never shows the target: stop waiting.
            (pending && settled && this.clock() - pending.at >= remoteCheckIntervalMs)
          ) {
            this.pending.delete(row.id);
            pendingAction = undefined;
          }
          return {
            source: 'instabox',
            machineId: row.id,
            name: row.name,
            state,
            checkedAt: new Date(this.clock()).toISOString(),
            spec: row.spec,
            template: row.template ? [row.template.id, row.template.version].filter(Boolean).join(' · ') : undefined,
            free: row.free,
            autoSuspendAfterSeconds: row.autoSuspendAfterSeconds,
            runStartedAt: row.runStartedAt ?? undefined,
            maxRunMinutes: row.maxRunMinutes,
            cooldownUntil: row.cooldownUntil,
            ...(state === 'running' && !pendingAction ? { live: this.freshMetrics(row.id) } : {}),
            pendingAction,
          };
        });
      for (const id of this.pending.keys())
        if (!machines.some((machine) => machine.machineId === id)) this.pending.delete(id);
      this.cached = { machines };
    } catch (error) {
      const detail = error as { stderr?: string; message?: string };
      if (/\bnot (?:signed|logged) in\b|\bunauthenticated\b/i.test(`${detail.stderr ?? ''}\n${detail.message ?? ''}`)) {
        this.cached = undefined;
        this.pending.clear();
      } else {
        this.cached = {
          error: '无法连接 instabox',
          machines: (this.cached?.machines ?? []).map((machine) => ({ ...machine, stale: true })),
        };
      }
    }
  }

  private run(args: string[], timeout = 20_000) {
    return this.host.run(this.executable!, args, { windowsHide: true, timeout, maxBuffer: 1024 * 1024 });
  }

  private freshMetrics(id: string): RemoteServerLive | undefined {
    const live = this.metrics.get(id)?.live;
    return live && this.clock() - Date.parse(live.checkedAt) <= 5 * 60_000 ? live : undefined;
  }

  private async readMetrics(): Promise<void> {
    await Promise.all(
      (this.cached?.machines ?? [])
        .filter((m) => m.state === 'running' && !m.stale && !m.pendingAction)
        .map(async (machine) => {
          const previous = this.metrics.get(machine.machineId);
          if (previous?.work) return previous.work;
          if (previous && this.clock() - previous.at < remoteCheckIntervalMs) return;
          const entry: { at: number; live?: RemoteServerLive; work?: Promise<void> } = { at: this.clock() };
          this.metrics.set(machine.machineId, entry);
          entry.work = (async () => {
            try {
              const result = await this.run(['metrics', machine.machineId, '--since', '5m', '--json']);
              entry.live = parseInstaboxMetrics(JSON.parse(result.stdout), this.clock());
            } catch {
              // Missing or malformed samples are unknown, never a zero reading.
              entry.live = undefined;
            } finally {
              entry.work = undefined;
              const current = this.cached?.machines.find((m) => m.machineId === machine.machineId);
              if (current?.state === 'running' && !current.pendingAction && !current.stale) current.live = entry.live;
            }
          })();
          await entry.work;
        }),
    );
  }

  private machine(id: string): InstaboxMachineView {
    if (this.cached?.error) throw problem(502, '无法连接 instabox');
    const machine = this.cached?.machines.find((m) => m.machineId === id);
    if (!machine || !this.executable) throw problem(404, '找不到 instabox 机器');
    return machine;
  }

  async sshConfig(machineId: string): Promise<unknown> {
    z.string()
      .regex(/^m_[a-z0-9]+$/)
      .parse(machineId);
    await this.listing;
    await this.poll(true);
    this.machine(machineId);
    try {
      return JSON.parse((await this.run(['ssh-config', machineId, '--json'])).stdout);
    } catch {
      throw problem(502, 'instabox 操作失败');
    }
  }

  wake(machineId: string, ready?: (remainingMs: number) => Promise<boolean>): Promise<void> {
    z.string()
      .regex(/^m_[a-z0-9]+$/)
      .parse(machineId);
    const previous = this.waking.get(machineId);
    if (previous) return previous;
    const deadline = this.clock() + 60_000;
    const remaining = () => {
      const ms = deadline - this.clock();
      if (ms <= 0) throw problem(504, 'instabox 机器 60 秒内没有醒来');
      return ms;
    };
    const wait = async <T>(work: Promise<T>): Promise<T> => {
      const ms = remaining();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          work,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(problem(504, 'instabox 机器 60 秒内没有醒来')), ms);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    const perform = async () => {
      let resumed = false;
      for (;;) {
        // Acquire synchronously after waiting: another wake may have taken the writer in the meantime.
        while (this.acting) await wait(this.acting.catch(() => undefined));
        if (this.cancelledWakes.has(machineId)) throw problem(409, 'instabox 操作进行中');
        let machine!: InstaboxMachineView;
        const operation = (async () => {
          await wait(Promise.resolve(this.listing));
          await wait(this.poll(true, Math.min(20_000, remaining())));
          remaining();
          machine = this.machine(machineId);
          if (machine.pendingAction === 'pause') throw problem(409, 'instabox 操作进行中');
          if (machine.state === 'paused' && !resumed && machine.pendingAction !== 'resume') {
            const cooldown = Date.parse(machine.cooldownUntil ?? '');
            if (cooldown > this.clock())
              throw problem(409, `${machine.name} 冷却中，${new Date(cooldown).toTimeString().slice(0, 5)} 后才能唤醒`);
            try {
              await wait(this.run(['resume', machineId, '--no-wait'], Math.min(20_000, remaining())));
            } catch (error) {
              if ((error as { status?: number }).status === 504) throw error;
              await wait(this.poll(true, Math.min(20_000, remaining())));
              throw problem(502, 'instabox 操作失败');
            }
            resumed = true;
            this.pending.set(machineId, { action: 'resume', at: this.clock() });
            machine.pendingAction = 'resume';
          } else if (!['running', 'starting', 'paused', 'pausing'].includes(machine.state)) {
            throw problem(409, `现在不能唤醒 ${machine.state}`);
          }
        })();
        this.acting = operation;
        try {
          await operation;
        } finally {
          if (this.acting === operation) this.acting = undefined;
        }
        if (machine.state === 'running' && !machine.pendingAction) {
          if (!ready || (await wait(ready(remaining())))) {
            if (this.cancelledWakes.has(machineId)) throw problem(409, 'instabox 操作进行中');
            remaining();
            return;
          }
        }
        await this.pause(Math.min(2000, remaining()));
      }
    };
    const promise = perform().finally(() => {
      this.waking.delete(machineId);
      this.cancelledWakes.delete(machineId);
      if (this.pending.get(machineId)?.action === 'resume') this.pending.delete(machineId);
    });
    this.waking.set(machineId, promise);
    return promise;
  }

  async action(input: unknown): Promise<void> {
    const { machineId, action } = instaboxActionSchema.extend({ action: z.enum(['pause', 'resume']) }).parse(input);
    if (this.acting) throw Object.assign(new Error('instabox 操作进行中'), { status: 409 });
    const perform = async () => {
      // Finish older reads before writing, so they cannot overwrite the post-action list.
      await this.listing;
      const machine = this.cached?.machines.find((item) => item.machineId === machineId);
      if (!machine || !this.executable) throw Object.assign(new Error('找不到 instabox 机器'), { status: 404 });
      if (machine.pendingAction && !(action === 'pause' && this.waking.has(machineId)))
        throw Object.assign(new Error('instabox 操作进行中'), { status: 409 });
      if (action === 'pause' && this.waking.has(machineId)) this.cancelledWakes.add(machineId);
      try {
        await this.run([action === 'pause' ? 'suspend' : 'resume', machineId, '--no-wait']);
      } catch {
        // The service may have accepted it before the CLI failed; show what it reports now.
        await this.poll(true).catch(() => undefined);
        throw Object.assign(new Error('instabox 操作失败'), { status: 502 });
      }
      this.pending.set(machineId, { action, at: this.clock() });
      this.cached = {
        ...this.cached!,
        machines: this.cached!.machines.map((item) =>
          item.machineId === machineId ? { ...item, pendingAction: action } : item,
        ),
      };
      await this.poll(true);
    };
    this.acting = perform();
    try {
      await this.acting;
    } finally {
      this.acting = undefined;
    }
  }
}

const problem = (status: number, message: string) => Object.assign(new Error(message), { status });

/** Accept only explicit, finite samples; unknown provider data leaves the bars absent. */
export function parseInstaboxMetrics(value: unknown, now: number): RemoteServerLive | undefined {
  const sample = z.object({
    timestamp: z.string().datetime({ offset: true }),
    cpuUsedPct: z.number().finite().min(0).max(100),
    memUsed: z.number().finite().nonnegative(),
    memTotal: z.number().finite().positive(),
  });
  // Shape of `instabox metrics <id> --json`: { metrics: [{ timestamp, cpuUsedPct, memUsed, memTotal, … }] }, oldest first.
  const parsed = z.object({ metrics: z.array(sample) }).safeParse(value);
  if (!parsed.success) return undefined;
  const latest = parsed.data.metrics
    .filter((s) => Date.parse(s.timestamp) <= now && now - Date.parse(s.timestamp) <= 5 * 60_000)
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))[0];
  if (!latest || latest.memUsed > latest.memTotal) return undefined;
  return {
    online: true,
    checkedAt: latest.timestamp,
    cpuPercent: latest.cpuUsedPct,
    memoryTotal: latest.memTotal,
    memoryAvailable: latest.memTotal - latest.memUsed,
  };
}
