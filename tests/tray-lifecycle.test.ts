import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPowerState } from '../src/electron/power-state.ts';
import { createKeepAwake } from '../src/electron/keep-awake.ts';
import { electronModule } from './helpers/electron-harness.ts';
import { nextTurn } from './helpers/ui-harness.ts';
import type { SystemResources } from '../src/electron/system-monitor.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(
  fetcher?: (url: string) => Promise<unknown>,
  platform: NodeJS.Platform = 'win32',
  extra: {
    state?: ReturnType<typeof createPowerState>;
    awake?: ReturnType<typeof createKeepAwake>;
    blackout?: () => void;
  } = {},
) {
  let saved = { keepAwake: false, blackout: false };
  const state = extra.state ?? {
    get: () => ({ ...saved }),
    set: (change: Partial<typeof saved>) => {
      saved = { ...saved, ...change };
    },
  };
  let currentMenu: {
    label?: string;
    type?: string;
    enabled?: boolean;
    checked?: boolean;
    click?: (item: { checked: boolean }) => void;
  }[] = [];
  let focus = '',
    starts = 0,
    menus = 0,
    activeLoads = 0,
    maxLoads = 0;
  const windows: Window[] = [],
    loads: ReturnType<typeof deferred<void>>[] = [];
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let nextTimer = 0;
  let measuredHeight = 260;
  let interval: (() => void) | undefined;
  const activities: { running: number; localRunning?: number }[] = [];
  let cursor = { x: 10, y: 10 };
  const scripts: string[] = [];
  const contextMenus: Array<Array<{ label?: string; click?: () => void }>> = [];
  const monitor = {
    state: { observedAt: 0, gpuState: 'loading' } as SystemResources,
    active: false,
    starts: 0,
    stops: 0,
    disposed: false,
    onUpdate: () => {},
    publish(state: SystemResources) {
      this.state = state;
      this.onUpdate();
    },
  };
  class Window extends EventEmitter {
    visible = false;
    destroyed = false;
    focused = false;
    bounds = { x: 100, y: 100, width: 340, height: 260 };
    positions: { x: number; y: number; width: number; height: number }[] = [];
    options: Record<string, unknown>;
    webContents = Object.assign(new EventEmitter(), {
      executeJavaScript: async (script: string) => {
        scripts.push(script);
        return measuredHeight;
      },
    });
    constructor(options: Record<string, unknown>) {
      super();
      this.options = options;
      windows.push(this);
    }
    isDestroyed() {
      return this.destroyed;
    }
    isVisible() {
      return this.visible;
    }
    isFocused() {
      return this.focused;
    }
    getSize() {
      return [this.bounds.width, this.bounds.height];
    }
    getBounds() {
      return { ...this.bounds };
    }
    setBounds(bounds: typeof this.bounds) {
      this.bounds = { ...bounds };
      this.positions.push({ ...bounds });
    }
    setSize() {}
    setPosition() {}
    show() {
      assert.equal(this.destroyed, false);
      this.visible = true;
    }
    focus() {
      focus = 'popup';
      this.focused = true;
    }
    hide() {
      this.visible = false;
      this.focused = false;
    }
    destroy() {
      this.destroyed = true;
      this.visible = false;
    }
    loadURL() {
      const load = deferred<void>();
      loads.push(load);
      maxLoads = Math.max(maxLoads, ++activeLoads);
      return load.promise.finally(() => {
        activeLoads--;
      });
    }
  }
  const tray = Object.assign(new EventEmitter(), {
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    getBounds: () => ({ x: 500, y: 900, width: 20, height: 20 }),
    setImage() {},
    tooltip: '',
    setToolTip(value: string) {
      this.tooltip = value;
    },
    setContextMenu(menu: typeof currentMenu) {
      currentMenu = menu;
      assert.equal(this.destroyed, false);
      menus++;
    },
    popUpContextMenu(menu: (typeof contextMenus)[number]) {
      assert.equal(this.destroyed, false);
      assert.ok(
        windows.every((window) => !window.visible),
        'Hide the quota card before opening a native menu',
      );
      contextMenus.push(menu);
    },
  });
  const response = () => Promise.resolve({ ok: true, json: async () => ({ running: 0, lines: [], totals: [] }) });
  const module = await electronModule(
    'src/electron/tray.ts',
    {
      BrowserWindow: Window,
      app: { isPackaged: true, getLoginItemSettings: () => ({ openAtLogin: false }) },
      Menu: { buildFromTemplate: (items: unknown) => items },
      nativeImage: {},
      nativeTheme: { shouldUseDarkColors: false, shouldUseDarkColorsForSystemIntegratedUI: false, on() {}, off() {} },
      shell: {},
      screen: {
        getDisplayMatching: () => ({
          bounds: { x: 0, y: 0, width: 1000, height: 940 },
          workArea: { x: 0, y: 0, width: 1000, height: 900 },
        }),
        getCursorScreenPoint: () => cursor,
      },
      powerSaveBlocker: {
        start: (kind: string) => {
          assert.equal(kind, 'prevent-app-suspension');
          starts++;
          return 1;
        },
        stop() {},
      },
    },
    {
      process: { platform, env: {} },
      fetch: fetcher ?? response,
      setTimeout: (callback: () => void, delay: number) => {
        timers.set(++nextTimer, { callback, delay });
        return nextTimer;
      },
      clearTimeout: (id: number) => timers.delete(id),
      setInterval: (callback: () => void) => {
        interval = callback;
        return 1;
      },
      clearInterval() {},
      fixtureMonitor: monitor,
    },
    {
      './system-monitor.ts': `export const createSystemMonitor = ({onUpdate}) => {
        fixtureMonitor.onUpdate = onUpdate;
        return {
          snapshot: () => fixtureMonitor.state,
          start() { fixtureMonitor.active = true; fixtureMonitor.starts++; },
          stop() { if (fixtureMonitor.active) fixtureMonitor.stops++; fixtureMonitor.active = false; },
          dispose() { fixtureMonitor.active = false; fixtureMonitor.disposed = true; }
        };
      };`,
    },
  );
  const control = module.attachTray({
    tray,
    state,
    ...extra,
    iconsDir: 'fixture-without-icons',
    origin: 'http://fixture.invalid',
    open: () => {
      focus = 'main';
    },
    quit() {},
    onActivity: (data: { running: number; localRunning?: number }, lit: boolean) => {
      assert.equal(lit, true);
      activities.push(data);
    },
  });
  return {
    tray,
    menu: () => currentMenu,
    windows,
    loads,
    control,
    monitor,
    scripts,
    contextMenus,
    activities,
    measure: (height: number) => {
      measuredHeight = height;
    },
    poll: () => interval?.(),
    focus: () => focus,
    starts: () => starts,
    menus: () => menus,
    maxLoads: () => maxLoads,
    cursor: (point: { x: number; y: number }) => {
      cursor = point;
    },
    settleBlur: () => {
      for (const [id, timer] of timers)
        if (timer.delay < 100) {
          timers.delete(id);
          timer.callback();
        }
    },
    settleLayout: () => {
      for (const [id, timer] of timers)
        if (timer.delay === 125) {
          timers.delete(id);
          timer.callback();
        }
    },
  };
}

