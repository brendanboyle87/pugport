import assert from 'node:assert/strict';
import test from 'node:test';
import {
  effectiveGates,
  formatGateLines,
  gateLoosening,
  normalizeGates,
  parseGateLines,
  projectGatesInputSchema,
} from '../src/shared/project-gates.ts';
import { desktopPermissionChange } from '../src/server/permission-change.ts';
import { electronModule } from './helpers/electron-harness.ts';
import type { Workspace } from '../src/server/workspace.ts';
import type { Project } from '../src/shared/types.ts';

test('default and non-default lines round trip with LF and normalize paths and authors', () => {
  const defaults = formatGateLines();
  assert.equal(defaults.split('\n').length, 7);
  assert.equal(formatGateLines(normalizeGates(parseGateLines(defaults.replaceAll('\n', '\r\n')).gates!)), defaults);
  const source =
    'always-ask ./branch foo\nalways-ask \\docs\\**\nalways-ask branch RELEASE/*\nauthor A@EXAMPLE.COM ask\nauthor b@example.com ask\nno-merge 7:00-08:00 America/New_York\nallow private text\nblock quoted text';
  const parsed = parseGateLines(source);
  assert.deepEqual(parsed.errors, []);
  const formatted = formatGateLines(normalizeGates(parsed.gates!));
  assert.match(formatted, /always-ask \.\/branch foo/);
  assert.match(formatted, /always-ask docs\/\*\*/);
  assert.match(formatted, /author a@example.com b@example.com ask/);
  assert.equal(formatGateLines(normalizeGates(parseGateLines(formatted).gates!)), formatted);
  assert.deepEqual(effectiveGates(normalizeGates({ version: 1, alwaysAsk: { paths: [], branches: [] } })).alwaysAsk, {
    paths: [],
    branches: [],
  });
});
test('parser and boundary schema reject malformed rules', () => {
  for (const input of [
    'unknown x',
    'always-ask',
    'always-ask branch',
    'no-merge x',
    'no-merge 07:00-07:00',
    'no-merge 07:00-08:00 Invalid/Zone',
    'no-merge 07:00-08:00\nno-merge 09:00-10:00',
    'author',
    'author invalid',
    'author a@example.com ask\nauthor b@example.com refuse',
    'allow ab',
    'block',
    `block ${'x'.repeat(201)}`,
  ]) {
    const errors = parseGateLines(input).errors;
    assert.ok(errors.length, input);
    assert.ok(errors[0]!.line > 0, input);
  }
  for (const input of [
    { version: 1, updatedAt: 'x' },
    { version: 1, windows: { noMerge: { from: '07:00', to: '07:00' } } },
    { version: 1, windows: { noMerge: { from: '07:00', to: '08:00', tz: 'invalid' } } },
    { version: 1, alwaysAsk: { paths: Array(51).fill('x') } },
    { version: 1, text: { allow: ['  a '] } },
  ])
    assert.equal(projectGatesInputSchema.safeParse(input).success, false);
});
test('parser reports the correct line and reason for each invalid form', () => {
  const cases: Array<[string, string]> = [
    ['oops x', '不认识「oops」'],
    ['always-ask', 'always-ask 后面写路径'],
    ['always-ask branch', 'always-ask branch 后面写一个分支名'],
    ['no-merge bad', '时间写成'],
    ['no-merge 07:00-07:00', '开始和结束不能'],
    ['no-merge 07:00-08:00 Bad/Zone', '不认识时区'],
    ['no-merge 01:00-02:00\nno-merge 03:00-04:00', '只能有一行'],
    ['author', 'author 后面写邮箱'],
    ['author bad', '不是邮箱'],
    ['author a@example.com ask\nauthor b@example.com refuse', '同一个 refuse 或 ask'],
    ['allow ab', '至少 3 个字符'],
    ['block', 'block 后面写文字'],
    [`block ${'x'.repeat(201)}`, '最多 200 个字符'],
  ];
  for (const [input, reason] of cases) {
    const error = parseGateLines(`\n${input}`).errors[0]!;
    assert.equal(error.line, input.includes('\n') ? 3 : 2, input);
    assert.ok(error.message.includes(reason), input);
  }
  assert.ok(
    parseGateLines(Array.from({ length: 51 }, (_, i) => `block item${i}`).join('\n')).errors.some((e) =>
      e.message.includes('最多 50'),
    ),
  );
  // Only rule lines count toward the 200-line limit.
  assert.deepEqual(parseGateLines(Array(201).fill('').join('\n')).errors, []);
  assert.ok(
    parseGateLines(Array.from({ length: 201 }, (_, i) => `always-ask p${i}`).join('\n')).errors.some((e) =>
      e.message.includes('最多 200 行'),
    ),
  );
  for (const input of ['author <a@example.com>', 'author a@example.com,'])
    assert.ok(parseGateLines(input).errors[0]?.message.includes('不是邮箱'), input);
  assert.ok(parseGateLines('allow private\ttext').errors[0]?.message.includes('控制字符'));
});
test('every field classifies loosening and time windows conservatively', () => {
  const defaults = effectiveGates();
  assert.ok(
    gateLoosening(undefined, { version: 1, alwaysAsk: { paths: [], branches: [] } }).some((v) =>
      v.includes('migrations'),
    ),
  );
  assert.deepEqual(gateLoosening(undefined, defaults), []);
  // Lists equal to the defaults are not stored, so such a project keeps following the defaults.
  assert.equal(normalizeGates(parseGateLines(formatGateLines()).gates!), undefined);
  // Paths match case-sensitively, branches do not.
  assert.deepEqual(
    gateLoosening({ version: 1, alwaysAsk: { paths: ['Docs/**'] } }, { version: 1, alwaysAsk: { paths: ['docs/**'] } }),
    ['不再必问路径：Docs/**'],
  );
  assert.deepEqual(
    gateLoosening({ version: 1, alwaysAsk: { branches: ['MAIN'] } }, { version: 1, alwaysAsk: { branches: ['main'] } }),
    [],
  );
  const old = {
    version: 1 as const,
    text: { allow: ['old'], block: ['stop'] },
    windows: { noMerge: { from: '22:00', to: '07:00' } },
    commitAuthor: { emails: ['a@example.com'], onMismatch: 'refuse' as const },
  };
  const next = {
    version: 1 as const,
    text: { allow: ['new'], block: ['extra'] },
    windows: { noMerge: { from: '23:00', to: '07:00' } },
    commitAuthor: { emails: ['a@example.com', 'b@example.com'], onMismatch: 'ask' as const },
  };
  const loose = gateLoosening(old, next);
  // The dialog shows 20 lines; new allowed text and authors come first.
  assert.ok(loose[0]!.includes('新增放行'));
  for (const fragment of ['新增放行', '不再拦截', '禁止合并时段', '新增提交作者', '作者不符'])
    assert.ok(
      loose.some((v) => v.includes(fragment)),
      fragment,
    );
  assert.ok(
    gateLoosening(undefined, { version: 1, commitAuthor: { emails: ['a@example.com'] } }).some((v) =>
      v.includes('新增提交作者'),
    ),
  );
  assert.ok(gateLoosening(old, undefined).some((v) => v.includes('不再要求提交作者')));
  assert.deepEqual(gateLoosening(old, { ...old, windows: { noMerge: { from: '21:00', to: '08:00' } } }), []);
  assert.ok(gateLoosening(old, { ...old, windows: { noMerge: { from: '21:00', to: '08:00', tz: 'UTC' } } }).length);
});
test('desktop confirmation cancels, applies, and rejects stale descriptions', async () => {
  const { createPermissionChange } = await electronModule('src/electron/permission-change.ts', { app: {} });
  const project = { id: 'p', name: 'Synthetic', path: 'synthetic', createdAt: '', updatedAt: '' } as Project;
  let writes = 0;
  const workspace = {
    store: { get: () => project },
    controller: {},
    setProjectGates(_id: string, input: any) {
      writes++;
      project.gates = normalizeGates(input);
    },
  } as unknown as Workspace;
  const frame = { url: 'http://127.0.0.1:4317' };
  const window = { isDestroyed: () => false, webContents: { mainFrame: frame } };
  const event = { sender: window.webContents, senderFrame: frame };
  let response = 0,
    dialogs = 0;
  const handler = createPermissionChange(
    () => window,
    frame.url,
    async (_owner: unknown, options: any) => {
      dialogs++;
      assert.match(options.message, /Synthetic/);
      assert.match(options.message, /不再必问路径：\*\*\/migrations/);
      return { response };
    },
    (value: unknown, apply: boolean, expected?: string) => desktopPermissionChange(workspace, value, apply, expected),
  );
  const change = { kind: 'project-gates', projectId: 'p', gates: { version: 1, alwaysAsk: { paths: [] } } };
  assert.equal(await handler(event, change), false);
  assert.equal(writes, 0);
  response = 1;
  assert.equal(await handler(event, change), true);
  assert.equal(writes, 1);
  const tightening = { kind: 'project-gates', projectId: 'p', gates: { version: 1 } };
  assert.equal(await handler(event, tightening), true);
  assert.equal(dialogs, 2);
  const description = await desktopPermissionChange(workspace, change, false);
  project.gates = { version: 1, text: { block: ['synthetic'] } };
  await assert.rejects(desktopPermissionChange(workspace, change, true, description), /重新确认/);
  project.gates = undefined;
  project.name = 'Changed';
  await assert.rejects(desktopPermissionChange(workspace, change, true, description), /重新确认/);
  await assert.rejects(desktopPermissionChange(workspace, change, true, 'stale'), /重新确认/);
});
