import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { googleOfficeOperations } from '../src/server/connectors-google-office.ts';
import type { OfficeApi } from '../src/server/connector-office.ts';

function operation(name: string) {
  const found = googleOfficeOperations.find((op) => op.name === `connector_google_${name}`);
  assert.ok(found, name);
  return found;
}
function mock(...responses: any[]) {
  const calls: { path: string; init?: RequestInit }[] = [];
  const api: OfficeApi = async (path, init) => {
    calls.push({ path, init });
    if (!responses.length) throw new Error('Unexpected additional API request');
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return response;
  };
  return { api, calls };
}
async function run(name: string, args: unknown, api: OfficeApi) {
  const op = operation(name);
  return op.run(op.schema.parse(args), api) as Promise<any>;
}
const body = (call: { init?: RequestInit }) => JSON.parse(String(call.init?.body));
const search = (call: { path: string }) => new URL(call.path, 'https://test.invalid').searchParams;
const paragraph = (text: string) => ({ paragraph: { elements: [{ textRun: { content: text } }] } });

test('office registry has unique names, strict JSON schemas and read/write capabilities', () => {
  assert.equal(new Set(googleOfficeOperations.map((op) => op.name)).size, googleOfficeOperations.length);
  for (const op of googleOfficeOperations) {
    assert.equal(op.provider, 'google');
    assert.equal(op.readOnly, op.capability.endsWith('_read'));
    const schema = z.toJSONSchema(op.schema);
    assert.equal(schema.additionalProperties, false, op.name);
    assert.equal(schema.type, 'object', op.name);
  }
});

test('Docs read covers nested tabs, tables, footnotes and explicit character pagination', async () => {
  const doc = {
    documentId: 'doc',
    title: 'Quarterly plan',
    revisionId: 'r1',
    tabs: [
      {
        tabProperties: { tabId: 'first', title: 'Overview' },
        documentTab: {
          body: {
            content: [
              paragraph('First\n'),
              { table: { tableRows: [{ tableCells: [{ content: [paragraph('Cell\n')] }] }] } },
            ],
          },
          footnotes: { f1: { content: [paragraph('Note\n')] } },
        },
        childTabs: [
          {
            tabProperties: { tabId: 'child', title: 'Detail' },
            documentTab: { body: { content: [paragraph('Child\n')] } },
          },
        ],
      },
    ],
  };
  const first = mock(doc);
  const page = await run('docs_read', { documentId: 'doc', limit: 7 }, first.api);
  assert.equal(search(first.calls[0]).get('includeTabsContent'), 'true');
  assert.equal(page.text, 'First\nC');
  assert.equal(page.totalCharacters, 'First\nCell\nNote\nChild\n'.length);
  assert.equal(page.nextOffset, 7);
  assert.deepEqual(
    page.tabs.map((tab: any) => tab.id),
    ['first', 'child'],
  );
  const next = await run('docs_read', { documentId: 'doc', offset: 7, expectedRevisionId: 'r1' }, mock(doc).api);
  assert.equal(page.text + next.text, 'First\nCell\nNote\nChild\n');
  assert.equal(next.nextOffset, null);
  const child = await run('docs_read', { documentId: 'doc', tabId: 'child' }, mock(doc).api);
  assert.equal(child.text, 'Child\n');
  await assert.rejects(run('docs_read', { documentId: 'doc', tabId: 'missing' }, mock(doc).api), /not found/);
  await assert.rejects(run('docs_read', { documentId: 'doc', expectedRevisionId: 'old' }, mock(doc).api), /changed/);
});

test('Docs append and exact replacement bind revision and tab instead of arbitrary requests', async () => {
  const append = mock({ documentId: 'd1' });
  await run(
    'docs_append',
    { documentId: 'd1', tabId: 't1', text: 'New paragraph', requiredRevisionId: 'rev1' },
    append.api,
  );
  assert.equal(append.calls[0].path, '/docs/v1/documents/d1:batchUpdate');
  assert.deepEqual(body(append.calls[0]), {
    writeControl: { requiredRevisionId: 'rev1' },
    requests: [{ insertText: { endOfSegmentLocation: { tabId: 't1' }, text: 'New paragraph' } }],
  });
  const replace = mock({});
  await run(
    'docs_replace_text',
    { documentId: 'd1', find: 'a.*', replace: 'b', requiredRevisionId: 'r', tabId: 't' },
    replace.api,
  );
  assert.deepEqual(body(replace.calls[0]).requests[0].replaceAllText, {
    containsText: { text: 'a.*', matchCase: true },
    replaceText: 'b',
    tabsCriteria: { tabIds: ['t'] },
  });
  assert.throws(() => operation('docs_append').schema.parse({ documentId: 'd', text: 'hi', requests: [] }));
});

