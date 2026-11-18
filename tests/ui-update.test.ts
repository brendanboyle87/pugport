import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createUiUpdateCheck, eligibleUiRelease, rejectedUiBuilds } from '../src/ui/ui-update.ts';
import { holdUiUpdate, registerUiUpdateBlocker, uiUpdateBlocked } from '../src/ui/ui-update-guard.ts';

const release = { enabled: true, buildId: 'ui-next', compatibility: 'same' };

test('UI candidate rejects changed contract, invalid id, failed build and unchanged version', () => {
  assert.equal(eligibleUiRelease(release, 'ui-current', 'same', []), 'ui-next');
  for (const value of [null, {}, { ...release, enabled: false }, { ...release, buildId: '../next' }])
    assert.equal(eligibleUiRelease(value, 'ui-current', 'same', []), undefined);
  assert.equal(eligibleUiRelease(release, 'ui-next', 'same', []), undefined);
  assert.equal(eligibleUiRelease(release, 'ui-current', 'changed', []), undefined);
  assert.equal(eligibleUiRelease(release, 'ui-current', 'same', ['ui-next']), undefined);
  assert.equal(rejectedUiBuilds({ getItem: () => 'invalid' }), undefined);
  assert.equal(rejectedUiBuilds({ getItem: () => '[1]' }), undefined);
  assert.deepEqual(rejectedUiBuilds({ getItem: () => null }), []);
});

test('UI protection is composable, fails closed and releases safely', () => {
  let dirty = false;
  const remove = registerUiUpdateBlocker(() => dirty);
  assert.equal(uiUpdateBlocked(), false);
  dirty = true;
  const endUpload = holdUiUpdate();
  remove();
  assert.equal(uiUpdateBlocked(), true);
  endUpload();
  endUpload();
  assert.equal(uiUpdateBlocked(), false);
  const failing = registerUiUpdateBlocker(() => {
    throw new Error('temporarily unavailable');
  });
  assert.equal(uiUpdateBlocked(), true);
  failing();
  assert.equal(uiUpdateBlocked(), false);
});

test('UI waits for editing and activates once without restarting or cancelling any task', async () => {
  let dirty = true;
  let calls = 0;
  const activations: string[] = [];
  const notices: boolean[] = [];
  const check = createUiUpdateCheck({
    buildId: 'ui-current',
    compatibility: 'same',
    readStatus: async () => {
      calls++;
      return release;
    },
    rejected: () => [],
    blocked: () => dirty,
    activate: (id) => {
      activations.push(id);
    },
    pending: (value) => notices.push(value),
  });
  await check();
  assert.deepEqual(activations, []);
  assert.deepEqual(notices, [true]);
  dirty = false;
  await check();
  await check();
  assert.deepEqual(activations, ['ui-next']);
  assert.equal(calls, 2);
});

test('UI checks current blockers after delayed response and coalesces concurrent polls', async () => {
  let finish!: (value: unknown) => void;
  let dirty = false;
  let reads = 0;
  let activated = false;
  const check = createUiUpdateCheck({
    buildId: 'ui-current',
    compatibility: 'same',
    readStatus: () => {
      reads++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    rejected: () => [],
    blocked: () => dirty,
    activate: () => {
      activated = true;
    },
    pending: () => {},
  });
  const first = check();
  await check();
  dirty = true;
  finish(release);
  await first;
  assert.equal(reads, 1);
  assert.equal(activated, false);
});

test('UI storage or network failures cannot cause a reload', async () => {
  let activated = false;
  const options = {
    buildId: 'ui-current',
    compatibility: 'same',
    readStatus: async (): Promise<unknown> => {
      throw new Error('offline');
    },
    rejected: (): string[] | undefined => [],
    blocked: () => false,
    activate: () => {
      activated = true;
    },
    pending: () => {},
  };
  await createUiUpdateCheck(options)();
  await createUiUpdateCheck({ ...options, readStatus: async () => release, rejected: () => undefined })();
  assert.equal(activated, false);
});
