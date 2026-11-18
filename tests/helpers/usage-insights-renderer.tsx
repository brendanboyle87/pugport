import React from 'react';
import { createRoot } from 'react-dom/client';
import { UsageSpend } from '../../src/ui/UsageSpend';
import { startInterfaceLanguage } from '../../src/ui/i18n';
import type { AppState } from '../../src/shared/types';
import type { InsightFilters } from '../../src/shared/usage-insights';
import type { Api } from '../../src/ui/Workspace';
import { insightFixture } from './usage-insights-fixture';
import '@fontsource-variable/inter';
import '@fontsource-variable/noto-sans-sc';
import '../../src/ui/studio.css';
import '../../src/ui/UsageSpend.css';

const params = new URLSearchParams(location.search);
const locale = params.get('locale') ?? 'en';
localStorage.setItem('comborunner.locale', locale);
sessionStorage.clear();
const fixture = window as unknown as { calls: string[]; errors: string[]; ready: boolean };
fixture.calls = [];
fixture.errors = [];
window.addEventListener('error', (event) => fixture.errors.push(event.message));
window.addEventListener('unhandledrejection', (event) => fixture.errors.push(String(event.reason)));
window.fetch = () => {
  throw new Error('Unexpected network request');
};
const state = { projects: [], targets: [], runtimes: [], runs: [], settings: {} } as unknown as AppState;
const api = (async (path: string) => {
  fixture.calls.push(path);
  const query = new URL(path, 'https://fixture.invalid').searchParams;
  const filters: InsightFilters = {
    range: (query.get('range') ?? '7d') as InsightFilters['range'],
    kind: (query.get('kind') ?? 'all') as InsightFilters['kind'],
    project: query.get('project') ?? '',
    runtime: query.get('runtime') ?? '',
  };
  return insightFixture(filters, params.has('empty'));
}) as Api;
void startInterfaceLanguage().then(() => {
  createRoot(document.getElementById('root')!).render(<UsageSpend state={state} api={api} onInspect={() => {}} />);
  fixture.ready = true;
});
