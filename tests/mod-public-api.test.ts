import assert from 'node:assert/strict';
import test from 'node:test';
import { createContext, runInContext } from 'node:vm';
import type {} from '../docs/examples/mods/pugport-mod';
import { MOD_CLIENT_SHIM } from '../src/shared/mod-client-shim';
import {
  ModBridgeError,
  type ModHostEvent,
  type ModHostInfo as HostInfo,
  type ModState as HostState,
  type ModMessage as HostMessage,
  modEventSchemas,
} from '../src/ui/mods/mod-host-bridge';
import type { ModVoiceEvent as ModVoiceEventType } from '../src/ui/mods/mod-voice';
import type { z } from 'zod';

type Same<A, B> = [A, B] extends [B, A] ? true : false;
// These assertions bring the copyable author declaration into the normal typecheck.
const contracts: [
  Same<ModHostInfo, HostInfo>,
  Same<ModState, HostState>,
  Same<ModMessage, HostMessage>,
  Same<keyof ModEvents, ModHostEvent>,
  Same<ModModelEvent, z.infer<(typeof modEventSchemas)['model']>>,
  Same<ModVoiceEvent, ModVoiceEventType>,
  Same<ModError['code'], ModBridgeError['code']>,
] = [true, true, true, true, true, true, true];

test('shim forwards Ctrl or Command J without exposing a new public API', () => {
  const listeners = new Map<string, (event: any) => void>();
  const parent = {};
  const sandbox = createContext({
    parent,
    setTimeout,
    clearTimeout,
    addEventListener: (name: string, fn: (event: any) => void) => listeners.set(name, fn),
    removeEventListener: (name: string) => listeners.delete(name),
  });
  runInContext('window = globalThis', sandbox);
  runInContext(MOD_CLIENT_SHIM, sandbox);
  const sent: unknown[] = [];
  const port = {
    onmessage: null,
    start() {},
    close() {},
    postMessage: (value: unknown) => sent.push(structuredClone(value)),
  };
  listeners.get('message')!({ isTrusted: true, source: parent, data: { pugport: 2, type: 'connect' }, ports: [port] });
  sent.length = 0;
  let prevented = 0;
  const key = (options: object) =>
    listeners.get('keydown')!({ key: 'j', preventDefault: () => prevented++, ...options });
  key({ ctrlKey: true });
  key({ metaKey: true, key: 'J' });
  key({ ctrlKey: true, shiftKey: true });
  key({ ctrlKey: true, altKey: true });
  key({ key: 'j' });
  assert.equal(prevented, 2);
  assert.deepEqual(sent, [
    { type: 'shortcut', name: 'chat' },
    { type: 'shortcut', name: 'chat' },
  ]);
  listeners.get('pagehide')!({});
  key({ ctrlKey: true });
  assert.equal(sent.length, 2, 'detached frame no longer forwards');
});

