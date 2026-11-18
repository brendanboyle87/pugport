import { setSessionToken } from '../src/electron/session-header.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import type { BrowserWindow, BrowserWindowConstructorOptions, IpcMainInvokeEvent } from 'electron';
import { createQuickChat } from '../src/electron/quick-chat.ts';
import { createQuickChatClient } from '../src/electron/quick-chat-client.ts';
import { bindQuickChat, quickChatLabels } from '../src/electron/quick-chat-page.ts';
import { DEFAULT_QUICK_CHAT_SETTINGS } from '../src/shared/quick-chat.ts';
import { createTranslator } from '../src/shared/i18n/index.ts';
import english from '../src/shared/i18n/en.json' with { type: 'json' };

test('Mac quick-chat shortcut hints translate before selecting the Command modifier', () => {
  const translate = createTranslator(english);
  const t = (text: string) => translate(text) ?? text;
  assert.equal(
    quickChatLabels(t, 'ctrl-enter', 'darwin').hint,
    'Cmd+Enter to send · Enter for a new line · Esc to hide',
  );
  assert.equal(
    quickChatLabels(t, 'ctrl-enter', 'win32').hint,
    'Ctrl+Enter to send · Enter for a new line · Esc to hide',
  );
});

const turn = () => new Promise<void>((done) => setImmediate(done));
function fixture(saved: unknown = undefined) {
  const callbacks = new Map<string, () => void>();
  const conflicts = new Set<string>();
  const windows: FakeWindow[] = [];
  const sent: unknown[][] = [];
  const opened: string[] = [];
  let notices = 0,
    failSave = false,
    failSend = false;
  let storage = saved;
  let complete: (() => void) | undefined;
  class FakeWindow extends EventEmitter {
    destroyed = false;
    visible = false;
    bounds: unknown;
    page = '';
    webContents = Object.assign(new EventEmitter(), {
      mainFrame: { url: '' },
      setWindowOpenHandler() {},
      send: (...args: unknown[]) => sent.push(args),
    });
    constructor(readonly options: BrowserWindowConstructorOptions) {
      super();
      windows.push(this);
    }
    async loadURL(url: string) {
      this.page = url;
      this.webContents.mainFrame.url = url;
    }
    setBounds(bounds: unknown) {
      this.bounds = bounds;
    }
    show() {
      this.visible = true;
    }
    focus() {}
    hide() {
      this.visible = false;
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
    }
  }
  const make = () =>
    createQuickChat({
      createWindow: (options) => new FakeWindow(options) as unknown as BrowserWindow,
      screen: {
        getCursorScreenPoint: () => ({ x: -500, y: 300 }),
        getDisplayNearestPoint: () => ({ workArea: { x: -1200, y: -100, width: 1200, height: 900 } }) as any,
      },
      shortcuts: {
        register: (key, callback) => {
          if (key === 'invalid') throw new Error('invalid');
          if (conflicts.has(key) || callbacks.has(key)) return false;
          callbacks.set(key, callback);
          return true;
        },
        unregister: (key) => {
          callbacks.delete(key);
        },
      },
      preload: 'fixture/preload.cjs',
      read: () => storage,
      write: (value) => {
        if (failSave) throw new Error('disk full');
        storage = value;
      },
      async send(text, id) {
        sent.push(['message', text, id]);
        if (failSend) throw new Error('offline');
        if (complete)
          await new Promise<void>((done) => {
            complete = done;
          });
        return id ?? 'created';
      },
      conversation: async (id) => id ?? 'created',
      open: (id) => {
        opened.push(id);
      },
      translate: (text) => text,
      notice: () => {
        notices++;
      },
    });
  const control = make();
  return {
    control,
    make,
    windows,
    callbacks,
    conflicts,
    sent,
    opened,
    notices: () => notices,
    storage: () => storage,
    failSave: () => {
      failSave = true;
    },
    failSend: (value: boolean) => {
      failSend = value;
    },
    defer: () => {
      complete = () => {};
    },
    complete: () => complete?.(),
  };
}

test('a shortcut taken by another app at startup opens no dialog and reports unregistered', () => {
  const f = fixture();
  f.control.dispose();
  f.conflicts.add('Ctrl+Alt+Space');
  const started = f.make();
  assert.equal(started.configure().registered, false);
  assert.equal(f.notices(), 0);
  started.dispose();
});

