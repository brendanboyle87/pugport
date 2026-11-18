import React from 'react';
import { createRoot } from 'react-dom/client';
import { UsageSpend } from '../../src/ui/UsageSpend';
import { startInterfaceLanguage } from '../../src/ui/i18n';
import type { AppState } from '../../src/shared/types';
import type { Api } from '../../src/ui/Workspace';
import '@fontsource-variable/inter';
import '@fontsource-variable/noto-sans-sc';
import '../../src/ui/studio.css';
import '../../src/ui/UsageSpend.css';

const fixture = window as unknown as {
  calls: string[];
  errors: string[];
  ready: boolean;
  opened: string[];
  spendFixtures: Record<string, unknown>;
};
fixture.calls = [];
fixture.errors = [];
fixture.opened = [];
window.addEventListener('error', (e) => fixture.errors.push(e.message));
window.addEventListener('unhandledrejection', (e) => fixture.errors.push(String(e.reason)));
window.fetch = () => {
  throw Error('Unexpected network request');
};
localStorage.setItem('comborunner.locale', new URLSearchParams(location.search).get('locale') ?? 'en');
sessionStorage.clear();
const state = { projects: [], targets: [], runtimes: [], runs: [], settings: {} } as unknown as AppState;
const api = (async (path: string) => {
  fixture.calls.push(path);
  const url = new URL(path, 'https://fixture.invalid');
  const q = url.searchParams;
  const key = url.pathname.endsWith('/details')
    ? `details-${q.get('group') ?? 'task'}`
    : `${q.get('range') ?? '7d'}-${q.get('billing') ?? 'all'}`;
  return structuredClone(fixture.spendFixtures[key] ?? fixture.spendFixtures['7d-all']);
}) as Api;
void startInterfaceLanguage().then(() => {
  createRoot(document.getElementById('root')!).render(
    <UsageSpend state={state} api={api} onInspect={(id) => fixture.opened.push(id)} />,
  );
  fixture.ready = true;
});
