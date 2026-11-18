import type { RunInput, RuntimeSnapshot, Settings } from '../src/shared/types.ts';
export const now = Date.parse('2026-10-12T12:00:00Z');
export const settings: Settings = {
  refreshSeconds: 60,
  reservePercent: 10,
  maxQuotaAgeSeconds: 180,
  preferCli: true,
  designProvider: 'claude',
  architectureProvider: 'codex',
  routineProvider: 'codex',
  unknownQuotaPolicy: 'manual-only',
  defaultProjectPath: 'fixture',
  maxConcurrentRuns: 2,
};
export const input: RunInput = {
  prompt: 'Say hello',
  kind: 'routine',
  projectPath: 'fixture',
  permissionMode: 'read-only',
};
export const free: RuntimeSnapshot = {
  id: 'api-ollama',
  provider: 'pi',
  gateway: 'api',
  apiProvider: 'ollama',
  costTier: 'free',
  local: true,
  mayLog: false,
  label: 'Ollama',
  environment: 'native',
  installed: true,
  status: 'ready',
  models: [{ id: 'pugport-ollama/qwen', label: 'qwen', efforts: ['off'] }],
  quota: { status: 'unknown', source: 'test', observedAt: null, windows: [] },
  accounting: { mode: 'usage', source: 'test' },
  capabilities: { execute: true, resume: true, cancel: true, approvals: true, toolless: true },
  refreshedAt: new Date(now).toISOString(),
};
export const paid: RuntimeSnapshot = {
  ...free,
  id: 'codex',
  provider: 'codex',
  label: 'Codex',
  apiProvider: undefined,
  costTier: undefined,
  gateway: undefined,
  models: [{ id: 'gpt-6-sol', label: 'Sol', efforts: ['low', 'medium', 'high'] }],
  accounting: { mode: 'subscription', source: 'test' },
  quota: {
    status: 'known',
    source: 'test',
    observedAt: new Date(now).toISOString(),
    windows: [{ id: 'week', label: 'week', usedPercent: 20, resetsAt: new Date(now + 3600000).toISOString() }],
  },
};
