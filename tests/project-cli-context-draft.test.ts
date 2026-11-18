import assert from 'node:assert/strict';
import test from 'node:test';
import { queryDraft, queryFromDraft } from '../src/ui/project-cli-context-draft.ts';
import { ProjectCliContextService } from '../src/server/project-cli-context.ts';
import type { WorkspaceStore } from '../src/server/workspace-store.ts';
import type { ProjectSshQuery } from '../src/shared/project-cli-context.ts';

const job: ProjectSshQuery = {
  name: 'build',
  host: 'synthetic-host',
  argv: ['/srv/build', '{sha}', '{branch}', '{file}', '{mode}', '{count}'],
  params: { sha: 'sha', branch: 'branch', file: 'relpath', mode: 'word', count: 'int' },
  push: { repository: '~/project.git', refs: ['{sha}:refs/heads/job', '{branch}:refs/heads/check'] },
  cwd: '/srv/project',
  background: true,
  readOnly: true,
  timeoutSeconds: 14400,
};

test('query drafts preserve jobs and plain queries', () => {
  for (const query of [job, { name: 'status', host: 'synthetic-host', argv: ['pwd'] }]) {
    assert.deepEqual(queryFromDraft(queryDraft(query)), query);
  }
});

test('edited job fields survive the existing context save and reload', async () => {
  const records = new Map<string, unknown>([['project:p', { id: 'p', path: process.cwd() }]]);
  const store = {
    get: <T>(kind: string, id: string) => structuredClone(records.get(kind + ':' + id)) as T | undefined,
    save: (kind: string, id: string, _owner: string, value: unknown) => {
      records.set(kind + ':' + id, structuredClone(value));
    },
  } as Pick<WorkspaceStore, 'get' | 'save'>;
  const service = new ProjectCliContextService(store);
  const edited = queryDraft({ name: 'build', host: 'synthetic-host', argv: ['pwd'] });
  Object.assign(edited, {
    arguments: job.argv.join('\n'),
    parameters: 'sha=sha\nbranch=branch\nfile=relpath\nmode=word\ncount=int',
    repository: '~/project.git',
    refs: '{sha}:refs/heads/job\n{branch}:refs/heads/check',
    cwd: '/srv/project',
    background: true,
    readOnly: true,
    timeoutSeconds: 14400,
  });
  await service.update(
    'p',
    { revision: 0, autoMemoryDirectory: null, sshQueries: [queryFromDraft(edited)] },
    { source: 'user' },
  );
  assert.deepEqual(new ProjectCliContextService(store).get('p').sshQueries, [job]);
  assert.deepEqual(queryDraft(service.get('p').sshQueries[0]!), queryDraft(job));
});

test('draft validation keeps invalid and incomplete settings from becoming a save payload', () => {
  for (const parameters of [
    'sha=bogus',
    'sha=sha\nsha=branch',
    '-name=word',
    'just-a-name',
    Array.from({ length: 9 }, (_, i) => 'p' + i + '=word').join('\n'),
  ]) {
    assert.throws(() => queryFromDraft({ ...queryDraft(job), parameters }), /参数/);
  }
  for (const patch of [{ repository: '' }, { refs: '' }, { background: undefined }])
    assert.throws(() => queryFromDraft({ ...queryDraft(job), ...patch }), /推送/);
});

test('clearing optional fields removes them without retaining old job data', () => {
  const edited = {
    ...queryDraft(job),
    parameters: '',
    repository: '',
    refs: '',
    cwd: undefined,
    background: undefined,
    readOnly: undefined,
    timeoutSeconds: 30,
    arguments: 'pwd',
  };
  const saved = JSON.parse(JSON.stringify(queryFromDraft(edited)));
  assert.deepEqual(saved, { name: 'build', host: 'synthetic-host', argv: ['pwd'], timeoutSeconds: 30 });
});