test('public author types match bridge payloads and shim calls, events and errors', async () => {
  assert.ok(contracts.every(Boolean));
  const listeners = new Map<string, (event: unknown) => void>();
  const parent = {};
  const sandbox = createContext({
    parent,
    setTimeout,
    clearTimeout,
    addEventListener: (name: string, fn: (event: unknown) => void) => listeners.set(name, fn),
    removeEventListener: (name: string) => listeners.delete(name),
  });
  runInContext('window = globalThis', sandbox);
  runInContext(MOD_CLIENT_SHIM, sandbox);
  const api: PugPortMod = sandbox.pugport;
  const requests: { id: string; method: string; params: unknown }[] = [];
  let rejectCode: ModError['code'] | undefined;
  const port = {
    onmessage: null as null | ((event: { data: unknown }) => void),
    start() {},
    close() {},
    postMessage(request: { id: string; method: string; params: unknown }) {
      requests.push(structuredClone(request));
      if (request.id === 'handshake') return;
      queueMicrotask(() =>
        port.onmessage?.({
          data: {
            type: 'response',
            id: request.id,
            ...(rejectCode
              ? { error: new ModBridgeError(rejectCode) }
              : { result: request.method === 'voice.start' ? { sessionId: 's', provider: 'gpt-live' } : {} }),
          },
        }),
      );
    },
  };
  listeners.get('message')!({ isTrusted: true, source: parent, data: { pugport: 2, type: 'connect' }, ports: [port] });
  const emit = (event: keyof ModEvents, data: unknown) => port.onmessage!({ data: { type: 'event', event, data } });
  emit('ready', {});
  await api.host.info();
  await api.state.get();
  await api.state.set({ values: { notes: 'synthetic' }, expectedRevision: 2 });
  await api.messages.list();
  await api.messages.list({ limit: 1, before: 'm' });
  await api.composer.insert({ text: 'draft', mode: 'append' });
  await api.ui.chat({ open: true });
  await api.ui.setDirty(true);
  await api.ui.notify('Saved');
  await api.model.run({ prompt: 'Correct this sentence.', saveTo: 'feedback', format: 'json' });
  await api.model.cancel({ runId: 'run' });
  await api.voice.status();
  const voice = await api.voice.start({ language: 'en-US' });
  await voice.say('Hi');
  await voice.instruct('Be brief.');
  await voice.interrupt();
  await voice.stop();
  await api.voice.speak({ sessionId: 's', text: 'Hello' });
  await api.voice.interrupt({ sessionId: 's' });
  await api.voice.instruct({ sessionId: 's', text: 'Correct the last sentence.' });
  await api.voice.stop({ sessionId: 's' });
  await api.storage.put({ collection: 'ledger', items: [{ key: 'tx_1', value: '{}' }] });
  await api.storage.list({ collection: 'ledger', limit: 10 });
  await api.connections.list();
  await api.connections.transactions({ connectionId: 'conn_synthetic1', cursor: 'c' });
  await api.files.pick({ accept: ['.csv', '.pdf'] });
  await api.files.pdfText({ fileId: 'f', fromPage: 2 });
  assert.deepEqual(
    requests.slice(1).map(({ method, params }) => [method, params]),
    [
      ['host.info', {}],
      ['state.get', {}],
      ['state.set', { values: { notes: 'synthetic' }, expectedRevision: 2 }],
      ['messages.list', {}],
      ['messages.list', { limit: 1, before: 'm' }],
      ['composer.insert', { text: 'draft', mode: 'append' }],
      ['ui.chat', { open: true }],
      ['ui.setDirty', { dirty: true }],
      ['ui.notify', { message: 'Saved' }],
      ['model.run', { prompt: 'Correct this sentence.', saveTo: 'feedback', format: 'json' }],
      ['model.cancel', { runId: 'run' }],
      ['voice.status', {}],
      ['voice.start', { language: 'en-US' }],
      ['voice.speak', { sessionId: 's', text: 'Hi' }],
      ['voice.instruct', { sessionId: 's', text: 'Be brief.' }],
      ['voice.interrupt', { sessionId: 's' }],
      ['voice.stop', { sessionId: 's' }],
      ['voice.speak', { sessionId: 's', text: 'Hello' }],
      ['voice.interrupt', { sessionId: 's' }],
      ['voice.instruct', { sessionId: 's', text: 'Correct the last sentence.' }],
      ['voice.stop', { sessionId: 's' }],
      ['storage.put', { collection: 'ledger', items: [{ key: 'tx_1', value: '{}' }] }],
      ['storage.list', { collection: 'ledger', limit: 10 }],
      ['connections.list', {}],
      ['connections.transactions', { connectionId: 'conn_synthetic1', cursor: 'c' }],
      ['files.pick', { accept: ['.csv', '.pdf'] }],
      ['files.pdfText', { fileId: 'f', fromPage: 2 }],
    ],
  );
  // The voice handle hears only its own session.
  assert.equal(voice.sessionId, 's');
  assert.equal(voice.provider, 'gpt-live');
  const heard: string[] = [];
  const offTranscript = voice.on('transcript', (data) => heard.push(`said:${data.text}`));
  voice.on('ended', (data) => heard.push(`ended:${data.reason}`));
  const line = { kind: 'transcript', turn: 1, role: 'user', final: true };
  emit('voice', { sessionId: 'other', seq: 1, ...line, text: 'not mine' });
  emit('voice', { sessionId: 's', seq: 2, ...line, text: 'Hello' });
  emit('voice', { sessionId: 's', seq: 3, kind: 'state', state: 'stopped', provider: 'gpt-live', reason: 'mod' });
  offTranscript();
  emit('voice', { sessionId: 's', seq: 4, ...line, text: 'after off' });
  assert.deepEqual(heard, ['said:Hello', 'ended:mod']);
  assert.throws(() => voice.on('audio' as never, () => undefined), /Invalid voice event/);
  for (const code of ['E_INVALID', 'E_PERMISSION', 'E_CONFLICT', 'E_UNAVAILABLE', 'E_LIMIT'] as const) {
    rejectCode = code;
    await assert.rejects(api.state.get(), { code, message: new ModBridgeError(code).message });
  }
  const payloads: ModEvents = {
    ready: {},
    state: { revision: 2, values: { notes: 'saved' } },
    messages: { count: 1, lastId: 'm' },
    run: { running: false },
    theme: { theme: 'dark', tokens: {} },
    visibility: { visible: false },
    chat: { open: true },
    model: { runId: 'run', status: 'completed', text: '{}', saveTo: 'feedback' },
    voice: { sessionId: 's', seq: 1, kind: 'transcript', turn: 1, role: 'user', text: 'Hello', final: true },
    connections: {
      connections: [
        {
          id: 'conn_synthetic1',
          provider: 'plaid',
          environment: 'sandbox',
          status: 'reauth_required',
          products: ['transactions'],
        },
      ],
    },
    // Last: detaching ends the transport.
    detached: {},
  };
  for (const name of Object.keys(payloads) as (keyof ModEvents)[]) {
    let count = 0;
    const off = api.on(name, (data) => {
      assert.deepEqual(data, payloads[name]);
      count++;
    });
    emit(name, payloads[name]);
    off();
    if (name !== 'detached') emit(name, payloads[name]);
    assert.equal(count, 1);
  }
  assert.throws(() => runInContext("pugport.on('settings', () => {})", sandbox), /Invalid Mod event/);
  assert.deepEqual(Object.keys(api).sort(), [
    'composer',
    'connections',
    'files',
    'host',
    'messages',
    'model',
    'on',
    'state',
    'storage',
    'ui',
    'voice',
  ]);
  await assert.rejects(api.state.get(), { code: 'E_UNAVAILABLE' });
});
