import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import { SyncStore } from '../src/server/account-sync-store.ts';
import { SyncEngine } from '../src/server/account-sync.ts';
import { MemorySyncRemote, PostgrestSyncRemote } from '../src/server/account-sync-remote.ts';
import {
  createDataKey,
  encryptRecord,
  decryptRecord,
  messageProvenanceHash,
} from '../src/server/account-sync-crypto.ts';
import { projectSyncIdentity } from '../src/server/account-sync-project.ts';
import { filterSyncValue, syncSettingsKeys } from '../src/shared/account-sync.ts';
import { mapApiRouting } from '../src/shared/account-sync-routing.ts';

const config = { url: 'https://synthetic.invalid', publishableKey: 'sb_publishable_synthetic' };
const key = createDataKey();
const chat = (id = 'c') => ({
  id,
  projectId: 'p',
  title: 'Original',
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
});
const message = (id: string, content: string, createdAt = '2026-01-02') => ({
  id,
  conversationId: 'c',
  role: 'user',
  content,
  createdAt,
});
function device(t: TestContext, remote = new MemorySyncRemote(), id = 'a') {
  const dir = mkdtempSync(join(tmpdir(), 'pugport-sync-'));
  const db = new DatabaseSync(join(dir, 'studio.sqlite'));
  const workspace = new WorkspaceStore(db, { recoverInterrupted: false });
  const local = new SyncStore(workspace, dir);
  const engine = new SyncEngine({ local, remote, deviceId: id, config, sealKey: createDataKey() });
  t.after(() => {
    engine.stop();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, db, workspace, local, engine, remote };
}
async function enable(d: ReturnType<typeof device>) {
  await d.engine.enable({ userId: 'user', generation: d.remote.generation });
}
async function converge(...devices: ReturnType<typeof device>[]) {
  for (let i = 0; i < 4; i++) for (const d of devices) await d.engine.syncNow();
}

test('Mod workspaces and approval cards stay local across updates from both computers and older clients', async (t) => {
  const remote = new MemorySyncRemote();
  const a = device(t, remote, 'a'),
    b = device(t, remote, 'b');
  const local = (id: string) => ({
    modWorkspaceId: `workspace-${id}`,
    modApproval: { modeId: `mod-${id}`, version: '1.0.0', permissions: ['model:run'] },
  });
  for (const [d, id] of [
    [a, 'a'],
    [b, 'b'],
  ] as const)
    d.workspace.save('conversation', 'c', 'p', { ...chat(), workMode: 'mods-author', ...local(id) });
  await enable(a);
  await enable(b);
  await converge(a, b);
  for (const [d, id] of [
    [a, 'a'],
    [b, 'b'],
  ] as const) {
    const value = d.workspace.get<Record<string, unknown>>('conversation', 'c')!;
    assert.equal(value.modWorkspaceId, local(id).modWorkspaceId);
    assert.deepEqual(value.modApproval, local(id).modApproval);
    assert.equal(filterSyncValue('conversation', value).modWorkspaceId, undefined);
    assert.equal(filterSyncValue('conversation', value).modApproval, undefined);
    assert.equal(filterSyncValue('conversation', value).workMode, 'mods-author');
  }
  a.workspace.save('conversation', 'c', 'p', { ...a.workspace.get('conversation', 'c')!, title: 'From A' });
  await converge(a, b);
  assert.equal(b.workspace.get<Record<string, unknown>>('conversation', 'c')!.title, 'From A');
  b.workspace.save('conversation', 'c', 'p', { ...b.workspace.get('conversation', 'c')!, title: 'From B' });
  await converge(b, a);
  assert.equal(a.workspace.get<Record<string, unknown>>('conversation', 'c')!.title, 'From B');
  for (const [d, id] of [
    [a, 'a'],
    [b, 'b'],
  ] as const) {
    // Old clients can still upload local fields. They must neither replace local values nor create them.
    d.local.suppress(() =>
      d.local.apply('conversation', 'c', {
        owner: 'p',
        deleted: false,
        value: { ...chat(), ...local('foreign') },
      }),
    );
    const value = d.workspace.get<Record<string, unknown>>('conversation', 'c')!;
    assert.equal(value.modWorkspaceId, local(id).modWorkspaceId);
    assert.deepEqual(value.modApproval, local(id).modApproval);
    d.local.suppress(() =>
      d.local.apply('conversation', 'new', {
        owner: 'p',
        deleted: false,
        value: { ...chat('new'), ...local('foreign') },
      }),
    );
    const created = d.workspace.get<Record<string, unknown>>('conversation', 'new')!;
    assert.equal(created.modWorkspaceId, undefined);
    assert.equal(created.modApproval, undefined);
  }
});

test('Navigator API routing is mapped on upload and download without rewriting text', async (t) => {
  const d = device(t);
  await enable(d);
  d.db.exec('CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  d.db.prepare('INSERT INTO config(key,value) VALUES(?,?)').run('apiSyncIds', JSON.stringify({ local: 'remote' }));
  const source = { ...chat(), navigatorRoute: { runtimeId: 'local', model: 'local', effort: 'high' } };
  d.workspace.save('conversation', 'c', 'p', source);
  assert.deepEqual(d.local.pending().find((row) => row.id === 'c')!.value.navigatorRoute, {
    runtimeId: 'remote',
    model: 'local',
    effort: 'high',
  });
  const uploaded = mapApiRouting('conversation', source, (id) => (id === 'local' ? 'remote' : id));
  d.local.suppress(() => d.local.apply('conversation', 'c', { owner: 'p', value: uploaded, deleted: false }));
  assert.deepEqual(
    d.workspace.get<Record<string, unknown>>('conversation', 'c')!.navigatorRoute,
    source.navigatorRoute,
  );
});

test('local seal round trip binds kind and id as associated data', () => {
  const sealed = encryptRecord(key, 'server-node-local', 'server-node', { token: 'synthetic-token' });
  assert.deepEqual(decryptRecord(key, 'server-node-local', 'server-node', sealed), { token: 'synthetic-token' });
  assert.notDeepEqual(encryptRecord(key, 'message', 'm', {}), encryptRecord(key, 'message', 'm', {}));
  assert.doesNotMatch(JSON.stringify(sealed), /synthetic-token/);
  assert.throws(() => decryptRecord(key, 'api-provider-local', 'server-node', sealed), /AUTHENTICATION_FAILED/);
  assert.throws(() => decryptRecord(key, 'server-node-local', 'api-provider', sealed), /AUTHENTICATION_FAILED/);
  assert.throws(
    () => decryptRecord(createDataKey(), 'server-node-local', 'server-node', sealed),
    /AUTHENTICATION_FAILED/,
  );
  assert.throws(
    () =>
      decryptRecord(key, 'server-node-local', 'server-node', { ...sealed, tag: Buffer.alloc(16).toString('base64') }),
    /AUTHENTICATION_FAILED/,
  );
});

test('sync strings normalize NUL and lone surrogates recursively without mutating local content', async (t) => {
  const bad = 'tool\u0000output ' + '😀'.slice(0, 1) + '\uDC00' + '😀';
  // The adjacent high/low pair above is valid; also exercise isolated halves independently.
  const source = { title: '😀'.slice(0, 1), nested: [{ text: 'a\u0000b', low: '\uDC00', valid: '😀' }], bad };
  const normalized = filterSyncValue('conversation', source);
  assert.equal(normalized.title, '�');
  assert.deepEqual(normalized.nested, [{ text: 'a�b', low: '�', valid: '😀' }]);
  assert.equal(source.nested[0].text, 'a\u0000b');
  assert.deepEqual(filterSyncValue('settings', { globalInstructions: '\u0000\uD800', localOnly: 'x' }), {
    globalInstructions: '��',
  });
  assert.deepEqual(filterSyncValue('memory', { ['key\u0000']: '\uDC00' }), { 'key�': '�' });
  const d = device(t);
  d.workspace.save('conversation', 'c', '', { ...chat(), ...source });
  await enable(d);
  await d.engine.syncNow();
  assert.equal(d.engine.status, 'idle');
  assert.equal(d.local.pending().length, 0);
  assert.deepEqual(d.remote.records.get(JSON.stringify(['conversation', 'c']))!.body.value.nested, normalized.nested);
});

test('project and settings filters default unknown settings to local only', () => {
  assert.deepEqual(
    [...syncSettingsKeys],
    [
      'globalInstructions',
      'routePolicy',
      'routingRules',
      'routingProfiles',
      'routeGoal',
      'routePreferencesEnabled',
      'decisionMode',
      'composerSendKey',
      'appearanceTheme',
      'appearanceAccent',
      'locale',
      'steerOnSend',
      'notifyOnFinish',
      'notifySound',
      'showAutomaticReplyIdentity',
      'showAgentConversations',
      'agentPresets',
    ],
  );
  assert.deepEqual(
    filterSyncValue('settings', { globalInstructions: 'hello', brandNewSetting: true, toolApprovalMode: 'never' }),
    { globalInstructions: 'hello' },
  );
  assert.deepEqual(
    filterSyncValue('project', {
      id: 'p',
      name: 'P',
      path: 'private',
      trusted: true,
      approvedVerificationCommands: ['x'],
      localMemory: {},
      manuscript: {},
      mcpServers: ['x'],
      folderMissing: true,
    }),
    { id: 'p', name: 'P' },
  );
  assert.deepEqual(
    filterSyncValue('message', {
      attachments: [
        { id: 'a', name: 'image', mimeType: 'image/png', size: 3, kind: 'image', path: 'private', data: 'secret' },
      ],
      untrustedContent: true,
    }),
    {
      attachments: [{ id: 'a', name: 'image', mimeType: 'image/png', size: 3, kind: 'image' }],
      untrustedContent: true,
    },
  );
});

test('off creates no sync state, backup or remote traffic', async (t) => {
  const d = device(t);
  d.workspace.save('conversation', 'c', 'p', chat());
  await d.engine.syncNow();
  assert.equal(d.engine.status, 'off');
  assert.equal(d.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'sync_%'").get()!.n, 0);
  const disabled = new SyncEngine({
    local: d.local,
    remote: new MemorySyncRemote(),
    deviceId: 'x',
    config: { url: '', publishableKey: '' },
  });
  await disabled.enable({ userId: 'user', generation: 'synthetic-generation' });
  assert.equal(disabled.status, 'off');
  assert.equal(d.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'sync_%'").get()!.n, 0);
});

test('outbox migration, snapshot, exclusions, deletes and transactional echo suppression', async (t) => {
  const d = device(t);
  d.workspace.save('conversation', 'c', 'p', chat());
  d.workspace.save('conversation', 'secret', 'p', { ...chat('secret'), incognito: true });
  d.workspace.save('message', 'private', 'secret', message('private', 'secret'));
  d.workspace.save('message', 'import', 'c', { ...message('import', 'old'), importedFrom: { provider: 'claude' } });
  d.workspace.save('human-message', 'import', 'c', { id: 'import' });
  await enable(d);
  assert.deepEqual(
    d.local.pending().map((r) => r.id),
    ['c'],
  );
  await d.engine.syncNow();
  for (const kind of ['workflow', 'memory-auto', 'targets', 'attachment']) d.workspace.save(kind, kind, 'c', {});
  d.workspace.save('message', 'm', 'c', message('m', 'hello'));
  assert.deepEqual(
    d.local.pending().map((r) => r.id),
    ['m'],
  );
  d.local.suppress(() => d.workspace.save('message', 'remote', 'c', message('remote', 'remote')));
  assert.throws(() =>
    d.local.suppress(() => {
      d.workspace.save('message', 'rolled-back', 'c', {});
      throw Error('rollback');
    }),
  );
  assert.equal(d.workspace.get('message', 'rolled-back'), undefined);
  d.workspace.deleteRecord('message', 'm');
  assert.equal(d.local.pending()[0].deleted, true);
  d.engine.stop();
  d.workspace.save('message', 'off', 'c', message('off', 'off'));
  assert.equal(
    d.local.pending().some((r) => r.id === 'off'),
    false,
  );
});

test('first enable backs up before snapshot; union matches projects and chat scope', async (t) => {
  const remote = new MemorySyncRemote();
  const a = device(t, remote, 'a'),
    b = device(t, remote, 'b');
  for (const [d, prefix] of [
    [a, 'a'],
    [b, 'b'],
  ] as const) {
    const path = join(d.dir, 'repo');
    mkdirSync(join(path, '.git'), { recursive: true });
    writeFileSync(join(path, '.git', 'config'), '[remote "origin"]\n url = https://synthetic.invalid/repo.git\n');
    d.workspace.save('project', prefix, prefix, {
      id: prefix,
      name: 'Repo',
      gitRemote: 'https://synthetic.invalid/repo.git',
      path,
    });
    d.workspace.save('project', `${prefix}-chat`, `${prefix}-chat`, {
      id: `${prefix}-chat`,
      name: prefix,
      scope: 'chat',
    });
    d.workspace.save('conversation', prefix, prefix, { ...chat(prefix), projectId: prefix });
  }
  await enable(a);
  await a.engine.syncNow();
  await enable(b);
  assert.ok(existsSync(b.local.backupPath!));
  const backup = new DatabaseSync(b.local.backupPath!);
  assert.equal(backup.prepare("SELECT count(*) AS n FROM workspace_records WHERE kind='conversation'").get()!.n, 1);
  backup.close();
  await converge(a, b);
  for (const d of [a, b]) {
    assert.equal(d.workspace.list('conversation').length, 2);
    assert.equal(d.workspace.list('project').length, 2);
  }
});

test('two devices keep messages ordered, preserve provenance and merge fields with title history', async (t) => {
  const remote = new MemorySyncRemote();
  const a = device(t, remote, 'a'),
    b = device(t, remote, 'b');
  a.workspace.save('conversation', 'c', 'p', chat());
  await enable(a);
  await a.engine.syncNow();
  await enable(b);
  await converge(a, b);
  a.workspace.save('message', 'a', 'c', message('a', 'one', '2026-01-03'));
  a.workspace.save('human-message', 'a', 'c', { id: 'a' });
  b.workspace.save('message', 'b', 'c', { ...message('b', 'two', '2026-01-02'), untrustedContent: true });
  a.workspace.save('conversation', 'c', 'p', { ...chat(), title: 'A', pinned: true });
  b.workspace.save('conversation', 'c', 'p', { ...chat(), title: 'B', folderId: 'f' });
  await converge(a, b);
  for (const d of [a, b]) {
    assert.deepEqual(
      d.workspace
        .messages('c')
        .filter((m) => m.role === 'user')
        .map((m) => m.id),
      ['b', 'a'],
    );
    const c = d.workspace.get<Record<string, unknown>>('conversation', 'c')!;
    assert.equal(c.title, 'B');
    assert.equal(c.pinned, true);
    assert.equal(c.folderId, 'f');
    assert.ok(d.workspace.list('sync-title-history').length);
    assert.ok(d.workspace.get('human-message', 'a'));
    assert.equal(d.workspace.get('human-message', 'b'), undefined);
    assert.equal(d.workspace.get<Record<string, unknown>>('message', 'b')!.untrustedContent, true);
    assert.ok(d.workspace.messages('c').some((m) => m.systemNotice));
  }
});

test('concurrent delete restores for a new message; remote purge only recycles', async (t) => {
  const remote = new MemorySyncRemote();
  const a = device(t, remote, 'a'),
    b = device(t, remote, 'b');
  a.workspace.save('conversation', 'c', 'p', chat());
  await enable(a);
  await a.engine.syncNow();
  await enable(b);
  await converge(a, b);
  a.workspace.save('conversation', 'c', 'p', { ...chat(), deletedAt: '2026-01-02' });
  b.workspace.save('message', 'new', 'c', message('new', 'keep', '2026-01-03'));
  await converge(a, b);
  assert.equal(b.workspace.get<Record<string, unknown>>('conversation', 'c')!.deletedAt, undefined);
  assert.ok(b.workspace.messages('c').some((m) => m.systemNotice));
  a.workspace.deleteRecord('conversation', 'c');
  await converge(a, b);
  assert.ok(b.workspace.get<Record<string, unknown>>('conversation', 'c')!.deletedAt);
  assert.ok(b.workspace.get('message', 'new'));
});

test('same-name folders merge and references follow the canonical id', async (t) => {
  const remote = new MemorySyncRemote();
  const a = device(t, remote, 'a'),
    b = device(t, remote, 'b');
  a.workspace.save('conversation-folder', 'fa', '', { id: 'fa', name: 'Work', createdAt: '2026-01-01' });
  b.workspace.save('conversation-folder', 'fb', '', { id: 'fb', name: 'ＷＯＲＫ', createdAt: '2026-01-01' });
  b.workspace.save('conversation', 'c', 'p', { ...chat(), folderId: 'fb' });
  await enable(a);
  await a.engine.syncNow();
  await enable(b);
  await converge(a, b);
  for (const d of [a, b]) {
    assert.equal(d.workspace.list('conversation-folder').length, 1);
    assert.equal(d.workspace.get<Record<string, unknown>>('conversation', 'c')!.folderId, 'fa');
  }
});

test('offline and quota retain outbox; account switch needs explicit consent', async (t) => {
  const remote = new MemorySyncRemote(10);
  const d = device(t, remote);
  d.workspace.save('conversation', 'c', 'p', chat());
  await enable(d);
  await d.engine.syncNow();
  assert.equal(d.engine.status, 'error: QUOTA_EXCEEDED');
  assert.equal(d.local.pending().length, 1);
  remote.online = false;
  await d.engine.syncNow();
  assert.equal(d.engine.status, 'offline');
  assert.equal(d.local.pending().length, 1);
  d.engine.stop();
  await d.engine.enable({ userId: 'other', generation: remote.generation });
  assert.equal(d.engine.status, 'error: ACCOUNT_CHANGE_REQUIRES_CONSENT');
});

test('SQL has RLS on all tables, invoker push, no delete grants', () => {
  const sql = readFileSync(new URL('../supabase/migrations/0001_account_sync.sql', import.meta.url), 'utf8');
  for (const table of ['records', 'devices', 'user_keys'])
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`, 'i'));
  assert.doesNotMatch(sql, /grant\s+[^;]*\bdelete\b/i);
  assert.match(sql, /push_records[\s\S]*?security invoker/i);
  assert.match(sql, /revoke all[^;]*from anon, authenticated/i);
});

test('settings and project fields merge independently; local trust and paths survive pulls', async (t) => {
  const remote = new MemorySyncRemote(),
    a = device(t, remote, 'a'),
    b = device(t, remote, 'b');
  for (const d of [a, b])
    d.db.exec(
      `CREATE TABLE config(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO config VALUES('settings','{"notifySound":true,"notifyOnFinish":true,"globalInstructions":"base","sandboxDanger":true}');`,
    );
  a.workspace.save('project', 'p', 'p', { id: 'p', name: 'P', rules: ['old'], path: 'local-a', trusted: true });
  await enable(a);
  await a.engine.syncNow();
  await enable(b);
  await converge(a, b);
  b.workspace.save('project', 'p', 'p', {
    ...b.workspace.get<object>('project', 'p'),
    path: 'local-b',
    trusted: false,
  });
  a.db
    .prepare("UPDATE config SET value=? WHERE key='settings'")
    .run(JSON.stringify({ notifySound: false, notifyOnFinish: true, globalInstructions: 'A', sandboxDanger: true }));
  b.db.prepare("UPDATE config SET value=? WHERE key='settings'").run(
    JSON.stringify({
      notifySound: true,
      notifyOnFinish: false,
      globalInstructions: 'B',
      sandboxDanger: true,
      newKey: 'private',
    }),
  );
  a.workspace.save('project', 'p', 'p', { ...a.workspace.get<object>('project', 'p'), name: 'New' });
  b.workspace.save('project', 'p', 'p', { ...b.workspace.get<object>('project', 'p'), rules: ['new'] });
  await converge(a, b);
  for (const [d, path] of [
    [a, 'local-a'],
    [b, 'local-b'],
  ] as const) {
    assert.deepEqual(d.local.settings(), { notifySound: false, notifyOnFinish: false, globalInstructions: 'B' });
    const project = d.workspace.get<Record<string, unknown>>('project', 'p')!;
    assert.equal(project.path, path);
    assert.equal(project.name, 'New');
    assert.deepEqual(project.rules, ['new']);
  }
  assert.equal(
    JSON.parse(b.db.prepare("SELECT value FROM config WHERE key='settings'").get()!.value as string).newKey,
    'private',
  );
});

test('streaming assistant messages are held until the workflow settles', async (t) => {
  const remote = new MemorySyncRemote(),
    d = device(t, remote);
  d.workspace.save('conversation', 'c', 'p', chat());
  d.workspace.save('workflow', 'w', 'c', { id: 'w', status: 'running' });
  d.workspace.save('message', 'stream', 'c', { ...message('stream', 'partial'), role: 'assistant', workflowId: 'w' });
  await enable(d);
  await d.engine.syncNow();
  assert.equal(
    [...remote.records.values()].some((r) => r.id === 'stream'),
    false,
  );
  assert.equal(
    d.local.pending().some((r) => r.id === 'stream'),
    true,
  );
  d.workspace.save('workflow', 'w', 'c', { id: 'w', status: 'completed' });
  await d.engine.syncNow();
  assert.equal(
    [...remote.records.values()].some((r) => r.id === 'stream'),
    true,
  );
});

test('new edits during upload survive its acknowledgement and converge after retry', async (t) => {
  const remote = new MemorySyncRemote(),
    d = device(t, remote);
  d.workspace.save('conversation', 'c', 'p', chat());
  await enable(d);
  const push = remote.push.bind(remote);
  remote.push = async (generation, changes) => {
    const result = await push(generation, changes);
    d.workspace.save('conversation', 'c', 'p', { ...chat(), title: 'Edited during upload' });
    remote.push = push;
    return result;
  };
  await d.engine.syncNow();
  assert.equal(d.local.pending()[0].value.title, 'Edited during upload');
  await d.engine.syncNow();
  assert.equal(d.local.pending().length, 0);
  const cloud = [...remote.records.values()][0].body;
  assert.equal(cloud.value.title, 'Edited during upload');
});

test('a malformed pull page is rejected before any row or cursor is applied', async (t) => {
  const remote = new MemorySyncRemote(),
    a = device(t, remote, 'a'),
    b = device(t, remote, 'b');
  a.workspace.save('conversation', 'c', 'p', chat());
  a.workspace.save('message', 'm', 'c', message('m', 'safe'));
  await enable(a);
  await a.engine.syncNow();
  const malformed = [...remote.records.values()].find((r) => r.id === 'm')!;
  malformed.body.deleted = true;
  await enable(b);
  await b.engine.syncNow();
  assert.equal(b.engine.status, 'error: INVALID_RECORD');
  assert.equal(b.local.cursor, 0);
  assert.equal(b.workspace.get('conversation', 'c'), undefined);
  assert.equal(b.workspace.get('message', 'm'), undefined);
});

test('message ID collisions keep both versions without inventing human provenance', async (t) => {
  const remote = new MemorySyncRemote(),
    a = device(t, remote, 'a'),
    b = device(t, remote, 'b');
  a.workspace.save('conversation', 'c', 'p', chat());
  await enable(a);
  await a.engine.syncNow();
  await enable(b);
  await converge(a, b);
  a.workspace.save('message', 'collision', 'c', message('collision', 'A'));
  b.workspace.save('message', 'collision', 'c', message('collision', 'B'));
  await converge(a, b);
  for (const d of [a, b]) {
    assert.deepEqual(
      d.workspace
        .messages('c')
        .filter((m) => !m.systemNotice)
        .map((m) => m.content)
        .sort(),
      ['A', 'B'],
    );
    assert.equal(d.workspace.list('human-message').length, 0);
  }
});

test('older messages do not restore a recycled conversation', async (t) => {
  const remote = new MemorySyncRemote(),
    a = device(t, remote, 'a'),
    b = device(t, remote, 'b');
  a.workspace.save('conversation', 'c', 'p', chat());
  a.workspace.save('message', 'old', 'c', message('old', 'old', '2026-01-01'));
  await enable(a);
  await a.engine.syncNow();
  await enable(b);
  await converge(a, b);
  a.workspace.save('conversation', 'c', 'p', { ...chat(), deletedAt: '2026-01-03' });
  b.workspace.save('message', 'old', 'c', message('old', 'edited old message', '2026-01-01'));
  await converge(a, b);
  assert.equal(b.workspace.get<Record<string, unknown>>('conversation', 'c')!.deletedAt, '2026-01-03');
});

test('same project name without a matching nonempty git remote remains separate', async (t) => {
  const remote = new MemorySyncRemote(),
    a = device(t, remote, 'a'),
    b = device(t, remote, 'b');
  a.workspace.save('project', 'pa', 'pa', { id: 'pa', name: 'Same' });
  b.workspace.save('project', 'pb', 'pb', { id: 'pb', name: 'Same' });
  await enable(a);
  await a.engine.syncNow();
  await enable(b);
  await converge(a, b);
  for (const d of [a, b]) assert.equal(d.workspace.list('project').length, 2);
});

test('sign-out preserves queue; re-enable catches local changes and deletions', async (t) => {
  const remote = new MemorySyncRemote(),
    d = device(t, remote);
  d.workspace.save('conversation', 'c', 'p', chat());
  await enable(d);
  await d.engine.syncNow();
  const backup = d.local.backupPath;
  d.engine.stop();
  d.workspace.deleteRecord('conversation', 'c');
  assert.equal(d.local.pending().length, 0);
  await enable(d);
  assert.equal(d.local.backupPath, backup);
  assert.equal(d.local.pending()[0].deleted, true);
  await d.engine.syncNow();
  assert.equal([...remote.records.values()][0].deleted, true);
});

test('device registration exposes names only and never runs when off', async (t) => {
  const remote = new MemorySyncRemote(),
    d = device(t, remote);
  const metadata = {
    name: 'Synthetic PC',
    platform: 'win32',
    cli_providers: ['codex', 'claude', 'codex', 'C:\\private', 'token=value'],
  };
  await d.engine.upsertDevice(metadata);
  assert.equal(remote.devices.size, 0);
  await enable(d);
  await d.engine.upsertDevice(metadata);
  assert.deepEqual(remote.devices.get('a'), {
    id: 'a',
    name: 'Synthetic PC',
    platform: 'win32',
    cli_providers: ['claude', 'codex'],
  });
});

test('REST transport gets the current access token per request, never refreshes or follows redirects', async () => {
  const first = `header.${Buffer.from(JSON.stringify({ sub: 'user', nonce: 1 })).toString('base64url')}.signature`;
  const second = `header.${Buffer.from(JSON.stringify({ sub: 'user', nonce: 2 })).toString('base64url')}.signature`;
  let token = first;
  const calls: { url: string; init: RequestInit }[] = [];
  const request: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init! });
    return new Response('[]');
  };
  const remote = new PostgrestSyncRemote(config, 'user', () => token, request);
  await remote.pull(2);
  token = second;
  await remote.pull(3);
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, `Bearer ${first}`);
  assert.equal((calls[1].init.headers as Record<string, string>).Authorization, `Bearer ${second}`);
  assert.equal(calls[0].init.redirect, 'error');
  assert.match(calls[0].url, /\/rest\/v1\/rpc\/pull_sync_records$/);
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { after_seq: 2, max_rows: 200 });
  token = '';
  await assert.rejects(remote.pull(4), /SIGNED_OUT/);
  assert.equal(calls.length, 2);
});

test('transport rejects a token handed off for another account before sending data', async () => {
  let sent = 0;
  const request: typeof fetch = async () => {
    sent++;
    return new Response('[]');
  };
  const remote = new PostgrestSyncRemote(
    config,
    'A',
    async () => `h.${Buffer.from('{"sub":"B"}').toString('base64url')}.s`,
    request,
  );
  await assert.rejects(remote.pull(0), /ACCOUNT_MISMATCH/);
  assert.equal(sent, 0);
});

test('an oversized outbox record does not prevent downloading other-device changes', async (t) => {
  const remote = new MemorySyncRemote(),
    a = device(t, remote, 'a'),
    b = device(t, remote, 'b');
  a.workspace.save('conversation', 'c', 'p', chat());
  await enable(a);
  await a.engine.syncNow();
  await enable(b);
  await converge(a, b);
  a.workspace.save('message', 'large', 'c', message('large', 'x'.repeat(600000)));
  b.workspace.save('conversation', 'c', 'p', { ...chat(), title: 'Remote change' });
  await b.engine.syncNow();
  await a.engine.syncNow();
  assert.equal(a.engine.status, 'error: RECORD_TOO_LARGE');
  assert.equal(a.workspace.get<{ title: string }>('conversation', 'c')!.title, 'Remote change');
  assert.ok(a.local.pending().some((p) => p.id === 'large'));
});

test('privacy and imported-history changes while signed out invalidate an old queue', async (t) => {
  const remote = new MemorySyncRemote(),
    d = device(t, remote);
  d.workspace.save('conversation', 'c', 'p', chat());
  d.workspace.save('conversation', 'public', 'p', chat('public'));
  d.workspace.save('message', 'm', 'c', message('m', 'private'));
  d.workspace.save('message', 'import', 'public', { ...message('import', 'import'), conversationId: 'public' });
  d.workspace.save('human-message', 'import', 'public', { id: 'import' });
  await enable(d);
  d.engine.stop();
  d.workspace.save('conversation', 'c', 'p', { ...chat(), incognito: true });
  d.workspace.save('message', 'import', 'public', {
    ...message('import', 'import'),
    conversationId: 'public',
    importedFrom: { provider: 'claude' },
  });
  await enable(d);
  await d.engine.syncNow();
  assert.deepEqual(
    [...remote.records.values()].map((r) => r.id),
    ['public'],
  );
});

test('real project records derive matching identity from local git config without executing it', async (t) => {
  const remote = new MemorySyncRemote(),
    a = device(t, remote, 'a'),
    b = device(t, remote, 'b');
  for (const [d, id] of [
    [a, 'pa'],
    [b, 'pb'],
  ] as const) {
    const path = join(d.dir, 'repo');
    mkdirSync(join(path, '.git'), { recursive: true });
    writeFileSync(join(path, '.git', 'config'), '[remote "origin"]\n url = https://synthetic.invalid/repo.git\n');
    d.workspace.save('project', id, id, { id, name: 'Repo', path });
  }
  await enable(a);
  await a.engine.syncNow();
  await enable(b);
  await converge(a, b);
  for (const d of [a, b]) assert.equal(d.workspace.list('project').length, 1);
});

test('remote metadata preserves receiving-device lane paths and never exports them', async (t) => {
  const remote = new MemorySyncRemote(),
    a = device(t, remote, 'a'),
    b = device(t, remote, 'b');
  a.workspace.save('conversation', 'c', 'p', {
    ...chat(),
    lane: {
      parentConversationId: 'parent',
      sourceWorkflowId: 'w',
      workspaceId: 'private-a',
      base: 'C:/private',
      baseCommit: 'sha-a',
      branch: 'local-a',
      files: ['local-file'],
    },
  });
  await enable(a);
  await a.engine.syncNow();
  await enable(b);
  await converge(a, b);
  b.workspace.save('conversation', 'c', 'p', {
    ...b.workspace.get<object>('conversation', 'c'),
    lane: {
      parentConversationId: 'parent',
      sourceWorkflowId: 'w',
      workspaceId: 'private-b',
      base: 'D:/private',
      baseCommit: 'sha-b',
      branch: 'local-b',
      files: ['b-file'],
    },
  });
  a.workspace.save('conversation', 'c', 'p', { ...a.workspace.get<object>('conversation', 'c'), title: 'Changed' });
  await converge(a, b);
  const lane = b.workspace.get<{ lane: Record<string, unknown> }>('conversation', 'c')!.lane;
  assert.equal(lane.branch, 'local-b');
  assert.equal(lane.base, 'D:/private');
  const cloud = [...remote.records.values()].find((r) => r.kind === 'conversation')!.body;
  assert.deepEqual(Object.keys(cloud.value.lane as Record<string, unknown>).sort(), [
    'parentConversationId',
    'sourceWorkflowId',
  ]);
});

test('retained purge data is not resurrected by sign-out and re-enable', async (t) => {
  const remote = new MemorySyncRemote(),
    a = device(t, remote, 'a'),
    b = device(t, remote, 'b');
  a.workspace.save('conversation', 'c', 'p', chat());
  a.workspace.save('message', 'm', 'c', message('m', 'retained'));
  await enable(a);
  await a.engine.syncNow();
  await enable(b);
  await converge(a, b);
  a.workspace.deleteRecord('message', 'm');
  a.workspace.deleteRecord('conversation', 'c');
  await converge(a, b);
  b.engine.stop();
  await enable(b);
  await b.engine.syncNow();
  assert.ok(b.workspace.get('message', 'm'));
  assert.ok(b.workspace.get('conversation', 'c'));
  assert.ok([...remote.records.values()].every((r) => r.deleted));
  assert.equal(b.local.pending().length, 0);
});

test('a local human marker cannot bless a different cloud body with the same ID', async (t) => {
  const remote = new MemorySyncRemote(),
    a = device(t, remote, 'a'),
    b = device(t, remote, 'b');
  a.workspace.save('conversation', 'c', 'p', chat());
  await enable(a);
  await a.engine.syncNow();
  await enable(b);
  await converge(a, b);
  a.workspace.save('message', 'same', 'c', message('same', 'external A'));
  b.workspace.save('message', 'same', 'c', message('same', 'typed B'));
  b.workspace.save('human-message', 'same', 'c', { id: 'same' });
  await converge(a, b);
  for (const d of [a, b]) {
    const messages = d.workspace.messages('c').filter((m) => !m.systemNotice);
    const external = messages.find((m) => m.content === 'external A')!,
      typed = messages.find((m) => m.content === 'typed B')!;
    assert.equal(d.workspace.get('human-message', external.id), undefined);
    assert.ok(d.workspace.get('human-message', typed.id));
  }
});

test('ordinary first download and sequential messages do not create conflict notices', async (t) => {
  const remote = new MemorySyncRemote(),
    a = device(t, remote, 'a'),
    b = device(t, remote, 'b');
  a.workspace.save('conversation', 'c', 'p', chat());
  a.workspace.save('message', 'one', 'c', message('one', 'one'));
  a.workspace.save('message', 'two', 'c', message('two', 'two'));
  await enable(a);
  await a.engine.syncNow();
  await enable(b);
  await converge(a, b);
  assert.equal(
    b.workspace.messages('c').some((m) => m.systemNotice),
    false,
  );
  b.workspace.save('message', 'three', 'c', message('three', 'three'));
  await converge(b, a);
  for (const d of [a, b])
    assert.equal(
      d.workspace.messages('c').some((m) => m.systemNotice),
      false,
    );
});

test('mutable execution metadata does not remove genuine human provenance', async (t) => {
  const remote = new MemorySyncRemote(),
    a = device(t, remote, 'a'),
    b = device(t, remote, 'b');
  a.workspace.save('conversation', 'c', 'p', chat());
  a.workspace.save('message', 'm', 'c', message('m', 'typed'));
  a.workspace.save('human-message', 'm', 'c', { id: 'm' });
  await enable(a);
  await a.engine.syncNow();
  await enable(b);
  await converge(a, b);
  a.workspace.save('message', 'm', 'c', {
    ...message('m', 'typed'),
    workflowId: 'w',
    steering: { runId: 'r', status: 'accepted' },
  });
  await converge(a, b);
  assert.ok(b.workspace.get('human-message', 'm'));
});

test('deleting an imported message before its marker never queues the orphan marker', async (t) => {
  const d = device(t);
  d.workspace.save('conversation', 'c', 'p', chat());
  await enable(d);
  await d.engine.syncNow();
  d.workspace.save('message', 'imported', 'c', {
    ...message('imported', 'private history'),
    importedFrom: { provider: 'claude' },
  });
  d.workspace.save('human-message', 'imported', 'c', { id: 'imported' });
  d.workspace.deleteRecord('message', 'imported');
  d.workspace.deleteRecord('human-message', 'imported');
  assert.equal(d.local.pending().length, 0);
});

test('engine needs a cloud generation only after the account/configuration gate', async (t) => {
  const d = device(t),
    remote = new MemorySyncRemote();
  let accountCalls = 0;
  const account = remote.account.bind(remote);
  remote.account = async () => {
    accountCalls++;
    return account();
  };
  const off = new SyncEngine({
    local: d.local,
    remote,
    deviceId: 'off',
    config: { url: '', publishableKey: '' },
    sealKey: createDataKey(),
  });
  await off.enable({ userId: 'user', generation: '' });
  assert.equal(off.status, 'off');
  assert.equal(d.local.exists(), false);
  const active = new SyncEngine({ local: d.local, remote, deviceId: 'active', config, sealKey: createDataKey() });
  await active.enable({ userId: 'user', generation: '' });
  assert.equal(active.status, 'error: GENERATION_REQUIRED');
  assert.equal(d.local.exists(), false);
  await active.enable({ userId: 'user', generation: remote.generation });
  assert.equal(active.status, 'idle');
  assert.equal(accountCalls, 0, 'the account service, not the engine, asks the cloud for its generation');
  active.stop();
});

test('background scheduling debounces edits for three seconds and retries exponentially', async (t) => {
  const remote = new MemorySyncRemote(),
    d = device(t, remote);
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.now() });
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  let pulls = 0;
  const pull = remote.pull.bind(remote);
  remote.pull = async (...args) => {
    pulls++;
    return pull(...args);
  };
  await enable(d);
  t.mock.timers.tick(250);
  await settle();
  d.workspace.save('conversation', 'c', 'p', chat());
  t.mock.timers.tick(250);
  await settle();
  t.mock.timers.tick(2500);
  await settle();
  assert.equal(remote.records.size, 0);
  d.workspace.save('conversation', 'c', 'p', { ...chat(), title: 'Last edit' });
  t.mock.timers.tick(250);
  await settle();
  t.mock.timers.tick(2750);
  await settle();
  assert.equal(remote.records.size, 0);
  t.mock.timers.tick(250);
  await settle();
  assert.equal(remote.records.size, 1);
  remote.online = false;
  await d.engine.syncNow();
  const failed = pulls;
  t.mock.timers.tick(750);
  await settle();
  assert.equal(pulls, failed);
  t.mock.timers.tick(250);
  await settle();
  assert.equal(pulls, failed + 1);
  t.mock.timers.tick(1750);
  await settle();
  assert.equal(pulls, failed + 1);
  t.mock.timers.tick(250);
  await settle();
  assert.equal(pulls, failed + 2);
  remote.online = true;
  t.mock.timers.tick(4000);
  await settle();
  assert.equal(d.engine.status, 'idle');
  d.engine.stop();
});

test('a staged authenticated human marker survives re-enable until its message arrives', async (t) => {
  const remote = new MemorySyncRemote(),
    d = device(t, remote);
  const value = message('late', 'typed on another device');
  await remote.push(remote.generation, [
    {
      kind: 'conversation',
      id: 'c',
      last_seq: 0,
      deleted: false,
      device_id: 'other',
      body: { owner: 'p', value: chat(), deleted: false },
    },
    {
      kind: 'human-message',
      id: 'late',
      last_seq: 0,
      deleted: false,
      device_id: 'other',
      body: {
        owner: 'c',
        value: { id: 'late', messageHash: messageProvenanceHash('c', value) },
        deleted: false,
      },
    },
  ]);
  await enable(d);
  await d.engine.syncNow();
  assert.equal(d.workspace.get('human-message', 'late'), undefined);
  d.engine.stop();
  await enable(d);
  assert.equal(
    d.local.pending().some((p) => p.kind === 'human-message'),
    false,
  );
  await remote.push(remote.generation, [
    {
      kind: 'message',
      id: 'late',
      last_seq: 0,
      deleted: false,
      device_id: 'other',
      body: { owner: 'c', value, deleted: false },
    },
  ]);
  await d.engine.syncNow();
  assert.ok(d.workspace.get('human-message', 'late'));
});

test('confirmed cloud deletion retains local records and resets the next snapshot', async (t) => {
  const remote = new MemorySyncRemote(),
    d = device(t, remote);
  d.workspace.save('conversation', 'c', 'p', chat());
  await enable(d);
  await d.engine.syncNow();
  assert.equal(await d.engine.deleteCloudData(), true);
  assert.equal(d.engine.status, 'off');
  assert.equal(remote.records.size, 0);
  assert.ok(d.workspace.get('conversation', 'c'));
  await enable(d);
  assert.equal(d.local.cursor, 0);
  assert.equal(d.local.pending().length, 1);
  await d.engine.syncNow();
  assert.equal(remote.records.size, 1);
  assert.equal(d.engine.status, 'idle');
});

test('cloud deletion retains account lineage and blocks re-enable while deletion is pending', async (t) => {
  const remote = new MemorySyncRemote(),
    d = device(t, remote);
  d.workspace.save('conversation', 'c', 'p', chat());
  await enable(d);
  await d.engine.syncNow();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const remove = remote.deleteMyCloudData.bind(remote);
  remote.deleteMyCloudData = async () => {
    await gate;
    await remove();
  };
  const deleting = d.engine.deleteCloudData();
  await Promise.resolve();
  await d.engine.enable({ userId: 'user', generation: remote.generation });
  assert.equal(d.engine.status, 'error: CLOUD_DELETE_IN_PROGRESS');
  release();
  assert.equal(await deleting, true);
  const otherRemote = new MemorySyncRemote(50 * 1024 * 1024, 'other');
  const other = new SyncEngine({ local: d.local, remote: otherRemote, deviceId: 'other', config });
  await other.enable({ userId: 'other', generation: otherRemote.generation });
  assert.equal(other.status, 'error: ACCOUNT_CHANGE_REQUIRES_CONSENT');
  assert.equal(otherRemote.records.size, 0);
  other.stop();
});

test('bound Git origin wins over cloud identity and credentials are stripped', (t) => {
  const d = device(t),
    path = join(d.dir, 'repo');
  mkdirSync(join(path, '.git'), { recursive: true });
  writeFileSync(
    join(path, '.git', 'config'),
    '[remote "origin"]\n url = https://synthetic-user:synthetic-password@synthetic.invalid/new.git?credential=synthetic\n',
  );
  assert.equal(
    projectSyncIdentity({ path, gitRemote: 'https://synthetic.invalid/old.git' }),
    'https://synthetic.invalid/new.git',
  );
  writeFileSync(join(path, '.git', 'config'), '[core]\n bare = false\n');
  assert.equal(
    d.local.filtered('project', { path, gitRemote: 'https://synthetic.invalid/old.git' }).gitRemote,
    undefined,
  );
  assert.equal(projectSyncIdentity({ gitRemote: 'C:/private/repository' }), undefined);
});

test('all six workspace kinds queue changes and ignored kinds do not change the sync clock', async (t) => {
  const d = device(t);
  await enable(d);
  d.workspace.save('project', 'p', 'p', { id: 'p', name: 'P' });
  d.workspace.save('conversation', 'c', 'p', chat());
  d.workspace.save('message', 'm', 'c', message('m', 'typed'));
  d.workspace.save('human-message', 'm', 'c', { id: 'm' });
  d.workspace.save('conversation-folder', 'f', '', { id: 'f', name: 'Folder' });
  d.workspace.save('memory', 'p', 'p', { projectId: 'p', content: 'Memory' });
  assert.deepEqual(
    d.local.pending().map((p) => p.kind),
    ['project', 'conversation', 'message', 'human-message', 'conversation-folder', 'memory'],
  );
  const before = d.local.activity().generation;
  d.workspace.save('workflow', 'w', 'c', { id: 'w' });
  d.workspace.save('memory-auto', 'p', 'p', {});
  assert.equal(d.local.activity().generation, before);
});

test('merging project identity keeps both handwritten memories under the canonical project', async (t) => {
  const remote = new MemorySyncRemote(),
    a = device(t, remote, 'a'),
    b = device(t, remote, 'b');
  for (const [d, id] of [
    [a, 'a'],
    [b, 'b'],
  ] as const) {
    d.workspace.save('project', id, id, { id, name: 'Repo', gitRemote: 'https://synthetic.invalid/repo.git' });
    d.workspace.save('memory', id, id, { projectId: id, content: `Note ${id}`, revision: 1, updatedAt: '2026-01-01' });
  }
  await enable(a);
  await a.engine.syncNow();
  await enable(b);
  await converge(a, b);
  for (const d of [a, b]) {
    assert.match(d.workspace.memory('a').content, /Note a/);
    assert.match(d.workspace.memory('a').content, /Note b/);
  }
});

test('a new cloud generation resets once; a malformed record errors without reset', async (t) => {
  for (const mode of ['generation', 'malformed'] as const) {
    const remote = new MemorySyncRemote();
    const d = device(t, remote);
    let resets = 0,
      pushes = 0;
    const engine = new SyncEngine({
      local: d.local,
      remote,
      deviceId: 'reset',
      config,
      sealKey: createDataKey(),
      onReset: () => {
        resets++;
      },
    });
    await engine.enable({ userId: 'user', generation: remote.generation });
    d.workspace.save('conversation', 'c', 'p', chat());
    if (mode === 'generation') await remote.deleteMyCloudData();
    else
      await remote.push(remote.generation, [
        {
          kind: 'conversation',
          id: 'broken',
          last_seq: 0,
          deleted: false,
          device_id: 'other',
          body: { owner: 'p', value: { ...chat('broken') }, deleted: true },
        },
      ]);
    const push = remote.push.bind(remote);
    remote.push = async (generation, changes) => {
      pushes++;
      return push(generation, changes);
    };
    await engine.syncNow();
    await engine.syncNow();
    if (mode === 'generation') {
      assert.equal(resets, 1);
      assert.equal(pushes, 1);
      assert.equal(engine.status, 'error: CLOUD_DATA_RESET');
      assert.equal(d.local.state()?.enabled, 0);
      assert.equal(remote.records.size, 0, 'the stale generation never uploads into the emptied cloud');
    } else {
      assert.equal(resets, 0);
      assert.equal(engine.status, 'error: INVALID_RECORD');
      assert.equal(d.local.state()?.enabled, 1);
      assert.equal(d.local.cursor, 0);
    }
    engine.stop();
  }
});

test('a base without a cloud row re-uploads as new instead of resetting', async (t) => {
  const remote = new MemorySyncRemote();
  let resets = 0;
  const d = device(t, remote);
  const engine = new SyncEngine({
    local: d.local,
    remote,
    deviceId: 'a',
    config,
    sealKey: createDataKey(),
    onReset: () => {
      resets++;
    },
  });
  d.workspace.save('conversation', 'c', 'p', chat());
  await engine.enable({ userId: 'user', generation: remote.generation });
  await engine.syncNow();
  assert.ok(d.local.base('conversation', 'c'));
  remote.records.clear();
  d.workspace.save('conversation', 'c', 'p', { ...chat(), title: 'Edited after the cloud row vanished' });
  const sent: number[] = [];
  const push = remote.push.bind(remote);
  remote.push = async (generation, changes) => {
    sent.push(...changes.map((c) => c.last_seq));
    return push(generation, changes);
  };
  await engine.syncNow();
  assert.equal(resets, 0);
  assert.equal(engine.status, 'idle');
  assert.equal(d.local.base('conversation', 'c'), undefined);
  assert.equal(d.local.pending().length, 1);
  await engine.syncNow();
  assert.deepEqual(sent.slice(-1), [0]);
  assert.equal(d.local.pending().length, 0);
  const cloud = [...remote.records.values()].find((r) => r.id === 'c')!;
  assert.equal(cloud.body.value.title, 'Edited after the cloud row vanished');
  assert.equal(d.local.base('conversation', 'c')?.seq, cloud.seq);
  engine.stop();
});

test('remote tombstones revive unsynced project memory and folder edits', async (t) => {
  for (const kind of ['project', 'memory', 'conversation-folder']) {
    const remote = new MemorySyncRemote(),
      a = device(t, remote, 'a'),
      b = device(t, remote, 'b');
    const value = { id: 'record', name: 'Original', content: 'original' };
    a.workspace.save(kind, 'record', '', value);
    await enable(a);
    await a.engine.syncNow();
    await enable(b);
    await converge(a, b);
    a.workspace.deleteRecord(kind, 'record');
    b.workspace.save(kind, 'record', '', { ...value, name: 'Edited', content: 'edited' });
    await a.engine.syncNow();
    await b.engine.syncNow(false);
    assert.equal(b.workspace.get<{ content: string }>(kind, 'record')?.content, 'edited');
    assert.equal(b.local.pendingOne(kind, 'record')?.deleted, false);
    await converge(a, b);
    assert.equal(a.workspace.get<{ content: string }>(kind, 'record')?.content, 'edited');
  }
});

test('first settings merge prefers cloud and fills only missing cloud keys', async (t) => {
  const remote = new MemorySyncRemote(),
    a = device(t, remote, 'a'),
    b = device(t, remote, 'b');
  a.db.exec(
    `CREATE TABLE config(key TEXT PRIMARY KEY,value TEXT); INSERT INTO config VALUES('settings','{"appearanceTheme":"dark","locale":"en","globalInstructions":"cloud"}')`,
  );
  b.db.exec(
    `CREATE TABLE config(key TEXT PRIMARY KEY,value TEXT); INSERT INTO config VALUES('settings','{"appearanceTheme":"light","locale":"zh-CN","notifySound":false}')`,
  );
  await enable(a);
  await a.engine.syncNow();
  await enable(b);
  await converge(a, b);
  assert.deepEqual(b.local.settings(), {
    appearanceTheme: 'dark',
    locale: 'en',
    globalInstructions: 'cloud',
    notifySound: false,
  });
});

test('project merge rewrites every owned kind and memory-auto identity without syncing private kinds', async (t) => {
  const remote = new MemorySyncRemote(),
    a = device(t, remote, 'a'),
    b = device(t, remote, 'b');
  a.workspace.save('project', 'a', 'a', { id: 'a', name: 'Chat', scope: 'chat' });
  b.workspace.save('project', 'b', 'b', { id: 'b', name: 'Chat', scope: 'chat' });
  b.workspace.save('memory-auto', 'b', 'b', { projectId: 'b', content: 'private auto' });
  b.workspace.save('grok-import', 'import', 'b', { projectId: 'b', source: 'synthetic' });
  b.workspace.save('custom-local', 'custom', 'b', { value: 'preserve' });
  await enable(a);
  await a.engine.syncNow();
  await enable(b);
  await converge(a, b);
  assert.equal(b.db.prepare("SELECT COUNT(*) n FROM workspace_records WHERE owner='b'").get()!.n, 0);
  assert.equal(b.workspace.get<{ projectId: string }>('memory-auto', 'a')?.projectId, 'a');
  assert.equal(b.workspace.get('memory-auto', 'b'), undefined);
  assert.equal(b.workspace.get<{ projectId: string }>('grok-import', 'import')?.projectId, 'a');
  assert.equal(
    [...remote.records.values()].some((r) => ['memory-auto', 'grok-import', 'custom-local'].includes(r.kind)),
    false,
  );
});

test('pulled settings replace only allowlisted keys including remote removals', async () => {
  const sync = await import('../src/shared/account-sync.ts');
  const local = { globalInstructions: 'removed remotely', locale: 'en', privateOption: 'keep' };
  sync.replaceSyncedSettings(local, { locale: 'zh-CN', privateOption: 'remote cannot replace' });
  assert.deepEqual(local, { locale: 'zh-CN', privateOption: 'keep' });
});

test('drain waits for an interrupted async activation before another account enables', async (t) => {
  const d = device(t);
  const activate = d.local.activate.bind(d.local);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  d.local.activate = async (...args) => {
    await gate;
    return activate(...args);
  };
  const enabling = d.engine.enable({ userId: 'user', generation: d.remote.generation });
  d.engine.stop();
  let drained = false;
  const draining = d.engine.drain().then(() => {
    drained = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const drainedEarly = drained;
  release();
  await Promise.all([enabling, draining]);
  assert.equal(drainedEarly, false, 'activation must finish before the next account may mutate the same store');
  assert.equal(d.local.state()?.enabled, 0);
  d.local.activate = activate;
  const nextRemote = new MemorySyncRemote(undefined, 'other');
  const next = new SyncEngine({
    local: d.local,
    remote: nextRemote,
    deviceId: 'next',
    config,
    sealKey: createDataKey(),
  });
  try {
    await next.enable({ userId: 'other', generation: nextRemote.generation, allowAccountChange: true });
    assert.equal(d.local.state()?.account, 'other');
    assert.equal(d.local.state()?.enabled, 1);
  } finally {
    next.stop();
  }
});
