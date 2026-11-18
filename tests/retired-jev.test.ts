import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fork } from '../src/server/platform/test-process.ts';
import { Store } from '../src/server/store.ts';
import type { AppState, Settings } from '../src/shared/types.ts';

test(
  'old settings and keys stay local across HTTP updates and restart without key reads or requests',
  { timeout: 30000 },
  async (t) => {
    const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const directory = mkdtempSync(join(tmpdir(), 'pugport-retired-jev-'));
    const dataDir = join(directory, 'data');
    const home = join(directory, 'home');
    mkdirSync(home);
    const keyFile = join(home, '.jev-router.env');
    const legacyFile = join(home, '.jev-claude.env');
    const syntheticKey = 'synthetic-retired-key';
    writeFileSync(keyFile, `JEV_API_KEY=${syntheticKey}\n`);
    writeFileSync(legacyFile, `TYPESAFE_API_KEY=${syntheticKey}\n`);
    const seed = new Store(dataDir);
    seed.setConfig('settings', { taskJudgment: 'jev', memoryEvidence: 'jev', reservePercent: 17 });
    seed.setConfig(
      'targets',
      (['codex', 'cursor', 'gemini', 'pi'] as const).map((provider) => ({
        id: provider === 'pi' ? 'pi-local' : `${provider}-native`,
        provider,
        label: provider,
        command: 'unused',
        commandDiscovery: 'fixed' as const,
        environment: 'native' as const,
        enabled: false,
      })),
    );
    seed.close();
    const entry = join(directory, 'retired-jev.mjs');
    writeFileSync(
      entry,
      `
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { basename } from 'node:path';
let keyReads = 0, keyEnvReads = 0, requests = 0;
const keyPath = value => ['.jev-router.env', '.jev-claude.env'].includes(basename(String(value)));
for (const [api, names] of [[fs, ['readFileSync', 'statSync', 'openSync']], [fsp, ['readFile', 'stat', 'open']]]) {
  for (const name of names) {
    const original = api[name];
    api[name] = function(path, ...args) {
      if (keyPath(path)) { keyReads++; throw new Error('Retired key file must not be read'); }
      return original.call(this, path, ...args);
    };
  }
}
syncBuiltinESMExports();
process.env = new Proxy(process.env, { get(target, property) {
  if (property === 'JEV_API_KEY' || property === 'TYPESAFE_API_KEY') { keyEnvReads++; throw new Error('Retired key environment must not be read'); }
  return Reflect.get(target, property);
}, set(target, property, value) { target[property] = value; return true; } });
globalThis.fetch = async (url) => {
  const hostname = new URL(String(url)).hostname;
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostname)) requests++;
  throw new Error('HTTP forbidden in fixture');
};
process.on('message', message => {
  if (message === 'inspect-retired-jev') process.send?.({ type: 'retired-jev-audit', keyReads, keyEnvReads, requests });
});
await import(${JSON.stringify(pathToFileURL(join(sourceRoot, 'src/server/main.ts')).href)});
`,
    );
    t.after(() => {
      const safe = resolve(directory);
      assert.ok(safe.startsWith(resolve(tmpdir()) + sep) && basename(safe).startsWith('pugport-retired-jev-'));
      rmSync(safe, { recursive: true, force: true });
    });
    for (let restart = 0; restart < 2; restart++) {
      const child = fork(entry, [], {
        cwd: sourceRoot,
        execArgv: ['--import', 'tsx'],
        windowsHide: true,
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          COMBORUNNER_DATA_DIR: dataDir,
          COMBORUNNER_ROOT: sourceRoot,
          COMBORUNNER_PORT: '0',
          COMBORUNNER_MEMORY_DIR: join(directory, 'memory'),
          JEV_API_KEY: syntheticKey,
          TYPESAFE_API_KEY: syntheticKey,
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      let output = '';
      child.stdout?.on('data', (chunk) => {
        output += chunk;
      });
      child.stderr?.on('data', (chunk) => {
        output += chunk;
      });
      const exited = new Promise<number | null>((done) => child.once('exit', done));
      try {
        let token = '';
        let owner = '';
        const port = await new Promise<number>((done, reject) => {
          child.once('error', reject);
          child.once('exit', (code) => reject(new Error(`Server exited ${code}: ${output}`)));
          child.on('message', (message) => {
            if ((message as { type?: string }).type === 'session') {
              token = (message as { token: string }).token;
              owner = (message as { owner: string }).owner;
            }
            if ((message as { type?: string }).type === 'ready') done((message as { port: number }).port);
          });
        });
        const base = `http://127.0.0.1:${port}`;
        const session = { token };
        const headers = {
          'Content-Type': 'application/json',
          'x-agent-token': session.token,
          'x-pugport-owner': owner,
        };
        const state = (await fetch(`${base}/api/state`, { headers }).then((response) => response.json())) as AppState;
        assert.equal(state.settings.taskJudgment, 'local');
        assert.equal(state.settings.memoryEvidence, 'local');
        assert.equal(state.settings.reservePercent, 17);
        assert.equal('jev' in state, false);
        assert.ok(!state.plugins.some((plugin) => /jev|typesafe/i.test(JSON.stringify(plugin))));
        const patch = await fetch(`${base}/api/settings`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ taskJudgment: 'jev', memoryEvidence: 'jev' }),
        });
        assert.equal(patch.status, 200);
        const updated = (await patch.json()) as AppState;
        assert.equal(updated.settings.taskJudgment, 'local');
        assert.equal(updated.settings.memoryEvidence, 'local');
        const removed = await fetch(`${base}/api/jev/key`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ key: 'synthetic-new-key' }),
        });
        assert.equal(removed.status, 404);
        const audit = new Promise<{ keyReads: number; keyEnvReads: number; requests: number }>((done) => {
          child.on('message', (message) => {
            if ((message as { type?: string }).type === 'retired-jev-audit') done(message as never);
          });
        });
        child.send('inspect-retired-jev');
        const result = await audit;
        assert.equal(result.keyReads, 0);
        assert.equal(result.keyEnvReads, 0);
        assert.equal(result.requests, 0);
      } finally {
        if (child.exitCode === null && child.connected) child.send('shutdown');
        const timer = setTimeout(() => child.kill(), 5000);
        await exited;
        clearTimeout(timer);
      }
      const saved = new Store(dataDir);
      try {
        const settings = saved.config<Settings>('settings', {} as Settings);
        assert.equal(settings.taskJudgment, 'local');
        assert.equal(settings.memoryEvidence, 'local');
        assert.equal(settings.reservePercent, 17);
      } finally {
        saved.close();
      }
      assert.equal(readFileSync(keyFile, 'utf8'), `JEV_API_KEY=${syntheticKey}\n`);
      assert.equal(readFileSync(legacyFile, 'utf8'), `TYPESAFE_API_KEY=${syntheticKey}\n`);
    }
  },
);
