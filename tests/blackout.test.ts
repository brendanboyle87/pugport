import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPowerState } from '../src/electron/power-state.ts';
import type { BrowserWindow, BrowserWindowConstructorOptions, Display, screen } from 'electron';
import { blackoutHtml, blackoutRect, createBlackout, DEFAULT_BLACKOUT_SHORTCUT } from '../src/electron/blackout.ts';
import { createKeepAwake } from '../src/electron/keep-awake.ts';

const displays = [
  { id: 1, scaleFactor: 1.5, bounds: { x: 0, y: 0, width: 1707, height: 1067 } },
  { id: 2, scaleFactor: 1, bounds: { x: -1080, y: -200, width: 1080, height: 1920 } },
  { id: 3, scaleFactor: 1.25, bounds: { x: 1707, y: 0, width: 2560, height: 1440 } },
] as Display[];

function fixture(t: TestContext, persistent = false) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const userData = mkdtempSync(join(tmpdir(), 'pugport-blackout-'));
  let memory = { keepAwake: false, blackout: false };
  const state = persistent
    ? createPowerState(userData)
    : {
        get: () => ({ ...memory }),
        set: (change: Partial<typeof memory>) => {
          memory = { ...memory, ...change };
        },
      };
  let current = [...displays],
    primary = 1,
    starts = 0,
    stops = 0,
    notices = 0;
  const powerCalls: unknown[][] = [];
  const callbacks = new Map<string, () => void>();
  const conflicts = new Set<string>();
  const windows: Window[] = [];
  let rejectLoad: ((error: Error) => void) | undefined;
  class Window extends EventEmitter {
    webContents = new EventEmitter();
    destroyed = false;
    focused = false;
    focusCount = 0;
    top: unknown[] = [];
    visible = false;
    url = '';
    bounds: unknown;
    constructor(readonly options: BrowserWindowConstructorOptions) {
      super();
      windows.push(this);
    }
    isDestroyed() {
      return this.destroyed;
    }
    isFocused() {
      return this.focused;
    }
    setAlwaysOnTop(...args: unknown[]) {
      this.top = args;
    }
    setVisibleOnAllWorkspaces() {}
    setBounds(bounds: unknown) {
      this.bounds = bounds;
    }
    focus() {
      this.focusCount++;
      this.focused = true;
    }
    show() {
      this.visible = true;
    }
    loadURL(url: string) {
      this.url = url;
      return new Promise<void>((_, reject) => {
        rejectLoad = reject;
      });
    }
    destroy() {
      this.destroyed = true;
      this.emit('closed');
    }
  }
  const fakeScreen = Object.assign(new EventEmitter(), {
    getAllDisplays: () => current,
    getPrimaryDisplay: () => current.find((display) => display.id === primary)!,
  });
  const awake = createKeepAwake({
    start: (kind) => {
      powerCalls.push(['start', kind, ++starts]);
      return starts;
    },
    stop: (id) => {
      powerCalls.push(['stop', id]);
      stops++;
      return true;
    },
  });
  const options = {
    createWindow: (options: BrowserWindowConstructorOptions) => new Window(options) as unknown as BrowserWindow,
    screen: fakeScreen as unknown as typeof screen,
    awake,
    state,
    shortcuts: {
      register: (key: string, callback: () => void) => {
        if (key === 'invalid') throw Error('invalid accelerator');
        if (conflicts.has(key)) return false;
        callbacks.set(key, callback);
        return true;
      },
      unregister: (key: string) => {
        callbacks.delete(key);
      },
    },
    notice: () => {
      notices++;
    },
  };
  const control = createBlackout(options);
  const controls = [control];
  t.after(() => {
    for (const instance of controls) instance.dispose();
    rmSync(userData, { recursive: true, force: true });
  });
  const input = (type: string, key = 'A') => {
    let prevented = false;
    windows
      .find((window) => !window.destroyed)!
      .webContents.emit(
        'before-input-event',
        {
          preventDefault: () => {
            prevented = true;
          },
        },
        { type, key },
      );
    assert.equal(prevented, true);
  };
  return {
    control,
    Window,
    state,
    userData,
    saved: () => JSON.parse(readFileSync(join(userData, 'power-state.json'), 'utf8')),
    restart: () => {
      control.dispose();
      const next = createBlackout({ ...options, state: persistent ? createPowerState(userData) : state });
      controls.push(next);
      return next;
    },
    windows,
    awake,
    fakeScreen,
    callbacks,
    conflicts,
    input,
    rejectLoad: () => rejectLoad!(Error('load failed')),
    setDisplays: (value: Display[], primaryId = 1) => {
      current = value;
      primary = primaryId;
    },
    powerCalls,
    counts: () => ({ starts, stops, notices }),
  };
}

