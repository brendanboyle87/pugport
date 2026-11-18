import assert from 'node:assert/strict';
import test from 'node:test';
import {
  captureDenialsStreamingSupported,
  captureDenialsStreamingUnavailableReason,
} from '../src/shared/sandbox-capabilities.ts';
import { installedMxcSdkVersion, reviewedSdkVersion, spawnMxcProcess } from '../src/server/sandbox/helper-sdk.ts';

const crashReason = '学习模式暂不可用：当前 MXC SDK（1.0.0）在记录拒绝时会崩溃，SDK 修复后自动恢复';

test('streaming capture is gated for the crashing SDK and unconfirmed versions', () => {
  for (const version of [undefined, '', 'unknown', '0.9.9', '1.0.0', '1.0', '1.0.1-beta.1', 'v1.0.1'])
    assert.equal(captureDenialsStreamingSupported(version), false, String(version));
  assert.equal(captureDenialsStreamingUnavailableReason('1.0.0'), crashReason);
  assert.match(captureDenialsStreamingUnavailableReason(undefined), /尚未确认/);
});

test('fixed stable SDK versions automatically restore streaming capture support', () => {
  for (const version of ['1.0.1', '1.0.2', '1.1.0', '2.0.0'])
    assert.equal(captureDenialsStreamingSupported(version), true, version);
});

test('installed SDK matches the reviewed private mapper version; upgrades require review', async () => {
  const first = installedMxcSdkVersion();
  assert.equal(installedMxcSdkVersion(), first, 'Package metadata is cached once per helper module');
  assert.equal(await first, reviewedSdkVersion);
  assert.equal(reviewedSdkVersion, '1.0.0');
});

test('known-bad capture is rejected before metadata validation, SDK imports or native spawn', async (t) => {
  if ((await installedMxcSdkVersion()) !== '1.0.0') return t.skip('Known-bad SDK guard applies to 1.0.0');
  // An invalid required path also prevents native entry if the capability guard regresses.
  await assert.rejects(
    spawnMxcProcess({
      command: 'synthetic-never-executed',
      workingDirectory: '',
      containment: { type: 'processcontainer', config: { captureDenials: { mode: 'allow' } } },
    }),
    (error: unknown) => {
      assert.equal((error as NodeJS.ErrnoException).code, 'sandbox-learning-unavailable');
      assert.equal((error as Error).message, crashReason);
      return true;
    },
  );
});
