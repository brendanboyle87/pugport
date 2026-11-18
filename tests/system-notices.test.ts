import assert from 'node:assert/strict';
import test from 'node:test';
import type { ConversationMessage, RunRecord, Workflow } from '../src/shared/types.ts';
import { failureNotice, noticeMessage, stoppedPlanOutput, systemNoticeText } from '../src/shared/system-notices.ts';
import { createTranslator } from '../src/shared/i18n/index.ts';
import englishCatalog from '../src/shared/i18n/en.json' with { type: 'json' };
import traditionalCatalog from '../src/shared/i18n/zh-Hant.json' with { type: 'json' };
import { uiBundle, uiHarness } from './helpers/ui-harness.ts';

const task = { id: 'task', input: {}, runIds: ['run'], status: 'failed', error: 'Raw details' } as Workflow;
const run = { id: 'run', workflowId: task.id, error: task.error } as RunRecord;

test('every stopped verdict keeps its executor answer as a redacted body', () => {
  const owner = {
    ...task,
    status: 'blocked',
    activeStepId: 'step',
    plan: [
      { id: 'step', title: 'Work', runIds: ['run'] },
      { id: 'next', runIds: [] },
    ],
  } as Workflow;
  const answer = {
    ...run,
    stepId: 'step',
    status: 'failed',
    output: 'Partial result. token=synthetic-secret',
    taskOutcome: { status: 'partial', source: 'executor-report', summary: 'token=synthetic-secret' },
  } as RunRecord;
  for (const status of ['partial', 'blocked'] as const) {
    const record = { ...answer, taskOutcome: { ...answer.taskOutcome!, status } };
    assert.equal(stoppedPlanOutput(owner, [record]), 'Partial result. token=[redacted]');
    // The executor's own summary stays as the reason; only raw output is not repeated.
    assert.deepEqual(failureNotice(owner, [record]).stop, { step: 1, title: 'Work', reason: 'token=[redacted]' });
  }
  for (const patch of [
    { status: 'cancelled' },
    { status: 'running' },
    { errorCode: 'runtime-network-error' },
    { errorCode: 'runtime-task-unverified' },
    { verification: { status: 'failed' } },
    { taskOutcome: { status: 'unverified', source: 'file-receipts' } },
    { taskOutcome: { status: 'completed', source: 'executor-report' } },
    { taskOutcome: undefined },
  ])
    assert.equal(stoppedPlanOutput(owner, [{ ...answer, ...patch } as RunRecord]), 'Partial result. token=[redacted]');
  for (const patch of [{ stepId: 'next' }, { workflowId: 'foreign' }, { visualAssistant: true }, { output: '  ' }])
    assert.equal(stoppedPlanOutput(owner, [{ ...answer, ...patch } as RunRecord]), undefined);
  for (const status of ['cancelled', 'interrupted', 'failed', 'blocked'] as const)
    assert.equal(stoppedPlanOutput({ ...owner, status }, [answer]), 'Partial result. token=[redacted]');
  assert.equal(stoppedPlanOutput({ ...owner, activeStepId: 'next' }, [answer]), undefined);
  assert.doesNotMatch(failureNotice(owner, [{ ...answer, output: '' }]).stop?.reason ?? '', /synthetic-secret/);
});

test('quota copy names the CLI and uses only a supplied valid reset time', () => {
  const limited = {
    ...run,
    errorCode: 'quota-or-rate-limit',
    account: { id: 'synthetic', label: 'Private account', provider: 'grok' as const },
  };
  const translate = createTranslator(englishCatalog);
  assert.equal(
    translate(failureNotice(task, [limited]).text),
    'Grok hit its usage limit. PugPort will use another signed-in account if one is free.',
  );
  const resetsAt = new Date(2026, 9, 29, 15, 40).toISOString();
  for (const context of [{ resetsAt }, { availability: { retryAt: resetsAt } }]) {
    assert.equal(
      translate(failureNotice(task, [limited], context).text),
      'Grok hit its usage limit, resets at 3:40 PM. PugPort will use another signed-in account if one is free.',
    );
  }
  assert.equal(failureNotice(task, [limited], { resetsAt: 'invalid' }).text, failureNotice(task, [limited]).text);
  assert.doesNotMatch(failureNotice(task, [limited]).text, /Private account/);
});

