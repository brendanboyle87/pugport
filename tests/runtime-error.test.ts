import assert from 'node:assert/strict';
import { test } from 'node:test';
import { homedir } from 'node:os';
import { redactError, runtimeError } from '../src/server/adapters/process.ts';

test('structured errors keep their code and bounded useful detail without secrets, paths or request bodies', () => {
  const key = 'abcdef0123456789.SYNTHETIC_ZHIPU_SECRET';
  const raw = `HTTP 429 failed API key ${key}\nBearer opaque-token\nAuthorization: Custom opaque-auth\n${homedir()}/private C:\\private-data\\run /private/agent/log https://example.test/key\n\u001b[31mRetry later\u001b[0m`;
  const error = runtimeError(raw, { provider: 'Pi', secrets: [key], paths: ['C:/private-data', '/private/agent'] });
  assert.equal(error.message, redactError(raw));
  assert.match(error.detail!, /Retry later/);
  assert.doesNotMatch(
    error.detail!,
    /SYNTHETIC|opaque-token|opaque-auth|private-data|\/private\/agent|example.test|\u001b/,
  );
  assert.ok(!error.detail!.includes(homedir()));
  assert.doesNotMatch(
    runtimeError(JSON.stringify({ message: 'C:\\private-data\\log' }), { provider: 'Pi', paths: ['C:/private-data'] })
      .detail!,
    /private-data/,
  );
  assert.equal(runtimeError(error).detail, error.detail);
  assert.doesNotMatch(
    runtimeError('Authorization: [redacted] STILL_SECRET', { provider: 'Test' }).detail!,
    /STILL_SECRET/,
  );
  assert.equal(runtimeError(new Error(raw)).detail, undefined, 'Transport failures must not opt into raw diagnostics.');
  assert.ok(runtimeError('x'.repeat(1000), { provider: 'Test' }).detail!.length <= 500);
  assert.doesNotMatch(
    runtimeError('bad request prompt=PRIVATE file contents', { provider: 'Test' }).detail!,
    /PRIVATE|file contents/,
  );
  assert.doesNotMatch(
    runtimeError('{"message":"invalid","request":{"messages":[{"content":"PRIVATE"}]}}', { provider: 'Test' }).detail!,
    /PRIVATE/,
  );
});

test('echoed prompts are removed before path redaction, including JSON-escaped multi-line text', () => {
  const prompt = 'PRIVATE_PROMPT_SENTINEL\nRead C:\\private-data\\notes.txt';
  for (const raw of [`Rejected: ${prompt}`, JSON.stringify({ message: `Rejected: ${prompt}` })]) {
    const error = runtimeError(raw, { provider: 'Pi', prompt, paths: ['C:/private-data'] });
    assert.doesNotMatch(error.detail!, /PRIVATE_PROMPT_SENTINEL|notes\.txt/);
    assert.match(error.detail!, /Rejected/);
  }
});

test('provider validation messages retain request and content field explanations', () => {
  for (const message of [
    'Invalid request: Your request exceeded model token limit. Please reduce the length of your messages.',
    'messages.1.content: Input should be a valid string',
    'Invalid input: expected text; content: missing; messages: required',
  ])
    assert.equal(runtimeError(message, { provider: 'Test' }).detail, `Test: ${message}`);
});

test('only quoted request body keys and prompt= remove the remainder', () => {
  for (const key of ['prompt', 'messages', 'input', 'content', 'file_content']) {
    for (const value of ['"PRIVATE"', '["PRIVATE"]', '{"text":"PRIVATE"}']) {
      const error = runtimeError(`Invalid body: "${key}": ${value}`, { provider: 'Test' });
      assert.equal(error.detail, 'Test: Invalid body: [redacted request]');
    }
  }
});

test('short prompts do not corrupt diagnostic words; long prompts are still removed', () => {
  assert.equal(runtimeError('token limit', { provider: 'Test', prompt: 'ok' }).detail, 'Test: token limit');
  const prompt = '1234567890abcdef';
  assert.equal(
    runtimeError(`Rejected ${prompt}`, { provider: 'Test', prompt }).detail,
    'Test: Rejected [redacted prompt]',
  );
});
