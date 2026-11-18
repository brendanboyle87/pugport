import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTranslator, defaultLocale, withSpacing } from '../src/shared/i18n/index.ts';

import { deriveTrajectory } from '../src/shared/trajectory.ts';
import {
  approvalPreviewTooLong,
  bridgeEventAskCaller,
  bridgeEventAssignSubtask,
  bridgeEventMessageSubtask,
  bridgeEventReplyQuestion,
  bridgeStageVerifyRecyclePaths,
  connectorApprovalDescription,
  connectorApprovalExpired,
  connectorAuthChanged,
  connectorCalendarNotice,
  connectorDraftDenied,
  connectorDraftNotice,
  connectorDraftTitle,
  connectorEditDenied,
  connectorEditTitle,
  githubApprovalDenied,
  githubApprovalExpired,
  githubApprovalTitle,
  mcpApprovalDenied,
  mcpPermissionsChanged,
} from '../src/shared/bridge-copy.ts';
import { choosePlanningStrategy } from '../src/server/planning-policy.ts';
import keys from '../src/shared/i18n/keys.json' with { type: 'json' };
import english from '../src/shared/i18n/en.json' with { type: 'json' };
import traditional from '../src/shared/i18n/zh-Hant.json' with { type: 'json' };

test('interface text translates exactly, by pattern, and leaves unknown or non-Chinese text alone', () => {
  const translate = createTranslator({
    设置: 'Settings',
    '{0} 个任务运行中': '{0} tasks running',
    '{1} 中的 {0}': '{0} in {1}',
    本机: 'Local',
    '{0} · {1}': '{0} · {1}',
  });
  assert.equal(translate('  设置 '), 'Settings');
  assert.equal(translate('3 个任务运行中'), '3 tasks running');
  // Placeholders may swap order; a known piece inside a pattern is translated too.
  assert.equal(translate('报告.md 中的 本机'), 'Local in 报告.md');
  assert.equal(translate('Grok B'), undefined);
  assert.equal(translate('一段用户自己写的话'), undefined);
  assert.equal(withSpacing(' 设置 ', 'Settings'), ' Settings ');
});

test('a label ending in a full-width colon keeps a space before the value in the next text node', () => {
  assert.equal(withSpacing('预计耗时：', 'Estimated duration:'), 'Estimated duration: ');
  assert.equal(withSpacing('下次检查：', 'Next check: '), 'Next check: ');
  assert.equal(withSpacing('出错：网络', 'Error: network'), 'Error: network');
  assert.equal(withSpacing('设置', 'Settings'), 'Settings');
});

test('the system language picks the starting language', () => {
  assert.equal(defaultLocale(['zh-CN']), 'zh-CN');
  assert.equal(defaultLocale(['zh-TW', 'en']), 'zh-TW');
  assert.equal(defaultLocale(['zh-HK']), 'zh-TW');
  assert.equal(defaultLocale(['en-US']), 'en');
  assert.equal(defaultLocale(['fr-FR']), 'zh-CN');
});

test('every interface string has an English and a Traditional Chinese translation with the same placeholders', () => {
  const placeholders = (text: string) => (text.match(/\{\d+\}/g) ?? []).sort().join();
  for (const key of keys as string[]) {
    const en = (english as Record<string, string>)[key];
    const hant = (traditional as Record<string, string>)[key];
    assert.equal(typeof en, 'string', `missing English: ${key}`);
    assert.equal(typeof hant, 'string', `missing Traditional Chinese: ${key}`);
    assert.equal(placeholders(en!), placeholders(key), `placeholders differ: ${key}`);
    assert.doesNotMatch(en!, /[㐀-鿿]/, `Chinese left in English: ${key}`);
  }
});

test('a piece is looked up only as a whole key, never matched against patterns, so pattern-shaped names stay as written', () => {
  const translate = createTranslator(english);
  // A conversation called 任务 1 or 下载 报告 is the user's name, not "Task 1" or "Download 报告". Interface
  // sentences embedded in another sentence are translated where they are built (translateInterfaceText).
  assert.equal(translate('删除「任务 1」？'), 'Delete “任务 1”?');
  assert.equal(translate('删除「下载 报告」？'), 'Delete “下载 报告”?');
  assert.equal(
    translate('任务完整执行链加载失败（Request failed (404)）。'),
    'Failed to load the complete task execution history (Request failed (404)).',
  );
});

