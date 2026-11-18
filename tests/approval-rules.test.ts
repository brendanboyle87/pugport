import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, parse, resolve, sep } from 'node:path';
import { Controller } from '../src/server/controller.ts';
import { Workspace } from '../src/server/workspace.ts';
import { approvalKey, normalizedCommand } from '../src/server/approval-rules.ts';
import { canonical } from '../src/server/sandbox/execution.ts';
import { syntheticCodex } from './helpers/codex-rpc.ts';
import { findNode, uiBundle, uiHarness } from './helpers/ui-harness.ts';
import type { ApprovalKey, Conversation, Project, Provider, RunRecord, Workflow } from '../src/shared/types.ts';

test('exact commands accept only plain command strings', () => {
  for (const command of ['npm test', 'git status --short', 'node scripts/build.mjs', ' npm   test  --watch '])
    assert.equal(normalizedCommand(command), command.trim().replace(/ +/g, ' '));
  for (const command of [
    'bash -lc npm test',
    'powershell -Command Get-Item',
    'node -e code',
    'python -c code',
    'cmd /c dir',
    'ti\\meout 60 x',
    'bash \\-c x',
    'C:\\tools\\npm.cmd run build',
    'git',
    '',
  ])
    assert.equal(normalizedCommand(command), undefined, command);
  for (const char of ['&', ';', '|', '>', '<', '%', '^', '\\', '\n', '\r', '`', '$(', '\t', '"', "'"]) {
    assert.equal(normalizedCommand(`npm test ${char} whoami`), undefined, char);
    assert.equal(normalizedCommand(`npm test${char}`), undefined, `trailing ${char}`);
    assert.equal(normalizedCommand(`${char}npm test`), undefined, `leading ${char}`);
  }
});

test('only supported operations with complete paths produce keys; grant and network context never do', () => {
  const root = process.cwd();
  for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
    const input =
      tool === 'NotebookEdit' ? { notebook_path: join(root, 'book.ipynb') } : { file_path: join(root, 'src/file.ts') };
    const key = approvalKey(tool, input, root)!;
    assert.ok('paths' in key);
    assert.equal(key.paths[0], resolve(root, Object.values(input)[0]!));
  }
  assert.equal(approvalKey('Codex file change', { changes: [] }, root), undefined);
  assert.equal(
    approvalKey('Codex file change', { changes: [{ path: 'a', kind: { type: 'update' } }, {}] }, root),
    undefined,
  );
  assert.equal(approvalKey('Read', { file_path: 'a' }, root), undefined);
  assert.equal(approvalKey('Codex permissions', { command: 'npm test' }, root), undefined);
  for (const context of [{ grantRoot: root }, { networkApprovalContext: {} }]) {
    assert.equal(approvalKey('Bash', { command: 'npm test', ...context }, root), undefined);
    assert.equal(
      approvalKey('Codex file change', { changes: [{ path: 'a', kind: { type: 'update' } }], ...context }, root),
      undefined,
    );
  }
});

test('exact commands preserve wrapper arguments and every program action', () => {
  assert.equal(normalizedCommand('CI=true npm test'), undefined);
  for (const command of [
    'timeout 60 npm test',
    'env npm test',
    'sudo npm test',
    '/usr/bin/env npm test',
    'npm run build --watch',
    'npm exec build --flag',
    'npm rum anything',
    'npm run',
    'dotnet tool list',
  ])
    assert.equal(normalizedCommand(command), command);
});

test('Codex file keys require a known kind.type for every change', () => {
  const root = process.cwd();
  for (const type of ['add', 'delete', 'update'])
    assert.deepEqual(approvalKey('Codex file change', { changes: [{ path: 'a.ts', kind: { type } }] }, root), {
      tool: 'Codex file change',
      paths: [join(root, 'a.ts')],
    });
  for (const kind of [
    undefined,
    null,
    'add',
    'delete',
    'update',
    {},
    [],
    1,
    { type: 'rename' },
    { type: { type: 'add' } },
    { update: { move_path: '../outside.ts' } },
  ]) {
    for (const changes of [
      [{ path: 'a.ts', kind }],
      [
        { path: 'safe.ts', kind: { type: 'add' } },
        { path: 'a.ts', kind },
      ],
    ])
      assert.equal(approvalKey('Codex file change', { changes }, root), undefined, JSON.stringify(kind));
  }
});