test('tray polling and refresh use the held session without fetching it', async () => {
  const urls: string[] = [];
  const f = await fixture(async (url) => {
    urls.push(url);
    return { ok: true, json: async () => ({ running: 0, lines: [], totals: [] }) };
  });
  f.tray.emit('click');
  f.loads[0]!.resolve();
  await nextTurn();
  f.windows[0]!.webContents.emit('will-navigate', { preventDefault() {} }, 'combo://refresh');
  await nextTurn();
  assert.ok(urls.some((url) => url.endsWith('/api/tray')));
  assert.ok(urls.some((url) => url.endsWith('/api/refresh')));
  assert.ok(urls.every((url) => !url.endsWith('/api/session')));
  f.control.dispose();
});

test('double-click cancels a first popup show while its initial navigation is pending', async () => {
  const f = await fixture();
  f.tray.emit('click');
  assert.equal(f.loads.length, 1);
  f.tray.emit('double-click');
  assert.equal(f.focus(), 'main');
  f.loads[0]!.resolve();
  await nextTurn();
  assert.equal(f.windows[0]!.visible, false);
  assert.equal(f.focus(), 'main');
  assert.equal(f.maxLoads(), 1);
  // Cancellation affects only the earlier show: a later single click works normally.
  f.tray.emit('click');
  await nextTurn();
  assert.equal(f.windows[0]!.visible, true);
  assert.equal(f.focus(), 'popup');
  f.control.dispose();
});