test('portrait, negative origins and mixed DPI retain full display DIPs', (t) => {
  for (const display of displays) assert.deepEqual(blackoutRect(display), display.bounds);
  const f = fixture(t);
  f.control.toggle();
  assert.equal(f.windows.length, 3);
  f.windows.forEach((window, index) => {
    const { x, y, width, height, ...options } = window.options;
    assert.deepEqual({ x, y, width, height }, displays[index]!.bounds);
    assert.equal(options.fullscreen, true);
    assert.equal(options.frame, false);
    assert.equal(options.skipTaskbar, true);
    assert.equal(options.hasShadow, false);
    assert.equal(options.backgroundColor, '#000000');
    assert.deepEqual(window.top, [true, 'screen-saver']);
    assert.equal(window.visible, true);
    assert.equal(decodeURIComponent(window.url.split(',')[1]!), blackoutHtml);
  });
  assert.match(blackoutHtml, /cursor:none/);
  assert.match(blackoutHtml, /<body><\/body>/);
  assert.doesNotMatch(blackoutHtml, /animation|<script/);
});

test('failed and invalid shortcut changes retain the registered toggle', (t) => {
  const f = fixture(t);
  assert.equal(f.control.setShortcut(DEFAULT_BLACKOUT_SHORTCUT), true);
  f.conflicts.add('Ctrl+Alt+C');
  assert.equal(f.control.setShortcut('Ctrl+Alt+C'), false);
  assert.equal(f.control.setShortcut('invalid'), false);
  assert.equal(f.control.shortcut, DEFAULT_BLACKOUT_SHORTCUT);
  assert.equal(f.counts().notices, 2);
  f.callbacks.get(DEFAULT_BLACKOUT_SHORTCUT)!();
  assert.equal(f.control.active, true);
  f.callbacks.get(DEFAULT_BLACKOUT_SHORTCUT)!();
  assert.equal(f.control.active, false);
  assert.equal(f.control.setShortcut('Ctrl+Alt+N'), true);
  assert.equal(f.callbacks.has(DEFAULT_BLACKOUT_SHORTCUT), false);
  assert.equal(f.callbacks.has('Ctrl+Alt+N'), true);
});

test('blackout holds the display awake, mouse input schedules nothing, and a key restores', (t) => {
  const f = fixture(t);
  f.control.toggle();
  assert.deepEqual(f.powerCalls, [['start', 'prevent-display-sleep', 1]]);
  const timeout = t.mock.method(globalThis, 'setTimeout');
  const interval = t.mock.method(globalThis, 'setInterval');
  for (const type of ['mouseMove', 'mouseEnter', 'mouseLeave', 'mouseDown', 'mouseUp', 'mouseWheel']) {
    let consumed = false;
    f.windows[0]!.webContents.emit(
      'before-mouse-event',
      {
        preventDefault: () => {
          consumed = true;
        },
      },
      { type },
    );
    // Moves reach the page so `cursor: none` hides the pointer; clicks and the wheel are swallowed.
    assert.equal(consumed, !['mouseMove', 'mouseEnter', 'mouseLeave'].includes(type));
    assert.equal(f.control.active, true);
  }
  assert.equal(timeout.mock.callCount(), 0);
  assert.equal(interval.mock.callCount(), 0);
  t.mock.timers.tick(6 * 60_000);
  assert.deepEqual(f.powerCalls, [['start', 'prevent-display-sleep', 1]]);
  f.input('keyUp');
  assert.equal(f.control.active, true);
  f.input('keyDown');
  assert.equal(f.control.active, false);
  assert.ok(f.windows.every((window) => window.destroyed));
  assert.equal(f.counts().stops, 1);
  t.mock.timers.tick(30_000);
  assert.deepEqual(f.powerCalls, [
    ['start', 'prevent-display-sleep', 1],
    ['stop', 1],
  ]);
});

