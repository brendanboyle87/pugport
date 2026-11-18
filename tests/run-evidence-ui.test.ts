import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RunRecord } from '../src/shared/types.ts';
import { RunEvidence } from '../src/ui/RunEvidence.tsx';

const run = (patch: Partial<RunRecord> = {}): RunRecord => ({
  id: 'synthetic-run',
  prompt: 'Check source',
  projectPath: 'C:/synthetic-project',
  kind: 'routine',
  status: 'completed',
  startedAt: '2026-10-24T12:00:00Z',
  endedAt: '2026-10-24T12:00:01Z',
  output: 'Done',
  route: { runtimeId: 'synthetic', model: 'test', kind: 'routine', reasons: [], warnings: [] },
  events: [],
  ...patch,
});
const render = (record: RunRecord) => renderToStaticMarkup(createElement(RunEvidence, { run: record }));

test('a completed process or an old passing command is not displayed as version-bound verification', () => {
  assert.match(render(run()), /尚未验证/);
  const legacy = render(run({ verification: { command: 'check', status: 'passed', exitCode: 0, output: '' } }));
  assert.match(legacy, /文件版本尚未确认/);
  assert.doesNotMatch(legacy, /该检查已通过/);
  assert.doesNotMatch(legacy, /<details[^>]*\bopen(?:=|\s|>)/);
});

test('a host receipt shows the checked snapshot and reuse without claiming every feature was tested', () => {
  const html = render(
    run({
      taskOutcome: { status: 'completed', source: 'executor-report' },
      verification: {
        command: 'check',
        status: 'passed',
        exitCode: 0,
        output: '',
        receipt: {
          id: 'synthetic-receipt',
          source: 'host-verification',
          checkedAt: '2026-10-24T12:00:01Z',
          snapshot: '0123456789abcdef',
          revision: 'synthetic-revision',
          reused: true,
          stable: true,
          scope: {
            projectPath: 'C:/synthetic-project',
            environment: 'native',
            permissionMode: 'read-only',
            command: 'check',
          },
        },
      },
    }),
  );
  assert.match(html, /执行器报告已完成/);
  assert.match(html, /该检查已通过/);
  assert.match(html, /0123456789ab/);
  assert.match(html, /已复用相同文件版本/);
  assert.match(html, /不代表所有功能/);
});