test('quick chat defaults, conflicts, invalid accelerators, disabling and restart persistence', async () => {
  const f = fixture();
  assert.equal(f.control.configure().shortcut, 'Ctrl+Alt+Space');
  assert.equal(f.callbacks.size, 1);
  for (const shortcut of ['Ctrl+Alt+B', 'invalid']) {
    f.conflicts.add('Ctrl+Alt+B');
    assert.equal(f.control.configure({ ...DEFAULT_QUICK_CHAT_SETTINGS, shortcut }).registered, false);
    assert.ok(f.callbacks.has('Ctrl+Alt+Space'));
    assert.equal(f.storage(), undefined);
  }
  assert.equal(f.notices(), 0, 'conflicts show inline on the settings page, not as dialogs');
  f.control.configure({ enabled: false, shortcut: 'Ctrl+Alt+N', target: 'last' });
  assert.equal(f.callbacks.size, 0);
  f.control.dispose();
  const restored = f.make();
  assert.deepEqual(restored.configure(), { enabled: false, shortcut: 'Ctrl+Alt+N', target: 'last', registered: false });
  restored.configure({ enabled: true, shortcut: 'Ctrl+Alt+N', target: 'last' });
  assert.ok(f.callbacks.has('Ctrl+Alt+N'));
  restored.dispose();
  assert.equal(f.callbacks.size, 0);
});

test('save failure rolls back registration; malformed saved settings use defaults; startup conflict can be retried', () => {
  const f = fixture({ enabled: 'yes' });
  f.failSave();
  assert.throws(() => f.control.configure({ ...DEFAULT_QUICK_CHAT_SETTINGS, shortcut: 'Ctrl+Alt+N' }), /无法保存/);
  assert.deepEqual([...f.callbacks.keys()], ['Ctrl+Alt+Space']);
  f.control.dispose();
  f.conflicts.add('Ctrl+Alt+Space');
  const conflict = f.make();
  assert.equal(conflict.configure().registered, false);
  assert.throws(() => conflict.configure({ enabled: true }), /无效/);
  conflict.dispose();
});

test('hotkey opens on active display with isolation; blur and close hide; only the owned main frame is accepted', async () => {
  const f = fixture();
  f.callbacks.get('Ctrl+Alt+Space')!();
  await turn();
  const win = f.windows[0]!;
  assert.equal(win.visible, true);
  assert.deepEqual(win.bounds, { x: -890, y: 195, width: 580, height: 310 });
  assert.equal(win.options.frame, false);
  assert.equal(win.options.alwaysOnTop, true);
  assert.equal(win.options.webPreferences?.nodeIntegration, false);
  assert.equal(win.options.webPreferences?.sandbox, true);
  const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame } as unknown as IpcMainInvokeEvent;
  assert.equal(f.control.fromWindow(event), true);
  assert.equal(f.control.fromWindow({ ...event, sender: {} } as IpcMainInvokeEvent), false);
  assert.equal(f.control.fromWindow({ ...event, senderFrame: { url: win.page } } as IpcMainInvokeEvent), false);
  win.emit('blur');
  assert.equal(win.visible, false);
  await f.control.show();
  assert.equal(f.windows.length, 1);
  win.emit('close', { preventDefault() {} });
  assert.equal(win.visible, false);
  f.control.dispose();
  assert.equal(win.destroyed, true);
});

test('send appends to the displayed target, hides only on success, rejects duplicate sends and remembers destination', async () => {
  const f = fixture({ ...DEFAULT_QUICK_CHAT_SETTINGS, target: 'last' });
  f.control.remember({ id: 'selected', title: 'Selected chat', project: 'Project A' });
  await f.control.show();
  assert.match(JSON.stringify(f.sent.at(-1)), /Project A · Selected chat/);
  f.failSend(true);
  await assert.rejects(f.control.send('hello'), /offline/);
  assert.equal(f.windows[0]!.visible, true);
  f.failSend(false);
  f.defer();
  const sending = f.control.send('hello');
  await assert.rejects(f.control.send('hello'), /暂时无法发送/);
  assert.equal(f.windows[0]!.visible, true);
  f.complete();
  await sending;
  assert.equal(f.windows[0]!.visible, false);
  assert.deepEqual(f.sent.filter((item) => item[0] === 'message').at(-1), ['message', 'hello', 'selected']);
  await f.control.show();
  f.windows[0]!.webContents.emit('will-navigate', { preventDefault() {} }, 'pugport-quick-chat:open');
  await turn();
  assert.deepEqual(f.opened, ['selected']);
  f.control.dispose();
});

test('everyday ignores last project, falls back to a new conversation, and rejects blank or oversized input', async () => {
  const f = fixture();
  f.control.remember({ id: 'project-chat', title: 'Private project', project: 'Project A' });
  await f.control.show();
  assert.match(JSON.stringify(f.sent.at(-1)), /日常对话 · 新对话/);
  for (const input of ['', '  ', 1, 'x'.repeat(50001)]) await assert.rejects(f.control.send(input));
  await f.control.send('hello');
  assert.deepEqual(
    f.sent.filter((item) => item[0] === 'message'),
    [['message', 'hello', undefined]],
  );
  f.control.dispose();
  const empty = fixture({ ...DEFAULT_QUICK_CHAT_SETTINGS, target: 'last' });
  await empty.control.show();
  await empty.control.send('hello');
  assert.deepEqual(
    empty.sent.filter((item) => item[0] === 'message'),
    [['message', 'hello', undefined]],
  );
  empty.control.dispose();
});