test('Sheets use RAW by default and explicit USER_ENTERED for formulas', async () => {
  const raw = mock({ updatedCells: 2 });
  await run(
    'sheets_update',
    { spreadsheetId: 'sheet', range: "'Budget Q1'!A1:B1", values: [['=SUM(A2:A9)', 5]] },
    raw.api,
  );
  assert.equal(search(raw.calls[0]).get('valueInputOption'), 'RAW');
  assert.ok(raw.calls[0].path.includes(enc("'Budget Q1'!A1:B1")));
  assert.equal(raw.calls[0].init?.method, 'PUT');
  assert.deepEqual(body(raw.calls[0]).values, [['=SUM(A2:A9)', 5]]);
  const formula = mock({});
  await run(
    'sheets_append',
    { spreadsheetId: 'sheet', range: 'Sheet1!A1:B100', values: [['=1+1', null]], valueInputOption: 'USER_ENTERED' },
    formula.api,
  );
  assert.equal(search(formula.calls[0]).get('valueInputOption'), 'USER_ENTERED');
  assert.equal(search(formula.calls[0]).get('insertDataOption'), 'INSERT_ROWS');
  const read = mock({ values: [['=1+1']] });
  await run('sheets_read', { spreadsheetId: 'sheet', range: 'A1', valueRenderOption: 'FORMULA' }, read.api);
  assert.equal(search(read.calls[0]).get('valueRenderOption'), 'FORMULA');
});
const enc = encodeURIComponent;

test('Sheets reject unbounded ranges, oversized values and writes outside selected rectangle', async () => {
  const read = operation('sheets_read');
  for (const range of ['A:A', '1:100', 'Sheet1', 'A0:B2', 'B5:A1', 'A1:C10000', 'A1:XFD10']) {
    assert.equal(read.schema.safeParse({ spreadsheetId: 's', range }).success, false, range);
  }
  assert.equal(read.schema.safeParse({ spreadsheetId: 's', range: "'Owner''s Budget'!A1:CV100" }).success, true);
  const m = mock();
  await assert.rejects(run('sheets_update', { spreadsheetId: 's', range: 'A1', values: [[1, 2]] }, m.api), /outside/);
  await assert.rejects(
    run('sheets_append', { spreadsheetId: 's', range: 'A1:A10', values: [[1, 2]] }, m.api),
    /outside/,
  );
  assert.equal(m.calls.length, 0);
  assert.equal(
    operation('sheets_update').schema.safeParse({
      spreadsheetId: 's',
      range: 'A1:C100',
      values: Array.from({ length: 100 }, () => ['x'.repeat(20_000)]),
    }).success,
    false,
  );
});

test('Google Slides addition is atomic, custom-theme independent and revision checked', async () => {
  const metadata = {
    presentationId: 'deck',
    revisionId: 'r1',
    pageSize: { width: { magnitude: 720, unit: 'PT' }, height: { magnitude: 405, unit: 'PT' } },
  };
  const m = mock(metadata, { presentationId: 'deck', replies: [] });
  const result = await run(
    'slides_add_text_slide',
    { presentationId: 'deck', title: 'Revenue', body: 'Up 10%', insertionIndex: 0, requiredRevisionId: 'r1' },
    m.api,
  );
  assert.equal(m.calls.length, 2);
  assert.equal(m.calls[1].path, '/slides/v1/presentations/deck:batchUpdate');
  const request = body(m.calls[1]);
  assert.equal(request.writeControl.requiredRevisionId, 'r1');
  assert.equal(request.requests[0].createSlide.objectId, result.slideId);
  assert.equal(request.requests[0].createSlide.insertionIndex, 0);
  assert.equal(request.requests[0].createSlide.slideLayoutReference, undefined);
  assert.deepEqual(
    request.requests.filter((r: any) => r.insertText).map((r: any) => r.insertText.text),
    ['Revenue', 'Up 10%'],
  );
  for (const r of request.requests) if (r.createShape) assert.ok(r.createShape.objectId.length <= 50);
  const conflict = mock({ ...metadata, revisionId: 'r2' });
  await assert.rejects(
    run(
      'slides_add_text_slide',
      { presentationId: 'deck', title: 'T', body: '', requiredRevisionId: 'r1' },
      conflict.api,
    ),
    /changed/,
  );
  assert.equal(conflict.calls.length, 1);
});

