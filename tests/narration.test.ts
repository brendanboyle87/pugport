import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeNarration } from '../src/ui/narration.ts';
import type { PresentationItem } from '../src/shared/conversation-presentation.ts';
const n = (key: string, text?: string, runId = 'r'): PresentationItem => ({
  key,
  runId,
  kind: 'narration',
  text,
  preview: 'flattened preview',
});
test('stale detail, segmented narration and newer live text retain one complete body', () => {
  const body = '## Heading\n\n- first\n- second\n' + 'Long reply. '.repeat(40);
  const items = mergeNarration([n('a', body.slice(0, 15)), n('b', body.slice(15, 30))], [n('a', '##')], {
    runId: 'r',
    text: body,
  });
  assert.equal(items.map((i) => i.text).join(''), body);
  assert.equal(mergeNarration([n('a', 'short')], [n('a', body)])[0].text, body);
  const old = n('old', 'Old run', 'old');
  const fallback = mergeNarration([old, n('a')], [], { runId: 'r', text: body });
  assert.equal(fallback[0].text, 'Old run');
  assert.equal(fallback.filter((i) => i.runId === 'r').length, 1);
  assert.equal(fallback[1].text, body);
  assert.equal(mergeNarration([n('a', body)], [], { runId: 'r', text: 'short' })[0].text, body);
});
