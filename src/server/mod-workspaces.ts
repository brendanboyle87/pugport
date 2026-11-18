import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeModManifest, type ModPermission } from '../shared/mods-manifest.ts';
import { modDebugDigest, type ModDiagnostic } from '../shared/mod-debug.ts';
import type { Conversation, Project } from '../shared/types.ts';
import { ModeApprovalRequired, ModeConflict, type ConversationModes } from './conversation-modes.ts';
import { assertModRoot, ModPackError, packModDirectory, saveDevVersion, unpackMod } from './mod-pack.ts';
import type { WorkspaceStore } from './workspace-store.ts';

/** One authoring folder per Mods author chat; the folder is PugPort's own build area, not user data. */
export type ModWorkspaceRecord = {
  id: string;
  conversationId: string;
  path: string;
  modId?: string;
  latestVersion?: string;
  lastLoadAt?: string;
  /** The last mod_load result as shown to the executor (validation, warnings, permissions). */
  lastLoad?: ModLoadSummary;
  /** The newest frame diagnostics, kept across restarts; the live buffer holds more. */
  diagnostics?: ModDiagnostic[];
  createdAt: string;
};
export type ModLoadSummary = {
  ok: boolean;
  id?: string;
  version?: string;
  sha256?: string;
  issues?: string[];
  warnings?: string[];
  needsApproval?: string[];
};

/** What mod_load tells the executor: saved and live are separate, and nothing is installed without the user. */
export type ModLoadResult = {
  loaded: boolean;
  /** Bound, but the chat shows it only when the current turn ends. */
  pending?: boolean;
  id?: string;
  version?: string;
  sha256?: string;
  bytes?: number;
  warnings: string[];
  issues?: string[];
  permissions?: ModPermission[];
  needsApproval?: ModPermission[];
  notes: string[];
};

