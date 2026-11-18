import { z } from 'zod';
import {
  MOD_APPROVAL_PERMISSIONS,
  modManifestV2Schema,
  validateModeState,
  type ModManifestV2,
  type ModPermission,
} from '../../shared/mods-manifest';
import { modDataMethodSchemas, modDataPermission, type ModDataMethod } from '../../shared/mod-data';
import type { ModDataHost } from './mod-data-host';
import { modRunRequestSchema, type ModRunView } from '../../shared/conversation-modes';
import { registerUiUpdateBlocker } from '../ui-update-guard';
import { MOD_DIAGNOSTIC_TEXT_MAX, type ModDiagnostic } from '../../shared/mod-debug';
import {
  MOD_VOICE_INSTRUCTIONS_MAX,
  MOD_VOICE_SPEAK_MAX,
  type ModVoiceEvent,
  type ModVoiceOptions,
  type ModVoiceLiveUnavailable,
  type ModVoiceProvider,
  type ModVoiceSession,
} from './mod-voice';
export type ModVoiceStatus = {
  provider: ModVoiceProvider;
  available: boolean;
  gptLive: { available: boolean; reason?: ModVoiceLiveUnavailable };
};

export const MOD_BRIDGE_MAX_BYTES = 600 * 1024;
export const MOD_BRIDGE_MAX_IN_FLIGHT = 16;
const empty = z.object({}).strict();
const tokens = z.record(z.string().max(80), z.string().max(200));
const theme = z.enum(['light', 'dark']);
const state = z.object({ revision: z.number().int().nonnegative(), values: z.record(z.string(), z.string()) }).strict();
const info = z
  .object({
    apiVersion: z.literal(2),
    hostVersion: z.string().max(100),
    locale: z.string().max(40),
    theme,
    tokens,
    slot: z.enum(['mainView', 'rightPanel', 'sidebarPanel']),
    layout: z.enum(['workspace', 'panel', 'sidebar']),
    conversation: z.object({ id: z.string().max(200), title: z.string().max(1000) }).strict(),
    project: z
      .object({ id: z.string().max(200), name: z.string().max(1000) })
      .strict()
      .optional(),
  })
  .strict();
export type ModHostInfo = z.infer<typeof info>;
export type ModState = z.infer<typeof state>;
const message = z
  .object({
    id: z.string().max(200),
    role: z.enum(['user', 'assistant', 'system', 'tool']),
    content: z.string(),
    createdAt: z.string().max(100),
    attachments: z
      .array(z.object({ name: z.string().max(1000), kind: z.string().max(100) }).strict())
      .max(200)
      .optional(),
  })
  .strict();
export type ModMessage = z.infer<typeof message>;
export type ModHostContext = {
  conversationId: string;
  modId: string;
  version: string;
  instanceId: string;
  manifest: ModManifestV2;
  isCurrent(): boolean;
  info(): ModHostInfo;
  getState(): Promise<ModState>;
  setState(values: Record<string, string>, expectedRevision: number): Promise<ModState>;
  messages(): readonly ModMessage[];
  insert(text: string, mode: 'append' | 'replace'): void;
  chat?(open: boolean): void;
  toggleChat?(): void;
  notify(title: string, message: string): void;
  /** Declared permissions this binding may use now; approval permissions only after the user approved them. */
  granted?(): readonly ModPermission[];
  runModel?(input: ModModelRun): Promise<{ runId: string }>;
  cancelModel?(runId: string): Promise<void>;
  /** Mod-owned storage, bank connections and file import; each method checks its own permission. */
  data?: ModDataHost;
  voice?: {
    /** The provider a start would use now, and whether any voice is available at all. */
    status(): Promise<ModVoiceStatus>;
    start(options: ModVoiceOptions, emit: (event: ModVoiceEvent) => void): Promise<ModVoiceSession | undefined>;
  };
  /** Debug channel: frame errors and console lines, and every request the bridge refused. */
  diagnostic?(entry: ModDiagnostic): void;
};
/** What the frame's shim posts; the host stamps its own time. */
const diag = z
  .object({
    pugport: z.literal(2),
    type: z.literal('diag'),
    level: z.enum(['error', 'warn', 'log']),
    text: z.string().max(4000),
    at: z.number(),
    dropped: z.number().int().positive().max(100000).optional(),
  })
  .strict();
