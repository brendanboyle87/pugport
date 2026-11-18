import assert from 'node:assert/strict';
import test from 'node:test';
import AdmZip from 'adm-zip';
import { microsoftOfficeOperations } from '../src/server/connectors-microsoft-office.ts';
import {
  appendPresentationSlide,
  appendWord,
  createPresentation,
  createWord,
  createWorkbook,
  readPresentation,
  readWord,
  replacePresentationText,
  replaceWordParagraph,
} from '../src/server/connectors-office-xml.ts';
import type { OfficeApi } from '../src/server/connector-office.ts';

function op(name: string) {
  const found = microsoftOfficeOperations.find((o) => o.name === `connector_microsoft_${name}`);
  assert.ok(found);
  return found;
}
async function run(name: string, args: unknown, api: OfficeApi) {
  const operation = op(name);
  return operation.run(operation.schema.parse(args), api) as Promise<any>;
}
function mock(responses: unknown[] = []) {
  const calls: { path: string; init?: RequestInit; format?: string }[] = [];
  const api: OfficeApi = async (path, init, format) => {
    calls.push({ path, init, format });
    return responses.shift() ?? {};
  };
  return { api, calls };
}
function body(call: { init?: RequestInit }) {
  return JSON.parse(String(call.init?.body));
}

test('Microsoft operations are strict, account-scoped and advertise write capabilities accurately', () => {
  assert.equal(new Set(microsoftOfficeOperations.map((o) => o.name)).size, microsoftOfficeOperations.length);
  for (const operation of microsoftOfficeOperations) {
    assert.equal(operation.provider, 'microsoft');
    assert.equal(operation.readOnly, operation.capability.endsWith('_read'));
    assert.equal(operation.schema.safeParse({ arbitraryGraphPath: '/me/messages' }).success, false);
  }
  assert.equal(
    op('word_replace_paragraph').schema.safeParse({
      fileId: 'f',
      paragraphIndex: 0,
      expectedText: 'a',
      replacementText: 'b',
    }).success,
    false,
  );
  assert.equal(op('contact_read').schema.safeParse({ contactId: '..' }).success, false);
});

test('Excel rejects personal or unverified drives before workbook access', async () => {
  for (const driveType of ['personal', undefined]) {
    const { api, calls } = mock([{ driveType }]);
    await assert.rejects(
      run('excel_read', { fileId: 'a', worksheetId: 's', range: 'A1' }, api),
      /personal OneDrive|could not be verified/,
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, '/me/drive?$select=id,driveType');
  }
});

test('Excel range writes are exact, bounded and preserve distinct formula/value channels', async () => {
  const { api, calls } = mock([{ driveType: 'documentLibrary' }, { address: 'A1:B1' }]);
  await run(
    'excel_write',
    {
      driveId: 'drive A',
      fileId: 'f',
      worksheetId: 's',
      range: 'A1:B1',
      values: [[2, null]],
      formulas: [[null, '=A1*2']],
    },
    api,
  );
  assert.equal(calls[1].path, "/drives/drive%20A/items/f/workbook/worksheets/s/range(address='A1:B1')");
  assert.equal(calls[1].init?.method, 'PATCH');
  assert.deepEqual(body(calls[1]), { values: [[2, null]], formulas: [[null, '=A1*2']] });
  const untouched = mock();
  await assert.rejects(
    run('excel_write', { fileId: 'f', worksheetId: 's', range: 'A1:B2', values: [[1]] }, untouched.api),
    /exactly match/,
  );
  await assert.rejects(
    run('excel_read', { fileId: 'f', worksheetId: 's', range: 'A1:XFD1048576' }, untouched.api),
    /10,000/,
  );
  await assert.rejects(run('excel_read', { fileId: 'f', worksheetId: 's', range: "A1')/../" }, untouched.api));
  assert.equal(untouched.calls.length, 0);
});

test('Excel creates a valid blank workbook with collision protection', async () => {
  const { api, calls } = mock([{ driveType: 'business' }, { id: 'new', name: 'Budget.xlsx' }]);
  const result = await run('excel_create', { name: 'Budget.xlsx', worksheetName: 'Expenses' }, api);
  assert.equal(result.id, 'new');
  assert.equal(calls[1].path, '/me/drive/root:/Budget.xlsx:/content?@microsoft.graph.conflictBehavior=fail');
  assert.equal(calls[1].init?.method, 'PUT');
  const zip = new AdmZip(Buffer.from(calls[1].init?.body as Uint8Array));
  assert.match(zip.readAsText('xl/workbook.xml'), /name="Expenses"/);
  assert.match(zip.readAsText('[Content_Types].xml'), /spreadsheetml.sheet.main/);
});

