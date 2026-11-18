import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { managementOperations } from '../src/server/connectors-management.ts';
import type { OfficeApi } from '../src/server/connector-office.ts';

function get(name: string) {
  const operation = managementOperations.find((op) => op.name === `connector_${name}`);
  assert.ok(operation, name);
  return operation;
}
async function run(name: string, args: unknown, api: OfficeApi) {
  const operation = get(name);
  return operation.run(operation.schema.parse(args), api) as Promise<any>;
}
function mock(...responses: any[]) {
  const calls: { path: string; init: RequestInit }[] = [];
  const api: OfficeApi = async (path, init = {}) => {
    calls.push({ path, init });
    assert.ok(responses.length, 'Unexpected API call');
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return response;
  };
  return { api, calls };
}
const body = (call: { init: RequestInit }) => JSON.parse(String(call.init.body));
const url = (path: string) => new URL(path, 'https://graph.microsoft.com/v1.0');
const cursor = (url: string) => Buffer.from(url).toString('base64url');
const itemFields = 'id,name,eTag,file,folder,parentReference,size,webUrl';
const folderFields = 'id,displayName,parentFolderId,childFolderCount,totalItemCount,unreadItemCount';

test('management registry uses distinct strict schemas and separates writes from reads', () => {
  assert.equal(new Set(managementOperations.map((operation) => operation.name)).size, managementOperations.length);
  for (const operation of managementOperations) {
    assert.equal(z.toJSONSchema(operation.schema).additionalProperties, false, operation.name);
    assert.equal(operation.readOnly, operation.capability.endsWith('_read'), operation.name);
    assert.doesNotMatch(operation.name, /permanent|mail_send/);
  }
});

test('Gmail nested labels are allowed and message modify validates contradictory changes', async () => {
  const label = mock({ id: 'Label_123' });
  await run('google_mail_create_label', { name: 'Work/Invoices' }, label.api);
  assert.equal(label.calls[0].path, '/gmail/v1/users/me/labels');
  assert.equal(body(label.calls[0]).name, 'Work/Invoices');
  const modify = mock({ labelIds: ['Label_123'] });
  await run(
    'google_mail_modify',
    { id: 'message', addLabelIds: ['Label_123'], removeLabelIds: ['INBOX', 'UNREAD'] },
    modify.api,
  );
  assert.equal(modify.calls[0].path, '/gmail/v1/users/me/messages/message/modify');
  assert.deepEqual(body(modify.calls[0]), { addLabelIds: ['Label_123'], removeLabelIds: ['INBOX', 'UNREAD'] });
  const invalid = mock();
  await assert.rejects(run('google_mail_modify', { id: 'message' }, invalid.api), /Specify/);
  await assert.rejects(
    run('google_mail_modify', { id: 'message', addLabelIds: ['INBOX'], removeLabelIds: ['INBOX'] }, invalid.api),
    /cannot/,
  );
  assert.equal(invalid.calls.length, 0);
});

test('Gmail mail trash and restore use recoverable endpoints, never message DELETE', async () => {
  for (const action of ['trash', 'untrash']) {
    const m = mock({ id: 'm1' });
    await run(`google_mail_${action}`, { id: 'm1' }, m.api);
    assert.equal(m.calls[0].path, `/gmail/v1/users/me/messages/m1/${action}`);
    assert.equal(m.calls[0].init.method, 'POST');
  }
});

test('Outlook changes only supplied fields and moves messages to deleteditems for soft trash', async () => {
  const modify = mock({ id: 'm' });
  await run('microsoft_mail_modify', { id: 'm', isRead: false, categories: [], flag: 'complete' }, modify.api);
  assert.equal(modify.calls[0].init.method, 'PATCH');
  assert.deepEqual(body(modify.calls[0]), { isRead: false, categories: [], flag: { flagStatus: 'complete' } });
  const move = mock({ id: 'new-message-id' });
  const result = await run('microsoft_mail_move', { id: 'm', destinationId: 'deleteditems' }, move.api);
  assert.equal(move.calls[0].init.method, 'POST');
  assert.equal(move.calls[0].path, '/me/messages/m/move');
  assert.equal(body(move.calls[0]).destinationId, 'deleteditems');
  assert.equal(result.id, 'new-message-id');
});

