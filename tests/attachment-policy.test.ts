import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canInheritHistoryImage,
  historyImageOmissionContext,
  requestsHistoryImage,
} from '../src/server/attachment-policy.ts';
import type { ExecutionPolicy, Provider } from '../src/shared/types.ts';
import { supportsImageInput } from '../src/shared/image-input.ts';

test('explicit native vision providers retain history and text-only providers skip it', () => {
  for (const executionPolicy of ['cli-first', 'cli-only'] satisfies ExecutionPolicy[]) {
    for (const provider of ['codex', 'claude'] satisfies Provider[])
      assert.equal(canInheritHistoryImage({ provider, executionPolicy }), true);
    for (const provider of ['grok', 'pi', 'dsh'] satisfies Provider[])
      assert.equal(canInheritHistoryImage({ provider, executionPolicy }), false);
  }
});

test('selected runtime capability takes precedence over automatic provider preferences', () => {
  assert.equal(canInheritHistoryImage({ runtimeId: 'grok-1', runtimeProvider: 'grok' }), false);
  assert.equal(canInheritHistoryImage({ runtimeId: 'codex-1', runtimeProvider: 'codex' }), true);
  assert.equal(canInheritHistoryImage({ runtimeProvider: 'claude' }), true);
  assert.equal(canInheritHistoryImage({ runtimeId: 'unknown-1' }), false);
  assert.equal(canInheritHistoryImage({ provider: 'codex', runtimeProvider: 'grok' }), false);
  assert.equal(canInheritHistoryImage({ provider: 'grok', runtimeProvider: 'codex' }), false);
  assert.equal(canInheritHistoryImage({ runtimeId: 'grok-1', runtimeProvider: 'grok', runtimeImageInput: true }), true);
  assert.equal(canInheritHistoryImage({ provider: 'grok', runtimeImageInput: true }), true);
  assert.equal(canInheritHistoryImage({ runtimeProvider: 'codex', runtimeImageInput: false }), false);
  assert.equal(canInheritHistoryImage({ provider: 'codex', runtimeProvider: 'grok', runtimeImageInput: true }), false);
  assert.equal(
    canInheritHistoryImage({ provider: 'grok', runtimeImageInput: true, excludeProviders: ['grok'] }),
    false,
  );
});

test('automatic routing keeps history only when an eligible vision provider remains', () => {
  assert.equal(canInheritHistoryImage({ executionPolicy: 'cli-first' }), true);
  assert.equal(canInheritHistoryImage({ visionProviders: ['grok', 'codex'] }), true);
  assert.equal(canInheritHistoryImage({ visionProviders: ['claude'] }), true);
  // An explicit list consists of channels the caller has verified, including supported Grok builds.
  assert.equal(canInheritHistoryImage({ visionProviders: ['grok'] }), true);
  assert.equal(canInheritHistoryImage({ visionProviders: [] }), false);
  assert.equal(canInheritHistoryImage({ excludeProviders: ['codex'] }), true);
  assert.equal(canInheritHistoryImage({ excludeProviders: ['codex', 'claude'] }), false);
  assert.equal(canInheritHistoryImage({ visionProviders: ['codex'], excludeProviders: ['codex'] }), false);
  assert.equal(canInheritHistoryImage({ provider: 'claude', excludeProviders: ['claude'] }), false);
});

test('image capability uses verified channel support and preserves explicit negative observations', () => {
  const capabilities = { execute: true, resume: true, cancel: true, approvals: true };
  const native = { environment: 'native' as const, capabilities };
  assert.equal(supportsImageInput(undefined), false);
  assert.equal(supportsImageInput({ ...native, provider: 'codex' }), true);
  assert.equal(supportsImageInput({ ...native, provider: 'claude' }), true);
  assert.equal(supportsImageInput({ ...native, provider: 'grok' }), false);
  assert.equal(supportsImageInput({ ...native, provider: 'cursor' }), false);
  assert.equal(
    supportsImageInput({ ...native, provider: 'grok', capabilities: { ...capabilities, imageInput: true } }),
    true,
  );
  assert.equal(
    supportsImageInput({ ...native, provider: 'claude', capabilities: { ...capabilities, imageInput: false } }),
    false,
  );
  assert.equal(supportsImageInput({ ...native, provider: 'codex', gateway: 'api' }), false);
  assert.equal(supportsImageInput({ ...native, provider: 'codex', environment: 'wsl' }), false);
});

test('API-only and gateway routes do not inherit unsupported image context', () => {
  assert.equal(canInheritHistoryImage({ executionPolicy: 'api-only' }), false);
  assert.equal(canInheritHistoryImage({ executionPolicy: 'api-only', visionProviders: ['codex', 'claude'] }), false);
  assert.equal(canInheritHistoryImage({ provider: 'codex', executionPolicy: 'api-only' }), false);
  assert.equal(canInheritHistoryImage({ gateway: 'magpie' }), false);
  assert.equal(canInheritHistoryImage({ runtimeProvider: 'claude', gateway: 'magpie' }), false);
});

test('history policy never receives or mutates the attachments explicitly supplied this turn', () => {
  // The caller resolves current attachments separately. A false inheritance
  // decision must not remove a newly supplied image to make Grok/API routing pass.
  const currentAttachments = Object.freeze([Object.freeze({ id: 'new-image', kind: 'image' })]);
  const policy = Object.freeze({ provider: 'grok' as const, excludeProviders: Object.freeze(['codex'] as const) });
  assert.equal(canInheritHistoryImage(policy), false);
  assert.deepEqual(currentAttachments, [{ id: 'new-image', kind: 'image' }]);
  assert.deepEqual(policy, { provider: 'grok', excludeProviders: ['codex'] });
});

test('omission context identifies saved history images and explicitly disclaims receiving pixels', () => {
  assert.equal(historyImageOmissionContext([]), '');
  const context = historyImageOmissionContext(['previous.png', 'previous.png', 'name "quoted".png']);
  assert.match(context, /像素未提供给本次执行器/);
  assert.match(context, /原件仍保留在对话历史附件中/);
  assert.match(context, /不要假装看过其图片内容/);
  assert.equal(context.match(/previous\.png/g)?.length, 1);
  assert.ok(context.includes(JSON.stringify('name "quoted".png')));
});

test('only an explicit image reference or a quoted image requests visual history for technical failover', () => {
  for (const intent of [
    '继续看这张图片',
    '再对比之前的截图',
    'Describe the same image again.',
    'Read the picture above.',
  ])
    assert.equal(requestsHistoryImage(intent, false), true, intent);
  for (const intent of [
    'Explain this unrelated text topic.',
    'What does image input support mean?',
    '图片工具怎么安装？',
  ])
    assert.equal(requestsHistoryImage(intent, false), false, intent);
  assert.equal(requestsHistoryImage('继续处理', true), true);
});
