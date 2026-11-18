import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fork } from '../src/server/platform/test-process.ts';
import { testDirectory } from '../src/server/platform/under-test.ts';

test(
  'real backend leaves dormant connector data alone and returns 404 for connector routes',
  { timeout: 30000 },
  async (t) => {
    const root = join(testDirectory(), 'trim-backend');
    const data = join(root, 'data');
    await mkdir(data, { recursive: true });
    const saved = join(data, 'connectors.private.json');
    await writeFile(saved, 'synthetic dormant data; never parse or rewrite');
    const child = fork(resolve('src/server/main.ts'), [], {
      silent: true,
      execArgv: ['--import', 'tsx'],
      env: {
        ...process.env,
        COMBORUNNER_ROOT: root,
        COMBORUNNER_DATA_DIR: data,
        COMBORUNNER_PORT: '0',
        PUGPORT_ROLE: 'node',
        PUGPORT_PEER_HOST: '127.0.0.1',
        PUGPORT_PEER_PORT: '0',
        PUGPORT_NODE_FEATURES: '',
        PUGPORT_RUNTIME_DIR: join(root, 'runtime'),
      },
    });
    child.stdout?.resume();
    child.stderr?.resume();
    t.after(async () => {
      if (child.exitCode !== null) return;
      const closed = once(child, 'exit');
      child.send('shutdown');
      const timer = setTimeout(() => child.kill(), 5000);
      await closed.finally(() => clearTimeout(timer));
    });
    let token = '';
    let owner = '';
    let ready: { type: string; port: number; token?: string; owner?: string };
    do {
      [ready] = (await once(child, 'message')) as [typeof ready];
      if (ready.type === 'session') {
        token = ready.token ?? '';
        owner = ready.owner ?? '';
      }
    } while (ready.type !== 'ready');
    const base = `http://127.0.0.1:${ready.port}`;
    for (const [method, path] of [
      ['GET', '/api/connectors'],
      ['GET', '/api/connectors/oauth/callback'],
      ['POST', '/api/connectors/connect'],
      ['PATCH', '/api/conversations/synthetic/connectors'],
    ]) {
      const response = await fetch(base + path, {
        method,
        headers: { 'x-agent-token': token, 'x-pugport-owner': owner, 'Content-Type': 'application/json' },
        ...(method === 'GET' ? {} : { body: '{}' }),
      });
      assert.equal(response.status, 404, `${method} ${path}`);
    }
    const info = (await (
      await fetch(`${base}/api/app-info`, { headers: { 'x-agent-token': token, 'x-pugport-owner': owner } })
    ).json()) as {
      tools: Record<string, unknown>;
    };
    assert.equal('everything' in info.tools, false);
    assert.equal('embeddinggemma' in info.tools, false);
    assert.equal(await readFile(saved, 'utf8'), 'synthetic dormant data; never parse or rewrite');
  },
);
