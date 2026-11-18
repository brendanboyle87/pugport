import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  factCheckCorrections,
  factCheckMarker,
  factCheckPrompt,
  parseFactCheck,
  sourceUrls,
  usedWebInformation,
  webInformationEvent,
} from '../src/server/fact-check.ts';
import type { RunEvent, RunRecord } from '../src/shared/types.ts';

test('detects PugPort and native search/fetch tool records, never answer text or local search', () => {
  for (const data of [
    { tool: 'web_search' },
    { tool: 'web_fetch' },
    { kind: 'webSearch' },
    { tool: 'WebSearch' },
    { tool: 'WebFetch' },
    { tool: 'google_web_search' },
    { tool: 'mcp__pugport__web_search' },
    { tool: 'browse_page' },
    { tool: 'web.run' },
  ])
    assert.equal(webInformationEvent({ at: 'now', type: 'tool', data }), true, JSON.stringify(data));
  for (const event of [
    { at: 'now', type: 'text', text: 'Used web_search' },
    { at: 'now', type: 'tool', data: { tool: 'Bash', input: 'echo web_search' } },
    { at: 'now', type: 'tool', data: { tool: 'search_files' } },
  ] as RunEvent[])
    assert.equal(webInformationEvent(event), false);
  assert.equal(usedWebInformation([]), false);
  assert.equal(usedWebInformation([], true), true, '/search answer marker');
  assert.equal(
    usedWebInformation([{ webInformationUsed: true, events: [] } as unknown as RunRecord]),
    true,
    'retention preserves web use',
  );
});

test('checker receives only question, claims and cited URLs; fallback extracts at most twelve by consequence', () => {
  const prompt = factCheckPrompt(
    'Original question',
    'PRIVATE ANSWER explanation [source](https://example.org/primary).',
    [{ claim: 'Check this fact' }],
  );
  assert.ok(!prompt.includes('PRIVATE ANSWER'));
  assert.ok(prompt.includes('Original question'));
  assert.ok(prompt.includes('https://example.org/primary'));
  assert.match(prompt, /原问题语言和英文/);
  const fallback = factCheckPrompt('Question', 'Fact to extract.');
  assert.match(fallback, /最多 12 条，按错误后果/);
  assert.ok(fallback.includes('Fact to extract.'));
  const data = JSON.parse(
    factCheckPrompt(
      'Q',
      '',
      Array.from({ length: 20 }, (_, n) => ({ claim: `C${n}` })),
    )
      .split('输入数据：')[1]!
      .split('\n')[0]!,
  );
  assert.equal(data.claims.length, 12);
  assert.deepEqual(Object.keys(data), ['question', 'claims', 'sources']);
  assert.deepEqual(sourceUrls('[a](https://example.org/a) <https://example.org/a>'), ['https://example.org/a']);
});

test('parses sourced findings and sends only wrong facts back as visible corrections', () => {
  const report = parseFactCheck(
    `${factCheckMarker} ${JSON.stringify({
      claims: [
        { claim: 'A', status: 'verified', source: 'https://example.org/a' },
        { claim: 'B', status: 'unverifiable', reason: 'No primary evidence' },
        { claim: 'C', status: 'wrong', source: 'https://example.org/c', correction: 'Corrected C' },
      ],
    })}`,
  )!;
  assert.equal(report.status, 'completed');
  assert.deepEqual(
    report.claims.map((item) => item.status),
    ['verified', 'unverifiable', 'wrong'],
  );
  assert.equal(factCheckCorrections(report), 'C\n更正：Corrected C\n来源：https://example.org/c');
});

test('malformed, empty, unsourced and unsafe checker results never certify an answer', () => {
  for (const result of [
    'timeout',
    `${factCheckMarker} {`,
    `${factCheckMarker} {"claims":[]}`,
    ...[
      { claim: 'A', status: 'verified' },
      { claim: 'A', status: 'wrong', source: 'https://example.org' },
      { claim: 'A', status: 'verified', source: 'javascript:alert(1)' },
      { claim: 'A', status: 'pass', source: 'https://example.org' },
    ].map((claim) => `${factCheckMarker} ${JSON.stringify({ claims: [claim] })}`),
  ])
    assert.equal(parseFactCheck(result), undefined, result);
});