test('restoring on the shortcut modifier cannot immediately reactivate on its global dispatch', (t) => {
  const f = fixture(t);
  f.control.setShortcut(DEFAULT_BLACKOUT_SHORTCUT);
  f.control.toggle();
  f.input('keyDown', 'Control');
  f.callbacks.get(DEFAULT_BLACKOUT_SHORTCUT)!();
  assert.equal(f.control.active, false);
  t.mock.timers.tick(600);
  f.callbacks.get(DEFAULT_BLACKOUT_SHORTCUT)!();
  assert.equal(f.control.active, true);
});

test('tasks and blackout swap blocker levels without a gap and release independently', (t) => {
  const f = fixture(t);
  f.awake.set('tasks', true);
  assert.deepEqual(f.powerCalls, [['start', 'prevent-app-suspension', 1]]);
  f.control.toggle();
  f.awake.set('tasks', false);
  f.awake.set('tasks', true);
  assert.deepEqual(f.powerCalls, [
    ['start', 'prevent-app-suspension', 1],
    ['start', 'prevent-display-sleep', 2],
    ['stop', 1],
  ]);
  f.control.toggle();
  f.awake.set('tasks', false);
  assert.deepEqual(f.powerCalls, [
    ['start', 'prevent-app-suspension', 1],
    ['start', 'prevent-display-sleep', 2],
    ['stop', 1],
    ['start', 'prevent-app-suspension', 3],
    ['stop', 2],
    ['stop', 3],
  ]);
});

test('keep-awake updates a reason level, retains other display reasons and ignores repeated requests', (t) => {
  const f = fixture(t);
  f.awake.set('tasks', false);
  f.awake.set('tasks', true);
  f.awake.set('tasks', true);
  f.awake.set('tasks', true, 'display');
  f.awake.set('other', true, 'display');
  f.awake.set('tasks', true);
  f.awake.set('tasks', false);
  assert.deepEqual(f.powerCalls, [
    ['start', 'prevent-app-suspension', 1],
    ['start', 'prevent-display-sleep', 2],
    ['stop', 1],
  ]);
  f.awake.set('other', false);
  f.awake.set('other', false);
  f.awake.set('tasks', true);
  f.awake.set('tasks', false);
  assert.deepEqual(f.powerCalls.slice(3), [
    ['stop', 2],
    ['start', 'prevent-app-suspension', 3],
    ['stop', 3],
  ]);
});

test('hot-plug adds/removes covers, updates DPI bounds and refocuses the new primary', (t) => {
  const f = fixture(t);
  f.control.toggle();
  const updated = { ...displays[2]!, bounds: { x: 0, y: 0, width: 2048, height: 1152 } };
  f.setDisplays([updated], 3);
  f.fakeScreen.emit('display-removed');
  assert.equal(f.control.active, true);
  assert.equal(f.windows[0]!.destroyed, true);
  assert.equal(f.windows[1]!.destroyed, true);
  assert.deepEqual(f.windows[2]!.bounds, updated.bounds);
  const added = { ...displays[1]!, id: 4 };
  f.setDisplays([updated, added], 4);
  f.fakeScreen.emit('display-added');
  assert.equal(f.windows.length, 4);
  assert.equal(f.windows[3]!.focused, true);
  f.windows[3]!.focused = false;
  f.windows[3]!.emit('blur');
  t.mock.timers.tick(100);
  assert.equal(f.windows[3]!.focused, true);
  f.windows[3]!.focused = false;
  t.mock.timers.tick(1000);
  assert.equal(f.windows[3]!.focused, true);
  f.fakeScreen.emit('display-metrics-changed');
});