test('Outlook folders and OneDrive children retain same collection during paging', async () => {
  for (const [name, args, path, fields, resultKey] of [
    [
      'microsoft_mail_folders',
      { parentId: 'folder1' },
      '/me/mailFolders/folder1/childFolders',
      folderFields,
      'folders',
    ],
    ['microsoft_files_list_folder', { parentId: 'root' }, '/me/drive/root/children', itemFields, 'files'],
  ] as const) {
    const next = `https://graph.microsoft.com/v1.0${path}?$top=25&$select=${fields}&$skiptoken=opaque%2Btoken`;
    const first = mock({ value: [{ id: 'one' }], '@odata.nextLink': next });
    const page = await run(name, { ...args, limit: 25 }, first.api);
    assert.equal(page[resultKey][0].id, 'one');
    assert.equal(Buffer.from(page.nextCursor, 'base64url').toString(), next);
    const second = mock({ value: [{ id: 'two' }] });
    const last = await run(name, { ...args, limit: 25, cursor: page.nextCursor }, second.api);
    assert.equal(last.nextCursor, undefined);
    assert.equal(url(second.calls[0].path).searchParams.get('$skiptoken'), 'opaque+token');
    assert.equal(url(second.calls[0].path).pathname, path);
  }
});

test('Graph cursors reject foreign origin, traversal, changed collection, overlarge top and selected fields', async () => {
  const base = 'https://graph.microsoft.com/v1.0/me/drive/root/children';
  for (const raw of [
    'https://evil.invalid/v1.0/me/drive/root/children',
    'https://user:password@graph.microsoft.com/v1.0/me/drive/root/children',
    'https://graph.microsoft.com/v1.0/me/drive/root/children#fragment',
    'https://graph.microsoft.com/beta/me/drive/root/children',
    'https://graph.microsoft.com/v1.0/me/drive/root/children/../permissions',
    'https://graph.microsoft.com/v1.0/me/messages',
    `${base}?$top=101`,
    `${base}?$top=0`,
    `${base}?$top=30`,
    `${base}?$top=20&$top=20`,
    `${base}?$skip=-1`,
    `${base}?$skip=9007199254740992`,
    `${base}?$expand=permissions`,
    `${base}?$select=id,name,@microsoft.graph.downloadUrl`,
  ]) {
    const m = mock();
    await assert.rejects(
      run('microsoft_files_list_folder', { parentId: 'root', limit: 20, cursor: cursor(raw) }, m.api),
      /pagination/i,
      raw,
    );
    assert.equal(m.calls.length, 0);
  }
  const m = mock();
  await assert.rejects(run('microsoft_files_list_folder', { cursor: 'not_base64' }, m.api), /pagination/i);
  assert.equal(m.calls.length, 0);
});

test('provider nextLink receives the same validation and omitted limits stay bounded', async () => {
  await assert.rejects(
    run('microsoft_mail_folders', {}, mock({ value: [], '@odata.nextLink': 'https://evil.invalid/page' }).api),
    /pagination/i,
  );
  const m = mock({ value: [] });
  await run(
    'microsoft_mail_folders',
    { limit: 10, cursor: cursor('https://graph.microsoft.com/v1.0/me/mailFolders?$skip=20') },
    m.api,
  );
  assert.equal(url(m.calls[0].path).searchParams.get('$top'), '10');
  assert.equal(url(m.calls[0].path).searchParams.get('$select'), folderFields);
});

test('Drive folder listings escape parent query strings and preserve pagination tokens', async () => {
  const m = mock({ files: [{ id: 'file' }], nextPageToken: 'next' });
  const result = await run(
    'google_files_list_folder',
    { parentId: "folder'\\name", cursor: 'cursor&injection=x', limit: 10 },
    m.api,
  );
  const params = url(m.calls[0].path).searchParams;
  assert.equal(params.get('q'), "'folder\\'\\\\name' in parents and trashed = false");
  assert.equal(params.get('pageToken'), 'cursor&injection=x');
  assert.equal(params.get('pageSize'), '10');
  assert.equal(params.get('includeItemsFromAllDrives'), 'true');
  assert.equal(result.nextCursor, 'next');
});

test('Drive move preserves current parents until version checked and does not erase unspecified name', async () => {
  const m = mock({ id: 'file', version: '9', parents: ['old'] }, { id: 'file', parents: ['new'] });
  await run('google_files_update', { id: 'file', version: '9', parentId: 'new' }, m.api);
  assert.equal(m.calls[0].init.method, undefined);
  assert.equal(m.calls[1].init.method, 'PATCH');
  assert.deepEqual(body(m.calls[1]), {});
  assert.equal(url(m.calls[1].path).searchParams.get('addParents'), 'new');
  assert.equal(url(m.calls[1].path).searchParams.get('removeParents'), 'old');
  const noMove = mock({ version: '9', parents: ['new'] }, {});
  await run('google_files_update', { id: 'file', version: '9', parentId: 'new', name: 'Renamed' }, noMove.api);
  assert.equal(url(noMove.calls[1].path).searchParams.get('removeParents'), null);
  assert.deepEqual(body(noMove.calls[1]), { name: 'Renamed' });
});