test('protocol copy names the CLI and points to Connections', () => {
  const notice = failureNotice(task, [{ ...run, errorCode: 'runtime-protocol-incompatible' }], { provider: 'cursor' });
  assert.equal(
    createTranslator(englishCatalog)(notice.text),
    "Cursor's version doesn't work with this PugPort. Update the CLI in Connections, then retry.",
  );
});

test('moderation notices recognize only Pi finish reasons and Zhipu code 1301', () => {
  const english = createTranslator(englishCatalog);
  for (const errorDetail of [
    'Pi · zai: Provider finish_reason: content_filter',
    'Pi · zai-coding-cn: Provider finish_reason: sensitive',
    'Pi · Renamed platform: {"error":{"code":"1301","message":"rejected"}}',
  ]) {
    const notice = failureNotice(task, [{ ...run, apiProvider: 'zai-cn', errorDetail }]);
    assert.match(notice.text, /服务商的内容审核拦下了这次请求/);
    assert.match(english(notice.text)!, /content moderation blocked/);
  }
  for (const errorDetail of [
    'Pi · zai: sensitive text',
    'Pi · zai: safety policy',
    'Pi · zai: request 1301 failed',
    'Pi · zai: {"code":1301.5}',
    'Pi · zai: {"code":"1301-extra"}',
    'Pi · zai: {"other_code":1301}',
    'Codex: Provider finish_reason: content_filter',
    'Pi · zai: Provider finish_reason: content_filter_extra',
  ])
    assert.equal(failureNotice(task, [{ ...run, apiProvider: 'zai-cn', errorDetail }]).text, systemNoticeText.failed);
  for (const apiProvider of ['openai', undefined])
    assert.equal(
      failureNotice(task, [{ ...run, apiProvider, errorDetail: 'Pi · 智谱: {"code":1301}' }]).text,
      systemNoticeText.failed,
    );
});

test('system notices use the normal catalogs with valid source keys and matching locale placeholders', () => {
  const slots = (text: string) => (text.match(/\{\d+\}/g) ?? []).sort().join();
  for (const key of Object.values(systemNoticeText)) {
    const en = (englishCatalog as Record<string, string>)[key]!;
    assert.match(key, /[㐀-鿿]/);
    assert.doesNotMatch(en, /[㐀-鿿]/, key);
    const traditional = (traditionalCatalog as Record<string, string>)[key]!;
    assert.equal(typeof traditional, 'string', key);
    assert.equal(slots(en), slots(key), key);
    assert.equal(slots(traditional), slots(key), key);
  }
});

test('failure notices explain known app classifications while preserving raw details', () => {
  for (const [code, text] of [
    ['provider-retired', systemNoticeText.retired],
    ['runtime-network-error', systemNoticeText.network],
    ['runtime-timeout', systemNoticeText.timeout],
    ['runtime-permission-or-sandbox-error', systemNoticeText.permission],
    ['privacy-text-only', '这个免费来源可能记录内容，只能发纯文字；附件或写文件请换执行器'],
    ['runtime-task-unverified', systemNoticeText.unverified],
    ['runtime-task-incomplete', systemNoticeText.incomplete],
    ['runtime-verification-failed', systemNoticeText.verification],
    ['authentication-required', systemNoticeText.authentication],
    ['quota-or-rate-limit', systemNoticeText.quota.replace('{0}', 'CLI')],
    ['api-budget-exhausted', systemNoticeText.budget],
    ['api-budget-expired', systemNoticeText.expired],
    ['api-budget-usage-unknown', systemNoticeText.usage],
    ['unknown', systemNoticeText.failed],
  ]) {
    assert.deepEqual(failureNotice(task, [{ ...run, errorCode: code }]), { text, details: 'Raw details' });
  }
  assert.equal(
    failureNotice({ ...task, input: { ...task.input, readOnlyTrigger: '不要修改' } }, [
      { ...run, errorCode: 'runtime-permission-or-sandbox-error' },
    ]).text,
    systemNoticeText.readOnly,
  );
});

