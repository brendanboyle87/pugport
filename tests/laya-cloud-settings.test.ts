import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadLayaSettings } from '../src/server/app-settings.ts';
import { layaSharesTraining } from '../src/shared/laya.ts';
import { filterSyncValue } from '../src/shared/account-sync.ts';
import { TaskJudge } from '../src/server/task-judgment.ts';

const tierResponse = (choice = 'opus') => ({
  answers: {
    model_tier: {
      type: 'choice',
      choice,
      confidence: 0.95,
      probabilities: Object.fromEntries(
        ['haiku', 'sonnet', 'opus', 'fable'].map((tier) => [tier, tier === choice ? 0.97 : 0.01]),
      ),
    },
  },
  usage: { input_tokens: 10, output_tokens: 1 },
});

test('migration adopts cloud and retains local installation and explicit privacy preferences', () => {
  assert.equal(loadLayaSettings().mode, 'cloud');
  const old = {
    enabled: true,
    pythonPath: 'C:/synthetic/python.exe',
    checkpointPath: 'C:/synthetic/model',
    recordTraining: false,
  };
  const migrated = loadLayaSettings(old);
  assert.deepEqual(migrated, { ...old, mode: 'cloud', shareTraining: false });
  assert.equal(loadLayaSettings({ ...migrated, mode: 'local' }).pythonPath, old.pythonPath);
  assert.equal(loadLayaSettings({ mode: 'rules', shareTraining: false }).mode, 'rules');
  assert.equal(loadLayaSettings({ shareTraining: false }).shareTraining, false);
});

test('regional sharing defaults and explicit preferences only take effect in cloud mode', () => {
  assert.equal(layaSharesTraining(undefined), false);
  assert.equal(layaSharesTraining({ mode: 'cloud' }), false);
  assert.equal(layaSharesTraining({ shareTraining: true }), true);
  assert.equal(layaSharesTraining({ shareTraining: false }), false);
  assert.equal(layaSharesTraining({ mode: 'cloud' }, 'other'), true);
  assert.equal(layaSharesTraining({ mode: 'cloud' }, 'eu'), false);
  assert.equal(layaSharesTraining({ shareTraining: true }, 'eu'), true);
  assert.equal(layaSharesTraining({ shareTraining: false }, 'other'), false);
  for (const mode of ['local', 'jev', 'rules'] as const)
    assert.equal(layaSharesTraining({ mode, shareTraining: true }, 'other'), false);
  assert.deepEqual(
    filterSyncValue('settings', {
      laya: { mode: 'jev', shareTraining: true },
      apiKey: 'synthetic-key',
      install_id: 'synthetic-install',
    }),
    {},
  );
});

test('Jev maps only its tier and sends only to the fixed Jev endpoint when selected', async () => {
  let enabled = false,
    calls = 0,
    keyReads = 0;
  let choice = 'opus';
  const judge = new TaskJudge({
    enabled: () => enabled,
    credential: () => {
      keyReads++;
      return 'synthetic-key';
    },
    fetch: async (url, options) => {
      calls++;
      assert.equal(String(url), 'https://api.typesafe.ai/v1/systemone');
      assert.equal(options?.redirect, 'error');
      assert.equal(new Headers(options?.headers).get('Authorization'), 'Bearer synthetic-key');
      const request = JSON.parse(String(options?.body));
      assert.deepEqual(Object.keys(request.questions), ['model_tier']);
      assert.deepEqual(request.state, { request: 'Synthetic task' });
      return Response.json(tierResponse(choice));
    },
  });
  assert.equal((await judge.judge('Synthetic task')).reason, 'disabled');
  assert.equal(keyReads, 0);
  assert.equal(calls, 0);
  enabled = true;
  for (const [tier, expected] of [
    ['haiku', 'light'],
    ['sonnet', 'standard'],
    ['opus', 'strong'],
    ['fable', 'strong'],
  ]) {
    choice = tier!;
    const result = await judge.judge('Synthetic task');
    assert.equal(result.status, 'accepted');
    assert.equal(result.suggestedTier, expected);
    assert.equal(result.intent, undefined);
    assert.equal(result.kind, undefined);
    assert.equal(result.complexity, undefined);
    assert.ok(!JSON.stringify(result).includes('synthetic-key'));
  }
});

test('Jev schema errors, HTTP errors, missing credentials and deadline fall back to local rules', async () => {
  for (const response of [
    Response.json({ answers: {} }),
    new Response('', { status: 429 }),
    Response.json(tierResponse('unknown')),
  ]) {
    const judge = new TaskJudge({
      enabled: () => true,
      credential: () => 'synthetic-key',
      fetch: async () => response,
    });
    assert.equal((await judge.judge('Synthetic task')).status, 'fallback');
  }
  const missing = new TaskJudge({
    enabled: () => true,
    credential: () => undefined,
    fetch: async () => {
      throw new Error('must not call');
    },
  });
  assert.equal((await missing.judge('Synthetic task')).reason, 'not-configured');
  const slow = new TaskJudge({
    enabled: () => true,
    credential: () => 'synthetic-key',
    timeoutMs: 1,
    fetch: () => new Promise(() => {}),
  });
  assert.equal((await slow.judge('Synthetic task')).reason, 'timeout');
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(slow.judge('Synthetic task', { signal: abort.signal }), { name: 'AbortError' });
});