test('Mac mouse-up opens the card even without click; a matching click does not close it again', async () => {
  const f = await fixture(undefined, 'darwin');
  f.tray.emit('mouse-up');
  f.loads[0]!.resolve();
  await nextTurn();
  assert.equal(f.windows[0]!.isVisible(), true);
  f.tray.emit('click');
  await nextTurn();
  assert.equal(f.windows[0]!.isVisible(), true, 'the same native action must toggle only once');
  f.tray.emit('mouse-up');
  assert.equal(f.windows[0]!.isVisible(), false);
  f.control.dispose();
  assert.equal(f.tray.listenerCount('mouse-up'), 0);
});

test('dispose during fetch cannot restart a sleep blocker or touch the destroyed tray', async () => {
  const response = deferred<unknown>();
  const f = await fixture(() => response.promise);
  const before = f.menus();
  f.control.dispose();
  f.tray.destroyed = true;
  response.resolve({ ok: true, json: async () => ({ running: 1, lines: [], totals: [] }) });
  await nextTurn();
  assert.equal(f.starts(), 0);
  assert.equal(f.menus(), before);
});

test('dispose during a popup navigation prevents later show or focus', async () => {
  const f = await fixture();
  f.tray.emit('click');
  f.control.dispose();
  f.loads[0]!.resolve();
  await nextTurn();
  assert.equal(f.windows[0]!.destroyed, true);
  assert.equal(f.windows[0]!.visible, false);
  assert.equal(f.focus(), '');
});

test('poll and repeated clicks serialize popup navigation while showing the newest task state', async () => {
  const response = deferred<unknown>();
  const f = await fixture(() => response.promise);
  f.tray.emit('click');
  response.resolve({ ok: true, json: async () => ({ running: 1, lines: [], totals: [] }) });
  await nextTurn();
  f.tray.emit('click');
  assert.equal(f.loads.length, 1);
  f.loads[0]!.resolve();
  await nextTurn();
  assert.equal(f.loads.length, 1, 'fresh running-task state patches the already loaded page');
  assert.ok(f.scripts.some((script) => script.includes('1 个 Agent 任务运行中')));
  assert.equal(f.maxLoads(), 1);
  assert.equal(f.windows[0]!.visible, true);
  assert.equal(f.focus(), 'popup');
  f.control.dispose();
});

test('hidden prewarm blur does not cancel the pending tray click', async () => {
  const f = await fixture();
  try {
    f.tray.emit('click');
    f.windows[0]!.emit('blur');
    f.loads[0]!.resolve();
    await nextTurn();
    f.settleBlur();
    assert.equal(f.windows[0]!.visible, true);
    assert.equal(f.focus(), 'popup');
  } finally {
    f.control.dispose();
  }
});

test('a stale blur after Windows tray focus handoff does not instantly hide the focused card', async () => {
  const f = await fixture();
  try {
    f.tray.emit('click');
    f.loads[0]!.resolve();
    await nextTurn();
    f.windows[0]!.emit('blur');
    f.settleBlur();
    assert.equal(f.windows[0]!.visible, true);
    // A real outside focus change still dismisses the card, and a quick later click reopens it.
    f.windows[0]!.focused = false;
    f.windows[0]!.emit('blur');
    f.settleBlur();
    assert.equal(f.windows[0]!.visible, false);
    f.tray.emit('click');
    await nextTurn();
    assert.equal(f.windows[0]!.visible, true);
  } finally {
    f.control.dispose();
  }
});

test('clicking the tray while its card loses focus still toggles closed', async () => {
  const f = await fixture();
  try {
    f.tray.emit('click');
    f.loads[0]!.resolve();
    await nextTurn();
    f.cursor({ x: 510, y: 905 });
    f.windows[0]!.focused = false;
    f.windows[0]!.emit('blur');
    f.settleBlur();
    f.tray.emit('click');
    await nextTurn();
    assert.equal(f.windows[0]!.visible, false);
  } finally {
    f.control.dispose();
  }
});