test('Claude Bash with sandbox disabled never gets a key', () => {
  for (const dangerouslyDisableSandbox of [true, 1, 'true', {}])
    assert.equal(approvalKey('Bash', { command: 'npm test', dangerouslyDisableSandbox }, process.cwd()), undefined);
  for (const dangerouslyDisableSandbox of [false, null, undefined])
    assert.deepEqual(approvalKey('Bash', { command: 'npm test', dangerouslyDisableSandbox }, process.cwd()), {
      tool: 'Bash',
      command: 'npm test',
    });
});

test('Claude file paths must be absolute and untrimmed; no file tool accepts home expansion', () => {
  const root = process.cwd();
  for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
    for (const path of [
      'src/a.ts',
      '~/.bashrc',
      '~user/file',
      ' C:\\Windows\\x',
      ` ${join(root, 'a')}`,
      `${join(root, 'a')} `,
    ]) {
      const input = tool === 'NotebookEdit' ? { notebook_path: path } : { file_path: path };
      assert.equal(approvalKey(tool, input, root), undefined, `${tool}: ${path}`);
    }
  }
  assert.equal(
    approvalKey('Codex file change', { changes: [{ path: '~/.bashrc', kind: { type: 'update' } }] }, root),
    undefined,
  );
  assert.equal(approvalKey('Bash', { command: '~/bin/npm test' }, root), undefined);
});

test('Claude file tools on Windows require drive-letter absolute paths', { skip: process.platform !== 'win32' }, () => {
  for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
    for (const path of [
      '/x/file.ts',
      '\\x\\file.ts',
      'C:file.ts',
      '//server/share/file.ts',
      '\\\\server\\share\\file.ts',
    ]) {
      const input = tool === 'NotebookEdit' ? { notebook_path: path } : { file_path: path };
      assert.equal(approvalKey(tool, input, process.cwd()), undefined, `${tool}: ${path}`);
    }
    for (const path of ['C:/x/file.ts', 'C:\\x\\file.ts']) {
      const input = tool === 'NotebookEdit' ? { notebook_path: path } : { file_path: path };
      assert.ok(approvalKey(tool, input, process.cwd()), `${tool}: ${path}`);
    }
  }
});

test('Codex rename keys include both destination spellings and reject malformed destinations', () => {
  const root = process.cwd();
  for (const field of ['move_path', 'movePath']) {
    const input = { changes: [{ path: 'src/a.ts', kind: { type: 'update', [field]: 'src/b.ts' } }] };
    assert.deepEqual(approvalKey('Codex file change', input, root), {
      tool: 'Codex file change',
      paths: [resolve(root, 'src/a.ts'), resolve(root, 'src/b.ts')],
    });
    for (const value of [null, undefined]) {
      input.changes[0].kind[field] = value as unknown as string;
      assert.deepEqual(approvalKey('Codex file change', input, root), {
        tool: 'Codex file change',
        paths: [resolve(root, 'src/a.ts')],
      });
    }
    for (const value of [42, false, {}, [], '~/.bashrc', '../outside.ts', 'src/../a.ts', 'src\\..\\a.ts']) {
      input.changes[0].kind[field] = value as string;
      assert.equal(approvalKey('Codex file change', input, root), undefined);
    }
  }
  assert.deepEqual(
    approvalKey(
      'Codex file change',
      { changes: [{ path: 'a', kind: { type: 'update', move_path: 'b', movePath: 'c' } }] },
      root,
    ),
    { tool: 'Codex file change', paths: ['a', 'b', 'c'].map((path) => join(root, path)) },
  );
});

