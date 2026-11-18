import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectProcessOutput,
  isRemovedGoogleCliLaunch,
  redactError,
  spawnTarget,
  terminateProcess,
} from '../src/server/adapters/process.ts';
import {
  defaultNativeAccountHome,
  defaultNativeAccountFingerprint,
  nativeAccountFingerprint,
  nativeAccountEnvironment,
  launchAccountLogin,
  createNativeAccount,
} from '../src/server/native-accounts.ts';
import { mirrorAccountSharedConfig } from '../src/server/account-shared-config.ts';
import type { RuntimeTarget } from '../src/shared/types.ts';

const legacy: RuntimeTarget = {
  id: 'gemini-native',
  provider: 'gemini',
  label: 'Legacy Gemini',
  environment: 'native',
  enabled: true,
  get command(): string {
    throw new Error('Retired executable must not be inspected');
  },
};

test('legacy Gemini targets cannot reach process launch or inspect their executable', async () => {
  assert.equal(redactError(new Error('provider-retired')), 'provider-retired');
  await assert.rejects(spawnTarget(legacy, ['--version']), /provider-retired/);
  const managed = Object.create(legacy) as RuntimeTarget;
  managed.accountId = 'old-account';
  managed.accountHome = 'unused';
  await assert.rejects(spawnTarget(managed, []), /provider-retired/);
});

test('legacy Gemini accounts cannot read identities, mirror config or launch login', async () => {
  assert.equal(defaultNativeAccountHome(legacy, {}), undefined);
  assert.equal(defaultNativeAccountFingerprint(legacy, {}), undefined);
  const managed = Object.create(legacy) as RuntimeTarget;
  managed.accountId = 'old-account';
  managed.accountHome = 'unused';
  assert.equal(nativeAccountFingerprint(managed), undefined);
  assert.throws(() => nativeAccountEnvironment(managed, {}), /仅支持 Grok/);
  await mirrorAccountSharedConfig(managed, {});
  await assert.rejects(launchAccountLogin(managed), /仅支持 Grok/);
});

test('changing another CLI command cannot create or log in to a Google CLI account', async () => {
  for (const command of ['C:\\synthetic\\gemini.exe', 'C:\\synthetic\\agy.exe', '/synthetic/gemini']) {
    const target: RuntimeTarget = {
      id: 'codex-account-synthetic',
      provider: 'codex',
      label: 'Synthetic',
      environment: 'native',
      enabled: false,
      command,
      accountId: 'synthetic',
      get accountHome(): string {
        throw new Error('Must reject before examining the account profile');
      },
    };
    await assert.rejects(launchAccountLogin(target), /provider-retired/);
    await assert.rejects(createNativeAccount('unused', target, 'Synthetic'), /provider-retired/);
  }
});

test('saved MCP commands cannot launch Gemini or Antigravity under the API harness', async () => {
  const target: RuntimeTarget = {
    id: 'extension-synthetic',
    provider: 'pi',
    label: 'Synthetic MCP',
    environment: 'native',
    enabled: true,
    command: 'unused',
  };
  for (const launch of [
    { command: 'gemini' },
    { command: 'agy' },
    { command: 'C:\\synthetic\\Gemini.CMD' },
    { command: 'C:\\synthetic\\AGY.EXE' },
    { command: '/synthetic/bin/gemini' },
    { command: 'node', args: ['/synthetic/node_modules/@google/gemini-cli/bundle/gemini.js'] },
    { command: 'node.exe', args: ['C:\\synthetic\\node_modules\\@google\\gemini-cli\\bundle\\gemini.js'] },
    { command: 'npx.cmd', args: ['--yes', '@google/gemini-cli@1.0.0'] },
    { command: 'npx', args: ['--package=@google/gemini-cli', 'gemini'] },
    { command: 'npm', args: ['exec', '--', '@google/gemini-cli'] },
    { command: 'pnpm', args: ['dlx', '@google/gemini-cli'] },
    { command: 'pnpm.cmd', args: ['exec', '@google/gemini-cli'] },
    { command: 'yarn', args: ['dlx', '@google/gemini-cli@latest'] },
    { command: 'bunx', args: ['@google/gemini-cli'] },
    { command: 'bun', args: ['x', '@google/gemini-cli'] },
    { command: 'pnpx', args: ['@google/gemini-cli'] },
    { command: '/synthetic/node_modules/@google/gemini-cli/bundle/gemini.js' },
  ]) {
    assert.equal(isRemovedGoogleCliLaunch(launch), true, JSON.stringify(launch));
    const options = {
      get env(): NodeJS.ProcessEnv {
        throw new Error('Must reject before environment or executable discovery');
      },
    };
    await assert.rejects(spawnTarget({ ...target, ...launch }, [], options), /provider-retired/);
    await assert.rejects(
      spawnTarget({ ...target, command: launch.command }, launch.args ?? [], options),
      /provider-retired/,
    );
  }
});

test('malformed saved command fields are not classified as Google CLI launches', () => {
  for (const launch of [
    null,
    undefined,
    {},
    { command: 42 },
    { command: null },
    { command: {} },
    { command: 'npx', args: '@google/gemini-cli' },
    { command: 'gemini', args: {} },
    { command: 'agy', args: null },
    { command: 'node', args: [null, 42, {}] },
  ])
    assert.equal(isRemovedGoogleCliLaunch(launch), false, JSON.stringify(launch));
});

test('Google API model arguments do not block the Pi launcher', async () => {
  const apiLaunch = {
    command: process.execPath,
    args: ['/synthetic/pi/cli.js', '--provider', 'google', '--model', 'gemini-2.5-pro'],
  };
  assert.equal(isRemovedGoogleCliLaunch(apiLaunch), false);
  const child = await spawnTarget(
    {
      id: 'api-google',
      provider: 'pi',
      gateway: 'api',
      apiProvider: 'google',
      label: 'Google API',
      environment: 'native',
      enabled: true,
      command: process.execPath,
    },
    ['-e', 'process.stdout.write("gemini-api-allowed")'],
  );
  child.stdin.end();
  try {
    assert.equal((await collectProcessOutput(child, 10_000)).stdout, 'gemini-api-allowed');
  } finally {
    await terminateProcess(child);
  }
});