test('Microsoft paging resumes same collection and rejects external/cross-service cursors', async () => {
  const next = 'https://graph.microsoft.com/v1.0/me/contacts?$skiptoken=next%2Btoken&$top=2';
  const { api, calls } = mock([{ value: [{ id: 'c1' }], '@odata.nextLink': next }, { value: [{ id: 'c2' }] }]);
  const first = await run('contacts_list', { pageSize: 2 }, api);
  assert.equal(first.hasMore, true);
  const second = await run('contacts_list', { pageSize: 2, cursor: first.nextCursor }, api);
  assert.equal(second.hasMore, false);
  const continuation = new URL(calls[1].path, 'https://graph.microsoft.com');
  assert.equal(continuation.pathname, '/me/contacts');
  assert.equal(continuation.searchParams.get('$skiptoken'), 'next+token');
  assert.equal(continuation.searchParams.get('$top'), '2');
  for (const value of [
    'https://attacker.test/v1.0/me/contacts',
    'https://graph.microsoft.com/v1.0/me/messages',
    'https://graph.microsoft.com/v1.0/me/contacts?$expand=manager',
    'https://user@graph.microsoft.com/v1.0/me/contacts',
    'https://graph.microsoft.com/v1.0/me/contacts?$filter=startswith(displayName,%27x%27)',
    'https://graph.microsoft.com/v1.0/me/contacts?$top=999999',
    'https://graph.microsoft.com/v1.0/me/contacts?$top=1&$top=99',
  ]) {
    const probe = mock();
    await assert.rejects(
      run('contacts_list', { cursor: Buffer.from(value).toString('base64url') }, probe.api),
      /cursor|parameter|size/,
    );
    assert.equal(probe.calls.length, 0);
  }
});

test('Calendar read expands occurrences for the requested interval, writes disclose invitations', async () => {
  const interval = { start: '2026-10-05T00:00:00-04:00', end: '2026-10-12T00:00:00-04:00' };
  const listing = mock([{ value: [] }]);
  await run('calendar_events', { calendarId: 'work', ...interval }, listing.api);
  const url = new URL(listing.calls[0].path, 'https://graph.microsoft.com');
  assert.equal(url.pathname, '/me/calendars/work/calendarView');
  assert.equal(url.searchParams.get('startDateTime'), interval.start);
  const creation = mock([{ id: 'event' }]);
  const event = {
    subject: 'Review',
    start: { dateTime: '2026-10-06T09:00:00', timeZone: 'Eastern Standard Time' },
    end: { dateTime: '2026-10-06T10:00:00', timeZone: 'Eastern Standard Time' },
    attendees: [{ emailAddress: { address: 'guest@example.com' }, type: 'required' }],
  };
  await run('calendar_create', { calendarId: 'work', ...event }, creation.api);
  assert.equal(creation.calls[0].path, '/me/calendars/work/events');
  assert.ok(body(creation.calls[0]).transactionId);
  assert.deepEqual(body(creation.calls[0]).attendees, event.attendees);
  assert.match(op('calendar_create').description, /sends invitations/);
  assert.match(op('calendar_delete').description, /cancellations/);
  assert.equal(op('calendar_events').schema.safeParse({ ...interval, end: interval.start }).success, false);
});

test('To Do preserves omitted fields and contact prefix is OData escaped', async () => {
  const tasks = mock();
  await run('task_update', { listId: 'list', taskId: 'task', changes: { status: 'completed' } }, tasks.api);
  assert.deepEqual(body(tasks.calls[0]), { status: 'completed' });
  assert.equal(tasks.calls[0].path, '/me/todo/lists/list/tasks/task');
  const contacts = mock([{ value: [] }]);
  await run('contacts_list', { namePrefix: "O'Neil" }, contacts.api);
  assert.equal(
    new URL(contacts.calls[0].path, 'https://graph.microsoft.com').searchParams.get('$filter'),
    "startswith(displayName,'O''Neil')",
  );
  assert.equal(op('contact_update').schema.safeParse({ contactId: 'c', changes: {} }).success, false);
});

test('Word read returns useful paragraph indices and append uses If-Match while preserving other package parts', async () => {
  const original = createWord(['Hello <world> & 中文', 'Second']);
  const zip = new AdmZip(original);
  zip.addFile('word/media/image1.png', Buffer.from([1, 2, 3]));
  const bytes = zip.toBuffer();
  const metadata = {
    id: 'doc',
    name: 'Report.docx',
    size: bytes.length,
    eTag: '"old"',
    webUrl: 'https://onedrive.example/doc',
    '@microsoft.graph.downloadUrl': 'https://secret.example/signed',
  };
  const reader = mock([metadata, bytes]);
  const result = await run('word_read', { fileId: 'doc' }, reader.api);
  assert.deepEqual(result.paragraphs, [
    { index: 0, text: 'Hello <world> & 中文' },
    { index: 1, text: 'Second' },
  ]);
  assert.equal(result.eTag, '"old"');
  assert.equal(result['@microsoft.graph.downloadUrl'], undefined);
  const writer = mock([metadata, bytes, { id: 'doc', eTag: '"new"' }]);
  await run('word_append', { fileId: 'doc', eTag: '"old"', paragraphs: ['Appended'] }, writer.api);
  assert.equal(writer.calls[1].format, 'bytes');
  assert.equal(writer.calls[2].path, '/me/drive/items/doc/content');
  assert.equal(new Headers(writer.calls[2].init?.headers).get('If-Match'), '"old"');
  const edited = Buffer.from(writer.calls[2].init?.body as Uint8Array);
  assert.deepEqual(new AdmZip(edited).readFile('word/media/image1.png'), Buffer.from([1, 2, 3]));
  assert.equal(readWord(edited).paragraphs.at(-1)?.text, 'Appended');
});

