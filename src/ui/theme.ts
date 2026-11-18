import { useEffect, useState } from 'react';
import { desktopBridge } from './desktop';

export type Theme = 'system' | 'light' | 'dark';
export const themeLabels: Record<Theme, string> = { system: '跟随系统', light: '浅色', dark: '深色' };
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(readTheme);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      document.documentElement.dataset.theme = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme;
      document.documentElement.style.colorScheme = document.documentElement.dataset.theme;
      document.documentElement.style.backgroundColor =
        document.documentElement.dataset.theme === 'dark' ? '#121316' : '#f3f3f5';
    };
    apply();
    void desktopBridge()?.setTheme?.(theme).catch(console.warn);
    try {
      localStorage.setItem('agent-studio-theme', theme);
    } catch {
      /* Private sessions still support a temporary theme. */
    }
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === 'agent-studio-theme' || event.key === null) setTheme(readTheme());
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);
  return [theme, setTheme] as const;
}

function readTheme(): Theme {
  try {
    const value = localStorage.getItem('agent-studio-theme');
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

export const accentLabels = { blue: '蓝色', violet: '紫色', teal: '青色', pink: '粉色' } as const;
export type Accent = keyof typeof accentLabels;
function readAccent(): Accent {
  try {
    const value = localStorage.getItem('pugport-accent');
    return value && Object.hasOwn(accentLabels, value) ? (value as Accent) : 'blue';
  } catch {
    return 'blue';
  }
}
export function useAccent() {
  const [accent, setAccent] = useState<Accent>(readAccent);
  useEffect(() => {
    document.documentElement.dataset.accent = accent;
    try {
      localStorage.setItem('pugport-accent', accent);
    } catch {
      /* Temporary accents still work. */
    }
  }, [accent]);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === 'pugport-accent' || event.key === null) setAccent(readAccent());
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);
  return [accent, setAccent] as const;
}
