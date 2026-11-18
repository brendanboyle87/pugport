import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { MODE_SOURCE_CATALOG_MAX_BYTES, MODE_SOURCE_PACKAGE_MAX_BYTES } from '../shared/conversation-modes.ts';
import {
  modCatalogMetadataSchema,
  modManifestSchema,
  MOD_PACKAGE_MAX_BYTES,
  type ModManifest,
} from '../shared/mods-manifest.ts';
import {
  modeSourceCatalogSchema,
  modeSourceConfigSchema,
  modeSourceInstallSchema,
  modeSourceRevisionSchema,
  type ModeSourceCatalog,
  type ModeSourceConfig,
  type ModeSourceView,
} from '../shared/mode-source.ts';
import { ghTokenSource, type GitHubTokenSource } from './github.ts';
import type { ConversationModes } from './conversation-modes.ts';
import type { WorkspaceStore } from './workspace-store.ts';

export class ModeSourceError extends Error {
  readonly status = 409;
}
type Context = {
  config: ModeSourceConfig;
  generation: number;
  controller: AbortController;
  signal: AbortSignal;
  token: string;
};
type Cache = { key: string; revision: string; entries: ModeSourceCatalog['mods']; at: number };
const sourceId = 'github';
const sourceOwner = 'conversation-modes';
const keyOf = (config: ModeSourceConfig) => JSON.stringify(config);
const metadata = ({ path: _path, sha256: _digest, ...value }: ModeSourceCatalog['mods'][number]) => value;