test('Word stale eTag and oversized files fail before download or write', async () => {
  for (const metadata of [
    { name: 'a.docx', size: 10, eTag: 'new' },
    { name: 'a.docx', size: 15_000_000, eTag: 'old' },
  ]) {
    const { api, calls } = mock([metadata]);
    await assert.rejects(run('word_append', { fileId: 'd', eTag: 'old', paragraphs: ['x'] }, api), /changed|12 MiB/);
    assert.equal(calls.length, 1);
  }
});

test('Plain Word edits preserve section configuration and refuse complex paragraphs', () => {
  assert.equal(readWord(createWord(['Line one\nLine two'])).paragraphs[0].text, 'Line one\nLine two');
  const original = createWord(['First', 'Second']);
  const changed = replaceWordParagraph(original, 0, 'First', 'New & improved');
  assert.equal(readWord(changed).paragraphs[0].text, 'New & improved');
  const xml = new AdmZip(appendWord(changed, ['Last'])).readAsText('word/document.xml');
  assert.ok(xml.indexOf('Last') < xml.indexOf('<w:sectPr>'));
  assert.throws(() => replaceWordParagraph(original, 0, 'Not first', 'x'), /no longer matches/);
  const complex = new AdmZip(original);
  complex.updateFile(
    'word/document.xml',
    Buffer.from(
      complex.readAsText('word/document.xml').replace('<w:r>', '<w:bookmarkStart w:id="1" w:name="x"/><w:r>'),
    ),
  );
  assert.throws(() => replaceWordParagraph(complex.toBuffer(), 0, 'First', 'x'), /complex content/);
});

test('PowerPoint create, ordered text read, append and exact text edit preserve existing slide content', () => {
  const original = createPresentation([
    { title: 'Title & 中文', paragraphs: ['One', 'Two'] },
    { title: 'Second', paragraphs: ['End'] },
  ]);
  assert.deepEqual(
    readPresentation(original).slides.map((s) => s.text),
    ['Title & 中文\nOne\nTwo', 'Second\nEnd'],
  );
  const appended = appendPresentationSlide(original, { title: 'Third', paragraphs: ['New'] });
  assert.equal(readPresentation(appended).totalSlides, 3);
  assert.deepEqual(
    new AdmZip(original).readFile('ppt/slides/slide1.xml'),
    new AdmZip(appended).readFile('ppt/slides/slide1.xml'),
  );
  const changed = replacePresentationText(appended, 0, 'One', 'Updated');
  assert.equal(readPresentation(changed).slides[0].text, 'Title & 中文\nUpdated\nTwo');
  assert.throws(() => replacePresentationText(original, 0, 'Missing', 'x'), /exactly match/);
  const repeated = createPresentation([{ title: 'Same', paragraphs: ['Same'] }]);
  assert.throws(() => replacePresentationText(repeated, 0, 'Same', 'x'), /exactly match/);
});

test('Office packages reject malformed XML, entities, signatures, macros and suspicious compression sizes', () => {
  const original = createWord(['safe']);
  for (const mutate of [
    (zip: AdmZip) => zip.addFile('_xmlsignatures/sig1.xml', Buffer.from('x')),
    (zip: AdmZip) => zip.addFile('word/vbaProject.bin', Buffer.from('x')),
    (zip: AdmZip) =>
      zip.updateFile('word/document.xml', Buffer.from('<!DOCTYPE x [<!ENTITY x SYSTEM "file:///secret">]><x/>')),
    (zip: AdmZip) => zip.updateFile('word/document.xml', Buffer.from('<broken>')),
    (zip: AdmZip) => zip.addFile('word/header.xml', Buffer.from('<!DOCTYPE x><x/>')),
    (zip: AdmZip) => zip.updateFile('word/document.xml', Buffer.from('<a>'.repeat(300) + '</a>'.repeat(300))),
  ]) {
    const zip = new AdmZip(original);
    mutate(zip);
    assert.throws(() => readWord(zip.toBuffer()));
  }
  const bomb = Buffer.from(original);
  const central = bomb.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.ok(central >= 0);
  bomb.writeUInt32LE(0x7fffffff, central + 24);
  assert.throws(() => readWord(bomb), /decompression limits/);
  assert.throws(() => createWord(['bad\u0000text']), /invalid in XML/);
  assert.throws(() => createPresentation([{ title: '\ud800', paragraphs: [] }]), /invalid in XML/);
});

test('Basic xlsx writer escapes names and provides workbook relationships', () => {
  const zip = new AdmZip(createWorkbook('A&B'));
  assert.match(zip.readAsText('xl/workbook.xml'), /A&amp;B/);
  assert.match(zip.readAsText('xl/_rels/workbook.xml.rels'), /worksheets\/sheet1.xml/);
  assert.match(zip.readAsText('xl/worksheets/sheet1.xml'), /sheetData/);
});
