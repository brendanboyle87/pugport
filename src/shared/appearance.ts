export const zoomPresets = [0.8, 0.9, 1, 1.1, 1.25, 1.5] as const;
export type AppearanceTheme = 'system' | 'light' | 'dark';

export function isAppearanceTheme(value: unknown): value is AppearanceTheme {
  return value === 'system' || value === 'light' || value === 'dark';
}

export function presetZoom(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1;
  return zoomPresets.reduce<number>(
    (nearest, preset) => (Math.abs(preset - value) < Math.abs(nearest - value) ? preset : nearest),
    1,
  );
}

export function stepZoom(value: number, direction: -1 | 1): number {
  const index = zoomPresets.findIndex((preset) => preset === presetZoom(value));
  return zoomPresets[Math.max(0, Math.min(zoomPresets.length - 1, index + direction))]!;
}