test('read-only context does not replace a known quota, login or connection failure cause', () => {
  const readOnlyTask = { ...task, input: { ...task.input, readOnlyTrigger: '不要修改' } };
  for (const [errorCode, text] of [
    ['quota-or-rate-limit', systemNoticeText.quota.replace('{0}', 'CLI')],
    ['authentication-required', systemNoticeText.authentication],
    ['runtime-network-error', systemNoticeText.network],
    ['runtime-timeout', systemNoticeText.timeout],
  ])
    assert.equal(failureNotice(readOnlyTask, [{ ...run, errorCode }]).text, text);
});

test('structured native permission, incomplete outcomes and failed verification explain locally known results', () => {
  const readOnlyTask = { ...task, input: { ...task.input, readOnlyTrigger: '只读' } };
  assert.equal(
    failureNotice(task, [{ ...run, events: [{ type: 'tool', at: '', data: { status: 'failed' } }] }]).text,
    systemNoticeText.tool,
  );
  assert.equal(
    failureNotice(readOnlyTask, [{ ...run, taskOutcome: { status: 'blocked', source: 'native-permission' } }]).text,
    systemNoticeText.readOnly,
  );
  assert.equal(
    failureNotice(readOnlyTask, [{ ...run, taskOutcome: { status: 'partial', source: 'executor-report' } }]).text,
    systemNoticeText.incomplete,
  );
  assert.equal(
    failureNotice(readOnlyTask, [{ ...run, taskOutcome: { status: 'unverified', source: 'missing-report' } }]).text,
    systemNoticeText.unverified,
  );
  assert.equal(
    failureNotice(readOnlyTask, [
      { ...run, verification: { status: 'failed', command: 'Synthetic check', exitCode: 1, output: '' } },
    ]).text,
    systemNoticeText.verification,
  );
});

test('legacy final system failures get a display notice with full original content while saved and model replies remain intact', () => {
  const legacy: ConversationMessage = {
    id: 'reply',
    conversationId: 'conversation',
    workflowId: task.id,
    role: 'assistant',
    content: 'Old system failure\n\nRaw details\nFull original message',
    createdAt: '2026-10-01T00:00:00Z',
    replyIdentity: { automatic: true, kind: 'system', runs: [] },
  };
  const owner = { ...task, conversationId: legacy.conversationId, finalMessageId: legacy.id };
  const normalized = noticeMessage(legacy, owner, [run]);
  assert.equal(normalized.systemNotice?.text, systemNoticeText.failed);
  assert.equal(normalized.systemNotice?.details, legacy.content);
  assert.equal(legacy.systemNotice, undefined);
  assert.equal(normalized.content, normalized.systemNotice?.text);
  assert.equal(legacy.content, 'Old system failure\n\nRaw details\nFull original message');
  for (const untouched of [
    { ...legacy, replyIdentity: { automatic: true, kind: 'model' as const, runs: [] } },
    { ...legacy, device: { id: 'device', name: 'Device' } },
    { ...legacy, id: 'not-final' },
  ])
    assert.equal(noticeMessage(untouched, owner, [run]), untouched);
  assert.equal(noticeMessage(legacy, { ...owner, conversationId: 'foreign' }, [run]), legacy);
});

test('cancellation, interruption and background waits are explained without claiming failure', () => {
  assert.equal(failureNotice({ ...task, status: 'cancelled' }, [run]).text, systemNoticeText.cancelled);
  assert.equal(failureNotice({ ...task, status: 'interrupted' }, [run]).text, systemNoticeText.interrupted);
  assert.equal(
    failureNotice({ ...task, waitingOn: { jobId: 'job' } } as Workflow, [run]).text,
    systemNoticeText.background,
  );
});