test('renderer loss releases the old pending load so the next click creates a working card', async () => {
  const f = await fixture();
  try {
    f.tray.emit('click');
    const old = f.windows[0]!;
    old.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    assert.equal(old.destroyed, true);
    f.tray.emit('click');
    assert.equal(f.windows.length, 2);
    f.loads[1]!.resolve();
    await nextTurn();
    assert.equal(f.windows[1]!.visible, true);
    // Completion/events from the destroyed renderer must not affect its replacement.
    f.loads[0]!.resolve();
    old.emit('blur');
    await nextTurn();
    f.settleBlur();
    assert.equal(f.windows[1]!.visible, true);
  } finally {
    f.control.dispose();
  }
});

test('disposed tray listeners and pending blur cannot restore a window or open the main app', async () => {
  const f = await fixture();
  f.tray.emit('click');
  f.loads[0]!.resolve();
  await nextTurn();
  f.windows[0]!.focused = false;
  f.windows[0]!.emit('blur');
  f.control.dispose();
  f.settleBlur();
  f.tray.emit('double-click');
  f.tray.emit('click');
  assert.equal(f.windows.length, 1);
  assert.notEqual(f.focus(), 'main');
  assert.equal(f.tray.listenerCount('click'), 0);
  assert.equal(f.tray.listenerCount('right-click'), 0);
});

test('macOS left-click shows only the quota card; right-click hides it before opening a fresh menu', async () => {
  const f = await fixture(undefined, 'darwin');
  try {
    await nextTurn();
    assert.equal(f.menus(), 0, 'An attached menu would also open on a macOS left-click');
    f.tray.emit('click');
    f.loads[0]!.resolve();
    await nextTurn();
    assert.equal(f.windows[0]!.visible, true);
    assert.equal(f.contextMenus.length, 0);
    f.poll();
    await nextTurn();
    assert.equal(f.menus(), 0, 'Polling must not reattach a native menu');
    f.tray.emit('right-click');
    assert.equal(f.windows[0]!.visible, false);
    assert.equal(f.monitor.active, false);
    assert.equal(f.contextMenus.length, 1);
    assert.equal(
      f.contextMenus[0]!.some((item) => item.label === '查看剩余额度'),
      false,
    );
    f.tray.emit('click');
    await nextTurn();
    assert.equal(f.windows[0]!.visible, true, 'A subsequent single click can reopen the card');
  } finally {
    f.control.dispose();
  }
});

test('macOS right-click cancels a pending card show and remains detached after disposal', async () => {
  const f = await fixture(undefined, 'darwin');
  try {
    f.tray.emit('click');
    f.tray.emit('right-click');
    f.loads[0]!.resolve();
    await nextTurn();
    assert.equal(f.windows[0]!.visible, false);
    assert.equal(f.monitor.starts, 0);
    assert.equal(f.contextMenus.length, 1);
    f.control.dispose();
    f.tray.emit('right-click');
    assert.equal(f.contextMenus.length, 1);
    assert.equal(f.tray.listenerCount('right-click'), 0);
  } finally {
    f.control.dispose();
  }
});

test('Windows keeps its native context menu and dismisses the quota card on right-click', async () => {
  const f = await fixture(undefined, 'win32');
  try {
    assert.ok(f.menus() > 0);
    f.tray.emit('click');
    f.loads[0]!.resolve();
    await nextTurn();
    f.tray.emit('right-click');
    assert.equal(f.windows[0]!.visible, false);
    assert.equal(f.contextMenus.length, 0, 'Windows already opens the attached menu');
  } finally {
    f.control.dispose();
  }
});

test('resource sampling starts only for a visible card and its updates never navigate the page', async () => {
  const f = await fixture();
  try {
    assert.equal(f.monitor.starts, 0);
    f.tray.emit('click');
    assert.equal(f.monitor.starts, 0, 'pending hidden navigation does not collect GPU readings');
    f.loads[0]!.resolve();
    await nextTurn();
    assert.equal(f.monitor.starts, 1);
    f.monitor.publish({ observedAt: 1, cpuPercent: 26, gpuPercent: 53, gpuState: 'available' });
    await nextTurn();
    assert.equal(f.loads.length, 1);
    assert.ok(f.scripts.some((script) => script.includes('26%') && script.includes('53%')));
    const before = f.scripts.length;
    f.monitor.publish({ observedAt: 2, cpuPercent: 26, gpuPercent: 53, gpuState: 'available' });
    await nextTurn();
    assert.equal(f.scripts.length, before, 'unchanged readings do not churn the DOM');
    f.tray.emit('click');
    assert.equal(f.monitor.active, false);
    assert.equal(f.monitor.stops, 1);
    f.monitor.publish({ observedAt: 3, cpuPercent: 80, gpuState: 'loading' });
    await nextTurn();
    assert.equal(f.scripts.length, before, 'late samples cannot redraw a hidden card');
    f.tray.emit('click');
    await nextTurn();
    assert.equal(f.monitor.starts, 2);
    assert.equal(f.loads.length, 1);
  } finally {
    f.control.dispose();
  }
  assert.equal(f.monitor.disposed, true);
});

