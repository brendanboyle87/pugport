import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { Controller } from '../src/server/controller.ts';

test('a connection test retries when another lookup fills the missing workspace', async () => {
  const before = { id: 'synthetic', gateway: 'api', apiProvider: 'anthropic', args: [] };
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ args: [], gateway: 'api' }))
    .digest('hex');
  let retried = 0;
  const controller = Object.create(Controller.prototype);
  Object.assign(controller, {
    closing: false,
    closed: false,
    active: new Map(),
    targets: [{ ...before, apiWorkspaceId: 'wrkspc_fixture' }],
    snapshots: [],
    store: { run: () => undefined, config: () => ({}), setConfig() {} },
    detectApiWorkspace: async () => false,
    testConnection: async () => {
      retried++;
    },
    broadcast() {},
  });
  await controller.observeConnectionTest(
    'synthetic',
    {
      id: 'run',
      status: 'failed',
      errorCode: 'api-key-workspace-required',
      route: { model: 'fixture' },
      output: '',
    },
    fingerprint,
  );
  assert.equal(retried, 1);
});
