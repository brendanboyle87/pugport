import assert from 'node:assert/strict';
import { test } from 'node:test';
import { permissionCeilingLine, runNetworkAllowed, type PermissionOrigin } from '../src/shared/permission-reason.ts';
import { createTranslator } from '../src/shared/i18n/index.ts';
import en from '../src/shared/i18n/en.json' with { type: 'json' };

const write = (source: PermissionOrigin['source'] | undefined, extra: Partial<PermissionOrigin> = {}) => ({
  permissionMode: 'workspace-write' as const,
  ...(source ? { permissionOrigin: { mode: 'workspace-write' as const, source, ...extra } } : {}),
});

test('network follows the dispatcher origin and never exceeds it', () => {
  const table: [string, Parameters<typeof runNetworkAllowed>, boolean][] = [
    ['no origin', [write(undefined)], true],
    ['user', [write('user')], true],
    ['text', [write('text')], true],
    ['device', [write('device')], true],
    ['caller with network', [write('caller', { network: true })], true],
    ['caller without network', [write('caller', { network: false })], false],
    ['caller field absent', [write('caller')], false],
    ['parent unknown', [write('parent')], false],
    ['role', [write('role')], false],
    ['untrusted', [write('untrusted')], false],
    ['privacy', [write('privacy')], false],
    ['external', [write('external')], false],
    ['read-only', [{ permissionMode: 'read-only', permissionOrigin: { mode: 'read-only', source: 'user' } }], false],
    ['no mode', [{}], false],
    ['untrusted content', [{ ...write('user'), untrustedContent: true }], false],
    ['prohibit commands', [{ ...write('user'), prohibitCommands: true }], false],
    ['text only', [{ ...write('user'), textOnly: true }], false],
    ['background wakeup', [{ ...write('user'), backgroundTrigger: { kind: 'schedule', id: 'x' } }], false],
  ];
  for (const [name, args, expected] of table) assert.equal(runNetworkAllowed(...args), expected, name);
});

test('the permission ceiling line reports write, network and Git once per run', () => {
  const base = { write: true, network: true, git: 'worktree', enforced: true } as const;
  assert.equal(permissionCeilingLine(base), '权限上限：写入 开 · 网络 开 · Git 提交 本工作树');
  assert.equal(
    permissionCeilingLine({ ...base, network: false, git: 'off', enforced: false }),
    '权限上限：写入 开 · 网络 关 · Git 提交 关（该执行器没有沙箱，不受 PugPort 控制）',
  );
  assert.match(permissionCeilingLine({ ...base, git: 'main-checkout' }), /Git 提交 关（主检出：.*工作线.*）$/);
  assert.equal(
    permissionCeilingLine({ ...base, fullAccess: true, enforced: false, git: 'off' }),
    '权限上限：写入 开 · 网络 完全访问 · Git 提交 完全访问（该执行器没有沙箱，不受 PugPort 控制）',
  );
  assert.match(
    permissionCeilingLine({ write: true, network: false, git: 'off', enforced: false, pi: true }),
    /（Pi 自动模式不运行命令，不能提交或联网）$/,
  );
  const translate = createTranslator(en);
  const english = (text: string) => translate(text) ?? text;
  assert.equal(
    english(permissionCeilingLine(base)),
    'Permission ceiling: write on · network on · Git commits this worktree',
  );
  assert.equal(
    english(permissionCeilingLine({ ...base, git: 'off', network: false, enforced: false })),
    'Permission ceiling: write on · network off · Git commits off (this executor has no sandbox; not enforced by PugPort)',
  );
});
