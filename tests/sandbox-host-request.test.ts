import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { filterHostRequest, omitEmptyOptionalArrays } from '../src/server/sandbox/host-request.ts';
import { createRunTemp } from '../src/server/sandbox/run-temp.ts';

const missing = (code = 'ENOENT') => Object.assign(new Error('synthetic'), { code });
const directory = { isDirectory: () => true };

test('host filter checks every path list using metadata and preserves the original policy', async () => {
  const checked: string[] = [];
  const request = {
    command: 'synthetic',
    filesystem: {
      readonlyPaths: ['read', 'missing-read'],
      readwritePaths: ['write', 'missing-write'],
      deniedPaths: ['deny', 'missing-deny'],
      clearPolicyOnExit: false,
    },
  };
  const snapshot = structuredClone(request);
  const filtered = await filterHostRequest(request, async (path) => {
    checked.push(path);
    if (path.startsWith('missing-')) throw missing();
    return directory;
  });
  assert.deepEqual(filtered.filesystem, {
    readonlyPaths: ['read'],
    readwritePaths: ['write'],
    deniedPaths: ['deny'],
    clearPolicyOnExit: false,
  });
  assert.equal(checked.length, 6);
  assert.deepEqual(request, snapshot);
});

test('missing and empty arrays are omitted; SDK-reinserted arrays are removed again', async () => {
  const filtered = await filterHostRequest(
    { command: 'synthetic', filesystem: { readonlyPaths: ['missing'], readwritePaths: [], deniedPaths: [] } },
    async () => {
      throw missing('ENOTDIR');
    },
  );
  assert.deepEqual(filtered.filesystem, {});
  const wire = { ...filtered, filesystem: { ...filtered.filesystem, readonlyPaths: [], deniedPaths: [] } };
  assert.deepEqual(omitEmptyOptionalArrays(wire).filesystem, {});
  assert.deepEqual(wire.filesystem, { readonlyPaths: [], deniedPaths: [] });
});

test('metadata failures never silently remove a deny restriction', async () => {
  await assert.rejects(
    filterHostRequest({ command: 'synthetic', filesystem: { deniedPaths: ['unreadable'] } }, async () => {
      throw missing('EACCES');
    }),
    /sandbox-path-metadata-failed/,
  );
});

test('working directory must exist and be a directory', async () => {
  for (const metadata of [
    async () => {
      throw missing();
    },
    async () => ({ isDirectory: () => false }),
  ]) {
    await assert.rejects(
      filterHostRequest({ command: 'synthetic', workingDirectory: 'fixture' }, metadata),
      /sandbox-invalid-working-directory/,
    );
  }
});

test('denial report validates its parent, not the not-yet-created output file', async () => {
  const temporary = await createRunTemp('pi');
  try {
    const request = {
      command: 'synthetic',
      workingDirectory: temporary.directory,
      containment: {
        type: 'processcontainer' as const,
        config: { captureDenials: { outputPath: join(temporary.directory, 'not-created.json') } },
      },
    };
    assert.deepEqual(await filterHostRequest(request), request);
    await assert.rejects(
      filterHostRequest({
        ...request,
        containment: {
          type: 'processcontainer',
          config: { captureDenials: { outputPath: join(temporary.directory, 'missing', 'report.json') } },
        },
      }),
      /sandbox-invalid-denial-output-parent/,
    );
  } finally {
    await temporary.dispose();
  }
});

test('denial report parent cannot be a file or an empty path', async () => {
  for (const outputPath of [join('fixture', 'report.json'), '']) {
    await assert.rejects(
      filterHostRequest(
        { command: 'synthetic', containment: { type: 'processcontainer', config: { captureDenials: { outputPath } } } },
        async () => ({ isDirectory: () => false }),
      ),
      /sandbox-invalid-denial-output-parent/,
    );
  }
});

test('omitted filesystem and required locations trigger no filesystem operations', async () => {
  const request = { command: 'synthetic' };
  assert.deepEqual(await filterHostRequest(request, async () => assert.fail('No paths to inspect')), request);
});

test('request and mapped wire omit optional empty arrays at every used nesting level', async () => {
  const request = {
    command: 'synthetic',
    containment: {
      type: 'processcontainer' as const,
      config: { capabilities: [], filesystem: { enumeratePaths: [] } },
    },
    network: { egress: { default: 'deny' as const, allow: [], deny: [{ ports: [], to: [] }] } },
  };
  const snapshot = structuredClone(request);
  const filtered = await filterHostRequest(request, async () => assert.fail('No paths to inspect'));
  assert.deepEqual(filtered, {
    command: 'synthetic',
    containment: { type: 'processcontainer', config: { filesystem: {} } },
    network: { egress: { default: 'deny', deny: [{}] } },
  });
  assert.deepEqual(request, snapshot);
  const wire = {
    process: { commandLine: 'synthetic', env: [], timeout: 0, inheritDefaultEnv: false },
    processContainer: { capabilities: [], filesystem: { enumeratePaths: [] } },
    filesystem: { readonlyPaths: [], readwritePaths: [], deniedPaths: [] },
    network: { egress: { allow: [{ to: [{ cidr: '192.0.2.0/24', except: [] }], ports: [] }], deny: [] } },
  };
  assert.deepEqual(omitEmptyOptionalArrays(wire), {
    process: { commandLine: 'synthetic', timeout: 0, inheritDefaultEnv: false },
    processContainer: { filesystem: {} },
    filesystem: {},
    network: { egress: { allow: [{ to: [{ cidr: '192.0.2.0/24' }] }] } },
  });
});

test('optional-array cleanup retains all nonempty arrays, false flags and zero values', () => {
  const wire = {
    process: { env: ['SYNTHETIC=1'], inheritDefaultEnv: false, timeout: 0 },
    processContainer: { capabilities: ['registryRead'], filesystem: { enumeratePaths: ['fixture'] } },
    filesystem: { readwritePaths: ['write'], readonlyPaths: ['read'], deniedPaths: ['deny'] },
    network: { egress: { allow: [{ ports: [{ protocol: 'tcp', port: 443 }], to: [{ cidr: '192.0.2.0/24' }] }] } },
  };
  const snapshot = structuredClone(wire);
  assert.deepEqual(omitEmptyOptionalArrays(wire), snapshot);
  assert.deepEqual(wire, snapshot);
});
