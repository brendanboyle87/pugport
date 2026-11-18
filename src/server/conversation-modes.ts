import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  canAttachMod,
  modeActionRequestSchema,
  modeBindingRequestSchema,
  modeIdSchema,
  modeVersionSchema,
  modeVisibilityRequestSchema,
  type ConversationModeInstance,
  type ConversationModeView,
  type ConversationModesView,
  type ModeBinding,
  type ModeInstallation,
  type ModeCatalogEntry,
  type ModLocalBuild,
  type ModRunView,
  type WorkflowModeSnapshot,
} from '../shared/conversation-modes.ts';
import {
  MOD_APPROVAL_PERMISSIONS,
  modManifestSchema,
  modPermissionsToApprove,
  normalizeModManifest,
  validateModeState,
  type ModManifest,
  type ModPermission,
} from '../shared/mods-manifest.ts';
import type { Conversation, Workflow } from '../shared/types.ts';
import type { WorkspaceStore } from './workspace-store.ts';

export class ModeConflict extends Error {
  readonly status: number = 409;
}
/** Loading needs the user's approval first; the store asks once and loads again with the approved list. */
export class ModeApprovalRequired extends ModeConflict {
  readonly code = 'E_APPROVAL';
  constructor(readonly permissions: ModPermission[]) {
    super('This Mod version needs your approval for new permissions');
  }
}
const versionParts = (version: string) => version.split('.').map(BigInt);
/** Positive when a is the newer numeric version. */
export function compareModVersions(a: string, b: string): number {
  const left = versionParts(a);
  const right = versionParts(b);
  const index = left.findIndex((part, i) => part !== right[i]);
  return index < 0 ? 0 : left[index]! > right[index]! ? 1 : -1;
}
export class ModeStateError extends ModeConflict {
  readonly status: number;
  constructor(readonly code: 'E_INVALID' | 'E_CONFLICT' | 'E_UNAVAILABLE') {
    super(
      { E_INVALID: 'Invalid request.', E_CONFLICT: 'State revision changed.', E_UNAVAILABLE: 'Mod is unavailable.' }[
        code
      ],
    );
    this.status = code === 'E_INVALID' ? 400 : 409;
  }
}
const terminal = (workflow: Workflow) =>
  ['completed', 'failed', 'blocked', 'cancelled', 'interrupted'].includes(workflow.status);
type Host = {
  store: WorkspaceStore;
  requireConversation(id: string): Conversation;
  modeSwitchBarrier(id: string): string | undefined;
  notify(): void;
};
const manifestKey = (id: string, version: string) => `${id}@${version}`;
/** Drops empty fields from the joined workspace row; `incognito` is kept only when true. */
const localBuild = (json: string): ModLocalBuild => {
  const { workspaceId, conversationId, conversationTitle, incognito } = JSON.parse(json) as Record<string, unknown>;
  return {
    workspaceId: String(workspaceId),
    conversationId: String(conversationId),
    ...(typeof conversationTitle === 'string' ? { conversationTitle } : {}),
    ...(incognito === 1 || incognito === true ? { incognito: true } : {}),
  };
};

