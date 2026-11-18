import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { Store } from '../src/server/store.ts';
import { Controller } from '../src/server/controller.ts';
import { readJevKey, saveJevKey, jevConfigured } from '../src/server/jev-config.ts';
import { secretsDirectory } from '../src/server/api-providers.ts';

test('stored legacy CUDA settings migrate once to cloud and local remains available after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pugport-laya-migrate-'));
  const data = join(directory, 'data');
  try {
    const seed = new Store(data);
    seed.setConfig('settings', {
      laya: {
        enabled: true,
        pythonPath: 'C:/synthetic/python.exe',
        checkpointPath: 'C:/synthetic/model',
        recordTraining: false,
      },
      taskJudgment: 'jev',
      memoryEvidence: 'jev',
    });
    seed.close();
    let controller = new Controller(directory, data);
    try {
      assert.equal(controller.settings.laya?.mode, 'cloud');
      assert.equal(controller.settings.laya?.pythonPath, 'C:/synthetic/python.exe');
      assert.equal(controller.settings.laya?.recordTraining, false);
      assert.equal(controller.settings.taskJudgment, 'local');
      assert.equal(controller.settings.memoryEvidence, 'local');
      controller.updateSettings({ laya: { mode: 'jev', shareTraining: true } });
      assert.equal(controller.settings.taskJudgment, 'jev');
      assert.ok(controller.store.config<{ at: number }>('layaConsentAfter', { at: 0 }).at > 0);
    } finally {
      await controller.close();
    }
    controller = new Controller(directory, data);
    try {
      assert.equal(controller.settings.laya?.mode, 'jev');
      assert.equal(controller.settings.laya?.checkpointPath, 'C:/synthetic/model');
      controller.updateSettings({ laya: { mode: 'local' } });
      assert.equal(controller.settings.laya?.mode, 'local');
      assert.equal(controller.settings.taskJudgment, 'local');
      assert.equal(controller.settings.laya?.shareTraining, true);
    } finally {
      await controller.close();
    }
  } finally {
    const path = resolve(directory);
    assert.ok(path.startsWith(resolve(tmpdir()) + sep) && basename(path).startsWith('pugport-laya-migrate-'));
    await rm(path, { recursive: true, force: true });
  }
});

test('Jev key uses the private API credential store and can be removed without changing settings', async () => {
  const key = 'synthetic-jev-key-for-local-test';
  try {
    await saveJevKey(key);
    assert.equal(jevConfigured(), true);
    assert.equal(readJevKey(), key);
    assert.equal(await readFile(join(secretsDirectory(), 'api-jev-routing.key'), 'utf8'), key);
    await assert.rejects(saveJevKey('bad key with whitespace'));
    assert.equal(readJevKey(), key);
    await saveJevKey('');
    assert.equal(jevConfigured(), false);
  } finally {
    await saveJevKey('');
  }
});

test('Jev HTTP configuration never echoes malformed credential bodies', async () => {
  const { default: express } = await import('express');
  const { jevRoutes } = await import('../src/server/jev-config.ts');
  const app = express();
  jevRoutes(app);
  app.use(express.json());
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>((done, reject) => {
      server.once('listening', done);
      server.once('error', reject);
    });
    const address = server.address() as import('node:net').AddressInfo;
    for (const body of [
      '{"apiKey":"SYNTHETIC_PRIVATE_CREDENTIAL",',
      '{"apiKey":"' + 'SYNTHETIC_PRIVATE_CREDENTIAL'.repeat(1000),
    ]) {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/jev/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      assert.ok([400, 413].includes(response.status));
      assert.equal(await response.text(), '{"error":"Invalid JSON body"}');
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});
