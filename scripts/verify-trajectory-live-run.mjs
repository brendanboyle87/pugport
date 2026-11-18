import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { deriveTrajectory } from '../src/shared/trajectory.ts';
const id = '29a4ace9-4c1b-4aa6-86dc-eae09873b492';
const response = await fetch(`http://127.0.0.1:4317/api/runs/${id}`);
assert.equal(response.status, 200);
const run = await response.json();
const projection = deriveTrajectory(run);
const rows = projection.rows.filter((row) => row.lane === 'tools');
const observed = run.events.filter((event) => event.type === 'tool');
const stages = run.events.filter((event) => event.data?.kind === 'internal-step');
const toolObservations = rows.flatMap((row) => JSON.parse(row.detail).observations);
const stageObservations = rows.flatMap((row) =>
  (row.children ?? []).flatMap((child) => JSON.parse(child.detail).observations),
);
assert.equal(rows.length, 31);
assert.equal(observed.length, 84);
assert.equal(toolObservations.length, observed.length);
assert.equal(stages.length, 94);
assert.equal(stageObservations.length, stages.length);
assert.equal(projection.rows.filter((row) => row.stepId).length, 0);
assert.equal(rows.filter((row) => row.nativeToolId).length, 16);
assert.equal(rows.filter((row) => row.toolCallId).length, 15);
for (const event of observed)
  assert.ok(
    toolObservations.some((item) => item.sequence === event.seq),
    `Missing tool event ${event.seq}`,
  );
for (const event of stages)
  assert.ok(
    stageObservations.some((item) => item.sequence === event.seq),
    `Missing stage event ${event.seq}`,
  );
const terminal = rows.find((row) => row.label === 'run_terminal_command');
assert.ok(terminal?.argumentPreview);
assert.equal(terminal.status, 'completed');
assert.match(terminal.detail, /exitCode/);
const terminalOutput = JSON.parse(terminal.detail).native.output;
assert.equal(terminalOutput.outputEncoding, 'utf-8');
assert.equal(typeof terminalOutput.output, 'string');
assert.match(terminalOutput.output, /--- dirs ---/);
const receipt = {
  verifiedAt: new Date().toISOString(),
  runId: id,
  runStatus: run.status,
  primaryRows: projection.rows.length,
  nativeCalls: 16,
  applicationToolCalls: 15,
  preservedToolObservations: toolObservations.length,
  nestedStages: rows.reduce((sum, row) => sum + (row.children?.length ?? 0), 0),
  preservedStageObservations: stageObservations.length,
  orphanStages: 0,
  auditEventsMissing: run.auditEventsMissing,
  runEventsDropped: run.eventsDropped,
  nativeToolNames: [...new Set(rows.filter((row) => row.nativeToolId).map((row) => row.label))],
  terminalArgsAndObservedCompletionVisible: true,
  terminalByteOutputDecoded: true,
};
writeFileSync('reports/trajectory-real-run-verification.json', JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify(receipt));
