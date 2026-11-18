import assert from 'node:assert/strict';
import { test } from 'node:test';
import { permissionLine, type PermissionOrigin } from '../src/shared/permission-reason.ts';
import { resolveOneForAllInput } from '../src/server/one-for-all-policy.ts';
import { applyAgentPreset, resolveAgentPreset } from '../src/shared/agent-presets.ts';

test('each permission origin has a single short line', () => {
  const lines: Record<PermissionOrigin['source'], string> = {
    user: '只读 · 你的选择',
    text: '只读 · 你的消息要求只读：只读',
    role: '只读 · 你点名的只读角色',
    untrusted: '只读 · 对话里有别人写的文字，只看文字不用工具',
    privacy: '纯文字 · 这个免费来源可能记录内容',
    device: '只读 · 任务在另一台电脑上执行',
    external: '只读 · 外部智能体不能修改本机文件',
    parent: '只读 · 上级任务是只读的',
    caller: '继承自 只读：只读',
    mode: '可写入 · Mod 作者模式：只写这个对话的 Mod 工作文件夹',
  };
  for (const source of Object.keys(lines) as PermissionOrigin['source'][])
    assert.equal(permissionLine({ mode: 'read-only', source, note: '只读' }), lines[source]);
  assert.equal(permissionLine({ mode: 'workspace-write', source: 'user' }), '可写入 · 你的选择');
  assert.equal(permissionLine({ mode: 'workspace-write', source: 'device' }), '可写入 · 任务在另一台电脑上执行');
  assert.equal(
    permissionLine({ mode: 'workspace-write', source: 'text', note: '不要删除\n  文件' }),
    '范围限制（来自你的消息）：不要删除 文件',
  );
});

test('policy stores text provenance once and preserves stronger boundaries', () => {
  const input = {
    content: '只读',
    mode: 'auto' as const,
    permissionMode: 'workspace-write' as const,
    executionPolicy: 'cli-first' as const,
  };
  const resolved = resolveOneForAllInput(input);
  assert.deepEqual(resolved.permissionOrigin, { mode: 'read-only', source: 'text', note: '只读' });
  assert.deepEqual(resolveOneForAllInput(resolved).permissionOrigin, resolved.permissionOrigin);
  const parent = { mode: 'read-only' as const, source: 'parent' as const };
  assert.deepEqual(
    resolveOneForAllInput({
      ...input,
      content: 'Implement X',
      explicitWrite: true,
      permissionOrigin: { mode: 'read-only', source: 'privacy' },
    }).permissionOrigin,
    { mode: 'workspace-write', source: 'user' },
  );
  assert.deepEqual(
    resolveOneForAllInput({ ...input, permissionMode: 'read-only', permissionOrigin: parent }).permissionOrigin,
    parent,
  );
  const role = { ...resolveAgentPreset('standard', ''), permissionMode: 'read-only' as const };
  assert.equal(
    applyAgentPreset({ ...input, content: 'Explain', agentPresetId: 'standard' }, role).permissionOrigin?.source,
    'role',
  );
  // Automatic roles resolve to a writable role before application; a supplied read-only role still caps permission.
  assert.deepEqual(applyAgentPreset({ ...input, explicitWrite: true, agentPresetId: 'auto' }, role).permissionOrigin, {
    mode: 'read-only',
    source: 'role',
  });
  const automatic = resolveAgentPreset('auto', input.content, [], true);
  assert.equal(automatic.permissionMode, 'workspace-write');
  assert.equal(
    applyAgentPreset({ ...input, explicitWrite: true, agentPresetId: 'auto' }, automatic).permissionOrigin,
    undefined,
  );
});
