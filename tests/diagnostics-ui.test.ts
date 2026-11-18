import assert from 'node:assert/strict';
import test from 'node:test';
import { findNode, nextTurn, text, uiBundle, uiHarness } from './helpers/ui-harness.ts';

test('copy diagnostics and crash details never expose home subpaths or prefixed credentials', async () => {
  const copies: string[] = [];
  const globals = { navigator: { clipboard: { writeText: async (value: string) => copies.push(value) } } };
  const sensitive =
    String.raw`C:\Users\alice\Documents\Acme-private\plan.docx` +
    '\nrefresh_token=private-token\n"client_secret":"private-secret"\nhttps://example.test/#access_token=private-fragment';
  const copy = uiHarness(await uiBundle('src/ui/diagnostics.ts'), globals);
  await copy.exports.copyDiagnosticInfo({ os: 'win32' }, () => {}, '\n' + sensitive);
  const crash = uiHarness(await uiBundle('src/ui/desktop.ts'), globals);
  const notice = crash.exports.crashNotice({ kind: 'backend', reason: sensitive, at: '2026-11-03' }, {}, () => {});
  await notice.action.run();
  assert.equal(copies.length, 2);
  for (const value of copies) {
    assert.doesNotMatch(value, /alice|Documents|Acme-private|plan\.docx|private-token|private-secret|private-fragment/);
    assert.match(value, /\[path\]/);
    assert.match(value, /\[secret\]/);
  }
  assert.doesNotMatch(notice.message, /alice|private/);
  copy.unmount();
  crash.unmount();
});

test('About copies diagnostics only on click and update switch uses existing settings callback', async () => {
  const copied: string[] = [];
  const notices: any[] = [];
  const settings: boolean[] = [];
  const h = uiHarness(await uiBundle('src/ui/AppSettings.tsx'), {
    navigator: {
      clipboard: {
        writeText: async (value: string) => {
          copied.push(value);
        },
      },
    },
  });
  const tree = h.render('AppSection', {
    api: async () => ({}),
    notify: (value: unknown) => notices.push(value),
    state: {
      app: { version: '0.0.34', commit: 'abc1234', platform: 'win32', arch: 'x64', dataDir: 'private' },
      runtimes: [],
    },
    updateCheck: true,
    updatePending: false,
    onUpdateCheck: (value: boolean) => settings.push(value),
  });
  assert.equal(copied.length, 0);
  const copy = findNode(tree, (node) => node.type === 'button' && text(node) === '复制诊断信息')!;
  assert.ok(copy);
  copy.props.onClick();
  await nextTurn();
  assert.equal(copied.length, 1);
  assert.doesNotMatch(copied[0]!, /private|dataDir/);
  assert.equal(notices[0].message, '已复制，未发送任何信息。');
  const toggle = findNode(tree, (node) => node.type === 'input' && node.props['aria-label'] === '检查新版本')!;
  assert.equal(toggle.props.checked, true);
  toggle.props.onChange({ target: { checked: false } });
  assert.deepEqual(settings, [false]);
  h.unmount();
});

test('copy failure reports failure without claiming anything was copied', async () => {
  const notices: any[] = [];
  const h = uiHarness(await uiBundle('src/ui/diagnostics.ts'), {
    navigator: {
      clipboard: {
        writeText: async () => {
          throw new Error('denied');
        },
      },
    },
  });
  await h.exports.copyDiagnosticInfo({ os: 'linux' }, (value: unknown) => notices.push(value));
  assert.equal(notices[0].tone, 'error');
  assert.match(notices[0].message, /剪贴板权限/);
});

test('update notice dismisses only the current version and only stores on click', async () => {
  const writes: Array<[string, string]> = [];
  const h = uiHarness(await uiBundle('src/ui/AppUpdateNotice.tsx'), {
    localStorage: { getItem: () => null, setItem: (key: string, value: string) => writes.push([key, value]) },
  });
  const update = { version: '0.0.35', url: 'https://github.com/pugport/pugport/releases/tag/v0.0.35' };
  let tree = h.render('AppUpdateNotice', { update });
  assert.equal(writes.length, 0);
  assert.equal(findNode(tree, (node) => node.type === 'a')?.props.href, update.url);
  findNode(tree, (node) => node.type === 'button')!.props.onClick();
  assert.equal(h.render('AppUpdateNotice', { update }), null);
  assert.equal(writes[0]?.[1], '0.0.35');
  tree = h.render('AppUpdateNotice', { update: { ...update, version: '0.0.36' } });
  assert.ok(tree);
  h.unmount();
});

test('crash actions copy redacted event details or request a report only after a click', async () => {
  const copies: string[] = [];
  const notices: any[] = [];
  let reads = 0;
  let reports = 0;
  const h = uiHarness(await uiBundle('src/ui/desktop.ts'), {
    navigator: { clipboard: { writeText: async (text: string) => copies.push(text) } },
  });
  const notice = h.exports.crashNotice(
    { kind: 'renderer', reason: 'crashed', at: '2026-10-29T12:00:00Z' },
    {
      diagnosticInfo: async () => {
        reads++;
        return { version: '0.0.34', os: 'win32', clis: [{ provider: 'grok', status: 'ready', version: '1.2.3' }] };
      },
      reportProblem: async () => {
        reports++;
        throw new Error('IPC closed');
      },
    },
    (value: unknown) => notices.push(value),
  );
  assert.equal(reads, 0);
  assert.equal(reports, 0);
  await notice.action.run();
  assert.equal(reads, 1);
  assert.match(copies[0]!, /CLI: Grok/);
  assert.match(copies[0]!, /Crash: renderer \/ crashed\nTime: 2026-10-29T12:00:00Z/);
  assert.equal(notices[0].message, '已复制，未发送任何信息。');
  await notice.secondaryAction.run();
  assert.equal(reports, 1);
  assert.equal(notices.at(-1).tone, 'error');
});

test('crash records clear on dismissal, successful copy or report, but survive failed copy', async () => {
  let clears = 0;
  let dismissed = 0;
  let denied = true;
  const h = uiHarness(await uiBundle('src/ui/desktop.ts'), {
    navigator: {
      clipboard: {
        writeText: async () => {
          if (denied) throw new Error('denied');
        },
      },
    },
  });
  const notice = h.exports.crashNotice(
    { kind: 'backend', reason: 'abnormal-exit', at: '2026-10-29T12:00:00Z' },
    {
      clearCrashRecord: async () => {
        clears++;
      },
      reportProblem: async () => true,
    },
    () => {},
    () => {
      dismissed++;
    },
  );
  await notice.action.run();
  assert.equal(clears, 0);
  denied = false;
  await notice.action.run();
  assert.equal(clears, 1);
  await notice.secondaryAction.run();
  assert.equal(clears, 2);
  await notice.onDismiss();
  assert.equal(clears, 3);
  assert.equal(dismissed, 3);
  h.unmount();
});

test('cancelled or failed crash reports keep the persisted notice', async () => {
  let clears = 0;
  const h = uiHarness(await uiBundle('src/ui/desktop.ts'));
  const notice = h.exports.crashNotice(
    { kind: 'backend', reason: 'abnormal-exit', at: '2026-10-29T12:00:00Z' },
    {
      clearCrashRecord: async () => {
        clears++;
      },
      reportProblem: async () => false,
    },
    () => {},
  );
  await notice.secondaryAction.run();
  assert.equal(clears, 0);
  h.unmount();
});