test('parent segments are rejected before resolution for every file tool', () => {
  const root = process.cwd();
  for (const path of [`${root}/src/../a.ts`, `${root}\\src\\..\\a.ts`]) {
    assert.throws(() => canonical(path, true), /Parent path segments/);
    for (const tool of ['Codex file change', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
      const input =
        tool === 'Codex file change'
          ? { changes: [{ path, kind: { type: 'update' } }] }
          : tool === 'NotebookEdit'
            ? { notebook_path: path }
            : { file_path: path };
      assert.equal(approvalKey(tool, input, root), undefined, `${tool}: ${path}`);
    }
  }
  assert.equal(
    approvalKey('Codex file change', { changes: [{ path: 'src/../a.ts', kind: { type: 'update' } }] }, root),
    undefined,
  );
});

function fixture(t: TestContext) {
  const temporary = realpathSync.native(mkdtempSync(join(tmpdir(), 'pugport-approval-rules-')));
  const home = join(temporary, 'home');
  const root = join(home, 'repo');
  mkdirSync(root, { recursive: true });
  const savedEnvironment = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    OneDrive: process.env.OneDrive,
  };
  process.env.HOME = process.env.USERPROFILE = home;
  process.env.OneDrive = join(home, 'OneDrive');
  t.after(() => {
    for (const [key, value] of Object.entries(savedEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  assert.equal(homedir(), home);
  const controller = new Controller(root, join(temporary, 'data'));
  clearInterval(controller.timer);
  controller.targets = (['codex', 'claude', 'cursor', 'gemini', 'pi'] as Provider[]).map((provider) => ({
    id: provider,
    provider,
    label: provider,
    command: 'unused',
    environment: 'native',
    enabled: true,
  }));
  const workspace = new Workspace(controller, { autoTick: false });
  const abort = new AbortController();
  t.after(async () => {
    abort.abort();
    await workspace.close();
    await controller.close();
    assert.ok(temporary.startsWith(realpathSync.native(tmpdir()) + sep));
    assert.ok(temporary.includes('pugport-approval-rules-'));
    rmSync(temporary, { recursive: true, force: true });
  });
  const at = new Date().toISOString();
  workspace.store.save('project', 'project', 'project', {
    id: 'project',
    name: 'Fixture',
    path: root,
    createdAt: at,
    updatedAt: at,
  } as Project);
  for (const id of ['one', 'two']) {
    workspace.store.save('conversation', id, 'project', {
      id,
      projectId: 'project',
      title: id,
      createdAt: at,
      updatedAt: at,
    } as Conversation);
    workspace.store.save('workflow', id, id, {
      id,
      conversationId: id,
      projectId: 'project',
      userMessageId: id,
      status: 'completed',
      phase: 'summarize',
      plan: [],
      runIds: [],
      input: { content: 'Fixture', mode: 'chat', permissionMode: 'read-only', executionPolicy: 'cli-first' },
      memoryRevision: 0,
      memoryExcerpt: '',
      createdAt: at,
      updatedAt: at,
    } satisfies Workflow);
  }
  let next = 0;
  const run = (conversation = 'one', provider = 'codex'): RunRecord => {
    const value: RunRecord = {
      id: `run-${++next}`,
      workflowId: conversation,
      projectPath: root,
      prompt: 'Fixture',
      kind: 'general',
      status: 'running',
      toolApprovalMode: 'ask',
      output: '',
      events: [],
      startedAt: at,
      route: { runtimeId: provider, model: 'fixture', kind: 'general', reasons: [], warnings: [] },
    };
    controller.store.saveRun(value);
    return value;
  };
  const rules = () => workspace.store.get<Conversation>('conversation', 'one')!.approvalRules ?? [];
  const ask = (
    value: RunRecord,
    key: ApprovalKey | undefined,
    tool = key?.tool ?? 'Codex permissions',
    requireUser = false,
    description = 'Fixture operation',
  ) => controller.approve(value, tool, description, abort.signal, { key, requireUser });
  const answer = (remember = false, allow = true) => {
    assert.equal(controller.approvals.size, 1);
    const entry = [...controller.approvals.values()][0];
    controller.answerApproval(entry.value.id, allow, remember);
    return entry.value;
  };
  return { root, controller, workspace, run, rules, ask, answer };
}

test('rules persist, match only this conversation and exact command, log approvals, and removal asks again', async (t) => {
  const f = fixture(t);
  const key = approvalKey('Bash', { command: 'npm test' }, f.root)!;
  const first = f.ask(f.run('one', 'claude'), key);
  assert.deepEqual(f.answer(true).key, key);
  assert.equal(await first, true);
  assert.equal(f.rules().length, 1);
  assert.equal(
    f.workspace.state().conversations!.find((conversation) => conversation.id === 'one')!.approvalRules!.length,
    1,
  );
  const later = f.run('one', 'claude');
  assert.equal(await f.ask(later, key), true);
  assert.equal(f.controller.approvals.size, 0);
  assert.ok(
    f.controller.store
      .run(later.id)!
      .events.some(
        (event) =>
          event.text === '已按本对话规则自动允许：命令：npm test\nFixture operation' &&
          event.data?.ruleId === f.rules()[0].id,
      ),
  );
  for (const [run, otherKey] of [
    [f.run('two', 'claude'), key],
    [f.run('one', 'claude'), approvalKey('Bash', { command: 'npm install' }, f.root)!],
    [f.run('one', 'codex'), key],
  ] as const) {
    const pending = f.ask(run, otherKey);
    f.answer(false, false);
    assert.equal(await pending, false);
  }
  f.workspace.removeApprovalRule('one', f.rules()[0].id);
  assert.equal(f.rules().length, 0);
  const again = f.ask(f.run('one', 'claude'), key);
  f.answer();
  assert.equal(await again, true);
});

test('command rules match only the whole normalized command', async (t) => {
  const f = fixture(t);
  for (const [command, other] of [
    ['npm test', 'npm test --watch'],
    ['rm build.log', 'rm build.log -rf x'],
    ['mv a.txt b.txt', 'mv a.txt b.txt .bashrc'],
    ['git log', 'git log --output=out.txt'],
    ['git config user.name x', 'git config core.fsmonitor x'],
    ['npm rum build', 'npm rum other'],
  ]) {
    const key = approvalKey('Bash', { command }, f.root)!;
    assert.ok(key);
    const first = f.ask(f.run('one', 'claude'), key);
    f.answer(true);
    assert.equal(await first, true);
    for (const identical of [command, `  ${command.replaceAll(' ', '   ')}  `]) {
      assert.equal(await f.ask(f.run('one', 'claude'), approvalKey('Bash', { command: identical }, f.root)), true);
      assert.equal(f.controller.approvals.size, 0);
    }
    const pending = f.ask(f.run('one', 'claude'), approvalKey('Bash', { command: other }, f.root));
    f.answer(false, false);
    assert.equal(await pending, false);
  }
});

test('Codex command approvals always ask and send only individual decisions', async (t) => {
  const f = fixture(t);
  const requests: Array<Record<string, unknown>> = [];
  const adapter = syntheticCodex({ approval: true }, requests);
  let prompts = 0;
  for (let i = 0; i < 2; i++) {
    const run = f.run();
    await adapter.execute({
      target: f.controller.targets[0],
      input: { prompt: 'Fixture', projectPath: f.root, kind: 'general', permissionMode: 'read-only' },
      route: run.route,
      signal: new AbortController().signal,
      emit() {},
      approve: (tool, _description, key) => {
        const pending = f.ask(run, key, tool);
        if (f.controller.approvals.size) {
          prompts++;
          assert.equal([...f.controller.approvals.values()][0].value.key, undefined);
          f.answer();
        }
        return pending;
      },
    });
  }
  assert.equal(prompts, 2);
  assert.equal(f.rules().length, 0);
  assert.deepEqual(
    requests.filter((request) => request.id === 'synthetic-approval').map((request) => request.result),
    [{ decision: 'accept' }, { decision: 'accept' }],
  );
});

test('Claude rules match tool and exact command, and each edit tool stays within the project', async (t) => {
  const f = fixture(t);
  for (const [tool, input] of [
    ['Bash', { command: 'git status --short' }],
    ...['Edit', 'Write', 'MultiEdit'].map((tool) => [tool, { file_path: join(f.root, 'src/a.ts') }] as const),
    ['NotebookEdit', { notebook_path: join(f.root, 'book.ipynb') }],
  ] as const) {
    const key = approvalKey(tool, input, f.root)!;
    const first = f.ask(f.run('one', 'claude'), key);
    f.answer(true);
    assert.equal(await first, true);
    assert.equal(await f.ask(f.run('one', 'claude'), key), true);
    assert.equal(f.controller.approvals.size, 0);
    const other = f.ask(f.run('two', 'claude'), key);
    f.answer(false, false);
    assert.equal(await other, false);
  }
  const outside = f.ask(f.run('one', 'claude'), { tool: 'Edit', paths: [join(f.root, '../outside.ts')] });
  assert.equal(f.answer().key, undefined);
  assert.equal(await outside, true);
});

test('read-only runs with existing rules still ask and show no remember button', async (t) => {
  const f = fixture(t);
  const cardCode = await uiBundle('src/ui/App.tsx');
  for (const tool of ['Codex file change', 'Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'] as const) {
    const provider = tool === 'Codex file change' ? 'codex' : 'claude';
    const key: ApprovalKey =
      tool === 'Bash' ? { tool, command: 'npm test' } : { tool, paths: [join(f.root, 'safe.ts')] };
    const writable = f.run('one', provider);
    writable.permissionMode = 'workspace-write';
    const first = f.ask(writable, key);
    f.answer(true);
    assert.equal(await first, true);
    const readOnly = f.run('one', provider);
    readOnly.permissionMode = 'read-only';
    const pending = f.ask(readOnly, key);
    assert.equal(f.controller.approvals.size, 1, tool);
    const approval = [...f.controller.approvals.values()][0].value;
    assert.equal(approval.key, undefined, tool);
    assert.throws(() => f.controller.answerApproval(approval.id, true, true), /不能保存/);
    const tree = uiHarness(cardCode).render('ApprovalCard', { approval, api: async () => {}, notify() {} });
    assert.equal(
      findNode(tree, (node) => node.type === 'button' && node.props['data-approval-remember'] === true),
      undefined,
      tool,
    );
    f.answer(false, false);
    assert.equal(await pending, false);
  }
});

test('allow once and deny save no rules, and missing conversation scope cannot be remembered', async (t) => {
  const f = fixture(t);
  const key: ApprovalKey = { tool: 'Codex file change', paths: [join(f.root, 'src/a.ts')] };
  for (const allow of [true, false]) {
    const pending = f.ask(f.run(), key);
    f.answer(false, allow);
    assert.equal(await pending, allow);
    assert.equal(f.rules().length, 0);
  }
  const detached = f.run();
  detached.workflowId = undefined;
  const pending = f.ask(detached, key);
  assert.equal(f.answer().key, undefined);
  assert.equal(await pending, true);
});

test('file rules require every path inside the project, and never extend to a relocated project', async (t) => {
  const f = fixture(t);
  const key = approvalKey('Codex file change', { changes: [{ path: 'src/a.ts', kind: { type: 'update' } }] }, f.root)!;
  const first = f.ask(f.run(), key);
  f.answer(true);
  assert.equal(await first, true);
  assert.equal(await f.ask(f.run(), { ...key, paths: [join(f.root, 'new.ts')] } as ApprovalKey), true);
  for (const paths of [[join(f.root, '../outside.ts')], [join(f.root, 'a.ts'), `${f.root}-sibling/a.ts`], []]) {
    const pending = f.ask(f.run(), { tool: 'Codex file change', paths });
    assert.equal([...f.controller.approvals.values()][0].value.key, undefined);
    f.answer();
    assert.equal(await pending, true);
  }
  const project = f.workspace.store.get<Project>('project', 'project')!;
  project.path = join(f.root, 'relocated');
  f.workspace.store.save('project', project.id, project.id, project);
  const pending = f.ask(f.run(), { tool: 'Codex file change', paths: [join(project.path, 'a')] });
  f.answer();
  assert.equal(await pending, true);
});

test('rename destinations outside the project cannot match or expose a remember key', async (t) => {
  const f = fixture(t);
  const first = f.ask(
    f.run(),
    approvalKey('Codex file change', { changes: [{ path: 'src/a.ts', kind: { type: 'update' } }] }, f.root),
  );
  f.answer(true);
  await first;
  for (const field of ['move_path', 'movePath']) {
    const key = approvalKey(
      'Codex file change',
      {
        changes: [{ path: join(f.root, 'src/a.ts'), kind: { type: 'update', [field]: join(f.root, '../outside.ts') } }],
      },
      f.root,
    );
    const pending = f.ask(f.run(), key);
    assert.equal(f.answer().key, undefined);
    assert.equal(await pending, true);
  }
});

test('broad project roots cannot match existing file rules or expose a remember key', async (t) => {
  const f = fixture(t);
  const project = f.workspace.store.get<Project>('project', 'project')!;
  for (const root of new Set([
    parse(f.root).root,
    homedir(),
    dirname(homedir()),
    f.controller.dataDir,
    dirname(f.controller.dataDir),
    join(homedir(), 'Documents'),
    join(process.env.OneDrive!, 'Documents'),
    ...['.claude', '.codex', '.hidden/nested', 'AppData/Roaming/Code/User', 'aPpDaTa/Local/fixture'].map((path) =>
      join(homedir(), path),
    ),
  ])) {
    project.path = root;
    f.workspace.store.save('project', project.id, project.id, project);
    for (const tool of ['Codex file change', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'] as const) {
      const conversation = f.workspace.store.get<Conversation>('conversation', 'one')!;
      conversation.approvalRules = [{ id: 'existing', tool, projectPath: root }];
      f.workspace.store.save('conversation', conversation.id, conversation.projectId, conversation);
      const pending = f.ask(f.run('one', tool === 'Codex file change' ? 'codex' : 'claude'), {
        tool,
        paths: [join(root, 'safe.ts')],
      });
      const approval = [...f.controller.approvals.values()][0].value;
      assert.equal(approval.key, undefined, root);
      assert.throws(() => f.controller.answerApproval(approval.id, true, true), /不能保存/);
      f.answer(false, false);
      assert.equal(await pending, false);
    }
  }
});

test('a repository worktree below .claude still supports remembered file approvals', async (t) => {
  const f = fixture(t);
  const project = f.workspace.store.get<Project>('project', 'project')!;
  project.path = join(f.root, '.claude', 'worktrees', 'fixture');
  mkdirSync(project.path, { recursive: true });
  f.workspace.store.save('project', project.id, project.id, project);
  const key = { tool: 'Write' as const, paths: [join(project.path, 'safe.ts')] };
  const first = f.ask(f.run('one', 'claude'), key);
  assert.ok(f.answer(true).key);
  assert.equal(await first, true);
  assert.equal(await f.ask(f.run('one', 'claude'), key), true);
  assert.equal(f.controller.approvals.size, 0);
});

test('sandbox canonicalization remains lenient for parent segments and dangling junctions', (t) => {
  const f = fixture(t);
  const link = join(f.root, 'dangling');
  symlinkSync(join(f.root, 'missing-target'), link, 'junction');
  try {
    assert.equal(canonical(`${f.root}/src/../safe.ts`), join(f.root, 'safe.ts'));
    for (const path of [link, join(link, 'new/deep/file.ts')]) {
      assert.equal(canonical(path), path);
      assert.throws(() => canonical(path, true));
    }
  } finally {
    unlinkSync(link);
  }
});

test('protected directory segments never match file rules or expose a remember key', async (t) => {
  const f = fixture(t);
  for (const tool of ['Codex file change', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'] as const) {
    const run = () => f.run('one', tool === 'Codex file change' ? 'codex' : 'claude');
    const first = f.ask(run(), { tool, paths: [join(f.root, 'src/a.ts')] });
    f.answer(true);
    await first;
    for (const folder of [
      'AppData',
      'WindowsPowerShell',
      'PowerShell',
      'aPpDaTa',
      'wInDoWsPoWeRsHeLl',
      'pOwErShElL',
      '.git',
      '.codex',
      '.claude',
      '.agents',
      '.husky',
      '.gemini',
      '.cursor',
      '.grok',
      '.comborunner',
      '.arbitrary',
      '.github',
      '.GIT',
      '.CoDeX',
      '.ClAuDe',
      '.AGENTS',
      '.HUSKY',
      'GIT~1',
      'CLAUDE~1',
      '.git::$INDEX_ALLOCATION',
      '.git.',
      '.git ',
      '.claude.',
      '.claude ',
    ]) {
      for (const path of [join(f.root, folder, 'config'), join(f.root, 'nested', folder, 'hooks/pre-commit')]) {
        const pending = f.ask(run(), { tool, paths: [join(f.root, 'safe.ts'), path] });
        const approval = [...f.controller.approvals.values()][0].value;
        assert.equal(approval.key, undefined, path);
        assert.throws(() => f.controller.answerApproval(approval.id, true, true), /不能保存/);
        f.answer(false, false);
        assert.equal(await pending, false);
      }
    }
    for (const file of [
      'AGENTS.md',
      'CLAUDE.md',
      'GEMINI.md',
      'CLAUDE.local.md',
      'AGENTS.override.md',
      'agents.MD',
      'claude.MD',
      'gemini.MD',
      'claude.LOCAL.md',
      'agents.OVERRIDE.md',
    ]) {
      const pending = f.ask(run(), { tool, paths: [join(f.root, file)] });
      assert.equal(f.answer(false, false).key, undefined, file);
      assert.equal(await pending, false);
      assert.equal(await f.ask(run(), { tool, paths: [join(f.root, 'nested', file)] }), true);
    }
    for (const path of [
      `${f.root}/src/../safe.ts`,
      `${f.root}\\src\\..\\safe.ts`,
      join(f.root, 'safe.ts.'),
      join(f.root, 'safe.ts '),
    ]) {
      const pending = f.ask(run(), { tool, paths: [path] });
      assert.equal(f.answer(false, false).key, undefined, path);
      assert.equal(await pending, false);
    }
    for (const file of ['.mcp.json', '.MCP.JSON', '.gitignore']) {
      for (const path of [join(f.root, file), join(f.root, 'nested', file)]) {
        const pending = f.ask(run(), { tool, paths: [path] });
        assert.equal(f.answer(false, false).key, undefined, path);
        assert.equal(await pending, false);
      }
    }
  }
});

test('real hard links cannot match file rules or expose a remember key', async (t) => {
  const f = fixture(t);
  const projectRoot = join(f.root, 'project');
  mkdirSync(projectRoot);
  const outside = join(f.root, 'outside.ts');
  const linked = join(projectRoot, 'linked.ts');
  writeFileSync(outside, 'fixture');
  linkSync(outside, linked);
  assert.ok(lstatSync(linked).nlink > 1);
  assert.equal(realpathSync(linked), linked);
  const project = f.workspace.store.get<Project>('project', 'project')!;
  project.path = projectRoot;
  f.workspace.store.save('project', project.id, project.id, project);
  for (const tool of ['Codex file change', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'] as const) {
    const run = () => f.run('one', tool === 'Codex file change' ? 'codex' : 'claude');
    const safe = join(projectRoot, 'safe.ts');
    const first = f.ask(run(), { tool, paths: [safe] });
    assert.ok(f.answer(true).key);
    assert.equal(await first, true);
    for (const paths of [[linked], [safe, linked]]) {
      const pending = f.ask(run(), { tool, paths });
      const approval = [...f.controller.approvals.values()][0].value;
      assert.equal(approval.key, undefined, tool);
      assert.throws(() => f.controller.answerApproval(approval.id, true, true), /不能保存/);
      f.answer(false, false);
      assert.equal(await pending, false);
    }
  }
});

test('real junctions resolve both project and targets, including new files and protected aliases', async (t) => {
  const f = fixture(t);
  const projectRoot = join(f.root, 'project');
  const outside = join(f.root, 'outside');
  const projectAlias = join(f.root, 'project-alias');
  mkdirSync(join(projectRoot, 'node_modules'), { recursive: true });
  mkdirSync(join(projectRoot, '.git'));
  mkdirSync(outside);
  writeFileSync(join(outside, 'index.js'), 'fixture');
  const links = [projectAlias, join(projectRoot, 'node_modules/x'), join(projectRoot, 'metadata')];
  symlinkSync(projectRoot, links[0], 'junction');
  symlinkSync(outside, links[1], 'junction');
  symlinkSync(join(projectRoot, '.git'), links[2], 'junction');
  try {
    const project = f.workspace.store.get<Project>('project', 'project')!;
    project.path = projectAlias;
    f.workspace.store.save('project', project.id, project.id, project);
    const first = f.ask(f.run(), { tool: 'Codex file change', paths: [join(projectAlias, 'safe.ts')] });
    assert.ok(f.answer(true).key);
    await first;
    assert.equal(
      await f.ask(f.run(), { tool: 'Codex file change', paths: [join(projectRoot, 'new/deep/safe.ts')] }),
      true,
    );
    for (const path of ['node_modules/x/index.js', 'node_modules/x/new/deep/file.ts', 'metadata/config']) {
      const pending = f.ask(f.run(), { tool: 'Codex file change', paths: [join(projectAlias, path)] });
      assert.equal(f.answer(false, false).key, undefined, path);
      assert.equal(await pending, false);
    }
  } finally {
    for (const link of links.reverse()) unlinkSync(link);
  }
});

test('dangling junctions and their descendants cannot match or expose a remember key', async (t) => {
  const f = fixture(t);
  const link = join(f.root, 'dangling');
  symlinkSync(join(f.root, 'missing-target'), link, 'junction');
  try {
    const first = f.ask(f.run(), { tool: 'Codex file change', paths: [join(f.root, 'safe.ts')] });
    f.answer(true);
    await first;
    for (const path of [link, join(link, 'new/deep/file.ts')]) {
      assert.throws(() => canonical(path, true));
      const pending = f.ask(f.run(), { tool: 'Codex file change', paths: [path] });
      assert.equal(f.answer(false, false).key, undefined, path);
      assert.equal(await pending, false);
    }
  } finally {
    unlinkSync(link);
  }
});

test('auto-allow logs the request after redaction and then limits it to 300 characters', async (t) => {
  const f = fixture(t);
  const key = approvalKey('Bash', { command: 'npm test' }, f.root)!;
  const first = f.ask(f.run('one', 'claude'), key);
  f.answer(true);
  await first;
  const run = f.run('one', 'claude');
  const description = `npm test token=${'s'.repeat(400)} ${'x'.repeat(400)}`;
  assert.equal(await f.ask(run, key, key.tool, false, description), true);
  const event = f.controller.store.run(run.id)!.events.find((event) => event.data?.ruleId)!;
  const detail = event.text!.split('\n')[1];
  assert.equal(detail, `npm test token=[redacted] ${'x'.repeat(400)}`.slice(0, 300));
  assert.equal(detail.length, 300);
});

test('mandatory prompts, unsupported runtimes, missing keys and auto mode cannot inherit a rule', async (t) => {
  const f = fixture(t);
  const key: ApprovalKey = { tool: 'Codex file change', paths: [join(f.root, 'src/a.ts')] };
  const first = f.ask(f.run(), key);
  f.answer(true);
  await first;
  for (const [provider, tool, candidate, requireUser] of [
    ['codex', key.tool, key, true],
    ['codex', 'Codex permissions', key, false],
    ['codex', key.tool, undefined, false],
    ...['cursor', 'gemini', 'pi'].map((provider) => [provider, key.tool, key, false] as const),
  ] as const) {
    const pending = f.ask(f.run('one', provider), candidate, tool, requireUser);
    const approval = [...f.controller.approvals.values()][0].value;
    assert.equal(approval.key, undefined);
    assert.throws(() => f.controller.answerApproval(approval.id, true, true), /不能保存/);
    f.answer(false, false);
    assert.equal(await pending, false);
  }
  const automatic = f.run();
  automatic.toolApprovalMode = 'auto';
  assert.equal(await f.ask(automatic, key), false);
  assert.equal(f.controller.approvals.size, 0);
  assert.equal(f.rules().length, 1);
});