/** Only GitHub-hosted declarative data is read; credentials never leave this host. */
export class ModeSource {
  private cache?: Cache;
  private error?: string;
  private checkedAt?: string;
  private generation = 0;
  private closed = false;
  private requests = new Set<AbortController>();
  private pending?: { generation: number; promise: Promise<ModeSourceView> };
  constructor(
    private store: WorkspaceStore,
    private modes: ConversationModes,
    private options: {
      tokenSource?: GitHubTokenSource;
      fetch?: typeof fetch;
      now?: () => number;
      notify?: () => void;
    } = {},
  ) {}
  private now() {
    return (this.options.now ?? Date.now)();
  }
  private config(): ModeSourceConfig | null {
    const saved = this.store.get<unknown>('mode-source', sourceId);
    const parsed = modeSourceConfigSchema.safeParse(saved);
    return parsed.success ? parsed.data : null;
  }
  view(): ModeSourceView {
    if (this.closed) return { config: null, status: 'unconfigured', catalog: [] };
    const config = this.config();
    const cache = config?.enabled && this.cache?.key === keyOf(config) ? this.cache : undefined;
    return {
      config,
      status: !config?.enabled ? 'unconfigured' : this.error ? 'error' : cache ? 'ready' : 'unconfigured',
      catalog: cache?.entries.map((item) => ({ ...metadata(item), compatible: true as const })) ?? [],
      ...(cache ? { revision: cache.revision } : {}),
      ...(this.checkedAt ? { checkedAt: this.checkedAt } : {}),
      ...(config?.enabled && this.error ? { error: this.error } : {}),
    };
  }
  configure(input: unknown): ModeSourceView {
    if (this.closed) throw new ModeSourceError('Mod 源已关闭。');
    const config = modeSourceConfigSchema.parse(input);
    if (isDeepStrictEqual(config, this.config())) return this.view();
    this.generation++;
    for (const request of this.requests) request.abort();
    this.pending = undefined;
    this.cache = undefined;
    this.error = undefined;
    this.checkedAt = undefined;
    this.store.save('mode-source', sourceId, sourceOwner, config);
    this.options.notify?.();
    return this.view();
  }
  close() {
    this.closed = true;
    this.generation++;
    for (const request of this.requests) request.abort();
  }
  private active(context: Pick<Context, 'config' | 'generation'>) {
    return (
      !this.closed && context.generation === this.generation && keyOf(context.config) === JSON.stringify(this.config())
    );
  }
  private assertActive(context: Pick<Context, 'config' | 'generation'>) {
    if (!this.active(context)) throw new ModeSourceError('Mod 源已更改，请重试。');
  }
  private async context(): Promise<Context> {
    if (this.closed) throw new ModeSourceError('Mod 源已关闭。');
    const config = this.config();
    if (this.closed || !config?.enabled) throw new ModeSourceError('请先连接并启用 GitHub Mod 源。');
    const generation = this.generation;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
    this.requests.add(controller);
    try {
      const { token } = await (this.options.tokenSource ?? ghTokenSource)(signal);
      if (!token) throw new Error('Missing token');
      this.assertActive({ config, generation });
      return { config, generation, controller, signal, token };
    } catch (error) {
      this.requests.delete(controller);
      if (error instanceof ModeSourceError) throw error;
      throw new ModeSourceError('无法读取 GitHub 登录，请先在本机登录 GitHub CLI。');
    }
  }
  private async bytes(
    context: Context,
    path: string,
    limit: number,
    accept = 'application/vnd.github+json',
  ): Promise<Uint8Array> {
    this.assertActive(context);
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(
        `https://api.github.com/repos/${context.config.repository}/${path}`,
        {
          headers: {
            Authorization: `Bearer ${context.token}`,
            Accept: accept,
            'X-GitHub-Api-Version': '2022-11-28',
          },
          redirect: 'error',
          signal: context.signal,
        },
      );
    } catch {
      throw new ModeSourceError('GitHub Mod 源暂时无法访问，请稍后重试。');
    }
    this.assertActive(context);
    if (
      !response.ok ||
      response.redirected ||
      (response.url && new URL(response.url).origin !== 'https://api.github.com')
    ) {
      await response.body?.cancel().catch(() => {});
      throw new ModeSourceError('无法访问 GitHub Mod 源，请检查登录、仓库权限和引用。');
    }
    if (Number(response.headers.get('content-length')) > limit) {
      await response.body?.cancel().catch(() => {});
      throw new ModeSourceError('Mod 源文件超过大小限制。');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new ModeSourceError('Mod 源返回了空文件。');
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > limit) throw new ModeSourceError('Mod 源文件超过大小限制。');
        chunks.push(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      if (error instanceof ModeSourceError) throw error;
      throw new ModeSourceError('Mod 源文件读取失败，请重试。');
    } finally {
      reader.releaseLock();
    }
    this.assertActive(context);
    return Buffer.concat(chunks, length);
  }
  private json(bytes: Uint8Array): unknown {
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      throw new ModeSourceError('Mod 源文件不是有效的 UTF-8 JSON。');
    }
  }
  private async catalog(context: Context, revision: string) {
    const bytes = await this.bytes(
      context,
      `contents/${context.config.catalogPath}?ref=${revision}`,
      MODE_SOURCE_CATALOG_MAX_BYTES,
      'application/vnd.github.raw+json',
    );
    const parsed = modeSourceCatalogSchema.safeParse(this.json(bytes));
    if (!parsed.success) throw new ModeSourceError('Mod 源目录格式无效。');
    return parsed.data.mods;
  }
  async refresh(force = false): Promise<ModeSourceView> {
    if (this.closed) return this.view();
    const config = this.config();
    if (!config?.enabled || this.closed) return this.view();
    if (this.pending?.generation === this.generation) return this.pending.promise;
    if (!force && this.cache?.key === keyOf(config) && this.now() - this.cache.at < 30_000 && !this.error)
      return this.view();
    const generation = this.generation;
    const promise = (async () => {
      let context: Context | undefined;
      try {
        context = await this.context();
        const commit = await this.bytes(
          context,
          `commits/${encodeURIComponent(config.ref)}`,
          1024,
          'application/vnd.github.sha',
        );
        const revision = modeSourceRevisionSchema.safeParse(Buffer.from(commit).toString('utf8').trim());
        if (!revision.success) throw new ModeSourceError('GitHub 返回了无效的版本标识。');
        const entries = await this.catalog(context, revision.data);
        this.assertActive(context);
        this.cache = { key: keyOf(config), revision: revision.data, entries, at: this.now() };
        this.error = undefined;
      } catch (error) {
        if (generation === this.generation && !this.closed)
          this.error = error instanceof ModeSourceError ? error.message : 'GitHub Mod 源暂时不可用。';
      } finally {
        if (context) this.requests.delete(context.controller);
        if (generation === this.generation && !this.closed) {
          this.checkedAt = new Date(this.now()).toISOString();
          this.options.notify?.();
        }
      }
      return this.view();
    })();
    const pending = { generation, promise };
    this.pending = pending;
    try {
      return await promise;
    } finally {
      if (this.pending === pending) this.pending = undefined;
    }
  }
  async download(input: unknown): Promise<ModManifest> {
    const requested = modeSourceInstallSchema.parse(input);
    const context = await this.context();
    try {
      const entries =
        this.cache?.key === keyOf(context.config) && this.cache.revision === requested.revision
          ? this.cache.entries
          : await this.catalog(context, requested.revision);
      const entry = entries.find((item) => item.id === requested.id && item.version === requested.version);
      if (!entry) throw new ModeSourceError('所选 Mod 版本不在这个目录中，请刷新后重试。');
      const path = entry.path.split('/').map(encodeURIComponent).join('/');
      const bytes = await this.bytes(
        context,
        `contents/${path}?ref=${requested.revision}`,
        (entry.schemaVersion ?? 1) === 2 ? MOD_PACKAGE_MAX_BYTES : MODE_SOURCE_PACKAGE_MAX_BYTES,
        'application/vnd.github.raw+json',
      );
      if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256)
        throw new ModeSourceError('Mod 文件校验失败，未安装。');
      const manifest = modManifestSchema.safeParse(this.json(bytes));
      if (!manifest.success) throw new ModeSourceError('Mod 包格式无效，未安装。');
      const keys = Object.keys(modCatalogMetadataSchema.shape).filter(
        (key) => key !== 'schemaVersion' && key !== 'permissions',
      );
      const pickMetadata = (value: object) =>
        Object.fromEntries(
          keys.filter((key) => Object.hasOwn(value, key)).map((key) => [key, (value as Record<string, unknown>)[key]]),
        );
      const permissions = manifest.data.schemaVersion === 2 ? (manifest.data.permissions ?? []) : [];
      if (
        !isDeepStrictEqual(pickMetadata(manifest.data), pickMetadata(entry)) ||
        manifest.data.schemaVersion !== (entry.schemaVersion ?? 1) ||
        !isDeepStrictEqual(permissions, entry.permissions ?? [])
      )
        throw new ModeSourceError('Mod 包与目录信息不一致，未安装。');
      this.assertActive(context);
      return manifest.data;
    } finally {
      this.requests.delete(context.controller);
    }
  }
  async install(input: unknown) {
    const generation = this.generation;
    const approvedPermissions = modeSourceInstallSchema.parse(input).approvedPermissions ?? [];
    const manifest = await this.download(input);
    if (generation !== this.generation || this.closed) throw new ModeSourceError('Mod 源已更改，请重试。');
    return this.store.transaction(() => {
      this.modes.import(manifest);
      return this.modes.install(manifest.id, manifest.version, approvedPermissions);
    });
  }
}
