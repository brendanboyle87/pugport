import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { diagnosticEvent, RunEventLedger } from '../src/ui/RunEventLedger.tsx';
import type { RunRecord } from '../src/shared/types.ts';
import { findNode, uiBundle, uiHarness } from './helpers/ui-harness.ts';

const record: RunRecord = {
  id: 'ledger',
  prompt: 'fixture',
  projectPath: 'C:/Fixture',
  kind: 'routine',
  status: 'completed',
  startedAt: '2026-10-08T12:00:00Z',
  output: 'complete',
  route: { runtimeId: 'pi', model: 'fixture', kind: 'routine', reasons: [], warnings: [] },
  auditVersion: 1,
  auditCapture: 'public-events',
  auditEventsMissing: 0,
  events: [],
};
test('source ledger shows real sequence and complete event inputs without native private envelopes', () => {
  const event = {
    seq: 141,
    at: record.startedAt,
    type: 'tool' as const,
    data: {
      tool: 'read_file',
      toolCallId: 'call',
      provider: 'pi',
      input: { path: 'file.txt', password: 'SECRET' },
      output: 'x'.repeat(100000) + 'FULL-RESULT-TAIL',
      raw: { system: 'PRIVATE-PACKET' },
      reasoning: 'PRIVATE-REASONING',
    },
  };
  const result = JSON.stringify(diagnosticEvent(event, 1));
  assert.match(result, /FULL-RESULT-TAIL/);
  assert.match(result, /141/);
  assert.doesNotMatch(result, /SECRET|PRIVATE-/);
  assert.equal(
    diagnosticEvent({ seq: 142, at: record.startedAt, type: 'text', text: 'CREDENTIAL_FRAGMENT' }, 2).textCharacters,
    19,
  );
  assert.doesNotMatch(
    JSON.stringify(diagnosticEvent({ seq: 142, at: record.startedAt, type: 'text', text: 'CREDENTIAL_FRAGMENT' }, 2)),
    /CREDENTIAL_FRAGMENT/,
  );
});
test('ledger pagination exposes every observation and reports archive gaps separately', async () => {
  const events = Array.from({ length: 103 }, (_, index) => ({
    seq: index + 1,
    at: record.startedAt,
    type: 'tool' as const,
    data: { tool: `tool-${index}` },
  }));
  const harness = uiHarness(await uiBundle('src/ui/RunEventLedger.tsx'));
  const props = { run: { ...record, events }, onLoadFullAudit() {} };
  let tree = harness.render('RunEventLedger', props);
  const load = findNode(tree, (node) => node.type === 'button' && node.props.children === '加载后续记录')!;
  assert.ok(load);
  load.props.onClick();
  tree = harness.render('RunEventLedger', props);
  assert.ok(findNode(tree, (node) => node.type === 'p' && node.props.children === 'tool-102'));
  assert.ok(!findNode(tree, (node) => node.type === 'button' && node.props.children === '加载后续记录'));
  const html = renderToStaticMarkup(
    createElement(RunEventLedger, { ...props, run: { ...props.run, auditEventsMissing: 7 } }),
  );
  assert.match(html, /7.*个序号缺口/);
  assert.match(html, /#1/);
  assert.doesNotMatch(html, /无序号缺口/);
});
