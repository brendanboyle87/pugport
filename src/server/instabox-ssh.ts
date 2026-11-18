import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { InstaboxView } from '../shared/remote-servers.ts';
import type { InstaboxMonitor } from './instabox.ts';
import { checkSshForward } from './devices/ssh-tunnel.ts';

const idSchema = z.string().regex(/^m_[a-z0-9]+$/);
const stateSchema = z.object({
  entries: z.record(z.string(), z.string()).default({}),
  insertedInclude: z.string().optional(),
  createdConfig: z.boolean().optional(),
  managed: z.boolean().optional(),
});
type State = z.infer<typeof stateSchema>;
const aliasFor = (id: string) => `pugport-instabox-${createHash('sha256').update(id).digest('hex').slice(0, 7)}`;
const include = 'Include ~/.ssh/pugport-instabox.conf\n';

/** Only owner routes call mutations; background consumers only read the saved mapping and list. */
export class InstaboxSsh {
  private work: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly dataDir: string,
    readonly monitor: InstaboxMonitor,
    private readonly home = homedir(),
    private readonly ready = (alias: string, _remainingMs: number) => checkSshForward(alias, 22),
    private readonly forget: (alias: string) => void = () => {},
  ) {}
  private get file() {
    return join(this.dataDir, 'instabox-ssh.json');
  }
  private get directory() {
    return join(this.home, '.ssh');
  }
  private async regular(file: string) {
    try {
      const info = await lstat(file);
      if (info.isSymbolicLink() || (!info.isFile() && file !== this.directory))
        throw new Error('Unsafe SSH configuration path');
      if (file === this.directory && !info.isDirectory()) throw new Error('Unsafe SSH directory');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  private async state(): Promise<State> {
    try {
      return stateSchema.parse(JSON.parse(await readFile(this.file, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { entries: {} };
      throw error;
    }
  }
  private async atomic(file: string, text: string) {
    await this.regular(file);
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, text, { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  }
  private async save(state: State) {
    await mkdir(this.dataDir, { recursive: true });
    await this.atomic(this.file, JSON.stringify(state));
  }
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.work.catch(() => {}).then(run);
    this.work = next;
    return next;
  }
  async decorate(view: InstaboxView | undefined): Promise<InstaboxView | undefined> {
    await this.work.catch(() => {});
    const state = await this.state();
    if (!view && !state.managed) return undefined;
    return {
      ...view,
      sshManaged: state.managed,
      machines: (view?.machines ?? []).map((machine) => ({
        ...machine,
        ssh: state.entries[machine.machineId] ? aliasFor(machine.machineId) : undefined,
      })),
    };
  }
  async server(id: string) {
    await this.work.catch(() => {});
    idSchema.parse(id);
    const state = await this.state();
    if (!state.entries[id]) throw new Error('SSH entry is missing');
    return { name: id, ssh: aliasFor(id) };
  }
  async assertReachable(alias: string) {
    if (!alias.startsWith('pugport-instabox-')) return;
    await this.work.catch(() => {});
    const state = await this.state();
    const id = Object.keys(state.entries).find((id) => aliasFor(id) === alias);
    const machine = (await this.monitor.fresh())?.machines.find((machine) => machine.machineId === id);
    if (!machine || machine.stale || machine.pendingAction || machine.state !== 'running')
      throw new Error(`${machine?.name ?? alias} is paused; send from the PugPort window to wake it`);
  }
  async afterWake(id: string, remainingMs: number): Promise<boolean> {
    const state = await this.state();
    if (!state.entries[id]) return true;
    const alias = aliasFor(id);
    this.forget(alias);
    if (remainingMs < 3500) return false;
    return this.ready(alias, remainingMs);
  }
  prepare(id: string) {
    return this.serial(async () => {
      idSchema.parse(id);
      const state = await this.state();
      const raw = z.object({ id: z.string(), config: z.string() }).parse(await this.monitor.sshConfig(id));
      if (raw.id !== id) throw new Error('SSH configuration machine mismatch');
      const alias = aliasFor(id);
      if (Object.keys(state.entries).some((key) => key !== id && aliasFor(key) === alias))
        throw new Error('SSH alias collision');
      const values = new Map<string, string>();
      const permitted = new Set(['hostname', 'port', 'user', 'certificatefile', 'identityfile', 'identitiesonly']);
      for (const line of raw.config.split(/\r?\n/)) {
        const match = /^\s*(\S+)\s+(.+?)\s*$/.exec(line);
        if (!line.trim() || line.trim().startsWith('#')) continue;
        if (!match) throw new Error('Invalid SSH configuration');
        const key = match[1].toLowerCase();
        if (key === 'host') continue;
        if (!permitted.has(key) || values.has(key) || /[\x00-\x1f\x7f]/.test(match[2]))
          throw new Error('Unsupported SSH configuration; proxy commands are not allowed');
        values.set(key, match[2]);
      }
      if (!/^[a-zA-Z0-9][a-zA-Z0-9.:-]*$/.test(values.get('hostname') ?? '')) throw new Error('Invalid SSH host');
      if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(values.get('user') ?? '')) throw new Error('Invalid SSH user');
      if (!/^\d+$/.test(values.get('port') ?? '22')) throw new Error('Invalid SSH port');
      if (values.has('identitiesonly') && !/^(yes|no)$/i.test(values.get('identitiesonly')!))
        throw new Error('Invalid SSH identitiesonly');
      const port = Number(values.get('port') ?? '22');
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid SSH port');
      for (const key of ['certificatefile', 'identityfile']) {
        const value = values.get(key);
        if (value && (/[\x00-\x1f\x7f"`$%]/.test(value) || value.endsWith('\\')))
          throw new Error('Invalid SSH credential path');
      }
      const block =
        [
          `Host ${alias}`,
          ...[...values].map(([key, value]) => `  ${key} ${key.endsWith('file') ? `"${value}"` : value}`),
        ].join('\n') + '\n';
      await this.regular(this.directory);
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const configFile = join(this.directory, 'config');
      await this.regular(configFile);
      let config = '';
      let exists = true;
      try {
        config = await readFile(configFile, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        exists = false;
      }
      const entries = { ...state.entries, [id]: block };
      const managedFile = join(this.directory, 'pugport-instabox.conf');
      if (!state.managed) {
        try {
          await lstat(managedFile);
          throw new Error('Managed SSH file already exists without ownership');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      state.managed = true;
      await this.save(state);
      await this.atomic(managedFile, Object.values(entries).join('\n'));
      if (!config.split(/\r?\n/).some((line) => line.trim() === include.trim())) {
        state.insertedInclude = include;
        state.createdConfig = !exists;
        await this.save(state);
        await this.atomic(
          configFile,
          config.startsWith('\uFEFF') ? '\uFEFF' + include + config.slice(1) : include + config,
        );
      }
      state.entries = entries;
      await this.save(state);
      return { name: id, ssh: alias };
    });
  }
  remove() {
    return this.serial(async () => {
      const state = await this.state();
      await this.regular(this.directory);
      const file = join(this.directory, 'config');
      await this.regular(file);
      if (state.insertedInclude) {
        const config = await readFile(file, 'utf8').catch((error) => {
          if (error.code === 'ENOENT') return '';
          throw error;
        });
        const bom = config.startsWith('\uFEFF') ? '\uFEFF' : '';
        const body = config.slice(bom.length);
        const position = body.indexOf(state.insertedInclude);
        const restored =
          position >= 0 && (position === 0 || body[position - 1] === '\n')
            ? bom + body.slice(0, position) + body.slice(position + state.insertedInclude.length)
            : config;
        if (state.createdConfig && !restored)
          await unlink(file).catch((error) => {
            if (error.code !== 'ENOENT') throw error;
          });
        else if (restored !== config) await this.atomic(file, restored);
      }
      const managed = join(this.directory, 'pugport-instabox.conf');
      await this.regular(managed);
      if (state.managed)
        await unlink(managed).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
      await this.save({ entries: {} });
    });
  }
}
