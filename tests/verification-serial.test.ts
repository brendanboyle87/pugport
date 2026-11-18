import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from './helpers/session-workspace.ts';

test('verification commands run one at a time machine-wide and a cancelled waiter leaves without running', async (t) => {
  const { controller, directory } = fixture(t);
  const receipts = (
    controller as unknown as { verificationReceipts: { verify(request: { signal: AbortSignal }): Promise<unknown> } }
  ).verificationReceipts;
  let running = 0,
    peak = 0,
    executed = 0;
  t.mock.method(receipts, 'verify', async (request: { signal: AbortSignal }) => {
    if (request.signal.aborted) return { status: 'cancelled' };
    executed++;
    peak = Math.max(peak, ++running);
    await new Promise((resolve) => setTimeout(resolve, 50));
    running--;
    return { status: 'passed' };
  });
  const aborts = [new AbortController(), new AbortController(), new AbortController()];
  const results = aborts.map((abort) => controller.verify('npm test', directory, abort.signal));
  aborts[2]!.abort();
  const third = await Promise.race([
    results[2]!,
    new Promise((resolve) => setTimeout(() => resolve({ status: 'still waiting' }), 30)),
  ]);
  assert.equal((third as { status: string }).status, 'cancelled', 'the cancelled waiter does not wait for the others');
  assert.deepEqual(
    (await Promise.all(results)).map((result) => result.status),
    ['passed', 'passed', 'cancelled'],
  );
  assert.equal(peak, 1);
  assert.equal(executed, 2);
});
