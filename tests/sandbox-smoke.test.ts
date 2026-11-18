import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mxcRuntime, supportedNode } from '../src/server/sandbox/mxc-runtime.ts';
import { captureTarget } from '../src/server/adapters/process.ts';
import { buildSandboxRequest } from '../src/server/sandbox/policy-builder.ts';
import { createRunTemp } from '../src/server/sandbox/run-temp.ts';
import { reviewedSdkVersion } from '../src/server/sandbox/helper-sdk.ts';
import {
  captureDenialsStreamingSupported,
  captureDenialsStreamingUnavailableReason,
} from '../src/shared/sandbox-capabilities.ts';

async function echoSmoke(capture: boolean) {
  const temporary = await createRunTemp('pi');
  try {
    const sandbox = buildSandboxRequest(
      { provider: 'pi', taskKind: 'tool-less', projectPath: temporary.directory, runTemp: temporary.directory },
      {
        home: join(temporary.directory, 'synthetic-home'),
        dataDir: join(temporary.directory, 'synthetic-data'),
        secrets: join(temporary.directory, 'synthetic-secrets'),
        environment: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, LOCALAPPDATA: temporary.directory },
        readExecutePaths: [process.env.SystemRoot ?? 'C:\\Windows'],
        protectedDataPaths: [],
        realpath: (p) => p,
      },
    );
    if (!capture && sandbox.containment?.type === 'processcontainer') {
      const { captureDenials: _capture, ...config } = sandbox.containment.config ?? {};
      sandbox.containment = { ...sandbox.containment, config };
    }
    const sandboxFailures: string[] = [];
    let sandboxSucceeded = false;
    const result = await captureTarget(
      {
        id: 'mxc-smoke',
        provider: 'pi',
        label: 'Pi',
        command: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'),
        environment: 'native',
        enabled: true,
      },
      ['/d', '/c', 'echo MXC_OK'],
      {
        sandbox,
        env: sandbox.environment,
        timeoutMs: 30000,
        onSandboxFailure: (reason) => sandboxFailures.push(reason),
        onSandboxSuccess: () => {
          sandboxSucceeded = true;
        },
      },
    );
    assert.deepEqual(sandboxFailures, [], 'Native fallback cannot count as a successful MXC smoke');
    assert.equal(sandboxSucceeded, true, 'The MXC helper must complete successfully');
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /MXC_OK/);
  } finally {
    await temporary.dispose();
  }
}

test('real MXC plain streaming smoke: full policy without capture echoes MXC_OK', { timeout: 60000 }, async (t) => {
  if (process.env.PUGPORT_MXC_SMOKE !== '1') return t.skip('Opt in with PUGPORT_MXC_SMOKE=1');
  if (process.platform !== 'win32') return t.skip('Requires Windows process containers');
  if (!supportedNode(process.versions.node))
    return t.skip(`Node ${process.versions.node}; requires 24.21+ <25 or 26.8+`);
  const status = await mxcRuntime.probe();
  if (!status.available || status.tier !== 'base-container') return t.skip(status.message);
  await echoSmoke(false);
});

test('real MXC capture streaming smoke: unsupported SDK skips before probe or spawn', { timeout: 60000 }, async (t) => {
  if (process.env.PUGPORT_MXC_SMOKE !== '1') return t.skip('Opt in with PUGPORT_MXC_SMOKE=1');
  // The installed-version pin test forces review before changing this pre-probe safety gate.
  if (!captureDenialsStreamingSupported(reviewedSdkVersion))
    return t.skip(captureDenialsStreamingUnavailableReason(reviewedSdkVersion));
  if (process.platform !== 'win32') return t.skip('Requires Windows process containers');
  if (!supportedNode(process.versions.node))
    return t.skip(`Node ${process.versions.node}; requires 24.21+ <25 or 26.8+`);
  const status = await mxcRuntime.probe();
  if (!captureDenialsStreamingSupported(status.sdkVersion))
    return t.skip(captureDenialsStreamingUnavailableReason(status.sdkVersion));
  if (!status.available || status.tier !== 'base-container') return t.skip(status.message);
  await echoSmoke(true);
});