test('status lines joined from pieces translate piece by piece', () => {
  const translate = createTranslator({ 就绪: 'Ready', '{0} 次任务': '{0} tasks', '{0} · {1}': '{0} · {1}' });
  assert.equal(translate('就绪 · 5 次任务 · 470.3K tokens'), 'Ready · 5 tasks · 470.3K tokens');
});

test('retired cloud agent leaves no interface translation keys or values', () => {
  for (const catalog of [keys, english, traditional]) {
    assert.doesNotMatch(JSON.stringify(catalog), /codex-cloud|Codex (?:云端|雲端|Cloud)/i);
  }
});

test('trajectory native status labels and Cursor CLI label translate to English', () => {
  const translate = createTranslator(english);
  const statuses = [
    'process-start',
    'process-reuse',
    'process-exit',
    'protocol-unmapped',
    'protocol-observation',
    'model-request',
    'model-confirmed',
    'permission-config',
  ];
  const view = deriveTrajectory({
    id: 'run-1',
    prompt: 'hi',
    projectPath: 'C:/project',
    kind: 'routine',
    status: 'completed',
    startedAt: '2026-10-20T00:00:00Z',
    endedAt: '2026-10-20T00:00:01Z',
    output: 'ok',
    route: {
      runtimeId: 'cursor',
      model: 'gpt-5.5',
      kind: 'routine',
      reasons: [],
      warnings: [],
    },
    events: statuses.map((kind) => ({
      at: '2026-10-20T00:00:00Z',
      type: 'status' as const,
      text: kind,
      data: { source: 'native', kind },
    })),
  });
  for (const row of view.rows) {
    const translated = translate(row.label) ?? row.label;
    assert.doesNotMatch(translated, /[㐀-鿿]/, `untranslated trajectory label: ${row.label} -> ${translated}`);
  }
  assert.equal(translate('Cursor CLI · 启动进程'), 'Cursor CLI · Process started');
  assert.equal(translate('原生 CLI · 复用进程'), 'Native CLI · Process reused');
  assert.equal(translate('原生 CLI · 启动执行器'), 'Native CLI · Start executor');
});

test('connector, GitHub, and MCP confirmation titles and denial messages translate to English', () => {
  const translate = createTranslator(english);
  assert.equal(translate(githubApprovalTitle), 'Confirm GitHub write');
  assert.equal(translate(githubApprovalDenied), 'User declined the GitHub write.');
  assert.equal(translate(githubApprovalExpired), 'No confirmation within 4.5 minutes; no GitHub write was performed.');
  assert.equal(translate(connectorDraftTitle), 'Create email drafts');
  assert.equal(translate(connectorEditTitle), 'Edit connector content');
  assert.equal(translate(connectorDraftNotice), "A draft will be created; the email won't be sent.");
  assert.equal(
    translate(connectorCalendarNotice),
    'When a calendar action includes attendees, the service may send invitation, update or cancellation notices.',
  );
  assert.equal(
    translate(connectorApprovalExpired),
    'No confirmation within 4.5 minutes; no connector write was performed.',
  );
  assert.equal(translate(connectorDraftDenied), 'User declined creating the email draft.');
  assert.equal(translate(connectorEditDenied), 'User declined editing connector content.');
  assert.equal(translate(connectorAuthChanged), 'Account authorization changed; confirm the action again.');
  assert.equal(
    translate(approvalPreviewTooLong),
    'The action is too long to display in full for confirmation. Shorten it and try again.',
  );
  assert.equal(translate(mcpApprovalDenied), 'User declined this MCP write.');
  assert.equal(translate(mcpPermissionsChanged), "Project or MCP permissions changed; this call wasn't run.");
  assert.equal(translate(bridgeEventReplyQuestion), "Reply to subtask's question");
  assert.equal(translate(bridgeEventAssignSubtask), 'Assign subtask');
  assert.equal(translate(bridgeEventAskCaller), 'Ask caller');
  assert.equal(translate(bridgeEventMessageSubtask), 'Message subtask');
  assert.equal(translate(bridgeStageVerifyRecyclePaths), 'Verify recycle paths and protected folders');
  const desc = connectorApprovalDescription(
    { alias: 'Work Mail', email: 'me@example.com' },
    'connector_mail_create_draft',
    'Create draft',
    'Subject: Hello',
  );
  assert.equal(
    translate(desc),
    "Account: Work Mail (me@example.com)\nA draft will be created; the email won't be sent.\nSubject: Hello",
  );
});