const modelRun = modRunRequestSchema.omit({ instanceId: true });
export type ModModelRun = z.infer<typeof modelRun>;
export type ModPort = {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent) => void) | null;
  start(): void;
  close(): void;
};
const errors = {
  E_INVALID: 'Invalid request.',
  E_PERMISSION: 'Permission is not declared.',
  E_CONFLICT: 'State revision changed.',
  E_UNAVAILABLE: 'Mod is unavailable.',
  E_LIMIT: 'Request limit exceeded.',
} as const;
type ErrorCode = keyof typeof errors;
export class ModBridgeError extends Error {
  constructor(readonly code: ErrorCode) {
    super(errors[code]);
  }
}
const schemas = {
  'host.info': empty,
  'state.get': empty,
  'state.set': z
    .object({ values: z.record(z.string(), z.string()), expectedRevision: z.number().int().nonnegative() })
    .strict(),
  'messages.list': z
    .object({ limit: z.number().int().min(1).max(200).optional(), before: z.string().max(200).optional() })
    .strict(),
  'composer.insert': z.object({ text: z.string().max(16000), mode: z.enum(['append', 'replace']) }).strict(),
  'ui.setDirty': z.object({ dirty: z.boolean() }).strict(),
  'ui.chat': z.object({ open: z.boolean() }).strict(),
  'ui.notify': z.object({ message: z.string().min(1).max(200) }).strict(),
  'model.run': modelRun,
  'model.cancel': z.object({ runId: z.string().min(1).max(200) }).strict(),
  'voice.status': empty,
  'voice.start': z
    .object({
      language: z
        .string()
        .max(35)
        .regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/)
        .optional(),
      endSilenceMs: z.number().int().min(400).max(3000).optional(),
      provider: z.enum(['gpt-live', 'local']).optional(),
      instructions: z.string().max(MOD_VOICE_INSTRUCTIONS_MAX).optional(),
      maxMinutes: z.number().min(1).max(30).optional(),
      maxCostUsd: z.number().min(0.05).max(100).optional(),
      voice: z
        .string()
        .max(40)
        .regex(/^[a-z]+$/)
        .optional(),
    })
    .strict(),
  'voice.speak': z
    .object({ sessionId: z.string().max(100), text: z.string().min(1).max(MOD_VOICE_SPEAK_MAX) })
    .strict(),
  'voice.interrupt': z.object({ sessionId: z.string().max(100) }).strict(),
  'voice.instruct': z
    .object({ sessionId: z.string().max(100), text: z.string().min(1).max(MOD_VOICE_SPEAK_MAX) })
    .strict(),
  'voice.stop': z.object({ sessionId: z.string().max(100) }).strict(),
  ...modDataMethodSchemas,
};
const sessionEvent = { sessionId: z.string().max(100), seq: z.number().int().positive() };
const voiceEvent = z.discriminatedUnion('kind', [
  z
    .object({
      ...sessionEvent,
      kind: z.literal('state'),
      state: z.enum(['listening', 'hearing', 'speaking', 'stopped']),
      provider: z.enum(['gpt-live', 'local']),
      reason: z
        .enum(['mod', 'user', 'hidden', 'detached', 'idle', 'error', 'limit', 'interrupted', 'fallback', 'switched'])
        .optional(),
    })
    .strict(),
  z
    .object({
      ...sessionEvent,
      kind: z.literal('transcript'),
      turn: z.number().int().positive(),
      role: z.enum(['user', 'assistant']),
      text: z.string().max(20000),
      final: z.boolean(),
    })
    .strict(),
  z.object({ ...sessionEvent, kind: z.literal('error'), code: z.enum(['E_MIC', 'E_RECOGNITION']) }).strict(),
  z
    .object({
      ...sessionEvent,
      kind: z.literal('usage'),
      provider: z.enum(['gpt-live', 'local']),
      seconds: z.number().nonnegative(),
      costUsd: z.number().nonnegative(),
    })
    .strict(),
]);
const events = {
  ready: empty,
  state,
  messages: z.object({ count: z.number().int().nonnegative(), lastId: z.string().max(200).optional() }).strict(),
  run: z.object({ running: z.boolean() }).strict(),
  theme: z.object({ theme, tokens }).strict(),
  visibility: z.object({ visible: z.boolean() }).strict(),
  chat: z.object({ open: z.boolean() }).strict(),
  detached: empty,
  model: z
    .object({
      runId: z.string().max(200),
      status: z.enum(['completed', 'failed', 'cancelled']),
      text: z.string().optional(),
      error: z.enum(['E_FAILED', 'E_FORMAT', 'E_LIMIT', 'E_CANCELLED']).optional(),
      saveTo: z.string().max(40).optional(),
    })
    .strict(),
  voice: voiceEvent,
  connections: z
    .object({
      connections: z
        .array(
          z
            .object({
              id: z.string().max(100),
              provider: z.literal('plaid'),
              environment: z.enum(['sandbox', 'production']),
              institution: z
                .object({ id: z.string().max(200), name: z.string().max(200) })
                .strict()
                .optional(),
              status: z.enum(['connected', 'syncing', 'reauth_required', 'error', 'disconnected']),
              lastSyncedAt: z.string().max(40).optional(),
              lastAttemptAt: z.string().max(40).optional(),
              nextSyncAt: z.string().max(40).optional(),
              error: z
                .object({ code: z.string().max(100), message: z.string().max(500) })
                .strict()
                .optional(),
              products: z.array(z.string().max(40)).max(20),
            })
            .strict(),
        )
        .max(50),
    })
    .strict(),
};
/** The `model` event a settled run becomes. */
export function modelEvent(run: ModRunView) {
  return {
    runId: run.id,
    status: run.status,
    ...(run.text !== undefined ? { text: run.text } : {}),
    ...(run.error ? { error: run.error } : {}),
    ...(run.saveTo ? { saveTo: run.saveTo } : {}),
  };
}
export type ModHostEvent = keyof typeof events;
export const modEventSchemas = events;
const manifests = new Map<string, ModManifestV2>();
const notices = new Map<string, number[]>();
/** Installed versions are immutable; eviction only drops a parsed copy, never live capabilities. */
export function invalidateModManifestCache(id?: string): void {
  for (const key of manifests.keys()) if (!id || key.startsWith(`${id}@`)) manifests.delete(key);
}
export function cachedModManifest(manifest: ModManifestV2): ModManifestV2 {
  const key = `${manifest.id}@${manifest.version}`;
  let value = manifests.get(key);
  if (!value) {
    value = modManifestV2Schema.parse(manifest);
    if (manifests.size >= 200) manifests.delete(manifests.keys().next().value!);
    manifests.set(key, value);
  }
  return value;
}
function bounded(value: unknown): boolean {
  const seen = new Set<object>();
  let bytes = 0;
  let nodes = 0;
  const add = (count: number) => (bytes += count) <= MOD_BRIDGE_MAX_BYTES;
  const string = (text: string) => {
    if (!add(2)) return false;
    for (let i = 0; i < text.length; i++) {
      const char = text.charCodeAt(i);
      let size = char < 0x20 ? (char === 8 || char === 9 || char === 10 || char === 12 || char === 13 ? 2 : 6) : 1;
      if (char === 34 || char === 92) size = 2;
      else if (
        char >= 0xd800 &&
        char <= 0xdbff &&
        i + 1 < text.length &&
        text.charCodeAt(i + 1) >= 0xdc00 &&
        text.charCodeAt(i + 1) <= 0xdfff
      ) {
        size = 4;
        i++;
      } else if (char >= 0xd800 && char <= 0xdfff) size = 6;
      else if (char >= 0x800) size = 3;
      else if (char >= 0x80) size = 2;
      if (!add(size)) return false;
    }
    return true;
  };
  const visit = (item: unknown, depth: number): boolean => {
    if (++nodes > 100000 || depth > 20) return false;
    if (typeof item === 'string') return string(item);
    if (item === null) return add(4);
    if (typeof item === 'boolean') return add(item ? 4 : 5);
    if (typeof item === 'number') return add(JSON.stringify(item).length);
    if (!item || typeof item !== 'object' || seen.has(item)) return false;
    seen.add(item);
    if (!add(2)) return false;
    if (Array.isArray(item)) {
      for (let i = 0; i < item.length; i++) {
        if ((i > 0 && !add(1)) || !visit(item[i], depth + 1)) return false;
      }
    } else {
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) return false;
      let first = true;
      for (const key in item) {
        if (!Object.hasOwn(item, key)) continue;
        if ((!first && !add(1)) || !string(key) || !add(1) || !visit((item as Record<string, unknown>)[key], depth + 1))
          return false;
        first = false;
      }
    }
    return true;
  };
  try {
    return visit(value, 0);
  } catch {
    return false;
  }
}
function errorCode(error: unknown): ErrorCode {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return typeof code === 'string' && Object.hasOwn(errors, code) ? (code as ErrorCode) : 'E_UNAVAILABLE';
}

