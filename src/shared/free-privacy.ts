import { apiPreset } from './api-providers.ts';

/** Hosted presets cannot disable the guard; custom endpoints default to may-log. */
export function sourceMayLog(source: { apiProvider?: string; apiMayLog?: boolean; mayLog?: boolean }): boolean {
  const preset = apiPreset(source.apiProvider);
  if (preset?.tier !== 'free') return source.mayLog === true;
  return preset.id === 'custom' ? (source.apiMayLog ?? source.mayLog) !== false : preset.mayLog === true;
}