test('Slides paginated read and scoped exact replacement preserve revision', async () => {
  const m = mock({
    presentationId: 'p',
    title: 'Report',
    revisionId: 'r',
    slides: [{ objectId: 'a' }, { objectId: 'b' }],
  });
  const page = await run('slides_read', { presentationId: 'p', offset: 0, limit: 1 }, m.api);
  assert.deepEqual(page.slides, [{ objectId: 'a' }]);
  assert.equal(page.nextOffset, 1);
  const update = mock({});
  await run(
    'slides_replace_text',
    { presentationId: 'p', slideIds: ['b'], find: '2025', replace: '2026', requiredRevisionId: 'r' },
    update.api,
  );
  assert.deepEqual(body(update.calls[0]).requests[0].replaceAllText.pageObjectIds, ['b']);
  assert.equal(body(update.calls[0]).writeControl.requiredRevisionId, 'r');
});

test('Calendar lists encode tokens, use explicit intervals and preserve provider pagination', async () => {
  const m = mock({ items: [{ id: 'event' }], nextPageToken: 'next/page?token' });
  const result = await run(
    'calendar_events_list',
    {
      calendarId: 'team@example.com',
      timeMin: '2026-10-05T00:00:00-04:00',
      timeMax: '2026-10-06T00:00:00-04:00',
      pageToken: 'previous/page?token',
    },
    m.api,
  );
  assert.match(m.calls[0].path, /^\/calendar\/v3\/calendars\/team%40example.com\/events\?/);
  assert.equal(search(m.calls[0]).get('pageToken'), 'previous/page?token');
  assert.equal(search(m.calls[0]).get('singleEvents'), 'true');
  assert.equal(result.nextPageToken, 'next/page?token');
  assert.equal(
    operation('calendar_events_list').schema.safeParse({
      timeMin: '2026-10-05T00:00:00',
      timeMax: '2026-10-06T00:00:00Z',
    }).success,
    false,
  );
  assert.equal(
    operation('calendar_events_list').schema.safeParse({
      timeMin: '2026-10-06T00:00:00Z',
      timeMax: '2026-10-05T00:00:00Z',
    }).success,
    false,
  );
});

test('Calendar writes make guest notifications explicit and dates exclusive; updates preserve unspecified fields', async () => {
  const m = mock({ id: 'e' });
  await run(
    'calendar_event_create',
    {
      summary: 'Meeting',
      interval: { type: 'allDay', start: '2026-10-06', end: '2026-10-07' },
      attendees: [{ email: 'coworker@example.com' }],
    },
    m.api,
  );
  assert.equal(search(m.calls[0]).get('sendUpdates'), 'all');
  assert.deepEqual(body(m.calls[0]).start, { date: '2026-10-06' });
  assert.deepEqual(body(m.calls[0]).end, { date: '2026-10-07' });
  const update = mock({});
  await run(
    'calendar_event_update',
    { eventId: 'e', etag: '"v1"', location: 'Room 2', sendUpdates: 'none' },
    update.api,
  );
  assert.equal(update.calls[0].init?.method, 'PATCH');
  assert.deepEqual(body(update.calls[0]), { location: 'Room 2' });
  assert.equal(new Headers(update.calls[0].init?.headers).get('If-Match'), '"v1"');
  assert.equal(search(update.calls[0]).get('sendUpdates'), 'none');
  const empty = mock();
  await assert.rejects(run('calendar_event_update', { eventId: 'e', etag: 'v1' }, empty.api), /at least one/);
  assert.equal(empty.calls.length, 0);
  assert.equal(
    operation('calendar_event_create').schema.safeParse({
      summary: 'Bad date',
      interval: { type: 'allDay', start: '2026-02-30', end: '2026-03-02' },
    }).success,
    false,
  );
  assert.equal(
    operation('calendar_event_create').schema.safeParse({
      summary: 'Bad interval',
      interval: { type: 'allDay', start: '2026-10-06', end: '2026-10-06' },
    }).success,
    false,
  );
});

test('Calendar delete is conditional and only returns success after provider accepts it', async () => {
  const m = mock(null);
  assert.deepEqual(await run('calendar_event_delete', { eventId: 'e', etag: 'v1' }, m.api), {
    deleted: true,
    calendarId: 'primary',
    eventId: 'e',
  });
  assert.equal(m.calls[0].init?.method, 'DELETE');
  assert.equal(new Headers(m.calls[0].init?.headers).get('If-Match'), 'v1');
  await assert.rejects(
    run('calendar_event_delete', { eventId: 'e', etag: 'v1' }, mock(new Error('Precondition failed')).api),
    /Precondition/,
  );
});

