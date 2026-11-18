import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Controller } from '../src/server/controller.ts';
import { readApiKey } from '../src/server/api-providers.ts';
import type { RuntimeTarget } from '../src/shared/types.ts';

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'pugport-api-mutations-'));
  const previous = process.env.COMBORUNNER_SECRETS_DIR;
  process.env.COMBORUNNER_SECRETS_DIR = join(dir, 'secrets');
  t.mock.method(process, 'emitWarning', () => {});
  const controller = new Controller(dir, join(dir, 'data'), { readAccountIdentity: () => undefined });
  clearInterval(controller.timer);
  controller.targets = [];
  t.mock.method(controller as unknown as { checkApiKey(): void }, 'checkApiKey', () => {});
  t.after(async () => {
    if (controller.store.db.isOpen) await controller.close();
    if (previous === undefined) delete process.env.COMBORUNNER_SECRETS_DIR;
    else process.env.COMBORUNNER_SECRETS_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  return { controller, dir };
}

for (const kind of ['api', 'free'] as const) {
  test(`concurrent ${kind} additions persist distinct account keys`, async (t) => {
    const { controller } = fixture(t);
    const add = (key: string) =>
      kind === 'api' ? controller.addApiProvider('deepseek', key) : controller.addFreeSource('groq-free', key);
    await Promise.all([add('synthetic-first'), add('synthetic-second')]);
    const saved = controller.store.config<RuntimeTarget[]>('targets', []);
    assert.equal(saved.length, 2);
    assert.equal(new Set(saved.map((target) => target.id)).size, 2);
    assert.deepEqual(
      saved.map((target) => readApiKey(target.id)),
      ['synthetic-first', 'synthetic-second'],
    );
  });
}

test('invalid Anthropic workspaces never save a credential', async (t) => {
  const { controller, dir } = fixture(t);
  await assert.rejects(controller.addApiProvider('anthropic', 'synthetic-key', undefined, 'bad/id'), /工作区 ID/);
  assert.equal(controller.targets.length, 0);
  assert.equal(readApiKey('api-anthropic'), undefined);
  assert.deepEqual(
    readdirSync(dir).filter((name) => name === 'secrets'),
    [],
  );
});

test('a failed credential write releases subsequent account additions', async (t) => {
  const { controller, dir } = fixture(t);
  const blocked = join(dir, 'blocked');
  writeFileSync(blocked, 'not a directory');
  process.env.COMBORUNNER_SECRETS_DIR = blocked;
  await assert.rejects(controller.addApiProvider('deepseek', 'synthetic-failed'));
  process.env.COMBORUNNER_SECRETS_DIR = join(dir, 'secrets');
  await controller.addApiProvider('deepseek', 'synthetic-retry');
  assert.equal(controller.targets.length, 1);
  assert.equal(readApiKey(controller.targets[0]!.id), 'synthetic-retry');
});

test('removal and replacement cannot leave a secret after the account was deleted', async (t) => {
  const { controller } = fixture(t);
  await controller.addApiProvider('deepseek', 'synthetic-original');
  const id = controller.targets[0]!.id;
  const results = await Promise.allSettled([
    controller.replaceApiKey(id, 'synthetic-replacement'),
    controller.removeApiProvider(id),
  ]);
  assert.ok(results.every((result) => result.status === 'fulfilled'));
  assert.equal(controller.targets.length, 0);
  assert.equal(readApiKey(id), undefined);
  await controller.addApiProvider('deepseek', 'synthetic-next');
  assert.equal(readApiKey(controller.targets[0]!.id), 'synthetic-next');
});

test('shutdown drains a pending credential write and rejects later additions', async (t) => {
  const { controller } = fixture(t);
  const adding = controller.addApiProvider('deepseek', 'synthetic-closing');
  await Promise.resolve();
  const closing = controller.close();
  await assert.rejects(controller.addApiProvider('deepseek', 'synthetic-too-late'), /正在关闭/);
  await adding;
  await closing;
  assert.equal(controller.store.db.isOpen, false);
  assert.equal(readApiKey('api-deepseek'), 'synthetic-closing');
  assert.equal(readApiKey('api-deepseek-2'), undefined);
});