test('renderer loss and disposal stop monitoring and ignore late resource callbacks', async () => {
  const f = await fixture();
  f.tray.emit('click');
  f.loads[0]!.resolve();
  await nextTurn();
  f.windows[0]!.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.equal(f.monitor.active, false);
  assert.equal(f.monitor.stops, 1);
  const before = f.scripts.length;
  f.monitor.publish({ observedAt: 4, cpuPercent: 99, gpuState: 'loading' });
  await nextTurn();
  assert.equal(f.scripts.length, before);
  f.control.dispose();
  f.monitor.publish({ observedAt: 5, cpuPercent: 50, gpuState: 'loading' });
  await nextTurn();
  assert.equal(f.scripts.length, before);
});

test('native dragging keeps the popup position through live updates; reopening anchors it again', async () => {
  const f = await fixture();
  try {
    f.tray.emit('click');
    f.loads[0]!.resolve();
    await nextTurn();
    const card = f.windows[0]!;
    assert.equal(card.options.movable, true);
    assert.deepEqual(card.bounds, { x: 340, y: 640, width: 340, height: 260 });
    card.emit('will-move', {}, { x: 90, y: 120, width: 340, height: 260 });
    card.bounds = { ...card.bounds, x: 90, y: 120 };
    const positions = card.positions.length;
    f.monitor.publish({ observedAt: 1, cpuPercent: 45, gpuPercent: 30, gpuState: 'available' });
    await nextTurn();
    assert.equal(card.positions.length, positions, 'A data refresh does not call setBounds at the dragged position');
    assert.equal(card.bounds.x, 90);
    assert.equal(card.bounds.y, 120);
    assert.equal(f.loads.length, 1, 'Dragging and live updates do not navigate the renderer');
    f.tray.emit('click');
    f.tray.emit('click');
    await nextTurn();
    assert.deepEqual(card.bounds, { x: 340, y: 640, width: 340, height: 260 });
  } finally {
    f.control.dispose();
  }
});

test('a settled native DPI/resize change remeasures unchanged HTML and retains a dragged origin', async () => {
  const f = await fixture();
  try {
    f.tray.emit('click');
    f.loads[0]!.resolve();
    await nextTurn();
    const card = f.windows[0]!;
    f.measure(320);
    card.emit('resize');
    f.settleLayout();
    await nextTurn();
    assert.deepEqual(card.bounds, { x: 340, y: 580, width: 340, height: 320 });
    assert.equal(f.loads.length, 1);
    card.emit('will-move', {}, { x: 80, y: 120, width: 340, height: 320 });
    card.bounds = { ...card.bounds, x: 80, y: 120 };
    f.measure(340);
    card.emit('move');
    f.settleLayout();
    await nextTurn();
    assert.deepEqual(card.bounds, { x: 80, y: 120, width: 340, height: 340 });
    f.control.dispose();
    f.settleLayout();
    assert.equal(card.destroyed, true, 'Disposal cancels pending geometry work');
  } finally {
    f.control.dispose();
  }
});

test('local background work gets its own title, activity callback and sleep blocker without an Agent run', async () => {
  let phase = '本地读取';
  const f = await fixture(async () => ({
    ok: true,
    json: async () => ({
      running: 0,
      localRunning: 1,
      localTitle: '本地媒体分析',
      localPhase: phase,
      lines: [],
      totals: [],
    }),
  }));
  try {
    await nextTurn();
    assert.equal(f.starts(), 1);
    assert.match(f.tray.tooltip, /本地媒体分析.*本地读取/);
    assert.doesNotMatch(f.tray.tooltip, /空闲/);
    assert.equal(f.activities.at(-1)?.localRunning, 1);
    const menus = f.menus();
    phase = '正在核验';
    f.poll();
    await nextTurn();
    assert.match(f.tray.tooltip, /正在核验/);
    assert.ok(f.menus() > menus, 'The task menu also reacts to changed local activity');
  } finally {
    f.control.dispose();
  }
});