test('normal authenticated API creates once, preserves retry identity after failure and appends without creating', async () => {
  setSessionToken(() => undefined);
  let early = 0;
  const recovering = createQuickChatClient('http://fixture', (async () => {
    early++;
    return Response.json({});
  }) as unknown as typeof fetch);
  await assert.rejects(recovering.send('hello'), /本地后台不可用/);
  assert.equal(early, 0);
  setSessionToken(() => 'synthetic-token');
  const requests: { path: string; body: any; headers: any }[] = [];
  let fail = true,
    created = 0;
  const client = createQuickChatClient('http://fixture', (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    assert.notEqual(path, '/api/session');
    const body = JSON.parse(String(init.body));
    requests.push({ path, body, headers: init.headers });
    if (path === '/api/conversations') return Response.json({ id: `new-${++created}` });
    if (fail) return Response.json({ error: 'offline' }, { status: 503 });
    return Response.json({ message: { id: 'message' } });
  }) as typeof fetch);
  await assert.rejects(client.send('hello'), /offline/);
  fail = false;
  assert.equal(await client.send('hello'), 'new-1');
  assert.equal(created, 1);
  assert.equal(requests[1]!.body.clientMessageId, requests[2]!.body.clientMessageId);
  assert.equal(requests[2]!.body.mode, 'chat');
  assert.equal(requests[2]!.headers['x-agent-token'], 'synthetic-token');
  assert.equal(await client.send('next'), 'new-2');
  assert.equal(await client.send('append', 'selected'), 'selected');
  assert.equal(created, 2);
  assert.equal(requests.at(-1)!.path, '/api/conversations/selected/messages');
});

test('renderer Enter sends and hides through controller; composition and Shift+Enter do not send; Esc preserves draft', async () => {
  class Element extends EventEmitter {
    value = '';
    textContent = '';
    disabled = false;
    readOnly = false;
    addEventListener = this.on;
    focus() {}
    setAttribute() {}
  }
  const elements = Object.fromEntries(
    ['input', 'send', 'error', 'close', 'target', 'title', 'open', 'hint'].map((id) => [`#${id}`, new Element()]),
  );
  const document = Object.assign(new EventEmitter(), {
    querySelector: (id: string) => elements[id],
    addEventListener: EventEmitter.prototype.on,
  });
  const f = fixture();
  await f.control.show();
  const update = bindQuickChat(document as unknown as Document, {
    send: (text) => f.control.send(text),
    close: async () => f.control.hide(),
  });
  update({ labels: quickChatLabels((text) => text), target: 'Everyday' });
  const input = elements['#input']!;
  input.value = 'hello';
  input.emit('input');
  const key = (changes: object = {}) =>
    document.emit('keydown', { key: 'Enter', target: input, preventDefault() {}, ...changes });
  key({ isComposing: true });
  key({ keyCode: 229 });
  key({ shiftKey: true });
  input.emit('compositionstart');
  key();
  input.emit('compositionend');
  key();
  assert.equal(f.sent.filter((item) => item[0] === 'message').length, 0);
  input.emit('keyup', { key: 'Enter' });
  update({
    labels: quickChatLabels((text) => text, 'ctrl-enter', 'darwin'),
    target: 'Everyday',
    composerSendKey: 'ctrl-enter',
  });
  key();
  assert.equal(f.sent.filter((item) => item[0] === 'message').length, 0);
  assert.match(elements['#hint']!.textContent, /Cmd\+Enter/);
  key({ metaKey: true });
  key({ metaKey: true });
  await turn();
  assert.equal(f.sent.filter((item) => item[0] === 'message').length, 1);
  assert.equal(input.value, '');
  assert.equal(f.windows[0]!.visible, false);
  await f.control.show();
  input.value = 'draft';
  key({ key: 'Escape' });
  await turn();
  assert.equal(input.value, 'draft');
  assert.equal(f.windows[0]!.visible, false);
  await f.control.show();
  f.failSend(true);
  key({ ctrlKey: true });
  await turn();
  assert.equal(input.value, 'draft');
  assert.equal(elements['#error']!.textContent, 'offline');
  assert.equal(f.windows[0]!.visible, true);
  assert.equal(input.readOnly, false);
  f.control.dispose();
});

test('quick chat receives the composer send preference even without a last conversation', async () => {
  const f = fixture();
  f.control.remember({ id: '', title: '', project: '', composerSendKey: 'ctrl-enter' });
  await f.control.show();
  const state = f.sent.find((item) => item[0] !== 'message')![1] as {
    composerSendKey: string;
    labels: { hint: string };
  };
  assert.equal(state.composerSendKey, 'ctrl-enter');
  assert.ok(state.labels.hint.includes(process.platform === 'darwin' ? 'Cmd+Enter' : 'Ctrl+Enter'));
  f.control.dispose();
});
