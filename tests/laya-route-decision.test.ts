import assert from 'node:assert/strict';
import { test } from 'node:test';
import { layaRouteDecision } from '../src/shared/laya-route-decision.ts';
import type { LayaChoices } from '../src/shared/laya.ts';

const choices: LayaChoices = {
  task_type: 'conversation',
  difficulty: 'complex',
  web_search: 'no',
  input_modality: 'text',
  document_read: 'no',
  media_output: 'none',
  project_access: 'none',
  run_commands: 'no',
  browser_use: 'no',
  executor_intent: 'none',
};
test('Laya handling table has no category or tier policy and never plans a reply', () => {
  const reply = { handling: 'reply', writes: false, plan: false, web: false };
  const task = { handling: 'task', writes: false, plan: true, web: false };
  const rows: Array<[Partial<LayaChoices>, unknown]> = [
    [{}, reply],
    [{ project_access: 'write' }, { ...task, writes: true }],
    [{ run_commands: 'yes' }, task],
    [{ browser_use: 'yes' }, task],
    [{ media_output: 'image_create' }, task],
    [
      { task_type: 'research', web_search: 'yes', project_access: 'read' },
      { ...reply, web: true },
    ],
    [{ task_type: 'writing' }, reply],
    [{ task_type: 'translation' }, reply],
    [{ task_type: 'data_analysis' }, reply],
    // A coding or mixed question with nothing to write, run, browse or render is answered.
    [{ task_type: 'coding' }, reply],
    [{ task_type: 'mixed' }, reply],
    [
      { task_type: 'coding', project_access: 'write' },
      { ...task, writes: true },
    ],
    [{ task_type: 'automation' }, undefined],
    ...(['task_type', 'project_access', 'run_commands', 'browser_use', 'media_output'] as const).map(
      (field): [Partial<LayaChoices>, undefined] => [{ [field]: 'unclear' }, undefined],
    ),
    [
      { project_access: 'write', difficulty: 'simple' },
      { ...task, writes: true, plan: false },
    ],
  ];
  for (const [patch, expected] of rows)
    assert.deepEqual(layaRouteDecision({ ...choices, ...patch }), expected, JSON.stringify(patch));
});