test('unresponsive windows keep blackout and its display blocker through the night', (t) => {
  const f = fixture(t);
  f.control.toggle();
  f.windows[0]!.emit('unresponsive');
  t.mock.timers.tick(8 * 60 * 60_000);
  assert.equal(f.control.active, true);
  assert.equal(f.windows.length, 3);
  assert.ok(f.windows.every((window) => !window.destroyed));
  assert.equal(f.counts().stops, 0);
  assert.equal(f.state.get().blackout, true);
});

for (const event of ['render-process-gone', 'closed'] as const) {
  test(event + ' rebuilds only the failed display, at most three times per minute', (t) => {
    const f = fixture(t);
    f.control.toggle();
    let window = f.windows[0]!;
    for (let i = 0; i < 3; i++) {
      if (event === 'closed') window.destroy();
      else window.webContents.emit(event);
      assert.equal(window.destroyed, true);
      window = f.windows.at(-1)!;
      assert.equal(window.options.x, displays[0]!.bounds.x);
      assert.equal(window.visible, true);
      assert.equal(f.control.active, true);
      assert.equal(f.windows.length, 4 + i);
      assert.equal(f.windows[1]!.destroyed, false);
      assert.equal(f.windows[2]!.destroyed, false);
      assert.equal(f.counts().stops, 0);
    }
    if (event === 'closed') window.destroy();
    else window.webContents.emit(event);
    assert.equal(f.control.active, false);
    assert.equal(f.windows.length, 6);
    assert.ok(f.windows.every((cover) => cover.destroyed));
    assert.equal(f.counts().stops, 1);
    assert.equal(f.state.get().blackout, false);
    t.mock.timers.tick(30_000);
    assert.equal(f.windows.length, 6);
  });
}

test('rebuild allowance renews after a minute and on a new activation', (t) => {
  const f = fixture(t);
  f.control.toggle();
  f.windows[0]!.webContents.emit('render-process-gone');
  for (let i = 0; i < 2; i++) f.windows.at(-1)!.destroy();
  t.mock.timers.tick(60_000);
  f.windows.at(-1)!.destroy();
  assert.equal(f.control.active, true);
  f.control.toggle();
  f.control.toggle();
  f.windows.at(-1)!.destroy();
  assert.equal(f.control.active, true);
});

test('all displays can disappear and return without releasing blackout or throwing on focus', (t) => {
  const f = fixture(t);
  f.control.toggle();
  f.setDisplays([]);
  f.fakeScreen.emit('display-removed');
  t.mock.timers.tick(5000);
  assert.equal(f.control.active, true);
  assert.ok(f.windows.every((window) => window.destroyed));
  assert.equal(f.counts().stops, 0);
  assert.equal(f.state.get().blackout, true);
  f.setDisplays(displays);
  f.fakeScreen.emit('display-added');
  assert.equal(f.windows.length, 6);
  assert.ok(f.windows.slice(3).every((window) => window.visible && !window.destroyed));
  assert.equal(f.control.active, true);
  assert.deepEqual(f.powerCalls, [['start', 'prevent-display-sleep', 1]]);
});