/** Local declarative data only; this module has no model, tool, filesystem or process capability. */
export class ConversationModes {
  constructor(private readonly host: Host) {}
  /** One-time cleanup of the retired built-in StudyHub mod. Keeps messages and mode instances. */
  retireBuiltIns(): void {
    const migrationId = 'mods-studyhub-retire-v1';
    const done = () => !!this.host.store.get<{ completed: boolean }>('migration', migrationId)?.completed;
    if (done()) return;
    this.host.store.transaction(() => {
      if (done()) return;
      const retired = 'studyhub.workbench';
      const rows = this.host.store.db
        .prepare(
          "SELECT value FROM workspace_records WHERE kind='conversation' AND (json_extract(value,'$.modeBinding.modeId')=? OR json_extract(value,'$.pendingModeBinding.binding.modeId')=?)",
        )
        .all(retired, retired) as { value: string }[];
      for (const row of rows) {
        const conversation = JSON.parse(row.value) as Conversation;
        if (conversation.modeBinding?.modeId === retired) delete conversation.modeBinding;
        if (conversation.pendingModeBinding?.binding?.modeId === retired) delete conversation.pendingModeBinding;
        this.host.store.save('conversation', conversation.id, conversation.projectId, conversation);
      }
      this.host.store.db.prepare("DELETE FROM workspace_records WHERE kind='mode-installation' AND id=?").run(retired);
      this.host.store.db
        .prepare("DELETE FROM workspace_records WHERE kind='mode-manifest' AND substr(id,1,?)=?")
        .run(retired.length + 1, `${retired}@`);
      this.host.store.save('migration', migrationId, migrationId, { completed: true });
    });
  }
  catalog(): ConversationModesView {
    const rows = this.host.store.db
      .prepare(
        `
      SELECT json_extract(value,'$.id') AS id, json_extract(value,'$.version') AS version,
        json_extract(value,'$.title') AS title, json_extract(value,'$.description') AS description,
        json_extract(value,'$.author') AS author, json_extract(value,'$.category') AS category,
        json_extract(value,'$.icon') AS icon, json_extract(value,'$.homepage') AS homepage,
        json_extract(value,'$.schemaVersion') AS schemaVersion,
        json_extract(value,'$.cover') AS cover, json_extract(value,'$.card') AS card, json_extract(value,'$.logo') AS logo,
        json_extract(value,'$.permissions') AS permissions,
        (SELECT json_object('workspaceId', build.id,
            'conversationId', json_extract(build.value,'$.conversationId'),
            'conversationTitle', (SELECT json_extract(chat.value,'$.title') FROM workspace_records AS chat
              WHERE chat.kind='conversation' AND chat.id=json_extract(build.value,'$.conversationId')
                AND json_extract(chat.value,'$.deletedAt') IS NULL),
            'incognito', (SELECT json_extract(chat.value,'$.incognito') FROM workspace_records AS chat
              WHERE chat.kind='conversation' AND chat.id=json_extract(build.value,'$.conversationId')))
          FROM workspace_records AS build WHERE build.kind='mod-workspace'
            AND json_extract(build.value,'$.modId')=json_extract(manifest.value,'$.id')
          ORDER BY build.updated_at DESC LIMIT 1) AS localBuild
      FROM workspace_records AS manifest WHERE kind='mode-manifest' AND owner='conversation-modes'
      ORDER BY updated_at DESC LIMIT 200
    `,
      )
      .all() as Record<string, string | number | null>[];
    return {
      catalog: rows.map(
        (row) =>
          ({
            ...Object.fromEntries(
              Object.entries(row)
                .filter(([, value]) => value !== null)
                .map(([key, value]) => [
                  key,
                  ['cover', 'card', 'logo', 'permissions'].includes(key)
                    ? JSON.parse(value as string)
                    : key === 'localBuild'
                      ? localBuild(value as string)
                      : value,
                ]),
            ),
            compatible: true,
          }) as ModeCatalogEntry,
      ),
      installed: this.host.store.list<ModeInstallation>('mode-installation', 'conversation-modes', 200),
    };
  }
  import(value: unknown): ConversationModesView {
    const manifest = modManifestSchema.parse(value);
    const key = manifestKey(manifest.id, manifest.version);
    const previous = this.host.store.get<ModManifest>('mode-manifest', key);
    if (previous && !isDeepStrictEqual(previous, manifest))
      throw new ModeConflict('This version already exists with different content');
    const save = () => {
      const versions = this.host.store.db
        .prepare(
          "SELECT id, json_extract(value,'$.version') AS version FROM workspace_records WHERE kind='mode-manifest' AND owner='conversation-modes' AND json_extract(value,'$.id')=?",
        )
        .all(manifest.id) as { id: string; version: string }[];
      const current = manifest.version.split('.').map(BigInt);
      const older = versions
        .filter(({ version }) => {
          const parts = version.split('.').map(BigInt);
          const first = parts.findIndex((part, index) => part !== current[index]);
          return first >= 0 && parts[first]! < current[first]!;
        })
        .map(({ id }) => id);
      if (older.length)
        this.host.store.db
          .prepare(
            `
        DELETE FROM workspace_records AS candidate WHERE kind='mode-manifest' AND owner='conversation-modes'
          AND id IN (${older.map(() => '?').join(',')})
          AND NOT EXISTS (SELECT 1 FROM workspace_records AS installed WHERE installed.kind='mode-installation'
            AND json_extract(installed.value,'$.modeId')=json_extract(candidate.value,'$.id')
            AND json_extract(installed.value,'$.version')=json_extract(candidate.value,'$.version'))
          AND NOT EXISTS (SELECT 1 FROM workspace_records AS instance WHERE instance.kind='mode-instance'
            AND json_extract(instance.value,'$.modeId')=json_extract(candidate.value,'$.id')
            AND json_extract(instance.value,'$.version')=json_extract(candidate.value,'$.version'))
          AND NOT EXISTS (SELECT 1 FROM workspace_records AS chat WHERE chat.kind='conversation' AND (
            (json_extract(chat.value,'$.modeBinding.modeId')=json_extract(candidate.value,'$.id')
              AND json_extract(chat.value,'$.modeBinding.version')=json_extract(candidate.value,'$.version')) OR
            (json_extract(chat.value,'$.pendingModeBinding.binding.modeId')=json_extract(candidate.value,'$.id')
              AND json_extract(chat.value,'$.pendingModeBinding.binding.version')=json_extract(candidate.value,'$.version'))))
      `,
          )
          .run(...older);
      const count = this.host.store.db
        .prepare(
          "SELECT COUNT(*) AS count FROM workspace_records WHERE kind='mode-manifest' AND owner='conversation-modes'",
        )
        .get() as { count: number };
      if (!previous && count.count >= 200) throw new ModeConflict('The local mode catalog is full');
      this.host.store.save('mode-manifest', key, 'conversation-modes', manifest);
    };
    // Source installs already wrap import and installation in one transaction.
    if (this.host.store.db.isTransaction) save();
    else this.host.store.transaction(save);
    this.host.notify();
    return this.catalog();
  }
  private manifest(modeId: string, version: string): ModManifest {
    const manifest = this.host.store.get<ModManifest>('mode-manifest', manifestKey(modeId, version));
    if (!manifest || manifest.id !== modeId || manifest.version !== version)
      throw new ModeConflict('Mode version is unavailable');
    return modManifestSchema.parse(manifest);
  }
  export(modeId: string, version: string): ModManifest {
    modeIdSchema.parse(modeId);
    modeVersionSchema.parse(version);
    return this.manifest(modeId, version);
  }
  /**
   * Loading a newer version moves every chat bound to an older one; a version that needs new permissions loads
   * only with the user's approval, asked once for all chats.
   */
  install(
    modeId: string,
    version: string | null,
    approvedPermissions: readonly ModPermission[] = [],
  ): ConversationModesView {
    modeIdSchema.parse(modeId);
    if (version !== null) {
      modeVersionSchema.parse(version);
      const permissions = normalizeModManifest(this.manifest(modeId, version)).permissions ?? [];
      const previous = this.host.store.get<ModeInstallation>('mode-installation', modeId);
      if (previous?.version !== version) {
        const missing = modPermissionsToApprove(permissions, previous && this.grantedFor(previous));
        if (missing.some((item) => !approvedPermissions.includes(item))) throw new ModeApprovalRequired(missing);
        const carried = previous ? this.grantedFor(previous).approved : [];
        const save = () => {
          this.host.store.save('mode-installation', modeId, 'conversation-modes', {
            modeId,
            version,
            installedAt: new Date().toISOString(),
            approvedPermissions: permissions.filter(
              (item) =>
                MOD_APPROVAL_PERMISSIONS.includes(item) &&
                (approvedPermissions.includes(item) || carried.includes(item)),
            ),
          } satisfies ModeInstallation);
          if (!previous || compareModVersions(version, previous.version) > 0) this.upgradeChats(modeId, version);
        };
        if (this.host.store.db.isTransaction) save();
        else this.host.store.transaction(save);
      }
    } else
      this.host.store.db.prepare("DELETE FROM workspace_records WHERE kind='mode-installation' AND id=?").run(modeId);
    this.host.notify();
    return this.catalog();
  }
  private grantedFor(installation: ModeInstallation) {
    let permissions: ModPermission[] = [];
    try {
      permissions = normalizeModManifest(this.manifest(installation.modeId, installation.version)).permissions ?? [];
    } catch {
      // A missing old manifest grants nothing, so the new version asks for everything it needs.
    }
    return { permissions, approved: installation.approvedPermissions ?? [] };
  }
  /** Permissions the bound version may use now: declared, and approved when it needs approval. */
  granted(binding: ModeBinding): ModPermission[] {
    const installation = this.host.store.get<ModeInstallation>('mode-installation', binding.modeId);
    if (installation?.version !== binding.version) return [];
    const { permissions, approved } = this.grantedFor(installation);
    return permissions.filter((item) => !MOD_APPROVAL_PERMISSIONS.includes(item) || approved.includes(item));
  }
  /** Chats on an older version (or waiting to switch to one) move to the newly loaded version. */
  private upgradeChats(modeId: string, version: string) {
    const rows = this.host.store.db
      .prepare(
        `SELECT value FROM workspace_records WHERE kind='conversation'
          AND json_extract(value,'$.deletedAt') IS NULL AND json_extract(value,'$.closedAt') IS NULL
          AND ((json_extract(value,'$.modeBinding.modeId')=? AND json_extract(value,'$.modeBinding.version')<>?)
            OR (json_extract(value,'$.pendingModeBinding.binding.modeId')=?
              AND json_extract(value,'$.pendingModeBinding.binding.version')<>?))`,
      )
      .all(modeId, version, modeId, version) as { value: string }[];
    for (const row of rows) {
      const conversation = JSON.parse(row.value) as Conversation;
      if (!this.eligible(conversation)) continue;
      const pending = conversation.pendingModeBinding;
      // A pending switch to another Mod or to removal stays as the user asked.
      if (pending && pending.binding?.modeId !== modeId) continue;
      const current = pending ? pending.binding! : conversation.modeBinding!;
      if (compareModVersions(version, current.version) <= 0) continue;
      this.applyBinding(conversation, {
        ...this.attach(conversation.id, modeId, version),
        ...(current.attachedAt ? { attachedAt: current.attachedAt } : {}),
      });
    }
  }
  private installed(modeId: string, version: string) {
    return this.host.store.get<ModeInstallation>('mode-installation', modeId)?.version === version;
  }
  private conversation(id: string, writable = false): Conversation {
    const conversation = this.host.requireConversation(id);
    if (writable && conversation.closedAt) throw new ModeConflict('This private conversation is closing');
    return conversation;
  }
  private eligible(conversation: Conversation) {
    return canAttachMod(conversation);
  }
  private instance(conversationId: string, binding: ModeBinding): ConversationModeInstance {
    const value = this.host.store.get<ConversationModeInstance>('mode-instance', binding.instanceId);
    if (
      !value ||
      value.id !== binding.instanceId ||
      value.conversationId !== conversationId ||
      value.modeId !== binding.modeId ||
      value.version !== binding.version ||
      (value.schemaVersion !== 1 && value.schemaVersion !== 2)
    )
      throw new ModeConflict('Mode instance does not belong to this conversation');
    return value;
  }
  view(conversationId: string): ConversationModeView {
    const conversation = this.conversation(conversationId);
    const binding = conversation.modeBinding ?? null;
    return {
      binding,
      pending: conversation.pendingModeBinding ?? null,
      instance: binding ? this.instance(conversationId, binding) : null,
      manifest: binding ? normalizeModManifest(this.manifest(binding.modeId, binding.version)) : null,
      installed: !!binding && this.installed(binding.modeId, binding.version),
      granted: binding ? this.granted(binding) : [],
      runs: binding ? this.runs(conversationId, binding.instanceId) : [],
    };
  }
  /** Run results are bounded; a panel that missed the event still sees the last few. */
  private runs(conversationId: string, instanceId: string): ModRunView[] {
    return this.host.store
      .list<ModRunView & { instanceId: string }>('mod-run', conversationId, 50)
      .filter((run) => run.instanceId === instanceId)
      .slice(0, 5)
      .map(({ id, status, text, error, saveTo, createdAt, finishedAt }) => ({
        id,
        status,
        ...(text !== undefined ? { text } : {}),
        ...(error ? { error } : {}),
        ...(saveTo ? { saveTo } : {}),
        createdAt,
        ...(finishedAt ? { finishedAt } : {}),
      }));
  }
  bind(conversationId: string, request: unknown): ConversationModeView {
    const input = modeBindingRequestSchema.parse(request);
    const conversation = this.conversation(conversationId, true);
    if (input.modeId && !this.eligible(conversation)) throw new ModeConflict('这类对话不能添加 Mod。');
    const version =
      input.version ??
      (input.modeId ? this.host.store.get<ModeInstallation>('mode-installation', input.modeId)?.version : undefined);
    if (input.modeId && (!version || (!input.restoreInstanceId && !this.installed(input.modeId, version))))
      throw new ModeConflict('Install this version before using it');
    this.host.store.transaction(() => {
      const effective = conversation.pendingModeBinding
        ? conversation.pendingModeBinding.binding
        : conversation.modeBinding;
      if (input.expectedInstanceId && effective?.instanceId !== input.expectedInstanceId)
        throw new ModeConflict('The selected Mod changed; reload before removing it');
      const restoreFrom =
        input.restoreFromInstanceId === undefined ? input.restoreInstanceId : input.restoreFromInstanceId;
      if (
        input.restoreInstanceId &&
        ((conversation.modeBinding &&
          conversation.modeBinding.instanceId !== restoreFrom &&
          conversation.modeBinding.instanceId !== input.restoreInstanceId) ||
          (conversation.pendingModeBinding?.binding &&
            conversation.pendingModeBinding.binding.instanceId !== input.restoreInstanceId))
      )
        throw new ModeConflict('The selected Mod changed; Undo is no longer available');
      let binding: ModeBinding | null = null;
      if (input.modeId && version)
        binding = {
          ...this.attach(conversationId, input.modeId, version, input.restoreInstanceId),
          attachedAt: new Date().toISOString(),
        };
      if (binding?.instanceId === effective?.instanceId && effective?.attachedAt)
        binding!.attachedAt = effective.attachedAt;
      this.applyBinding(conversation, binding);
    });
    this.host.notify();
    return this.view(conversationId);
  }
  /** Restores or creates this chat's instance for one version, carrying matching saved keys forward. */
  private attach(conversationId: string, modeId: string, version: string, restoreInstanceId?: string): ModeBinding {
    const manifest = this.manifest(modeId, version);
    const row = this.host.store.db
      .prepare(
        "SELECT value FROM workspace_records WHERE kind='mode-instance' AND owner=? AND json_extract(value,'$.modeId')=? AND json_extract(value,'$.version')=? LIMIT 1",
      )
      .get(conversationId, modeId, version) as { value: string } | undefined;
    let instance = restoreInstanceId
      ? this.instance(conversationId, { instanceId: restoreInstanceId, modeId, version })
      : row
        ? (JSON.parse(row.value) as ConversationModeInstance)
        : undefined;
    if (!instance) {
      const at = new Date().toISOString();
      const panel = normalizeModManifest(manifest).contributions?.rightPanel;
      const initial = validateModeState(
        manifest,
        Object.fromEntries(
          (panel?.kind === 'form' ? panel.form.fields : []).map((field) => [field.id, field.initialValue ?? '']),
        ),
      );
      let state = initial;
      const prior = this.host.store.db
        .prepare(
          "SELECT value FROM workspace_records WHERE kind='mode-instance' AND owner=? AND json_extract(value,'$.modeId')=? ORDER BY updated_at DESC LIMIT 1",
        )
        .get(conversationId, modeId) as { value: string } | undefined;
      if (prior) {
        const known = new Set(
          manifest.schemaVersion === 1
            ? manifest.view.fields.map((field) => field.id)
            : (manifest.state?.keys ?? []).map((field) => field.id),
        );
        const old = JSON.parse(prior.value) as ConversationModeInstance;
        try {
          state = validateModeState(manifest, {
            ...initial,
            ...Object.fromEntries(Object.entries(old.state).filter(([id]) => known.has(id))),
          });
        } catch {
          // A version may narrow its state limits; its own initial values remain valid.
        }
      }
      instance = {
        id: randomUUID(),
        conversationId,
        modeId,
        version,
        schemaVersion: manifest.schemaVersion,
        revision: 0,
        createdAt: at,
        updatedAt: at,
        state,
      };
      this.host.store.save('mode-instance', instance.id, conversationId, instance);
    }
    const binding = { instanceId: instance.id, modeId, version };
    this.instance(conversationId, binding);
    return binding;
  }
  /** Switches now, or after the running turn when one is in flight. Caller holds the write transaction. */
  private applyBinding(conversation: Conversation, binding: ModeBinding | null) {
    const barrier = this.host.modeSwitchBarrier(conversation.id);
    if (barrier && binding?.instanceId !== conversation.modeBinding?.instanceId)
      conversation.pendingModeBinding = { binding, afterWorkflowId: barrier, requestedAt: new Date().toISOString() };
    else {
      if (binding) conversation.modeBinding = binding;
      else {
        delete conversation.modeBinding;
        delete conversation.modeHidden;
      }
      delete conversation.pendingModeBinding;
    }
    this.host.store.save('conversation', conversation.id, conversation.projectId, conversation);
  }
  setHidden(conversationId: string, request: unknown): Conversation {
    const { hidden, expectedInstanceId } = modeVisibilityRequestSchema.parse(request);
    const conversation = this.host.store.transaction(() => {
      const conversation = this.conversation(conversationId, true);
      if (!this.eligible(conversation)) throw new ModeConflict('这类对话不能添加 Mod。');
      if (!conversation.modeBinding) throw new ModeConflict('No Mod is attached to this conversation');
      if (
        expectedInstanceId &&
        (conversation.modeBinding.instanceId !== expectedInstanceId || conversation.pendingModeBinding)
      )
        throw new ModeConflict('The selected Mod changed; reload before opening it');
      if (hidden) conversation.modeHidden = true;
      else delete conversation.modeHidden;
      this.host.store.save('conversation', conversation.id, conversation.projectId, conversation);
      return conversation;
    });
    this.host.notify();
    return conversation;
  }
  action(conversationId: string, request: unknown): ConversationModeView {
    const parsed = modeActionRequestSchema.safeParse(request);
    if (!parsed.success) throw new ModeStateError('E_INVALID');
    const { instanceId, expectedRevision, action } = parsed.data;
    // Read the binding and revision under the same write lock as the mutation.
    this.host.store.transaction(() => {
      let conversation: Conversation;
      try {
        conversation = this.conversation(conversationId, true);
      } catch {
        throw new ModeStateError('E_UNAVAILABLE');
      }
      const binding = conversation.modeBinding;
      if (
        !this.eligible(conversation) ||
        !binding ||
        !this.installed(binding.modeId, binding.version) ||
        binding.instanceId !== instanceId
      )
        throw new ModeStateError('E_UNAVAILABLE');
      let instance: ConversationModeInstance;
      let manifest: ModManifest;
      try {
        instance = this.instance(conversationId, binding);
        manifest = this.manifest(binding.modeId, binding.version);
      } catch {
        throw new ModeStateError('E_UNAVAILABLE');
      }
      if (instance.revision !== expectedRevision) throw new ModeStateError('E_CONFLICT');
      try {
        const values = validateModeState(manifest, action.values);
        instance.state = validateModeState(manifest, { ...instance.state, ...values });
      } catch {
        throw new ModeStateError('E_INVALID');
      }
      instance.revision++;
      instance.updatedAt = new Date().toISOString();
      this.host.store.save('mode-instance', instance.id, conversationId, instance);
    });
    this.host.notify();
    return this.view(conversationId);
  }
  /**
   * Writes one model-run result into the chat's current instance of the same Mod (after an update, the new one).
   * Only that key changes, so newer edits to other keys survive; false when the key no longer fits.
   */
  saveRunOutput(conversationId: string, modeId: string, key: string, value: string): boolean {
    let saved = false;
    const write = () => {
      const conversation = this.host.store.get<Conversation>('conversation', conversationId);
      const binding = conversation?.modeBinding;
      if (!conversation || conversation.deletedAt || conversation.closedAt || binding?.modeId !== modeId) return;
      try {
        const instance = this.instance(conversationId, binding);
        const manifest = this.manifest(binding.modeId, binding.version);
        instance.state = validateModeState(manifest, { ...instance.state, [key]: value });
        instance.revision++;
        instance.updatedAt = new Date().toISOString();
        this.host.store.save('mode-instance', instance.id, conversationId, instance);
        saved = true;
      } catch {
        // Undeclared after an update, or over the state limits: the run reports E_LIMIT instead.
      }
    };
    if (this.host.store.db.isTransaction) write();
    else this.host.store.transaction(write);
    return saved;
  }
  capture(conversationId: string): WorkflowModeSnapshot | undefined {
    const conversation = this.conversation(conversationId, true);
    const binding = conversation.modeBinding;
    if (!this.eligible(conversation)) return undefined;
    if (!binding) return undefined;
    return { binding: { ...binding }, revision: this.instance(conversationId, binding).revision };
  }
  settled(workflow: Workflow) {
    if (!terminal(workflow)) return;
    const conversation = this.host.store.get<Conversation>('conversation', workflow.conversationId);
    if (
      !conversation ||
      conversation.deletedAt ||
      conversation.closedAt ||
      conversation.pendingModeBinding?.afterWorkflowId !== workflow.id
    )
      return;
    this.applyPending(conversation);
  }
  private applyPending(conversation: Conversation) {
    const pending = conversation.pendingModeBinding!;
    if (pending.binding && !this.eligible(conversation)) {
      delete conversation.pendingModeBinding;
      this.host.store.save('conversation', conversation.id, conversation.projectId, conversation);
      this.host.notify();
      return;
    }
    const barrier = this.host.modeSwitchBarrier(conversation.id);
    if (barrier) pending.afterWorkflowId = barrier;
    else {
      if (pending.binding) {
        this.instance(conversation.id, pending.binding);
        conversation.modeBinding = pending.binding;
      } else {
        delete conversation.modeBinding;
        delete conversation.modeHidden;
      }
      delete conversation.pendingModeBinding;
    }
    this.host.store.save('conversation', conversation.id, conversation.projectId, conversation);
    this.host.notify();
  }
  recover() {
    const rows = this.host.store.db
      .prepare(
        "SELECT value FROM workspace_records WHERE kind='conversation' AND json_type(value,'$.pendingModeBinding')='object' AND json_extract(value,'$.deletedAt') IS NULL AND json_extract(value,'$.closedAt') IS NULL",
      )
      .all() as { value: string }[];
    for (const row of rows) this.applyPending(JSON.parse(row.value) as Conversation);
  }
}
