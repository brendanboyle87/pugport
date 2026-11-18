import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildLaneHandover, laneGithubFacts, writeLaneHandover } from '../src/server/lane-handover.ts';
import type { Conversation, RunRecord, Workflow } from '../src/shared/types.ts';

test('handover uses audit readback, bounded redacted text and a valid lane path', () => {
  const run = {
    events: [
      { data: { source: 'pugport', kind: 'github-write', op: 'open', phase: 'executed', number: 11 } },
      {
        data: {
          source: 'pugport',
          kind: 'github-write',
          op: 'open',
          phase: 'readback',
          number: 123,
          url: 'https://example.invalid/pr/123',
        },
      },
      { data: { source: 'pugport', kind: 'github-write', op: 'push', phase: 'readback', sha: 'abcdef012345' } },
    ],
    verification: { command: 'npm test', status: 'passed', exitCode: 0 },
    taskOutcome: { status: 'partial', summary: '还差 X' },
  } as unknown as RunRecord;
  const github = laneGithubFacts([run], []);
  assert.equal(github.pr?.number, 123);
  assert.equal(github.pushedSha, 'abcdef012345');
  const lane = { id: 'lane', title: 'Synthetic', lane: { branch: 'example' } } as Conversation;
  const workflow = { id: 'workflow', input: { content: 'Synthetic task' }, status: 'completed' } as Workflow;
  const text = buildLaneHandover({
    lane,
    workflow,
    runs: [run],
    measured: { at: '', startHead: '123456789', head: 'abcdef012', statusTotal: 2 },
    github,
    events: [],
    projectPath: '',
    now: 'now',
  });
  for (const expected of ['#123', '1234567', 'abcdef0', 'npm test', '还差 X', 'issue：无记录'])
    assert.ok(text.includes(expected), expected);
  assert.ok(Buffer.byteLength(text) <= 8192);
  const dir = mkdtempSync(join(tmpdir(), 'pugport-handover-'));
  const path = writeLaneHandover(dir, lane.id, text);
  assert.ok(path);
  assert.equal(readFileSync(path, 'utf8'), text);
  assert.equal(writeLaneHandover(dir, '../bad', text), undefined);
});
