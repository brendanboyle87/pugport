/** Opt-in isolated startup measurement. Private snapshots and measurements stay in Temp. */
import { DatabaseSync, StatementSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer, get } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

const source = process.argv[2];
if (!source) throw new Error('Usage: startup-profile.ts <source.sqlite> [source-root] [seconds=120]');
const root = resolve(process.argv[3] || '.');
const seconds = Number(process.argv[4] || 120);
if (!(seconds >= 1 && seconds <= 600)) throw new Error('Invalid observation duration');
const port = Number(process.env.STARTUP_PROFILE_PORT || 6391);
if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 4317)
  throw new Error('Use an isolated non-desktop port');
const directory = mkdtempSync(join(tmpdir(), 'startup-profile-'));
const data = join(directory, 'data');
mkdirSync(data);
for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR'])
  process.env[key] = join(directory, 'home');
Object.assign(process.env, {
  PUGPORT_UNDER_TEST: '1',
  COMBORUNNER_DATA_DIR: data,
  COMBORUNNER_MEMORY_DIR: join(directory, 'memory'),
});
const original = new DatabaseSync(resolve(source), { readOnly: true });
try {
  original.prepare('VACUUM INTO ?').run(join(data, 'studio.sqlite'));
} finally {
  original.close();
}
const copy = new DatabaseSync(join(data, 'studio.sqlite'));
// Reusing an already-profiled private snapshot must still exercise reconciliation, not its warm checkpoint.
const forceReconcile = process.env.STARTUP_PROFILE_FORCE_RECONCILE === '1';
if (forceReconcile) {
  copy.exec("DELETE FROM workspace_records WHERE kind='migration' AND id='workflow-follow-ups-v1'");
  copy.exec('UPDATE usage_history_state SET imported_revision=-1');
  copy.exec(
    "UPDATE usage_runs SET value=json_remove(value,'$.observationVersion') WHERE id=(SELECT id FROM usage_runs LIMIT 1)",
  );
}
// Change only the copy: no credentials, project paths, execution or third-party service configuration.
copy.prepare("UPDATE config SET value='[]' WHERE key='targets'").run();
copy.prepare("UPDATE config SET value=? WHERE key='settings'").run(
  JSON.stringify({
    defaultProjectPath: directory,
    updateCheck: false,
    laya: { mode: 'local', recordTraining: false },
    hindsight: { enabled: false },
  }),
);
const projects = copy.prepare("SELECT id,value FROM workspace_records WHERE kind='project'").all();
for (const [index, row] of projects.entries()) {
  const value = JSON.parse(String(row.value));
  value.path = join(directory, 'projects', String(index));
  mkdirSync(value.path, { recursive: true });
  value.localMemory = { exportEnabled: false, cliEnabled: false };
  copy.prepare("UPDATE workspace_records SET value=? WHERE kind='project' AND id=?").run(JSON.stringify(value), row.id);
}
const counts = copy.prepare('SELECT kind,COUNT(*) AS count FROM workspace_records GROUP BY kind').all();
const runs = copy.prepare('SELECT COUNT(*) AS count FROM runs').get();
copy.close();
const load = (file: string) => import(pathToFileURL(join(root, 'src/server', file)).href);
const [{ Controller }, { Workspace }, { localComputer }, { LayaTrainingUpload }, memory] = await Promise.all([
  load('controller.ts'),
  load('workspace.ts'),
  load('platform/computer-context.ts'),
  load('laya-training-upload.ts'),
  load('memory-retrieval.ts'),
]);
// External probes, executor wakeups and filesystem deletion are outside this constructor/HTTP experiment.
Controller.prototype.readMachine = () => {};
Controller.prototype.resetTimer = () => {};
Controller.prototype.refresh = async () => {};
Workspace.prototype.purgeIncognito = async () => {};
Workspace.prototype.scheduleQueuedSteers = () => {};
localComputer.refresh = async () => {};
LayaTrainingUpload.prototype.start = () => {};
const timings: Record<string, { calls: number; totalMs: number; maxMs: number }> = {};
function record(name: string, start: number) {
  const ms = performance.now() - start;
  const item = (timings[name] ??= { calls: 0, totalMs: 0, maxMs: 0 });
  item.calls++;
  item.totalMs += ms;
  item.maxMs = Math.max(item.maxMs, ms);
}
for (const [file, className, names] of [
  ['usage.ts', 'UsageLedger', ['historyImport', 'normalizeHistory', 'importHistoryRows', 'historyImportSteps']],
  ['account-health.ts', 'AccountHealth', ['enrichExistingEvidence']],
  ['store.ts', 'Store', ['config', 'setConfig', 'saveRun', 'runSummaries', 'storedRun']],
] as const) {
  const prototype = (await load(file))[className].prototype;
  for (const name of names) {
    const method = prototype[name];
    if (typeof method !== 'function') continue;
    prototype[name] = function (...args: unknown[]) {
      const start = performance.now();
      try {
        const result = method.apply(this, args);
        if (result && typeof result.next === 'function') {
          const next = result.next;
          result.next = function (...values: unknown[]) {
            const step = performance.now();
            try {
              return next.apply(this, values);
            } finally {
              record(`${className}.${name}.next`, step);
            }
          };
        }
        return result;
      } finally {
        record(`${className}.${name}`, start);
      }
    };
  }
}
const statementNames = new WeakMap<object, string>();
for (const [prototype, names] of [
  [DatabaseSync.prototype, ['exec', 'prepare']],
  [StatementSync.prototype, ['run', 'all', 'get']],
] as const) {
  for (const name of names) {
    const method = Reflect.get(prototype, name);
    Reflect.set(prototype, name, function (this: unknown, ...args: unknown[]) {
      const start = performance.now();
      try {
        const result = method.apply(this, args);
        if (name === 'prepare') {
          const sql = String(args[0]);
          const table = /\b(?:FROM|INTO|UPDATE|TABLE(?: IF NOT EXISTS)?)\s+(\w+)/i.exec(sql)?.[1] ?? 'other';
          statementNames.set(result, `${sql.trim().split(/\s+/)[0].toUpperCase()}.${table}`);
        }
        return result;
      } finally {
        record(`sqlite.${name}`, start);
        const label = statementNames.get(this as object);
        if (label) record(`sql.${label}.${name}`, start);
      }
    });
  }
}
for (const name of [
  'repairWorkflowFollowUps',
  'archiveSettledDelegations',
  'archiveSettledDispatches',
  'refreshMemories',
  'state',
  'repairWorkflowFollowUpSteps',
  'archiveSettledDelegationSteps',
  'archiveSettledDispatchSteps',
]) {
  const method = Workspace.prototype[name];
  if (!method) continue;
  Workspace.prototype[name] = function (...args: unknown[]) {
    const start = performance.now();
    try {
      const result = method.apply(this, args);
      if (result && typeof result.next === 'function') {
        const next = result.next;
        result.next = function (...values: unknown[]) {
          const step = performance.now();
          try {
            return next.apply(this, values);
          } finally {
            record(`${name}.next`, step);
          }
        };
      }
      return result;
    } finally {
      record(name, start);
    }
  };
}
let skippedArchiveErrors = 0;
console.debug = () => {
  skippedArchiveErrors++;
};
const stages: Record<string, number> = {};
let maxLagMs = 0;
let readyAt: number | undefined;
let initialLagMs = 0;
let previous = performance.now();
const monitor = setInterval(() => {
  const now = performance.now();
  if (readyAt !== undefined) maxLagMs = Math.max(maxLagMs, now - Math.max(previous, readyAt) - 20);
  else initialLagMs = Math.max(initialLagMs, now - previous - 20);
  previous = now;
}, 20);
await delay(25);
const start = performance.now();
let at = start;
const controller = new Controller(root, data, {
  readAccountIdentity: () => undefined,
  nativeLogin: { pending: () => false },
});
stages.controllerMs = performance.now() - at;
console.log(JSON.stringify({ directory, stages, timings }));
controller.targets = [];
controller.snapshots = [];
at = performance.now();
const workspace = new Workspace(controller, { autoTick: false, memoryDebounceMs: 1000 });
stages.workspaceMs = performance.now() - at;
at = performance.now();
controller.recentState();
stages.firstStateMs = performance.now() - at;
const server = createServer((_request, response) => {
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(controller.recentState()));
});
await new Promise<void>((done, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', done);
});
stages.readyMs = performance.now() - start;
readyAt = performance.now();
initialLagMs = Math.max(initialLagMs, readyAt - previous - 20);
at = performance.now();
await new Promise<void>((done, reject) => {
  get(`http://127.0.0.1:${port}/`, (response) => {
    response.resume();
    response.on('end', done);
    response.on('error', reject);
  }).on('error', reject);
});
stages.firstHttpMs = performance.now() - at;
at = performance.now();
await memory.warmMemoryRetrieval(workspace.store);
stages.retrievalWarmMs = performance.now() - at;
console.log(JSON.stringify({ directory, stages, timings, initialLagMs, skippedArchiveErrors }));
await delay(Math.max(0, seconds * 1000 - (performance.now() - readyAt)));
clearInterval(monitor);
const report = {
  sourceRoot: root,
  directory,
  isolation: 'copied database; constructor and minimal HTTP harness; external probes, CLI and purge disabled',
  counts,
  runs,
  stages,
  timings,
  initialLagMs,
  observationSeconds: seconds,
  forceReconcile,
  maxLagMs,
  skippedArchiveErrors,
};
writeFileSync(join(directory, 'profile.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
// Worker shutdown timers are unref'd in the app, where the HTTP listener normally keeps them alive.
const cleanupKeepAlive = setInterval(() => {}, 1000);
try {
  await new Promise<void>((done) => server.close(() => done()));
  await memory.closeMemoryRetrieval(workspace.store);
  await workspace.close();
  await controller.close();
} finally {
  clearInterval(cleanupKeepAlive);
}
console.log(JSON.stringify({ cleanupComplete: true, exitCode: process.exitCode ?? 0 }));