const kind = 'mod-workspace';
const liveDiagnostics = 200;
const savedDiagnostics = 50;
const loadInterval = 10_000;
const owner = 'mods';
/** src/server or dist/server → the checkout, where docs/ ships with the app. */
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const inside = (parent: string, child: string) => {
  const path = relative(parent, child);
  return path === '' || (!!path && !path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
};
const real = (path: string) => (existsSync(path) ? realpathSync.native(path) : resolve(path));

/** docs/MODS.md sections 1–6 and 9: the interface. Packaging and acceptance come back in mod_load results. */
export function modSpec(markdown: string): string {
  const parts = markdown.split(/^(?=## )/m);
  const kept = parts.filter((part, index) => index === 0 || /^## (?:[1-6]|9)\. /.test(part));
  return `<!-- Copied by PugPort from docs/MODS.md (sections 1–6 and 9). Read-only reference; edits are not kept. -->\n\n${kept.join('').trimEnd()}\n`;
}

function packageBuildScript(folder: string) {
  try {
    const value = JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8')) as { scripts?: { build?: unknown } };
    return typeof value.scripts?.build === 'string';
  } catch {
    return false;
  }
}

export class ModWorkspaces {
  constructor(
    private readonly host: {
      store: WorkspaceStore;
      dataDir: string;
      requireConversation(id: string): Conversation;
      notify(conversationId: string): void;
      modes(): ConversationModes;
    },
    private readonly assets = sourceRoot,
  ) {}
  get root() {
    return join(this.host.dataDir, 'mods-workspace');
  }
  get(id: string) {
    return this.host.store.get<ModWorkspaceRecord>(kind, id);
  }
  chat(conversationId: string) {
    return this.host.requireConversation(conversationId);
  }
  forConversation(conversationId: string) {
    const id = this.host.requireConversation(conversationId).modWorkspaceId;
    return id ? this.get(id) : undefined;
  }
  /** Local builds by Mod id, newest first. */
  list() {
    return this.host.store.list<ModWorkspaceRecord>(kind, owner, 500);
  }
  /** Refuses project folders and PugPort's own data, except the mods-workspace area. */
  checkPath(path: string) {
    if (!isAbsolute(path)) throw new Error('Mod 工作文件夹需要绝对路径。');
    const target = real(path);
    const data = real(this.host.dataDir);
    if (inside(data, target) && !inside(real(this.root), target))
      throw new Error('Mod 工作文件夹不能放在 PugPort 数据文件夹里（mods-workspace 除外）。');
    for (const project of this.host.store.projects() as Project[])
      if (project.scope !== 'chat' && !project.removedAt && inside(real(project.path), target))
        throw new Error('Mod 工作文件夹不能放在已添加的项目里。');
    return target;
  }
  /** The chat's workspace, created and seeded on first use. */
  ensure(conversationId: string, path?: string): ModWorkspaceRecord {
    const existing = this.forConversation(conversationId);
    if (existing && !path) return existing;
    const conversation = this.host.requireConversation(conversationId);
    const id = randomBytes(5).toString('hex');
    const folder = path ? this.checkPath(path) : join(this.root, id);
    if (existing && path && relative(existing.path, folder) === '') return existing;
    // Change…: an empty folder, or one that already has the author layout. A build script there is never run.
    if (path && existsSync(folder)) {
      const names = readdirSync(folder).filter((name) => name !== '.pugport');
      if (names.length && !names.includes('manifest.json'))
        throw new Error('这个文件夹不是 Mod 作者布局：请选空文件夹，或含 manifest.json 和 ui/ 的文件夹。');
    }
    mkdirSync(folder, { recursive: true });
    this.seed(folder, id, conversationId);
    const record: ModWorkspaceRecord = {
      id,
      conversationId,
      path: realpathSync.native(folder),
      createdAt: new Date().toISOString(),
    };
    this.host.store.transaction(() => {
      this.host.store.save(kind, id, owner, record);
      this.host.store.save('conversation', conversation.id, conversation.projectId, {
        ...conversation,
        modWorkspaceId: id,
      });
    });
    this.host.notify(conversationId);
    return record;
  }
  /**
   * Store › Edit in chat for a Mod imported as JSON: this chat's new folder gets the Mod unpacked into the author
   * layout, and the folder counts as that Mod's Local build from now on.
   */
  async fromManifest(conversationId: string, manifest: unknown) {
    const record = this.ensure(conversationId);
    const unpacked = await unpackMod(manifest, record.path);
    const next: ModWorkspaceRecord = { ...record, modId: unpacked.id, latestVersion: unpacked.version };
    this.host.store.save(kind, record.id, owner, next);
    this.host.notify(conversationId);
    return next;
  }
  /** Binds an existing workspace (Store › Edit in chat) to another chat. */
  attach(id: string, conversationId: string) {
    const record = this.get(id);
    if (!record) throw new Error('Mod 工作文件夹记录不存在。');
    const conversation = this.host.requireConversation(conversationId);
    const next = { ...record, conversationId };
    this.host.store.transaction(() => {
      this.host.store.save(kind, id, owner, next);
      this.host.store.save('conversation', conversation.id, conversation.projectId, {
        ...conversation,
        modWorkspaceId: id,
        workMode: 'mods-author',
      });
    });
    this.host.notify(conversationId);
    return next;
  }
  private lastLoad = new Map<string, number>();
  private live = new Map<string, ModDiagnostic[]>();
  /** Observations posted by this chat's Mod frames: data for the next turn, never instructions. */
  addDiagnostics(id: string, entries: readonly ModDiagnostic[]) {
    const record = this.get(id);
    if (!record) throw new Error('Mod 工作文件夹记录不存在。');
    const all = [...this.diagnostics(id), ...entries].sort((a, b) => a.at - b.at).slice(-liveDiagnostics);
    this.live.set(id, all);
    this.host.store.save(kind, id, owner, { ...record, diagnostics: all.slice(-savedDiagnostics) });
    return all.length;
  }
  diagnostics(id: string): ModDiagnostic[] {
    return this.live.get(id) ?? this.get(id)?.diagnostics ?? [];
  }
  /** The bounded <pugport-mod-debug> block for a turn: entries after `since`; empty when nothing happened. */
  digest(conversationId: string, since: number) {
    const record = this.forConversation(conversationId);
    return record ? modDebugDigest(this.diagnostics(record.id), since) : '';
  }
  /** mod_load: pack → validate → import → install → bind to this chat, through the ordinary Mods methods. */
  async load(conversationId: string, options: { bump?: 'patch' | 'none'; now?: number } = {}): Promise<ModLoadResult> {
    const record = this.forConversation(conversationId);
    if (!record) throw new Error('This chat has no Mod workspace yet.');
    const now = options.now ?? Date.now();
    const last = this.lastLoad.get(record.id);
    if (last !== undefined && now - last < loadInterval)
      throw new Error(
        `mod_load runs at most once every 10 seconds; try again in ${Math.ceil((loadInterval - (now - last)) / 1000)} s.`,
      );
    this.lastLoad.set(record.id, now);
    const notes: string[] = [];
    const fail = (issues: string[]): ModLoadResult => {
      this.recordLoad(record.id, { ok: false, issues });
      return { loaded: false, issues, warnings: [], notes };
    };
    let packed: Awaited<ReturnType<typeof packModDirectory>>;
    try {
      assertModRoot(record.path);
      if (packageBuildScript(record.path))
        notes.push(
          'package.json has a build script. PugPort runs nothing from the folder; it packed manifest.json, README.md and ui/ as they are.',
        );
      packed = await packModDirectory(record.path, { dev: options.bump === 'patch' });
    } catch (error) {
      if (error instanceof ModPackError) return fail(error.issues);
      throw error;
    }
    const { manifest } = packed;
    if (record.modId !== manifest.id && this.host.store.get('mode-installation', manifest.id))
      return fail(['id: already used by another Mod']);
    const modes = this.host.modes();
    try {
      modes.import(manifest);
    } catch (error) {
      if (!(error instanceof ModeConflict)) throw error;
      return fail([
        /different content/.test(error.message)
          ? `version: ${manifest.version} is already loaded with different content; call mod_load with bump "patch"`
          : error.message,
      ]);
    }
    if (options.bump === 'patch') await saveDevVersion(packed);
    const permissions = normalizeModManifest(manifest).permissions ?? [];
    let needsApproval: ModPermission[] | undefined;
    try {
      modes.install(manifest.id, manifest.version);
    } catch (error) {
      if (!(error instanceof ModeApprovalRequired)) throw error;
      needsApproval = error.permissions;
    }
    const conversation = this.host.requireConversation(conversationId);
    let loaded = false;
    let pending = false;
    if (needsApproval) {
      this.host.store.save('conversation', conversation.id, conversation.projectId, {
        ...conversation,
        modApproval: {
          modeId: manifest.id,
          version: manifest.version,
          title: manifest.title,
          permissions: needsApproval,
          requestedAt: new Date(now).toISOString(),
        },
      } satisfies Conversation);
      notes.push(
        'Saved, not installed: the user must approve the listed permissions in this chat. You cannot approve them.',
      );
    } else {
      if (conversation.modApproval) {
        delete conversation.modApproval;
        this.host.store.save('conversation', conversation.id, conversation.projectId, conversation);
      }
      const view = modes.bind(conversationId, { modeId: manifest.id, version: manifest.version });
      loaded = view.binding?.modeId === manifest.id && view.binding.version === manifest.version;
      pending = !loaded && view.pending?.binding?.version === manifest.version;
      if (pending) notes.push('Loaded; it appears in this chat when the current turn ends.');
    }
    this.recordLoad(record.id, {
      ok: true,
      id: manifest.id,
      version: manifest.version,
      sha256: packed.sha256,
      warnings: packed.warnings,
      ...(needsApproval ? { needsApproval } : {}),
    });
    this.host.notify(conversationId);
    return {
      loaded,
      ...(pending ? { pending } : {}),
      id: manifest.id,
      version: manifest.version,
      sha256: packed.sha256,
      bytes: packed.bytes,
      warnings: packed.warnings,
      permissions,
      ...(needsApproval ? { needsApproval } : {}),
      notes,
    };
  }
  /** The user's answer to the approval card: install with the approved permissions and bind, or dismiss. */
  approve(
    conversationId: string,
    answer: Pick<NonNullable<Conversation['modApproval']>, 'modeId' | 'version' | 'permissions'> & {
      approved: boolean;
    },
  ) {
    const request = this.host.requireConversation(conversationId).modApproval;
    const permissions = request && [...request.permissions].sort();
    if (
      !request ||
      answer.modeId !== request.modeId ||
      answer.version !== request.version ||
      answer.permissions.length !== request.permissions.length ||
      [...answer.permissions].sort().some((permission, index) => permission !== permissions![index])
    )
      throw new ModeConflict('待批准的 Mod 已变化，请查看当前权限后再回答。');
    const { approved } = answer;
    if (approved) {
      const modes = this.host.modes();
      modes.install(request.modeId, request.version, request.permissions);
      modes.bind(conversationId, { modeId: request.modeId, version: request.version });
    }
    const latest = this.host.requireConversation(conversationId);
    delete latest.modApproval;
    this.host.store.save('conversation', latest.id, latest.projectId, latest);
    const record = latest.modWorkspaceId ? this.get(latest.modWorkspaceId) : undefined;
    if (approved && record?.lastLoad) {
      const { needsApproval: _approved, ...rest } = record.lastLoad;
      this.recordLoad(record.id, rest);
    }
    this.host.notify(conversationId);
    return latest;
  }
  recordLoad(id: string, summary: ModLoadSummary) {
    const record = this.get(id);
    if (!record) return;
    const at = new Date().toISOString();
    this.host.store.save(kind, id, owner, {
      ...record,
      lastLoadAt: at,
      lastLoad: summary,
      ...(summary.ok && summary.id ? { modId: summary.id, latestVersion: summary.version } : {}),
    } satisfies ModWorkspaceRecord);
  }
  /** Host-owned reference files; the author's own files (manifest.json, ui/, README.md) are never overwritten. */
  private seed(folder: string, id: string, conversationId: string) {
    const host = join(folder, '.pugport');
    mkdirSync(join(folder, 'ui'), { recursive: true });
    mkdirSync(host, { recursive: true });
    const docs = join(this.assets, 'docs');
    const spec = join(docs, 'MODS.md');
    writeFileSync(
      join(host, 'MOD-SPEC.md'),
      existsSync(spec)
        ? modSpec(readFileSync(spec, 'utf8'))
        : '# PugPort Mods\n\nThe Mod specification was not found in this PugPort installation.\n',
    );
    const types = join(docs, 'examples', 'mods', 'pugport-mod.d.ts');
    if (existsSync(types)) cpSync(types, join(host, 'pugport-mod.d.ts'));
    const example = join(docs, 'examples', 'mods', 'reading-notes');
    if (existsSync(example)) cpSync(example, join(host, 'example'), { recursive: true });
    writeFileSync(
      join(host, 'workspace.json'),
      `${JSON.stringify({ id, conversationId, note: 'Owned by PugPort. Edit manifest.json, README.md and ui/ instead.' }, null, 2)}\n`,
    );
  }
}
