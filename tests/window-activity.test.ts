import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activityLabel, activityTone, localActivity } from '../src/shared/background-activity.ts';
import type { BackgroundTask } from '../src/shared/types.ts';
import { electronModule } from './helpers/electron-harness.ts';

const task = (kind: BackgroundTask['kind'], state: BackgroundTask['state'] = 'running'): BackgroundTask => ({
  id: String(kind),
  kind,
  state,
  conversationId: 'fixture',
  title: 'private title',
  detail: 'private filename',
  done: 1,
  total: 10,
  startedAt: '2026-10-07T12:00:00Z',
});

type FixtureIcon = {
  bytes: Buffer;
  representations: Array<{ scaleFactor: number; width: number; height: number; buffer: Buffer }>;
};

test('local activity includes running media and image work, excludes paused jobs and private filenames', () => {
  assert.deepEqual(localActivity([task('media-analysis', 'paused')]), { localRunning: 0 });
  const result = localActivity([
    task(undefined),
    { ...task('media-analysis'), steps: [{ label: '预筛', state: 'running', done: 1, total: 10 }] },
  ]);
  assert.deepEqual(result, { localRunning: 2, localTitle: '本地媒体比对', localPhase: '预筛' });
  assert.equal(activityTone({ running: 0, ...result }), 'local');
  assert.equal(activityTone({ running: 1, ...result }), 'agent');
  assert.doesNotMatch(activityLabel({ running: 1, ...result }), /private/);
  const map: Record<string, string> = { '1 个 Agent 运行中': '1 Agent running', 本地媒体比对: 'Local comparison' };
  assert.equal(
    activityLabel({ running: 1, localRunning: 1, localTitle: '本地媒体比对' }, (text) => map[text] ?? text),
    '1 Agent running · Local comparison',
  );
});

async function fixture(reduced = false) {
  let destroyed = false,
    canTitle = true,
    next = 0;
  const timers = new Map<number, () => void>();
  const titles: string[] = [],
    overlays: Array<{ icon: FixtureIcon | null; label: string }> = [];
  const module = await electronModule(
    'src/electron/window-activity.ts',
    {},
    {
      setInterval: (callback: () => void) => {
        timers.set(++next, callback);
        return next;
      },
      clearInterval: (id: number) => timers.delete(id),
    },
  );
  const activity = module.createWindowActivity({
    window: {
      isDestroyed: () => destroyed,
      setTitle: (title: string) => titles.push(title),
      setOverlayIcon: (icon: FixtureIcon | null, label: string) => overlays.push({ icon, label }),
    },
    image: (bytes: Buffer) => {
      const representations: FixtureIcon['representations'] = [];
      return {
        bytes,
        representations,
        addRepresentation: (representation: FixtureIcon['representations'][number]) =>
          representations.push(representation),
      };
    },
    translate: (text: string) => text,
    canSetTitle: () => canTitle,
    reducedMotion: () => reduced,
    windows: true,
  });
  return {
    activity,
    timers,
    titles,
    overlays,
    module,
    destroyed: () => {
      destroyed = true;
    },
    canTitle: (value: boolean) => {
      canTitle = value;
    },
  };
}

test('taskbar badge stays small and confined to the lower-right corner at 100%, 150% and 200% DPI', async () => {
  const f = await fixture(true);
  const areas: number[] = [];
  for (const scale of [1, 1.5, 2]) {
    const width = 16 * scale;
    const bitmap = f.module.activityDotBitmap('local', 255, scale) as Buffer;
    assert.equal(bitmap.length, width * width * 4);
    let alphaArea = 0;
    for (let y = 0; y < width; y++)
      for (let x = 0; x < width; x++) {
        const offset = (y * width + x) * 4;
        const alpha = bitmap[offset + 3]!;
        alphaArea += alpha / 255;
        if (x < 8 * scale || y < 8 * scale) assert.equal(alpha, 0, 'Top and left remain transparent');
        if (alpha > 0) {
          assert.deepEqual([...bitmap.subarray(offset, offset + 3)], [236, 167, 117]);
          assert.ok(x < 15.5 * scale && y < 15.5 * scale, 'Antialiasing does not clip at the canvas edge');
        }
      }
    assert.ok(alphaArea / (width * width) < 0.12, 'The badge covers less than 12% of its overlay canvas');
    areas.push(alphaArea / (scale * scale));
  }
  assert.ok(Math.max(...areas) - Math.min(...areas) < 1, 'DPI does not enlarge the logical badge area');
  f.activity.update({ running: 0, localRunning: 1, localTitle: '本地媒体比对' });
  const icon = f.overlays.at(-1)!.icon!;
  assert.deepEqual(
    icon.representations.map(({ scaleFactor, width, height }) => [scaleFactor, width, height]),
    [
      [1.5, 24, 24],
      [2, 32, 32],
    ],
  );
  for (const representation of icon.representations)
    assert.deepEqual(representation.buffer, f.module.activityDotBitmap('local', 255, representation.scaleFactor));
  f.activity.dispose();
});

test('taskbar keeps its local blue dot visible while breathing, turns green for Agent work and clears on idle', async () => {
  const f = await fixture();
  f.activity.update({ running: 0, localRunning: 1, localTitle: '本地媒体比对' });
  assert.equal(f.titles.at(-1), 'PugPort · 本地媒体比对');
  assert.equal(f.timers.size, 1);
  const center = (12 * 16 + 12) * 4;
  assert.deepEqual([...f.overlays.at(-1)!.icon!.bytes.subarray(center, center + 4)], [236, 167, 117, 255]);
  const firstTimer = [...f.timers.values()][0]!;
  firstTimer();
  firstTimer();
  assert.equal(f.overlays.at(-1)!.icon!.bytes[center + 3], 192);
  const before = f.overlays.length;
  f.activity.update({ running: 0, localRunning: 1, localTitle: '本地媒体比对' });
  assert.equal(f.overlays.length, before);
  f.activity.update({ running: 1, localRunning: 1, localTitle: '本地媒体比对' });
  assert.match(f.titles.at(-1)!, /Agent.*本地媒体比对/);
  assert.deepEqual([...f.overlays.at(-1)!.icon!.bytes.subarray(center, center + 3)], [90, 211, 52]);
  f.activity.update({ running: 0, localRunning: 0 });
  assert.equal(f.titles.at(-1), 'PugPort');
  assert.equal(f.overlays.at(-1)!.icon, null);
  assert.equal(f.timers.size, 0);
  f.activity.dispose();
});

test('reduced motion is static, startup/error titles stay intact, and disposal stops pending callbacks', async () => {
  const f = await fixture(true);
  f.canTitle(false);
  f.activity.update({ running: 1 });
  assert.deepEqual(f.titles, []);
  assert.equal(f.timers.size, 0);
  f.canTitle(true);
  f.activity.title();
  assert.match(f.titles.at(-1)!, /Agent/);
  f.activity.dispose();
  const before = f.overlays.length;
  f.activity.update({ running: 2 });
  f.activity.title();
  assert.equal(f.overlays.length, before);
  const moving = await fixture();
  moving.activity.update({ running: 1 });
  const stale = [...moving.timers.values()][0]!;
  moving.activity.dispose();
  assert.equal(moving.timers.size, 0);
  const after = moving.overlays.length;
  stale();
  assert.equal(moving.overlays.length, after);
});
