import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { RuntimeTarget } from '../src/shared/types.ts';
import {
  closeNativeDiscoveryThread,
  discoverNativeInHelper,
  launchNativeDiscoveryHelper,
  useNativeDiscoveryThread,
} from '../src/server/native-discovery-client.ts';

// A synthetic Codex app-server: answers the metadata requests discovery makes, or hangs when told to.
const fixtureSource = String.raw`
const fs = require('node:fs');
const [trace, configPath, ...args] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
fs.appendFileSync(trace, JSON.stringify({ pid: process.pid, stage: args[0] }) + '\n');
const send = value => console.log(JSON.stringify(value));
if (config.hang) { process.stdin.resume(); setInterval(() => {}, 1000); }
else require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const packet = JSON.parse(line);
  if (packet.method === 'initialized') return;
  const result = packet.method === 'account/read'
    ? { account: { type: 'chatgpt', planType: 'plus' }, requiresOpenaiAuth: false }
    : packet.method === 'model/list'
      ? { data: [{ id: 'gpt-fixture', model: 'gpt-fixture', displayName: 'Fixture', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'medium' }], defaultReasoningEffort: 'medium' }] }
      : packet.method === 'account/rateLimits/read'
        ? { accountId: 'fixture-account', rateLimitsByLimitId: { codex: { primary: { usedPercent: config.used, windowDurationMins: 300, resetsAt: 4102444800 } } } }
        : {};
  send({ id: packet.id, result });
}).on('close', () => process.exit(0));
`;

async function fixture(id: string, config: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), 'native-discovery-thread-'));
  const script = join(root, 'fixture.cjs');
  const tracePath = join(root, 'trace.jsonl');
  const configPath = join(root, 'config.json');
  await writeFile(script, fixtureSource);
  await writeFile(configPath, JSON.stringify(config));
  const target: RuntimeTarget = {
    id,
    provider: 'codex',
    label: id,
    command: process.execPath,
    args: [script, tracePath, configPath],
    environment: 'native',
    enabled: true,
  };
  return {
    target,
    pids: async () =>
      (await readFile(tracePath, 'utf8').catch(() => ''))
        .split('\n')
        .filter(Boolean)
        .map((line) => (JSON.parse(line) as { pid: number }).pid),
    clean: () => rm(root, { recursive: true, force: true }),
  };
}
const gone = (pid: number) => assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });

test(
  'helpers launched from the discovery thread return the same metadata, each to its own caller',
  { timeout: 60_000 },
  async () => {
    const a = await fixture('synthetic-a', { used: 12 });
    const b = await fixture('synthetic-b', { used: 34 });
    try {
      const direct = await launchNativeDiscoveryHelper(a.target);
      useNativeDiscoveryThread();
      // The event loop keeps turning while the thread creates the processes.
      let turns = 0;
      const ticking = setInterval(() => turns++, 5);
      const [first, second] = await Promise.all([discoverNativeInHelper(a.target), discoverNativeInHelper(b.target)]);
      clearInterval(ticking);
      assert.ok(turns > 0);
      assert.deepEqual([first.snapshot.id, second.snapshot.id], ['synthetic-a', 'synthetic-b']);
      assert.equal(first.snapshot.status, 'ready');
      assert.deepEqual(first.snapshot.models, direct.snapshot.models);
      assert.deepEqual(
        [first.snapshot.quota.windows[0]?.usedPercent, second.snapshot.quota.windows[0]?.usedPercent],
        [12, 34],
      );
      // A failure inside the thread reaches the caller as the same error, and the thread keeps serving.
      await assert.rejects(
        discoverNativeInHelper({ ...a.target, provider: 'pi' }),
        (error: Error) => error.message === 'runtime-protocol-incompatible',
      );
      assert.equal((await discoverNativeInHelper(b.target)).snapshot.id, 'synthetic-b');
      for (const pid of [...(await a.pids()), ...(await b.pids())]) gone(pid);
    } finally {
      await closeNativeDiscoveryThread();
      await a.clean();
      await b.clean();
    }
  },
);

test('closing the discovery thread stops a helper that is still waiting on its CLI', { timeout: 60_000 }, async () => {
  const f = await fixture('synthetic-hang', { hang: true });
  try {
    useNativeDiscoveryThread();
    const pending = discoverNativeInHelper(f.target);
    const rejected = assert.rejects(pending, /operation-cancelled|runtime-process-closed/);
    const deadline = Date.now() + 30_000;
    while (!(await f.pids()).length) {
      assert.ok(Date.now() < deadline, 'the fixture CLI never started');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await closeNativeDiscoveryThread();
    await rejected;
    for (const pid of await f.pids()) gone(pid);
  } finally {
    await closeNativeDiscoveryThread();
    await f.clean();
  }
});