test('display discovery and focus failures retain blackout until a later display event succeeds', (t) => {
  const f = fixture(t);
  const discover = t.mock.method(f.fakeScreen, 'getAllDisplays', () => {
    throw Error('displays temporarily unavailable');
  });
  f.control.toggle();
  assert.equal(f.control.active, true);
  assert.equal(f.windows.length, 0);
  assert.equal(f.counts().stops, 0);
  discover.mock.restore();
  f.fakeScreen.emit('display-added');
  const primary = t.mock.method(f.fakeScreen, 'getPrimaryDisplay', () => {
    throw Error('primary temporarily unavailable');
  });
  assert.doesNotThrow(() => t.mock.timers.tick(1000));
  assert.equal(f.control.active, true);
  primary.mock.restore();
  f.windows[0]!.focused = false;
  t.mock.timers.tick(1000);
  assert.equal(f.windows[0]!.focused, true);
});

test('an incomplete new cover is discarded so a later display event can rebuild it', (t) => {
  const f = fixture(t);
  f.setDisplays([displays[0]!]);
  f.control.toggle();
  t.mock.method(
    f.Window.prototype,
    'show',
    () => {
      throw Error('window initialization temporarily unavailable');
    },
    { times: 1 },
  );
  f.setDisplays(displays);
  f.fakeScreen.emit('display-added');
  assert.equal(f.control.active, true);
  assert.equal(f.windows[0]!.destroyed, false);
  assert.equal(f.windows[1]!.destroyed, true);
  assert.equal(f.counts().stops, 0);
  f.fakeScreen.emit('display-added');
  assert.equal(f.windows.length, 4);
  assert.ok(f.windows.slice(2).every((window) => window.visible && !window.destroyed));
  assert.deepEqual(f.powerCalls, [['start', 'prevent-display-sleep', 1]]);
});
test('startup restores saved intent and stale input after quit cannot clear it', (t) => {
  const f = fixture(t);
  f.control.toggle();
  const old = f.windows[0]!;
  const restarted = f.restart();
  assert.equal(restarted.active, true);
  assert.deepEqual(f.powerCalls, [
    ['start', 'prevent-display-sleep', 1],
    ['stop', 1],
    ['start', 'prevent-display-sleep', 2],
  ]);
  old.webContents.emit('before-input-event', { preventDefault() {} }, { type: 'keyDown' });
  assert.equal(f.state.get().blackout, true);
  assert.equal(restarted.active, true);
  f.input('keyDown');
  assert.equal(restarted.active, false);
  assert.equal(f.state.get().blackout, false);
});
test('quit releases windows and shortcuts but preserves the flag for the next startup', (t) => {
  const f = fixture(t, true);
  f.state.set({ keepAwake: true });
  f.control.setShortcut(DEFAULT_BLACKOUT_SHORTCUT);
  f.control.toggle();
  f.control.dispose();
  assert.equal(f.control.active, false);
  assert.ok(f.windows.every((window) => window.destroyed));
  assert.equal(f.callbacks.size, 0);
  assert.equal(f.fakeScreen.listenerCount('display-added'), 0);
  assert.deepEqual(f.saved(), { keepAwake: true, blackout: true, blackoutExitedAt: Date.now() });
  assert.equal(f.counts().stops, 1);
  const restarted = f.restart();
  assert.equal(restarted.active, true);
  assert.equal(f.windows.length, 6);
  assert.deepEqual(f.powerCalls.at(-1), ['start', 'prevent-display-sleep', 2]);
  f.input('keyDown');
  assert.equal(restarted.active, false);
  assert.deepEqual(f.saved(), { keepAwake: true, blackout: false });
  restarted.dispose();
  assert.equal(f.restart().active, false);
});

test('key, shortcut and entry-point toggle clear the persisted flag', (t) => {
  const f = fixture(t, true);
  f.control.setShortcut(DEFAULT_BLACKOUT_SHORTCUT);
  for (const end of [() => f.input('keyDown'), () => f.callbacks.get(DEFAULT_BLACKOUT_SHORTCUT)!(), f.control.toggle]) {
    f.control.toggle();
    assert.equal(f.state.get().blackout, true);
    end();
    assert.equal(f.control.active, false);
    assert.equal(f.saved().blackout, false);
  }
});