test('Tasks carry date-only due dates, explicit completion, paging and revision conditions', async () => {
  const create = mock({ id: 't' });
  await run('tasks_create', { title: 'Pay invoice', dueDate: '2026-10-10', parentTaskId: 'parent' }, create.api);
  assert.equal(body(create.calls[0]).due, '2026-10-10T00:00:00.000Z');
  assert.equal(search(create.calls[0]).get('parent'), 'parent');
  const update = mock({});
  await run('tasks_update', { taskId: 't', etag: 'v1', status: 'completed', dueDate: null }, update.api);
  assert.deepEqual(body(update.calls[0]), { status: 'completed', due: null });
  assert.equal(new Headers(update.calls[0].init?.headers).get('If-Match'), 'v1');
  const list = mock({ items: [], nextPageToken: 'next' });
  assert.equal(
    (await run('tasks_list', { pageToken: 'token', showCompleted: true, showHidden: true }, list.api)).nextPageToken,
    'next',
  );
  assert.equal(search(list.calls[0]).get('showHidden'), 'true');
  assert.equal(search(list.calls[0]).get('pageToken'), 'token');
});

test('Tasks delete refuses assigned Docs/Chat tasks and stale revisions', async () => {
  const assigned = mock({ etag: 'v1', assignmentInfo: { surfaceType: 'DOCUMENT' } });
  await assert.rejects(run('tasks_delete', { taskId: 'task', etag: 'v1' }, assigned.api), /original Docs or Chat/);
  assert.equal(assigned.calls.length, 1);
  const stale = mock({ etag: 'v2' });
  await assert.rejects(run('tasks_delete', { taskId: 'task', etag: 'v1' }, stale.api), /changed/);
  assert.equal(stale.calls.length, 1);
  const allowed = mock({ etag: 'v1' }, null);
  const result = await run('tasks_delete', { taskId: 'task', etag: 'v1' }, allowed.api);
  assert.equal(result.deleted, true);
  assert.equal(allowed.calls[1].init?.method, 'DELETE');
});

test('Contacts read and list request CONTACT sources and preserve cursor', async () => {
  const m = mock({ connections: [{ resourceName: 'people/c123' }], nextPageToken: 'more' });
  const result = await run('contacts_list', { pageToken: 'start' }, m.api);
  assert.equal(result.nextPageToken, 'more');
  assert.equal(search(m.calls[0]).get('sources'), 'READ_SOURCE_TYPE_CONTACT');
  assert.ok(search(m.calls[0]).get('personFields')?.includes('metadata'));
  const read = mock({ resourceName: 'people/c123', etag: 'person-v1' });
  await run('contacts_read', { resourceName: 'people/c123' }, read.api);
  assert.ok(read.calls[0].path.startsWith('/people/v1/people/c123?'));
});

test('Contact search warms the provider cache and never presents limited matches as all contacts', async () => {
  const m = mock({}, { results: [{ person: { resourceName: 'people/c123' } }] });
  const result = await run('contacts_search', { query: 'Pat', pageSize: 10 }, m.api);
  assert.equal(search(m.calls[0]).get('query'), '');
  assert.equal(search(m.calls[1]).get('query'), 'Pat');
  assert.equal(search(m.calls[1]).get('pageSize'), '10');
  assert.equal(result.results.length, 1);
  assert.equal(operation('contacts_search').schema.safeParse({ query: 'x', pageSize: 31 }).success, false);
});

test('Free/busy lookup is read-only despite POST and keeps provider errors explicit', async () => {
  const data = { calendars: { 'team@example.com': { errors: [{ reason: 'notFound' }] } } };
  const m = mock(data);
  assert.equal(operation('calendar_freebusy').readOnly, true);
  assert.deepEqual(
    await run(
      'calendar_freebusy',
      { calendarIds: ['team@example.com'], timeMin: '2026-10-05T00:00:00Z', timeMax: '2026-10-06T00:00:00Z' },
      m.api,
    ),
    data,
  );
  assert.equal(m.calls[0].path, '/calendar/v3/freeBusy');
  assert.equal(m.calls[0].init?.method, 'POST');
  assert.deepEqual(body(m.calls[0]).items, [{ id: 'team@example.com' }]);
});