test('route reasons and planning strategy reasons translate to English with numbers, names, and times kept', () => {
  const translate = createTranslator(english);
  const samples = [
    [
      '为缓存留在原卡：续接本对话的原生会话，留在 Codex · 本机（上下文约 200k tokens，换卡要全部重读）',
      "Staying for the cache: continuing this chat's native session on Codex · Local (context about 200k tokens; switching would re-read all of it)",
    ],
    [
      'Codex · 本机：等上一步结算约 5 秒，为缓存留在原卡（上下文约 150k tokens）',
      'Codex · Local: waiting about 5s for the previous step to settle to stay on the same account for cache (context about 150k tokens)',
    ],
    [
      '赠金落后 $80，新任务换卡：这条后续消息不续接原会话，换到 OpenRouter，带上下文继续，换卡要重读约 120k tokens',
      "Credit grant is $80 behind pace, switching accounts for new work: this follow-up doesn't resume the native session and switches to OpenRouter with context (switching accounts re-reads about 120k tokens)",
    ],
    ['Codex A：连续 3 次技术失败，冷却到 14:30', 'Codex A: 3 technical failures in a row; cooling down until 14:30'],
    [
      '按次计费的 API 卡默认不参与自动选择，钉选后可用（这次未参与：通义千问 2、DeepSeek）',
      'Pay-per-use API cards are excluded from automatic selection; pin one to use it. (left out this time: Qwen 2, DeepSeek)',
    ],
    [
      'Codex · 本机 周额度超前（剩 80%，含 2 张重置卡，按进度应剩 50%），本轮换到同档进度正常的 Claude，带上下文继续，换卡要重读约 100k tokens',
      'Codex · Local Week usage limit is ahead of pace (80% left, including 2 reset cards; 50% expected by pace), so this turn switches to same-tier Claude on normal pace and continues with context (switching accounts re-reads about 100k tokens)',
    ],
    [
      'Codex A 有 1 张重置卡明天到期，按进度应优先用',
      'Codex A has 1 reset card expiring Tomorrow; prioritize this account to stay on pace',
    ],
    [
      '候选 1 不可用：Codex · 本机：连续 3 次技术失败，冷却到 14:30',
      'Candidate 1 unavailable: Codex · Local: 3 technical failures in a row; cooling down until 14:30',
    ],
    [
      '成员分配：Codex · 本机 剩 80%，约 5 小时后重置，快重置的额度多用，同时最多 4 个成员（加上这个共 2 个）',
      'Member allocation: Codex · Local 80% left, resets in about 5 h, used more since it resets soon, at most 4 members at once (2 including this one)',
    ],
    [
      'Codex · 本机：连续 3 次技术失败，冷却到 14:30\n- Claude：额度数据已过期，请刷新\n- 按次计费的 API 卡默认不参与自动选择，钉选后可用（这次未参与：通义千问 2、DeepSeek）',
      'Codex · Local: 3 technical failures in a row; cooling down until 14:30\n- Claude: Usage data is stale. Refresh\n- Pay-per-use API cards are excluded from automatic selection; pin one to use it. (left out this time: Qwen 2, DeepSeek)',
    ],
  ] as const;

  for (const [source, expected] of samples) {
    assert.equal(translate(source), expected);
  }

  for (const decision of [
    choosePlanningStrategy('find README.md'),
    choosePlanningStrategy('format src/index.ts'),
    choosePlanningStrategy('fix typo foo to bar in src/index.ts'),
    choosePlanningStrategy('rename variable oldName to newName in src/index.ts'),
    choosePlanningStrategy('rename src/a.ts to src/b.ts'),
    choosePlanningStrategy('refactor authentication and database migration'),
    choosePlanningStrategy('do A and then do B'),
    choosePlanningStrategy('update the layout', { nativeCli: true }),
    choosePlanningStrategy('update the layout', { selectedExecutor: true }),
  ]) {
    const translated = translate(decision.reason);
    assert.ok(translated, `missing translation for planning reason: ${decision.reason}`);
    assert.doesNotMatch(translated, /[㐀-鿿]/, `Chinese left in planning reason: ${decision.reason} -> ${translated}`);
  }
});

