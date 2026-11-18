import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createMxcRuntime,
  minimumBuilds,
  parseUbr,
  supportedNode,
  type MxcSdk,
} from '../src/server/sandbox/mxc-runtime.ts';

const ready = { sdkVersion: '1.0.0', tier: 'base-container', probes: { baseContainerSupportsDenyPaths: true } };
const fixture = (options: Parameters<typeof createMxcRuntime>[0] = {}) =>
  createMxcRuntime({
    platform: () => 'win32',
    arch: () => 'x64',
    release: () => '10.0.26300',
    nodeVersion: () => '24.21.0',
    ubr: async () => 9550,
    loadSdk: async () => ({ probe: () => ready }),
    ...options,
  });

test('UBR parsing accepts reg query hex and decimal, rejects missing/malformed values', () => {
  assert.equal(parseUbr('    UBR    REG_DWORD    0x254d\r\n'), 9549);
  assert.equal(parseUbr('UBR REG_DWORD 9550'), 9550);
  for (const output of ['', 'UBR REG_SZ 9550', 'UBR REG_DWORD 0xno', 'Other REG_DWORD 9550'])
    assert.equal(parseUbr(output), undefined);
});

test('all Windows branches gate on their own UBR before loading the SDK', async () => {
  assert.deepEqual(minimumBuilds, { 26100: 9278, 26200: 9278, 26300: 9550, 28000: 2804 });
  for (const [build, minimum] of Object.entries(minimumBuilds)) {
    for (const ubr of [minimum - 1, minimum, minimum + 1]) {
      let loaded = 0;
      const runtime = fixture({
        release: () => `10.0.${build}`,
        ubr: async () => ubr,
        loadSdk: async () => {
          loaded++;
          return { probe: () => ready };
        },
      });
      const status = await runtime.probe();
      assert.equal(status.available, ubr >= minimum, `${build}.${ubr}`);
      assert.equal(loaded, ubr >= minimum ? 1 : 0);
    }
  }
  const owner = await fixture({ ubr: async () => 9457 }).probe();
  assert.equal(owner.message, '不可用：系统 26300.9457，需要 26300.9550（KB5124010）');
});

test('unknown branches, unreadable UBR and unsupported platforms never load the SDK', async () => {
  for (const options of [
    { release: () => '10.0.27000' },
    { release: () => 'unknown' },
    { ubr: async () => undefined },
    {
      ubr: async () => {
        throw Error('registry unavailable');
      },
    },
    { platform: () => 'linux' },
    { arch: () => 'arm64' },
  ]) {
    const status = await fixture({ ...options, loadSdk: async () => assert.fail('must not load') }).probe();
    assert.equal(status.available, false);
  }
});

test('Node supports >=24.21.0 <25 or >=26.8.0, not prereleases', async () => {
  for (const version of ['24.21.0', '24.22.0', '26.8.0', '26.9.1', '27.0.0'])
    assert.ok(supportedNode(version), version);
  for (const version of ['22.0.0', '24.20.9', '25.9.0', '26.7.99', '24.21.0-rc.1', 'junk']) {
    assert.equal(supportedNode(version), false, version);
    assert.equal(
      (await fixture({ nodeVersion: () => version, loadSdk: async () => assert.fail('must not load') }).probe()).reason,
      'node',
    );
  }
});

test('missing SDK and failed probes return safe status without leaking error text', async () => {
  const missing = await fixture({
    loadSdk: async () => {
      throw Object.assign(Error('private path'), { code: 'ERR_MODULE_NOT_FOUND' });
    },
  }).probe();
  assert.equal(missing.message, '沙箱组件未安装');
  assert.equal(missing.available, false);
  for (const sdk of [
    {
      probe: () => {
        throw Error('private path');
      },
    },
    {},
  ]) {
    const status = await fixture({ loadSdk: async () => sdk as MxcSdk }).probe();
    assert.equal(status.reason, 'probe-failed');
    assert.ok(!JSON.stringify(status).includes('private path'));
  }
  assert.equal(
    (
      await fixture({
        loadSdk: async () => {
          throw Error('DLL error');
        },
      }).probe()
    ).reason,
    'probe-failed',
  );
});

test('only base-container with explicit deny-path support is ready', async () => {
  for (const tier of ['base-container', 'appcontainer-bfs', 'appcontainer-dacl', 'unknown', undefined]) {
    for (const deny of [true, false, undefined]) {
      const status = await fixture({
        loadSdk: async () => ({ probe: () => ({ tier, probes: { baseContainerSupportsDenyPaths: deny } }) }),
      }).probe();
      assert.equal(status.available, tier === 'base-container' && deny === true);
    }
  }
});

test('streaming capture gate uses helper SDK version without disabling the base container', async () => {
  const current = await fixture().probe();
  assert.equal(current.available, true);
  assert.equal(current.sdkVersion, '1.0.0');
  assert.equal(current.captureDenialsStreamingSupported, false);
  assert.equal(
    current.learningUnavailableReason,
    '学习模式暂不可用：当前 MXC SDK（1.0.0）在记录拒绝时会崩溃，SDK 修复后自动恢复',
  );
  const future = await fixture({ loadSdk: async () => ({ probe: () => ({ ...ready, sdkVersion: '1.0.1' }) }) }).probe();
  assert.equal(future.available, true);
  assert.equal(future.sdkVersion, '1.0.1');
  assert.equal(future.captureDenialsStreamingSupported, true);
  assert.equal(future.learningUnavailableReason, undefined);
  const unknown = await fixture({
    loadSdk: async () => ({ probe: () => ({ ...ready, sdkVersion: undefined }) }),
  }).probe();
  assert.equal(unknown.available, true);
  assert.equal(unknown.captureDenialsStreamingSupported, false);
});

test('probe caches concurrent requests and refresh rechecks Windows after update', async () => {
  let ubr = 9457,
    reads = 0,
    probes = 0;
  const runtime = fixture({
    ubr: async () => {
      reads++;
      return ubr;
    },
    loadSdk: async () => ({
      probe: () => {
        probes++;
        return ready;
      },
    }),
  });
  assert.equal(runtime.status().reason, 'checking');
  const first = runtime.probe();
  assert.equal(first, runtime.probe());
  await first;
  ubr = 9550;
  assert.equal((await runtime.probe()).available, false);
  assert.equal((await runtime.refresh()).available, true);
  assert.equal(reads, 2);
  assert.equal(probes, 1);
  assert.equal(runtime.status().message, '可用 · 进程容器');
});

test('a stale probe cannot overwrite a refreshed status', async () => {
  let finish!: (value: number) => void;
  let reads = 0;
  const runtime = fixture({
    ubr: () =>
      ++reads === 1
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(9550),
  });
  const old = runtime.probe();
  await runtime.refresh();
  finish(9457);
  await old;
  assert.equal(runtime.status().available, true);
});
