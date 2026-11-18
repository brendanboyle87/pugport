import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { findNode, nextTurn, text, uiBundle, uiHarness } from './helpers/ui-harness.ts';
import type { ProjectPurgePreview } from '../src/shared/project-data.ts';
let code: string;
before(async () => {
  code = await uiBundle('tests/helpers/project-management-fixture.ts');
});
const project = {
  id: 'removed',
  name: 'Removed project',
  path: 'C:/Original/keep-me',
  createdAt: '',
  updatedAt: '',
  removedAt: 'now',
};
const preview = (): ProjectPurgePreview => ({
  projectId: project.id,
  name: project.name,
  token: 'token-1',
  conversations: 3,
  attachments: 2,
  managedFiles: 7,
  managedBytes: 2048,
  preservedProjectPath: project.path,
  canPurge: true,
  partial: false,
});
function fixture() {
  const calls: any[] = [],
    notices: any[] = [];
  let checks = preview(),
    hold: any,
    fail = '',
    reloads = 0;
  const api = async (path: string, body?: any, method = 'POST') => {
    calls.push({ path, body, method });
    if (hold) await hold;
    if (fail) {
      const error = fail;
      fail = '';
      throw Error(error);
    }
    if (method === 'GET') return checks;
    return path.endsWith('/purge')
      ? {
          projectId: project.id,
          conversations: 3,
          attachments: 2,
          deletedFiles: 6,
          freedBytes: 1024,
          sharedFilesKept: 1,
          databaseSpace: 'reusable',
          scheduledTasks: checks.scheduledTasks,
        }
      : {};
  };
  const props = {
    project,
    api,
    reload: async () => {
      reloads++;
    },
    notify: (notice: any) => notices.push(notice),
  };
  const h = uiHarness(code);
  const render = () => h.render('RemovedProjectRow', props);
  const button = (label: string) => findNode(render(), (node) => node.type === 'button' && text(node) === label)!;
  const store = h.exports.confirmationStore;
  const inspect = async () => {
    render().props.onToggle({ currentTarget: { open: true } });
    await nextTurn();
  };
  const confirm = async (answer: boolean) => {
    const value = store.snapshot();
    assert.ok(value);
    store.resolve(value.id, answer);
    await nextTurn();
  };
  return {
    h,
    render,
    button,
    store,
    inspect,
    confirm,
    calls,
    notices,
    reloads: () => reloads,
    setPreview: (value: any) => (checks = value),
    fail: (message: string) => (fail = message),
    hold: () => {
      let release!: () => void;
      hold = new Promise<void>((resolve) => (release = resolve));
      return () => {
        hold = undefined;
        release();
      };
    },
  };
}
test('removed project rows do no eager I/O; opening inspects once and shows truthful counts before actions', async () => {
  const f = fixture();
  f.render();
  assert.equal(f.calls.length, 0);
  assert.equal(f.button('恢复').props.disabled, true);
  await f.inspect();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].method, 'GET');
  assert.match(text(f.render()), /3 个对话 · 2 个附件记录 · 7 个应用管理文件/);
  assert.match(text(f.render()), /2.0 KB/);
  assert.equal(f.button('恢复').props.disabled, false);
  f.h.unmount();
});
test('permanent purge confirms scope and exact token, cancels with no mutation, and preserves shared database space wording', async () => {
  const f = fixture();
  await f.inspect();
  f.button('永久清空').props.onClick();
  const first = f.store.snapshot();
  assert.match(first.options.summary, /原项目文件夹会保留/);
  assert.match(first.options.points.join(' '), /3 个对话、2 个附件记录、7 个应用管理文件/);
  assert.ok(first.options.points.includes('保留原项目目录：' + project.path));
  await f.confirm(false);
  assert.equal(f.calls.length, 1);
  const action = f.button('永久清空');
  action.props.onClick();
  action.props.onClick();
  await f.confirm(true);
  assert.equal(f.calls.filter((call) => call.method === 'POST').length, 1);
  assert.equal(f.calls.at(-1).path, '/api/projects/removed/purge');
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls.at(-1).body)), { token: 'token-1' });
  assert.equal(f.reloads(), 1);
  assert.match(f.notices[0].message, /原项目文件夹已保留/);
  assert.doesNotMatch(f.notices[0].message, /数据库.*(变小|缩小|释放)/);
  assert.equal(f.button('刷新列表').props.disabled, false);
  f.h.unmount();
});
test('restore uses the existing endpoint and never asks for purge permission or deletes data', async () => {
  const f = fixture();
  await f.inspect();
  await f.button('恢复').props.onClick();
  await nextTurn();
  assert.equal(f.calls.at(-1).path, '/api/projects/removed/restore');
  assert.equal(f.store.snapshot(), undefined);
  assert.equal(f.reloads(), 1);
  assert.equal(
    f.calls.some((call) => call.method === 'DELETE' || call.path.endsWith('/purge')),
    false,
  );
  f.h.unmount();
});
test('an app-created workspace is listed for deletion and never described as a preserved original folder', async () => {
  const f = fixture();
  const managedWorkspacePath = 'C:/PugPort/data/workspaces/00000000-0000-4000-8000-000000000001';
  f.setPreview({ ...preview(), preservedProjectPath: '', managedWorkspacePath });
  await f.inspect();
  f.button('永久清空').props.onClick();
  const dialog = f.store.snapshot();
  assert.match(dialog.options.summary, /应用自建的聊天目录也会永久删除/);
  assert.ok(dialog.options.points.includes('应用自建的聊天目录将一并清空：' + managedWorkspacePath));
  assert.ok(dialog.options.points.every((point: string) => !point.includes('保留原项目目录')));
  await f.confirm(false);
  assert.equal(f.calls.length, 1);
  f.h.unmount();
});
test('associated scheduled tasks are disclosed before confirmation and reported as paused afterward', async () => {
  const f = fixture();
  f.setPreview({ ...preview(), scheduledTasks: 2 });
  await f.inspect();
  assert.match(text(f.render()), /将暂停 2 个相关定时任务/);
  f.button('永久清空').props.onClick();
  assert.ok(f.store.snapshot().options.points.includes('同时暂停 2 个相关定时任务，保留其配置和历史。'));
  await f.confirm(true);
  assert.match(f.notices[0].message, /已暂停 2 个相关定时任务/);
  f.h.unmount();
});