test('quoted pattern values remain as written even when they match a catalog key', () => {
  const translate = createTranslator({ 设置: 'Settings', '删除「{0}」？': 'Delete “{0}”?' });
  assert.equal(translate('删除「设置」？'), 'Delete “设置”?');
});

test('route reason substitutions stay as written', () => {
  const translate = createTranslator(english, new Set(['设置', '项目  设置']));
  assert.equal(
    translate('设置：连续 3 次技术失败，冷却到 14:30'),
    '设置: 3 technical failures in a row; cooling down until 14:30',
  );
  assert.equal(
    translate('项目  设置：连续 3 次技术失败，冷却到 14:30'),
    '项目  设置: 3 technical failures in a row; cooling down until 14:30',
  );
});

test('route waste reasons translate system fragments but preserve account labels', () => {
  const translate = createTranslator(english, new Set(['设置', '项目  设置']));
  assert.equal(
    translate('设置 周额度后天重置，还剩 60%，按平时用量会剩约 40% 用不掉，先用它'),
    "设置's Week usage limit resets The day after tomorrow with 60% left; at the usual pace about 40% would go unused, so use it first",
  );
  assert.equal(
    translate('设置 周额度约 2 小时后重置，还剩 60%，按平时用量会剩约 40% 用不掉，先用它'),
    "设置's Week usage limit resets In about 2 hours with 60% left; at the usual pace about 40% would go unused, so use it first",
  );
});

test('route reasons preserve known names in any substitution position', () => {
  const translate = createTranslator(english, new Set(['设置']));
  assert.equal(
    translate('续接本对话的原生会话，留在 设置；快浪费的额度留给新任务'),
    "Continue this chat's native session and stay with 设置; save unused capacity for new tasks",
  );
  assert.equal(
    translate('赠金落后 $80，新任务换卡：这条后续消息不续接原会话，换到 设置，带上下文继续'),
    'Credit behind by $80; new task, so switching: this follow-up leaves the earlier session and moves to 设置 with the context',
  );
  assert.equal(
    createTranslator(english, new Set<string>())('续接本对话的原生会话，留在 设置；快浪费的额度留给新任务'),
    "Continue this chat's native session and stay with Settings; save unused capacity for new tasks",
  );
});

test('exact singular labels win inside joined status lines', () => {
  const translate = createTranslator(english);
  assert.equal(translate('1 位成员 · 1 位在干活'), '1 member · 1 working');
  assert.equal(translate('1 天后重置 · 10/22 00:00'), 'Resets in 24 h 0 min · 10/22 00:00');
});

test('device status translates every segment while preserving names and their separators', () => {
  for (const keep of [undefined, new Set(['Mac-mini', '设置 · 本机'])]) {
    const translate = createTranslator(english, keep);
    assert.equal(
      translate('设备「Mac-mini」：正在处理 · Claude · 正在 Edit · 已 12 次工具调用 · 最近活动 10:32'),
      'Device “Mac-mini”: Working · Claude · Using Edit · 12 tool calls · Last activity 10:32',
    );
  }
  const translate = createTranslator(english, new Set(['设置 · 本机']));
  assert.equal(
    translate('设备「设置 · 本机」：正在处理 · 设置 · 本机 · 已 12 次工具调用'),
    'Device “设置 · 本机”: Working · 设置 · 本机 · 12 tool calls',
  );
});

test('extension instructions point to the shared destination', () => {
  const translate = createTranslator(english);
  const source = '先到“扩展 → 连接与服务 → 联网搜索”添加独立的 DeepSeek 搜索 Key 并启用。';
  assert.match(translate(source)!, /Extensions → Connections → Web search/);
  assert.ok(keys.includes(source));
  assert.ok(traditional[source as keyof typeof traditional]);
});
