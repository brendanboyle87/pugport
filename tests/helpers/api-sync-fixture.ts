import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { Controller } from '../../src/server/controller.ts';
import { AccountSyncApi, type ApiSyncKeys } from '../../src/server/account-sync-api.ts';
import { readApiKey, saveApiKey, removeApiKey } from '../../src/server/api-providers.ts';

export function apiSyncFixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'pugport-api-sync-'));
  const secrets = join(dir, 'secrets');
  const controller = new Controller(dir, join(dir, 'data'), { readAccountIdentity: () => undefined });
  clearInterval(controller.timer);
  controller.targets = [];
  const refresh = t.mock.method(controller, 'refresh', async () => {});
  t.mock.method(controller as unknown as { checkApiKey(): void }, 'checkApiKey', () => {});
  const keys: ApiSyncKeys = {
    read: (id) => readApiKey(id, secrets),
    save: (id, key) => saveApiKey(id, key, secrets),
    remove: (id) => removeApiKey(id, secrets),
  };
  const api = new AccountSyncApi(controller, keys);
  t.after(async () => {
    if (controller.store.db.isOpen) await controller.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, secrets, controller, keys, api, refresh };
}