test('partial cleanup disables restore and offers a token-checked retry; active-task blocks show the server reason', async () => {
  const f = fixture();
  f.setPreview({ ...preview(), partial: true });
  await f.inspect();
  assert.equal(f.button('恢复').props.disabled, true);
  assert.match(text(f.render()), /只能重试清空/);
  f.button('重试清空').props.onClick();
  await f.confirm(false);
  f.h.unmount();
  const active = fixture();
  active.setPreview({ ...preview(), canPurge: false, blockedReason: '这个项目仍有任务在运行。' });
  await active.inspect();
  assert.equal(active.button('永久清空').props.disabled, true);
  assert.match(text(active.render()), /仍有任务在运行/);
  active.button('永久清空').props.onClick();
  await nextTurn();
  assert.equal(active.calls.length, 1);
  assert.equal(active.store.snapshot(), undefined);
  active.h.unmount();
});
test('purge errors preserve the row and require a fresh preview before retry', async () => {
  const f = fixture();
  await f.inspect();
  f.fail('文件占用，尚未完成清空。');
  f.button('永久清空').props.onClick();
  await f.confirm(true);
  assert.match(text(f.render()), /文件占用/);
  assert.equal(f.button('恢复').props.disabled, true);
  f.setPreview({ ...preview(), partial: true, token: 'retry-token' });
  await f.button('重新检查').props.onClick();
  await nextTurn();
  assert.equal(f.button('恢复').props.disabled, true);
  f.button('重试清空').props.onClick();
  await f.confirm(true);
  assert.equal(f.calls.at(-1).body.token, 'retry-token');
  assert.equal(f.calls.filter((call) => call.path.endsWith('/purge')).length, 2);
  f.h.unmount();
});
test('preview failure is retryable, preview is single-flight and late confirmation cannot purge after unmount', async () => {
  const f = fixture();
  f.fail('Preview unavailable');
  await f.inspect();
  assert.match(text(f.render()), /Preview unavailable/);
  const release = f.hold();
  f.button('重新检查').props.onClick();
  f.button('重新检查').props.onClick();
  assert.equal(f.calls.length, 2);
  release();
  await nextTurn();
  f.button('永久清空').props.onClick();
  f.h.unmount();
  await f.confirm(true);
  assert.equal(f.calls.filter((call) => call.method === 'POST').length, 0);
});
