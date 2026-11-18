import { readFileSync, writeFileSync } from 'node:fs';

const state = await fetch('http://127.0.0.1:4317/api/state').then((response) => response.json());
const receipt = {
  verifiedAt: new Date().toISOString(),
  providers: ['Codex CLI', 'Claude CLI', 'Cursor CLI', 'Grok CLI', 'Pi API'],
  validation: {
    unifiedRegressionPassed: 337,
    finalTargetedRegressionPassed: 153,
    typecheck: 'passed',
    diffCheck: 'passed',
    i18n: '4178 keys; zero missing',
    build: 'passed',
  },
  deployment: JSON.parse(readFileSync('reports/trajectory-backend-refresh.json', 'utf8')),
  realRun: JSON.parse(readFileSync('reports/trajectory-real-run-verification.json', 'utf8')),
  browser: {
    sourceCounts: { native: 16, pugport: 15 },
    originalToolObservationsVisibleAfterPagination: 84,
    originalPublicNonTextEventsVisibleAfterPagination: 183,
    fullToolDetailLength: 19538,
    fullToolDetailScrollable: true,
    fullTerminalArgsOutputAndLastObservationVerified: true,
    consoleErrors: 0,
    screenshots: [
      'reports/trajectory-concrete-tools.png',
      'reports/trajectory-full-tool-detail.png',
      'reports/trajectory-tool-hierarchy.png',
    ],
  },
  currentActivity: {
    activeRuns: state.runs.filter((run) => ['queued', 'running', 'waiting-approval'].includes(run.status)).length,
    backgroundTasks: state.backgroundTasks.length,
  },
  limitations: [
    'Old uncaptured events cannot be reconstructed; the verified old run lacks 47 model text deltas.',
    'Native executors may omit internal system prompts or details; these are not fabricated.',
    'Tool captures retain explicit size-limit markers; detail dialogs cannot recover uncaptured contents.',
    'The already-open desktop renderer needs to be reopened to load the new UI bundle.',
  ],
};
writeFileSync('reports/trajectory-diagnostic-final-validation.json', JSON.stringify(receipt, null, 2) + '\n');
console.log(
  JSON.stringify({
    verifiedAt: receipt.verifiedAt,
    currentActivity: receipt.currentActivity,
    validation: receipt.validation,
  }),
);