test('Drive stale or missing version blocks mutation and trash remains reversible', async () => {
  for (const response of [{ version: '10' }, {}]) {
    const m = mock(response);
    await assert.rejects(
      run('google_files_trash', { id: 'file', version: '9', trashed: true }, m.api),
      /changed|valid file version/i,
    );
    assert.equal(m.calls.length, 1);
  }
  for (const trashed of [true, false]) {
    const m = mock({ version: '9' }, { id: 'file', trashed });
    await run('google_files_trash', { id: 'file', version: '9', trashed }, m.api);
    assert.equal(m.calls[1].init.method, 'PATCH');
    assert.deepEqual(body(m.calls[1]), { trashed });
  }
});

test('Drive multipart upload has correct metadata, content and MIME boundary', async () => {
  const m = mock({ id: 'new-file' });
  const text = 'A,B\r\n1,2';
  await run('google_files_create_text', { name: 'data.csv', parentId: 'folder', mimeType: 'text/csv', text }, m.api);
  assert.match(m.calls[0].path, /^\/upload\/drive\/v3\/files\?/);
  assert.equal(url(m.calls[0].path).searchParams.get('uploadType'), 'multipart');
  const contentType = new Headers(m.calls[0].init.headers).get('Content-Type')!;
  assert.match(contentType, /^multipart\/related; boundary=pugport_/);
  const boundary = contentType.split('boundary=')[1];
  assert.ok(String(m.calls[0].init.body).startsWith(`--${boundary}\r\n`));
  assert.ok(String(m.calls[0].init.body).endsWith(`\r\n--${boundary}--`));
  assert.ok(
    String(m.calls[0].init.body).includes(
      JSON.stringify({ name: 'data.csv', parents: ['folder'], mimeType: 'text/csv' }),
    ),
  );
  assert.ok(String(m.calls[0].init.body).includes(text));
});

test('OneDrive create text uses explicit fail-on-conflict and encoded filename', async () => {
  const m = mock({ id: 'created' });
  await run('microsoft_files_create_text', { name: '会议记录.txt', text: 'Meeting notes' }, m.api);
  assert.match(m.calls[0].path, /^\/me\/drive\/root:\//);
  assert.ok(m.calls[0].path.includes(encodeURIComponent('会议记录.txt')));
  assert.equal(url(m.calls[0].path).searchParams.get('@microsoft.graph.conflictBehavior'), 'fail');
  assert.equal(m.calls[0].init.method, 'PUT');
  assert.equal(m.calls[0].init.body, 'Meeting notes');
});

test('OneDrive move to root resolves actual ID and sends current ETag; conflict behavior is in URL', async () => {
  const m = mock({ id: 'real-root-id' }, { id: 'file' });
  await run('microsoft_files_update', { id: 'file', parentId: 'root', etag: '"v1"' }, m.api);
  assert.equal(m.calls[0].path, '/me/drive/root?$select=id');
  assert.equal(m.calls[1].init.method, 'PATCH');
  assert.equal(new Headers(m.calls[1].init.headers).get('If-Match'), '"v1"');
  assert.deepEqual(body(m.calls[1]), { parentReference: { id: 'real-root-id' } });
  assert.equal(url(m.calls[1].path).searchParams.get('@microsoft.graph.conflictBehavior'), 'fail');
  const metadata = mock({ id: 'real-root-id' });
  await run('microsoft_files_metadata', { id: 'root' }, metadata.api);
  assert.match(metadata.calls[0].path, /^\/me\/drive\/root\?/);
});

test('OneDrive recycle is conditional DELETE, root is blocked, provider failure never claims success', async () => {
  const m = mock({ success: true });
  await run('microsoft_files_trash', { id: 'file', etag: '"v1"' }, m.api);
  assert.equal(m.calls[0].path, '/me/drive/items/file');
  assert.equal(m.calls[0].init.method, 'DELETE');
  assert.equal(new Headers(m.calls[0].init.headers).get('If-Match'), '"v1"');
  const root = mock();
  await assert.rejects(run('microsoft_files_trash', { id: 'root', etag: 'v' }, root.api), /root/);
  await assert.rejects(run('microsoft_files_update', { id: 'root', etag: 'v', name: 'New Root' }, root.api), /root/);
  assert.equal(root.calls.length, 0);
  await assert.rejects(
    run('microsoft_files_trash', { id: 'file', etag: 'v' }, mock(new Error('412 Precondition Failed')).api),
    /412/,
  );
});

test('conditional mutations reject wildcard or injected headers and missing Drive version', () => {
  for (const etag of ['*', 'W/*', 'v\r\nAuthorization: other'])
    assert.equal(get('microsoft_files_trash').schema.safeParse({ id: 'file', etag }).success, false);
  for (const version of ['undefined', '*', '-1', '9.5'])
    assert.equal(get('google_files_trash').schema.safeParse({ id: 'file', version, trashed: true }).success, false);
});