test('Contacts update uses source ETag and does not erase unspecified family name', async () => {
  const m = mock(
    {
      etag: 'person-v1',
      names: [{ givenName: 'Alice', familyName: 'Smith', metadata: { source: { type: 'CONTACT' } } }],
      metadata: {
        sources: [
          { type: 'PROFILE', id: 'profile', etag: 'profile-v1' },
          { type: 'CONTACT', id: 'contact', etag: 'contact-v1' },
        ],
      },
    },
    { resourceName: 'people/c1' },
  );
  await run(
    'contacts_update',
    { resourceName: 'people/c1', etag: 'person-v1', givenName: 'Alicia', phoneNumbers: [], notes: null },
    m.api,
  );
  assert.deepEqual(body(m.calls[1]).names, [{ givenName: 'Alicia', familyName: 'Smith' }]);
  assert.deepEqual(body(m.calls[1]).metadata.sources, [{ type: 'CONTACT', id: 'contact', etag: 'contact-v1' }]);
  assert.deepEqual(body(m.calls[1]).phoneNumbers, []);
  assert.deepEqual(body(m.calls[1]).biographies, []);
  assert.equal(search(m.calls[1]).get('updatePersonFields'), 'phoneNumbers,names,biographies');
  assert.equal(body(m.calls[1]).emailAddresses, undefined);
  const stale = mock({ etag: 'new' });
  await assert.rejects(
    run('contacts_update', { resourceName: 'people/c1', etag: 'old', notes: 'hi' }, stale.api),
    /changed/,
  );
  assert.equal(stale.calls.length, 1);
});

test('Contacts create/delete and all resource creation use scoped APIs without sending messages', async () => {
  for (const [name, args, path, expected] of [
    ['docs_create', { title: 'Doc' }, '/docs/v1/documents', { title: 'Doc' }],
    ['slides_create', { title: 'Slides' }, '/slides/v1/presentations', { title: 'Slides' }],
    ['tasks_list_create', { title: 'Errands' }, '/tasks/v1/users/@me/lists', { title: 'Errands' }],
    [
      'sheets_create',
      { title: 'Budget', sheetTitles: ['Income', 'Expenses'] },
      '/sheets/v4/spreadsheets',
      {
        properties: { title: 'Budget' },
        sheets: [{ properties: { title: 'Income' } }, { properties: { title: 'Expenses' } }],
      },
    ],
  ] as const) {
    const m = mock({ id: 'new' });
    await run(name, args, m.api);
    assert.equal(m.calls[0].path, path);
    assert.deepEqual(body(m.calls[0]), expected);
  }
  const contact = mock({ resourceName: 'people/c1' });
  await run(
    'contacts_create',
    { givenName: 'Pat', emailAddresses: [{ value: 'pat@example.com', type: 'work' }] },
    contact.api,
  );
  assert.deepEqual(body(contact.calls[0]).names, [{ givenName: 'Pat', familyName: '' }]);
  const deletion = mock(null);
  assert.equal((await run('contacts_delete', { resourceName: 'people/c1' }, deletion.api)).deleted, true);
  assert.equal(deletion.calls[0].path, '/people/v1/people/c1:deleteContact');
  assert.equal(deletion.calls[0].init?.method, 'DELETE');
});

test('IDs, cursor sizes, arbitrary fields and invalid header values are rejected before HTTP', () => {
  for (const documentId of ['../secret', '..', 'x?alt=media', 'https://example.com', 'x\r\nAuthorization: evil'])
    assert.equal(operation('docs_read').schema.safeParse({ documentId }).success, false, documentId);
  assert.equal(operation('calendar_list').schema.safeParse({ pageToken: 'a'.repeat(8193) }).success, false);
  assert.equal(operation('calendar_list').schema.safeParse({ pageSize: 101 }).success, false);
  assert.equal(operation('contacts_read').schema.safeParse({ resourceName: 'people/../me' }).success, false);
  assert.equal(operation('calendar_event_delete').schema.safeParse({ eventId: 'e', etag: 'a\r\nb' }).success, false);
  assert.equal(operation('calendar_event_delete').schema.safeParse({ eventId: 'e', etag: '*' }).success, false);
  assert.equal(
    operation('sheets_read').schema.safeParse({ spreadsheetId: 's', range: 'A1', endpoint: 'https://evil.invalid' })
      .success,
    false,
  );
  assert.equal(
    operation('sheets_create').schema.safeParse({ title: 'T', sheetTitles: ['Budget', 'budget'] }).success,
    false,
  );
});
