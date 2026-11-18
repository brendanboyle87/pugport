import type { BrowserWindow, NativeImage } from 'electron';
import { activityLabel, activityTone, type DesktopActivity } from '../shared/background-activity.ts';

/** A small lower-right badge in a transparent overlay; bitmap channels are BGRA. */
export function activityDotBitmap(tone: 'agent' | 'local', opacity = 255, scaleFactor = 1) {
  const width = Math.round(16 * scaleFactor);
  const bitmap = Buffer.alloc(width * width * 4);
  const color = tone === 'agent' ? [90, 211, 52] : [236, 167, 117];
  const center = 12.25 * scaleFactor;
  const radius = 2.75 * scaleFactor;
  for (let y = 0; y < width; y++)
    for (let x = 0; x < width; x++) {
      const distance = Math.hypot(x + 0.5 - center, y + 0.5 - center);
      const alpha = Math.max(0, Math.min(1, radius + 0.5 - distance));
      if (alpha === 0) continue;
      const offset = (y * width + x) * 4;
      bitmap[offset] = color[0]!;
      bitmap[offset + 1] = color[1]!;
      bitmap[offset + 2] = color[2]!;
      bitmap[offset + 3] = Math.round(alpha * opacity);
    }
  return bitmap;
}

/** Keep OS activity separate from page headings and from cached quota readings. */
export function createWindowActivity(options: {
  window: Pick<BrowserWindow, 'isDestroyed' | 'setTitle' | 'setOverlayIcon'>;
  image: (bitmap: Buffer) => NativeImage;
  translate: (text: string) => string;
  canSetTitle: () => boolean;
  reducedMotion: () => boolean;
  windows: boolean;
}) {
  let tone: ReturnType<typeof activityTone> = 'idle';
  let label = '';
  let frame = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let disposed = false;
  let overlaySet = false;
  const icons = new Map<string, NativeImage>();
  const opacities = [255, 224, 192, 224];
  const stopPulse = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };
  const title = () => {
    if (disposed || options.window.isDestroyed() || !options.canSetTitle()) return;
    options.window.setTitle(tone === 'idle' ? 'PugPort' : `PugPort · ${label}`);
  };
  const paint = () => {
    if (disposed || options.window.isDestroyed() || !options.windows) return;
    if (tone === 'idle') {
      if (overlaySet) options.window.setOverlayIcon(null, '');
      overlaySet = false;
      return;
    }
    const opacity = opacities[frame]!;
    const key = `${tone}:${opacity}`;
    let icon = icons.get(key);
    if (!icon) {
      icon = options.image(activityDotBitmap(tone, opacity));
      // Preserve the badge's 5.5 DIP size at common Windows display scales.
      for (const scaleFactor of [1.5, 2]) {
        const size = 16 * scaleFactor;
        icon.addRepresentation({
          scaleFactor,
          width: size,
          height: size,
          buffer: activityDotBitmap(tone, opacity, scaleFactor),
        });
      }
      icons.set(key, icon);
    }
    options.window.setOverlayIcon(icon, label);
    overlaySet = true;
  };
  return {
    title,
    update(activity: DesktopActivity) {
      if (disposed || options.window.isDestroyed()) return;
      const nextTone = activityTone(activity);
      const nextLabel = activityLabel(activity, options.translate);
      const reduced = options.reducedMotion();
      if (nextTone === tone && nextLabel === label && !!timer === (!reduced && tone !== 'idle' && options.windows))
        return;
      tone = nextTone;
      label = nextLabel;
      frame = 0;
      stopPulse();
      title();
      paint();
      if (tone !== 'idle' && options.windows && !reduced)
        timer = setInterval(() => {
          frame = (frame + 1) % opacities.length;
          paint();
        }, 1000);
    },
    dispose() {
      disposed = true;
      stopPulse();
      if (overlaySet && !options.window.isDestroyed()) options.window.setOverlayIcon(null, '');
      overlaySet = false;
      icons.clear();
    },
  };
}