test('tray menu has only the requested entries, combined status and optional blackout', async () => {
  let running = 2,
    localRunning = 3,
    blackouts = 0;
  const f = await fixture(
    async () => ({
      ok: true,
      json: async () => ({
        running,
        localRunning,
        localTitle: 'local title must not appear',
        lines: [],
        totals: [],
      }),
    }),
    'win32',
    {
      blackout: () => {
        blackouts++;
      },
    },
  );
  try {
    await nextTurn();
    assert.deepEqual(
      Array.from(f.menu(), (item) => item.label ?? item.type),
      ['打开 PugPort', '5 个任务运行中', 'separator', '立即黑屏', '不休眠', 'separator', '退出 PugPort'],
    );
    assert.equal(f.menu()[1]!.enabled, false);
    assert.equal(f.menu()[4]!.type, 'checkbox');
    f.menu()[3]!.click!({ checked: false });
    assert.equal(blackouts, 1);
    running = localRunning = 0;
    f.poll();
    await nextTurn();
    assert.equal(f.menu()[1]!.label, '当前没有运行中的任务');
  } finally {
    f.control.dispose();
  }
  const without = await fixture();
  assert.deepEqual(
    Array.from(without.menu(), (item) => item.label ?? item.type),
    ['打开 PugPort', '当前没有运行中的任务', 'separator', '不休眠', 'separator', '退出 PugPort'],
  );
  without.control.dispose();
});

for (const persistent of [false, true]) {
  test('manual keep awake reasons and startup state: ' + (persistent ? 'file' : 'memory'), async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'pugport-tray-power-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const file = join(directory, 'power-state.json');
    writeFileSync(file, JSON.stringify({ keepAwake: false, blackout: true }));
    let memory = { keepAwake: false, blackout: true };
    const state = {
      get: () => ({ ...memory }),
      set: (change: Partial<typeof memory>) => {
        memory = { ...memory, ...change };
      },
    };
    const saved = () => (persistent ? JSON.parse(readFileSync(file, 'utf8')) : state.get());
    const calls: unknown[][] = [];
    const power: unknown[][] = [];
    let id = 0;
    const realAwake = createKeepAwake({
      start: (kind) => {
        power.push(['start', kind]);
        return ++id;
      },
      stop: (value) => {
        power.push(['stop', value]);
        return true;
      },
    });
    const awake = {
      set: (...args: Parameters<typeof realAwake.set>) => {
        calls.push(args);
        realAwake.set(...args);
      },
    };
    let f = await fixture(undefined, 'win32', { state: persistent ? createPowerState(directory) : state, awake });
    t.after(() => f.control.dispose());
    await nextTurn();
    const toggle = (checked: boolean) => f.menu().find((item) => item.label === '不休眠')!.click!({ checked });
    toggle(true);
    assert.deepEqual(calls.at(-1), ['manual', true, 'system']);
    assert.deepEqual(saved(), { keepAwake: true, blackout: true });
    assert.equal(f.menu().find((item) => item.label === '不休眠')!.checked, true);
    awake.set('tasks', true);
    toggle(false);
    assert.equal(power.filter((call) => call[0] === 'stop').length, 0, 'manual off preserves tasks');
    toggle(true);
    awake.set('tasks', false);
    awake.set('blackout', true, 'display');
    awake.set('blackout', false);
    assert.deepEqual(power.at(-2), ['start', 'prevent-app-suspension']);
    f.control.dispose();
    assert.equal(saved().keepAwake, true);
    calls.length = 0;
    f = await fixture(undefined, 'win32', { state: persistent ? createPowerState(directory) : state, awake });
    assert.deepEqual(calls[0], ['manual', true, 'system']);
    assert.equal(f.menu().find((item) => item.label === '不休眠')!.checked, true);
    toggle(false);
    assert.deepEqual(saved(), { keepAwake: false, blackout: true });
  });
}
