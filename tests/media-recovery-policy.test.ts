import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canRecoverMediaJob } from '../src/server/media-recovery-policy.ts';
import type { Conversation, Project, Workflow } from '../src/shared/types.ts';
import type { MediaAnalysisReport } from '../src/server/media-analysis.ts';

const conversation = { id: 'conversation', projectId: 'project' } as Conversation;
const project = { id: 'project', path: process.cwd() } as Project;
const report = { owner: { conversationId: conversation.id, projectPath: project.path } } as MediaAnalysisReport;
const workflow = (id: string, fields: Partial<Workflow> = {}) =>
  ({
    id,
    conversationId: conversation.id,
    projectId: project.id,
    status: 'blocked',
    ...fields,
  }) as Workflow;

test('same owned project can resume without creating an agent run', () => {
  assert.equal(
    canRecoverMediaJob(report, conversation, project, () => undefined),
    true,
  );
  assert.equal(
    canRecoverMediaJob({ ...report, owner: { ...report.owner!, workflowId: 'task' } }, conversation, project, (id) =>
      workflow(id),
    ),
    true,
  );
});
test('deleted, foreign, or moved conversation and missing owner never resume', () => {
  for (const value of [undefined, { ...conversation, deletedAt: 'now' }, { ...conversation, id: 'foreign' }])
    assert.equal(
      canRecoverMediaJob(report, value, project, () => undefined),
      false,
    );
  assert.equal(
    canRecoverMediaJob(report, conversation, { ...project, path: project.path + '/moved' }, () => undefined),
    false,
  );
  assert.equal(
    canRecoverMediaJob({ ...report, owner: null }, conversation, project, () => undefined),
    false,
  );
});
test('stopped ancestor, missing workflow, foreign owner, and cycles prevent recovery', () => {
  const owned = { ...report, owner: { ...report.owner!, workflowId: 'child' } };
  for (const status of ['cancelled', 'deleted', 'stopped', 'missing', 'foreign', 'cycle']) {
    assert.equal(
      canRecoverMediaJob(owned, conversation, project, (id) => {
        if (id === 'child')
          return workflow(id, { delegation: { parentId: 'parent', requestId: 'fixture', role: 'reviewer' } });
        if (status === 'missing') return undefined;
        return workflow(id, {
          ...(status === 'cancelled' ? { status: 'cancelled' } : {}),
          ...(status === 'deleted' ? { deletedAt: 'now' } : {}),
          ...(status === 'stopped' ? { stopped: true } : {}),
          ...(status === 'foreign' ? { conversationId: 'foreign' } : {}),
          ...(status === 'cycle'
            ? { delegation: { parentId: 'child', requestId: 'fixture', role: 'reviewer' as const } }
            : {}),
        });
      }),
      false,
      status,
    );
  }
});