/** Each port is a revocable capability for exactly one captured conversation binding. */
export function createModHostBridge(
  context: ModHostContext,
  hooks: { voiceChanged?(provider: ModVoiceProvider | undefined): void } = {},
) {
  const manifest = cachedModManifest(context.manifest);
  const binding = [context.conversationId, context.modId, context.version, context.instanceId].join('\0');
  let port: ModPort | undefined;
  let generation = 0;
  let detached = false;
  let dirty = false;
  let unblock: (() => void) | undefined;
  let pending = new Set<string>();
  let voice: ModVoiceSession | undefined;
  let visible = true;
  const stopVoice = (reason: 'user' | 'hidden' | 'detached') => voice?.stop(reason);
  const current = () =>
    !detached &&
    context.isCurrent() &&
    manifest.id === context.modId &&
    manifest.version === context.version &&
    binding === [context.conversationId, context.modId, context.version, context.instanceId].join('\0');
  function send(target: ModPort, value: unknown) {
    try {
      target.postMessage(value);
    } catch {
      /* A removed frame no longer has a receiver. */
    }
  }
  function fail(target: ModPort, id: string, code: ErrorCode) {
    send(target, { type: 'response', id, error: { code, message: errors[code] } });
  }
  let watching: ReturnType<typeof setInterval> | undefined;
  /** A light poll while connected tells the Mod when a connection's status or data time changes. */
  function watchConnections() {
    if (
      !context.data ||
      !manifest.permissions?.includes('connections:read') ||
      !context.granted?.().includes('connections:read')
    )
      return;
    let last: string | undefined;
    const check = async () => {
      try {
        const connections = await context.data!.connections();
        const text = JSON.stringify(connections);
        if (last !== undefined && text !== last) emit('connections', { connections });
        last = text;
      } catch {
        /* The next check retries. */
      }
    };
    void check();
    watching = setInterval(() => void check(), 5000);
  }
  function clean() {
    stopVoice('detached');
    clearInterval(watching);
    watching = undefined;
    generation++;
    if (port) {
      for (const id of pending) fail(port, id, 'E_UNAVAILABLE');
      send(port, { type: 'event', event: 'detached', data: {} });
      port.onmessage = null;
      port.close();
      port = undefined;
    }
    pending = new Set();
    dirty = false;
    unblock?.();
    unblock = undefined;
  }
  function permission(name: ModPermission) {
    if (!manifest.permissions?.includes(name)) throw new ModBridgeError('E_PERMISSION');
    if (MOD_APPROVAL_PERMISSIONS.includes(name) && !context.granted?.().includes(name))
      throw new ModBridgeError('E_PERMISSION');
  }
  function session(id: string) {
    if (!voice || voice.id !== id) throw new ModBridgeError('E_INVALID');
    return voice;
  }
  function checkedState(value: unknown): ModState {
    const result = state.parse(value);
    result.values = validateModeState(manifest, result.values);
    return result;
  }
  async function dispatch(method: keyof typeof schemas, input: unknown): Promise<unknown> {
    if (Object.hasOwn(modDataMethodSchemas, method)) {
      permission(modDataPermission(method as ModDataMethod));
      if ((method === 'connections.authorize' || method === 'connections.reconnect') && !visible)
        throw new ModBridgeError('E_UNAVAILABLE');
      if (!context.data) throw new ModBridgeError('E_UNAVAILABLE');
      return context.data.call(method as ModDataMethod, input as Record<string, unknown>, () => current() && visible);
    }
    switch (method) {
      case 'host.info': {
        const result = info.parse(context.info());
        if (result.conversation.id !== context.conversationId) throw new ModBridgeError('E_UNAVAILABLE');
        return result;
      }
      case 'state.get':
        return checkedState(await context.getState());
      case 'state.set': {
        const args = schemas[method].parse(input);
        let values: Record<string, string>;
        try {
          values = validateModeState(manifest, args.values);
        } catch {
          throw new ModBridgeError('E_INVALID');
        }
        return checkedState(await context.setState(values, args.expectedRevision));
      }
      case 'messages.list': {
        permission('chat:read');
        const args = schemas[method].parse(input);
        const all = context.messages();
        const end = args.before ? all.findIndex((item) => item.id === args.before) : all.length;
        if (end < 0) throw new ModBridgeError('E_INVALID');
        return all.slice(Math.max(0, end - (args.limit ?? 200)), end).map((item) =>
          message.parse({
            id: item.id,
            role: item.role,
            content: item.content,
            createdAt: item.createdAt,
            ...(item.attachments ? { attachments: item.attachments.map(({ name, kind }) => ({ name, kind })) } : {}),
          }),
        );
      }
      case 'composer.insert': {
        permission('composer:draft');
        const args = schemas[method].parse(input);
        context.insert(args.text, args.mode);
        return {};
      }
      case 'ui.setDirty': {
        dirty = schemas[method].parse(input).dirty;
        if (!unblock) unblock = registerUiUpdateBlocker(() => dirty && current());
        return {};
      }
      case 'ui.chat': {
        if (!visible || context.info().layout !== 'workspace' || !context.chat)
          throw new ModBridgeError('E_UNAVAILABLE');
        context.chat(schemas[method].parse(input).open);
        return {};
      }
      case 'ui.notify': {
        const { message: text } = schemas[method].parse(input);
        const now = Date.now();
        for (const [id, times] of notices) if (times.every((time) => now - time >= 10000)) notices.delete(id);
        const times = (notices.get(manifest.id) ?? []).filter((time) => now - time < 10000);
        if (times.length >= 3) throw new ModBridgeError('E_LIMIT');
        notices.set(manifest.id, [...times, now]);
        context.notify(manifest.title, text);
        return {};
      }
      case 'model.run': {
        permission('model:run');
        if (!context.runModel) throw new ModBridgeError('E_UNAVAILABLE');
        return context.runModel(schemas[method].parse(input));
      }
      case 'model.cancel': {
        permission('model:run');
        if (!context.cancelModel) throw new ModBridgeError('E_UNAVAILABLE');
        await context.cancelModel(schemas[method].parse(input).runId);
        return {};
      }
      case 'voice.status': {
        permission('voice:session');
        return (
          (await context.voice?.status().catch(() => undefined)) ?? {
            provider: 'local',
            available: false,
            gptLive: { available: false },
          }
        );
      }
      case 'voice.start': {
        permission('voice:session');
        const options = schemas[method].parse(input);
        // The microphone only runs while the user can see the Mod; one session per frame.
        if (!context.voice || !visible) throw new ModBridgeError('E_UNAVAILABLE');
        if (voice) throw new ModBridgeError('E_LIMIT');
        let started: ModVoiceSession | undefined;
        try {
          started = await context.voice.start(options, (event) => {
            if (event.kind === 'state' && event.state === 'stopped' && voice?.id === event.sessionId) {
              voice = undefined;
              hooks.voiceChanged?.(undefined);
            } else if (event.kind === 'state' && voice?.id === event.sessionId) hooks.voiceChanged?.(event.provider);
            emit('voice', event);
          });
        } catch {
          throw new ModBridgeError('E_UNAVAILABLE');
        }
        if (!started) throw new ModBridgeError('E_LIMIT');
        if (!current() || !visible || voice) {
          started.stop('detached');
          throw new ModBridgeError('E_UNAVAILABLE');
        }
        voice = started;
        hooks.voiceChanged?.(started.provider());
        return { sessionId: started.id, provider: started.provider() };
      }
      case 'voice.speak': {
        permission('voice:session');
        const args = schemas[method].parse(input);
        session(args.sessionId).speak(args.text);
        return {};
      }
      case 'voice.instruct': {
        permission('voice:session');
        const args = schemas[method].parse(input);
        const live = session(args.sessionId);
        // Only GPT Live has a model to steer; a local session answers through model.run and speak.
        if (live.provider() !== 'gpt-live') throw new ModBridgeError('E_INVALID');
        live.instruct(args.text);
        return {};
      }
      case 'voice.interrupt': {
        permission('voice:session');
        session(schemas[method].parse(input).sessionId).interrupt();
        return {};
      }
      case 'voice.stop': {
        permission('voice:session');
        const { sessionId } = schemas[method].parse(input);
        // Stopping is idempotent: an ended session is already stopped.
        if (voice?.id === sessionId) voice.stop('mod');
        return {};
      }
    }
  }
  function emit(event: ModHostEvent, data: unknown) {
    if (event === 'visibility' && data && typeof data === 'object' && 'visible' in data) {
      visible = data.visible === true;
      if (!visible) stopVoice('hidden');
    }
    if (!port || !current() || !Object.hasOwn(events, event)) return;
    if (event === 'messages' && !manifest.permissions?.includes('chat:read')) return;
    const parsed = events[event].safeParse(data);
    if (!parsed.success || !bounded(parsed.data)) return;
    if (event === 'state') {
      try {
        checkedState(parsed.data);
      } catch {
        return;
      }
    }
    send(port, { type: 'event', event, data: parsed.data });
  }
  function connect(next: ModPort) {
    clean();
    if (!current()) {
      next.close();
      return;
    }
    port = next;
    const ticket = generation;
    const active = pending;
    const record = (entry: Omit<ModDiagnostic, 'at'>) => {
      if (ticket === generation && current()) context.diagnostic?.({ ...entry, at: Date.now() });
    };
    // A refused request is recorded with its method; the frame only ever sees the error code.
    const refuse = (id: string, method: string, code: ErrorCode) => {
      fail(next, id, code);
      record({ level: 'error', source: 'bridge', text: `${method.slice(0, 60)} refused: ${code}` });
    };
    next.onmessage = (event) => {
      const raw: unknown = event.data;
      const line = diag.safeParse(raw);
      if (line.success) {
        record({
          level: line.data.level,
          source: 'frame',
          text: line.data.text.slice(0, MOD_DIAGNOSTIC_TEXT_MAX),
          ...(line.data.dropped ? { dropped: line.data.dropped } : {}),
        });
        return;
      }
      if (
        z
          .object({ type: z.literal('shortcut'), name: z.literal('chat') })
          .strict()
          .safeParse(raw).success
      ) {
        if (
          ticket === generation &&
          current() &&
          visible &&
          context.info().slot === 'mainView' &&
          context.info().layout === 'workspace'
        )
          context.toggleChat?.();
        return;
      }
      const request = z
        .object({
          type: z.literal('request'),
          id: z.string().min(1).max(100),
          method: z.string(),
          params: z.unknown().optional(),
        })
        .strict()
        .safeParse(raw);
      if (!request.success) return;
      const { id, method } = request.data;
      if (ticket !== generation || !current()) {
        fail(next, id, 'E_UNAVAILABLE');
        return;
      }
      if (!Object.hasOwn(schemas, method)) {
        refuse(id, method, 'E_INVALID');
        return;
      }
      const name = method as keyof typeof schemas;
      const args = schemas[name].safeParse(request.data.params ?? {});
      if (!bounded(raw)) {
        refuse(id, method, 'E_LIMIT');
        return;
      }
      if (!args.success || active.has(id)) {
        refuse(id, method, 'E_INVALID');
        return;
      }
      if (active.size >= MOD_BRIDGE_MAX_IN_FLIGHT) {
        refuse(id, method, 'E_LIMIT');
        return;
      }
      active.add(id);
      void dispatch(name, args.data)
        .then((result) => {
          if (ticket !== generation || !current()) {
            fail(next, id, 'E_UNAVAILABLE');
            return;
          }
          if (!bounded(result)) {
            refuse(id, method, 'E_LIMIT');
            return;
          }
          send(next, { type: 'response', id, result });
        })
        .catch((error) => {
          if (ticket !== generation || !current()) fail(next, id, 'E_UNAVAILABLE');
          else refuse(id, method, errorCode(error));
        })
        .finally(() => active.delete(id));
    };
    next.start();
    emit('ready', {});
    watchConnections();
  }
  return {
    connect,
    emit,
    /** The host's own Stop control; the Mod receives a stopped state with reason `user`. */
    stopVoice: () => stopVoice('user'),
    detach() {
      detached = true;
      clean();
    },
  };
}