test('notice classification cannot pick foreign runs, auxiliary image runs or causes guessed from prose', () => {
  const unrelated = { ...run, workflowId: 'other', errorCode: 'quota-or-rate-limit' };
  assert.equal(failureNotice(task, [unrelated]).text, systemNoticeText.failed);
  assert.equal(
    failureNotice(task, [{ ...run, visualAssistant: true, errorCode: 'quota-or-rate-limit' }]).text,
    systemNoticeText.failed,
  );
  assert.equal(
    failureNotice({ ...task, error: 'The model says this was a quota problem.' }, [run]).text,
    systemNoticeText.failed,
  );
});

test('a blocked run keeps its summary in stop.reason and a failed run still has no stop', () => {
  const summary = 'synthetic blocked summary';
  const blocked = { ...task, status: 'blocked' as const };
  const kept = failureNotice(blocked, [
    {
      ...run,
      output: 'model text',
      taskOutcome: { status: 'blocked', source: 'file-receipts', summary },
    },
  ]);
  assert.equal(kept.text, systemNoticeText.incomplete);
  assert.equal(kept.stop?.reason, summary);
  assert.equal(
    failureNotice(task, [{ ...run, taskOutcome: { status: 'blocked', source: 'file-receipts', summary } }]).stop,
    undefined,
  );
  const fromOutput = failureNotice(blocked, [
    { ...run, output: 'last model paragraph', taskOutcome: { status: 'blocked', source: 'file-receipts' } },
  ]);
  assert.equal(fromOutput.stop?.reason, undefined);
  assert.equal(failureNotice(blocked, [{ ...run, output: 'last model paragraph' }]).stop?.reason, undefined);
  assert.equal(
    failureNotice(blocked, [
      {
        ...run,
        output: 'finished text',
        taskOutcome: { status: 'completed', source: 'file-receipts', summary: 'finished' },
      },
    ]).stop?.reason,
    undefined,
  );
  assert.equal(
    failureNotice(blocked, [
      {
        ...run,
        output: 'model text that must not replace the report',
        taskOutcome: { status: 'blocked', source: 'executor-report', summary: 'executor said this' },
      },
    ]).stop?.reason,
    'executor said this',
  );
});

test('all short system notices translate to English and Traditional Chinese through the existing translator', () => {
  const english = createTranslator(englishCatalog);
  const traditional = createTranslator(traditionalCatalog);
  for (const text of Object.values(systemNoticeText)) {
    assert.ok(english(text), text);
    assert.doesNotMatch(english(text)!, /[㐀-鿿]/);
    assert.ok(traditional(text), text);
  }
  assert.equal(english('按可写入重新执行'), 'Rerun with write access');
  assert.equal(english('Raw executor output'), undefined);
});

test('the UI language loader reads system notices from the normal English catalog', async () => {
  const harness = uiHarness(await uiBundle('src/ui/i18n.ts'), {
    localStorage: { getItem: () => 'en' },
    document: { documentElement: {}, body: { nodeType: 0 }, title: 'PugPort' },
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
    MutationObserver: class {
      observe() {}
    },
  });
  assert.equal(await harness.exports.startInterfaceLanguage(), 'en');
  assert.equal(
    harness.exports.translateInterfaceText(systemNoticeText.network),
    englishCatalog[systemNoticeText.network],
  );
  assert.equal(harness.exports.translateInterfaceText('设置'), 'Settings');
  assert.equal(harness.exports.translateInterfaceText('Raw executor output'), 'Raw executor output');
});

test('saved notice-only failures recover their own executor answer without replacing a saved body', () => {
  const owner = { ...task, conversationId: 'conversation', finalMessageId: 'message' };
  const message = {
    id: 'message',
    conversationId: owner.conversationId,
    workflowId: owner.id,
    role: 'assistant',
    content: systemNoticeText.unverified,
    systemNotice: { text: systemNoticeText.unverified },
  } as ConversationMessage;
  const record = { ...run, output: 'The executor answer.' };
  assert.equal(noticeMessage(message, owner, [record]).content, record.output);
  assert.equal(
    noticeMessage({ ...message, content: 'Already saved answer.' }, owner, [record]).content,
    'Already saved answer.',
  );
  assert.equal(noticeMessage({ ...message, workflowId: 'other' }, owner, [record]).content, message.content);
  assert.equal(message.content, systemNoticeText.unverified);
});