test('a failed overlay load rebuilds, while stale failures cannot close a later activation', async (t) => {
  const f = fixture(t);
  f.control.toggle();
  f.rejectLoad();
  await Promise.resolve();
  assert.equal(f.control.active, true);
  assert.equal(f.windows.length, 4);
  const old = f.windows.at(-1)!;
  f.control.toggle();
  f.control.toggle();
  const count = f.windows.length;
  old.webContents.emit('render-process-gone');
  old.emit('closed');
  assert.equal(f.control.active, true);
  assert.equal(f.windows.length, count);
});

test('power state validates saved fields and preserves both fields across independent updates', (t) => {
  const f = fixture(t, true);
  assert.deepEqual(f.state.get(), { keepAwake: false, blackout: false });
  f.state.set({ keepAwake: true });
  f.state.set({ blackout: true });
  f.state.set({ keepAwake: false });
  assert.deepEqual(createPowerState(f.userData).get(), { keepAwake: false, blackout: true });
  const file = join(f.userData, 'power-state.json');
  writeFileSync(file, '{"keepAwake":"true","blackout":true,"extra":42}');
  assert.deepEqual(createPowerState(f.userData).get(), { keepAwake: false, blackout: true });
  const warn = t.mock.method(console, 'warn', () => {});
  writeFileSync(file, '{broken');
  assert.deepEqual(createPowerState(f.userData).get(), { keepAwake: false, blackout: false });
  assert.equal(warn.mock.callCount(), 1);
});

test('a persistence failure is reported without trapping the user in blackout', (t) => {
  const f = fixture(t, true);
  const warn = t.mock.method(console, 'warn', () => {});
  rmSync(f.userData, { recursive: true });
  writeFileSync(f.userData, 'not a directory');
  f.control.toggle();
  assert.equal(f.control.active, true);
  f.input('keyDown');
  assert.equal(f.control.active, false);
  assert.equal(f.counts().stops, 1);
  assert.ok(warn.mock.callCount() >= 2);
});

for (const delay of [599_999, 600_000, 24 * 60 * 60_000]) {
  test('restart recovery expires after ten minutes: ' + delay, (t) => {
    const f = fixture(t);
    f.control.toggle();
    f.control.dispose();
    t.mock.timers.tick(delay);
    const restarted = f.restart();
    assert.equal(restarted.active, delay < 600_000);
    assert.equal(f.state.get().blackout, delay < 600_000);
  });
}

test('an empty blackout retries display discovery on the next timer tick', (t) => {
  const f = fixture(t);
  const discovery = t.mock.method(f.fakeScreen, 'getAllDisplays', () => {
    throw Error('temporary');
  });
  f.control.toggle();
  assert.equal(f.windows.length, 0);
  discovery.mock.restore();
  t.mock.timers.tick(1000);
  assert.equal(f.windows.length, 3);
  assert.equal(f.control.active, true);
});

test('startup clears the saved flag before building covers, so a crash while building cannot repeat on every launch', (t) => {
  const f = fixture(t);
  f.control.toggle();
  f.control.dispose();
  const writes: boolean[] = [];
  const seenByWindow: boolean[] = [];
  const spy = {
    get: f.state.get,
    set: (change: { blackout?: boolean }) => {
      if (change.blackout !== undefined) writes.push(change.blackout);
      f.state.set(change);
    },
  };
  const restarted = createBlackout({
    createWindow: (options) => {
      seenByWindow.push(f.state.get().blackout);
      return new f.Window(options) as unknown as BrowserWindow;
    },
    screen: f.fakeScreen as unknown as typeof screen,
    awake: f.awake,
    state: spy as never,
    shortcuts: { register: () => true, unregister() {} },
    notice() {},
  });
  t.after(() => restarted.dispose());
  assert.equal(restarted.active, true);
  assert.deepEqual(writes, [false, true]);
  assert.ok(seenByWindow.length > 0 && seenByWindow.every((flag) => flag === false));
});
