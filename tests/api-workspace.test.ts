import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiPreset, validWorkspaceId } from '../src/shared/api-providers.ts';
import { apiTarget, detectAnthropicWorkspace, syncApiModelsConfig } from '../src/server/api-providers.ts';
import { redactError } from '../src/server/adapters/process.ts';

const refusal =
  '400 {"type":"error","error":{"type":"invalid_request_error","message":"This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use."}}';

test('a key that is not scoped to a workspace gets its own reason instead of a generic key error', () => {
  assert.equal(redactError(new Error(refusal)), 'api-key-workspace-required');
  assert.equal(redactError(new Error('api-key-workspace-required')), 'api-key-workspace-required');
  assert.equal(redactError(new Error('invalid x-api-key')), 'api-key-auth-or-configuration');
});

test('the Anthropic workspace goes into the executor’s own models.json and comes out again when cleared', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pugport-api-workspace-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const anthropic = apiPreset('anthropic')!;
  const target = {
    ...apiTarget(root, root, anthropic, 'api-anthropic', 'Claude API'),
    apiWorkspaceId: 'wrkspc_01Fixture',
  };
  const file = join(target.agentDir!, 'models.json');
  syncApiModelsConfig(target, anthropic);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
    providers: { anthropic: { headers: { 'anthropic-workspace-id': 'wrkspc_01Fixture' } } },
  });
  const { apiWorkspaceId: _cleared, ...without } = target;
  syncApiModelsConfig(without, anthropic);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { providers: {} });

  const deepseek = apiPreset('deepseek')!;
  const other = { ...apiTarget(root, root, deepseek, 'api-deepseek', 'DeepSeek'), apiWorkspaceId: 'wrkspc_ignored' };
  syncApiModelsConfig(other, deepseek);
  assert.deepEqual(
    JSON.parse(readFileSync(join(other.agentDir!, 'models.json'), 'utf8')),
    {
      providers: { deepseek: { modelOverrides: { 'deepseek-v4-pro': { thinkingLevelMap: { low: 'low' } } } } },
    },
    'DeepSeek gets only its effort override, never the Anthropic header',
  );
});

test('only plain workspace IDs are accepted, so nothing odd can reach a request header', () => {
  assert.equal(validWorkspaceId('wrkspc_01AbC-def'), true);
  for (const value of ['', 'wrkspc 01', 'a\nb', 'x'.repeat(101), 'wrkspc_01"}'])
    assert.equal(validWorkspaceId(value), false);
});

test('the workspace is found for the user: the only one, otherwise the Default Workspace, never a guess', async () => {
  const fixture = (all: unknown[], named: unknown[], status = 200) => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = (async (url: string, init: { headers: Record<string, string> }) => {
      calls.push({ url, headers: init.headers });
      const body = { data: url.includes('include_default=true') ? all : named, has_more: false };
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  };
  const ws = (id: string, archived_at: string | null = null) => ({ type: 'workspace', id, name: id, archived_at });

  const only = fixture([ws('wrkspc_01Default')], []);
  assert.deepEqual(await detectAnthropicWorkspace('sk-ant-fixture', only.fetchImpl), { workspace: 'wrkspc_01Default' });
  assert.equal(only.calls.length, 1);
  assert.ok(only.calls[0].url.startsWith('https://api.anthropic.com/v1/organizations/workspaces?'));
  assert.equal(only.calls[0].headers['x-api-key'], 'sk-ant-fixture');
  assert.equal(only.calls[0].headers['anthropic-version'], '2023-06-01');

  const several = fixture(
    [ws('wrkspc_01Default'), ws('wrkspc_02Team'), ws('wrkspc_03Old', '2026-01-01T00:00:00Z')],
    [ws('wrkspc_02Team')],
  );
  assert.deepEqual(await detectAnthropicWorkspace('sk-ant-fixture', several.fetchImpl), {
    workspace: 'wrkspc_01Default',
  });

  const archivedAside = fixture([ws('wrkspc_02Team'), ws('wrkspc_03Old', '2026-01-01T00:00:00Z')], []);
  assert.deepEqual(await detectAnthropicWorkspace('sk-ant-fixture', archivedAside.fetchImpl), {
    workspace: 'wrkspc_02Team',
  });

  const unclear = fixture([ws('wrkspc_02Team'), ws('wrkspc_04Lab')], [ws('wrkspc_02Team'), ws('wrkspc_04Lab')]);
  assert.deepEqual(await detectAnthropicWorkspace('sk-ant-fixture', unclear.fetchImpl), {
    outcome: 'several',
    count: 2,
  });

  const refused = fixture([ws('wrkspc_01Default')], [], 403);
  assert.deepEqual(await detectAnthropicWorkspace('sk-ant-fixture', refused.fetchImpl), {
    outcome: 'refused',
    status: 403,
  });

  const odd = fixture([{ id: 'wrkspc_01"}' }], []);
  assert.deepEqual(await detectAnthropicWorkspace('sk-ant-fixture', odd.fetchImpl), { outcome: 'none' });

  const offline = (async () => {
    throw new Error('offline');
  }) as unknown as typeof fetch;
  assert.deepEqual(await detectAnthropicWorkspace('sk-ant-fixture', offline), { outcome: 'network' });
});
