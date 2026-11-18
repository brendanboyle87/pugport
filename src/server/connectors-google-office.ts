import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { OfficeOperation } from './connector-office.ts';

const id = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[^\u0000-\u001f\u007f/\\?#]+$/)
  .refine((s) => s !== '.' && s !== '..');
const title = z.string().trim().min(1).max(1024);
const text = z.string().max(100_000);
const token = z.string().min(1).max(8192).optional();
const pageSize = z.number().int().min(1).max(100).default(50);
const revision = z.string().min(1).max(1024);
const etag = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[^\r\n*]+$/);
const date = z.iso.date();
const timestamp = z.iso.datetime({ offset: true });
const enc = encodeURIComponent;
const json = (method: string, body: unknown, headers?: Record<string, string>): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});
function query(path: string, params: Record<string, unknown>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined) search.set(key, String(value));
  return search.size ? `${path}?${search}` : path;
}
function operation(
  name: string,
  capability: OfficeOperation['capability'],
  readOnly: boolean,
  description: string,
  schema: OfficeOperation['schema'],
  run: OfficeOperation['run'],
): OfficeOperation {
  return { name: `connector_google_${name}`, provider: 'google', capability, readOnly, description, schema, run };
}
function patchFields(args: Record<string, any>, keys: string[]) {
  return Object.fromEntries(keys.filter((key) => args[key] !== undefined).map((key) => [key, args[key]]));
}

// Docs may contain multiple nested tabs. Traverse paragraphs, tables and table-of-contents;
// never silently treat the first tab as the complete document.
function documentText(document: any, selectedTab?: string) {
  const tabs: { id: string; title: string }[] = [];
  const chunks: string[] = [];
  function content(elements: any[]) {
    for (const element of elements ?? []) {
      for (const part of element.paragraph?.elements ?? []) {
        if (typeof part.textRun?.content === 'string') chunks.push(part.textRun.content);
        if (part.inlineObjectElement) chunks.push('[Embedded object]');
      }
      for (const row of element.table?.tableRows ?? []) for (const cell of row.tableCells ?? []) content(cell.content);
      if (element.tableOfContents) content(element.tableOfContents.content);
    }
  }
  function body(body: any) {
    content(body?.body?.content);
    for (const section of ['headers', 'footers', 'footnotes'])
      for (const item of Object.values(body?.[section] ?? {}) as any[]) content(item.content);
  }
  function walk(items: any[]) {
    for (const tab of items ?? []) {
      const tabId = String(tab.tabProperties?.tabId ?? '');
      const tabTitle = String(tab.tabProperties?.title ?? '');
      tabs.push({ id: tabId, title: tabTitle });
      if (!selectedTab || selectedTab === tabId) body(tab.documentTab);
      walk(tab.childTabs);
    }
  }
  if (document.tabs?.length) walk(document.tabs);
  else if (!selectedTab) body(document);
  if (selectedTab && !tabs.some((tab) => tab.id === selectedTab)) throw new Error('Document tab was not found.');
  return { tabs, text: chunks.join('') };
}
const docs = (documentId: string) => `/docs/v1/documents/${enc(documentId)}`;

// Reject whole-column/whole-sheet reads. A model can page through explicit A1 rectangles.
function rangeSize(value: string) {
  const match =
    /^(?:(?:'(?:[^']|'')+'|[^'!]+)!)?\$?([A-Za-z]{1,3})\$?([1-9]\d{0,6})(?::\$?([A-Za-z]{1,3})\$?([1-9]\d{0,6}))?$/.exec(
      value,
    );
  if (!match) return null;
  const col = (s: string) => [...s.toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
  const columns = col(match[3] ?? match[1]) - col(match[1]) + 1;
  const rows = Number(match[4] ?? match[2]) - Number(match[2]) + 1;
  return rows > 0 && columns > 0 && rows <= 1000 && columns <= 100 && rows * columns <= 10_000
    ? { rows, columns }
    : null;
}
const range = z
  .string()
  .min(1)
  .max(300)
  .refine(
    (value) => rangeSize(value) !== null,
    'Use an explicit A1 rectangle, at most 1000 rows, 100 columns and 10000 cells.',
  );
const values = z
  .array(
    z
      .array(z.union([z.string().max(20_000), z.number().finite(), z.boolean(), z.null()]))
      .min(1)
      .max(100),
  )
  .min(1)
  .max(1000)
  .refine(
    (rows) => rows.reduce((n, row) => n + row.length, 0) <= 10_000 && JSON.stringify(rows).length <= 500_000,
    'At most 10000 cells and 500000 characters per write.',
  );
const sheet = (spreadsheetId: string) => `/sheets/v4/spreadsheets/${enc(spreadsheetId)}`;
const slides = (presentationId: string) => `/slides/v1/presentations/${enc(presentationId)}`;
const sheetInput = {
  spreadsheetId: id,
  range,
  values,
  valueInputOption: z.enum(['RAW', 'USER_ENTERED']).default('RAW'),
};

const eventInterval = z
  .discriminatedUnion('type', [
    z.strictObject({
      type: z.literal('timed'),
      start: timestamp,
      end: timestamp,
      timeZone: z.string().min(1).max(100).optional(),
    }),
    z.strictObject({ type: z.literal('allDay'), start: date, end: date }),
  ])
  .refine((v) => Date.parse(v.end) > Date.parse(v.start), 'The exclusive end must be after the start.');
const eventFields = {
  summary: title,
  description: z.string().max(20_000).optional(),
  location: z.string().max(2000).optional(),
  interval: eventInterval,
  attendees: z
    .array(z.strictObject({ email: z.email().max(320), optional: z.boolean().optional() }))
    .max(100)
    .optional(),
};
const eventPatch = {
  summary: title.optional(),
  description: z.string().max(20_000).optional(),
  location: z.string().max(2000).optional(),
  interval: eventInterval.optional(),
  attendees: eventFields.attendees,
};
const sendUpdates = z.enum(['all', 'externalOnly', 'none']).default('all');
const calendarId = id.default('primary');
const calendar = (id: string) => `/calendar/v3/calendars/${enc(id)}`;
function eventBody(args: any) {
  const result = patchFields(args, ['summary', 'description', 'location', 'attendees']);
  if (args.interval) {
    const v = args.interval;
    result.start =
      v.type === 'allDay' ? { date: v.start } : { dateTime: v.start, ...(v.timeZone ? { timeZone: v.timeZone } : {}) };
    result.end =
      v.type === 'allDay' ? { date: v.end } : { dateTime: v.end, ...(v.timeZone ? { timeZone: v.timeZone } : {}) };
  }
  if (!Object.keys(result).length) throw new Error('Specify at least one event field to update.');
  return result;
}
const taskListId = id.default('@default');
const tasks = (taskListId: string) => `/tasks/v1/lists/${enc(taskListId)}/tasks`;
const taskFields = {
  title,
  notes: z.string().max(8192).optional(),
  dueDate: date.nullable().optional(),
  status: z.enum(['needsAction', 'completed']).optional(),
};
function taskBody(args: any) {
  const body = patchFields(args, ['title', 'notes', 'status']);
  if (args.dueDate !== undefined) body.due = args.dueDate === null ? null : `${args.dueDate}T00:00:00.000Z`;
  if (!Object.keys(body).length) throw new Error('Specify at least one task field to update.');
  return body;
}
const personId = z.string().regex(/^people\/[A-Za-z0-9_-]{1,200}$/);
const personFields = 'names,emailAddresses,phoneNumbers,organizations,biographies,metadata';
const contactFields = {
  givenName: z.string().max(200).optional(),
  familyName: z.string().max(200).optional(),
  emailAddresses: z
    .array(z.strictObject({ value: z.email().max(320), type: z.enum(['home', 'work', 'other']).optional() }))
    .max(20)
    .optional(),
  phoneNumbers: z
    .array(
      z.strictObject({
        value: z.string().min(1).max(100),
        type: z.enum(['home', 'work', 'mobile', 'other']).optional(),
      }),
    )
    .max(20)
    .optional(),
  organization: z.string().max(500).nullable().optional(),
  notes: z.string().max(8192).nullable().optional(),
};
function contactBody(args: any, old?: any) {
  const body = patchFields(args, ['emailAddresses', 'phoneNumbers']);
  if (args.givenName !== undefined || args.familyName !== undefined) {
    const previous = old?.names?.find((n: any) => n.metadata?.source?.type === 'CONTACT') ?? old?.names?.[0] ?? {};
    body.names = [
      {
        ...patchFields(previous, [
          'givenName',
          'familyName',
          'middleName',
          'honorificPrefix',
          'honorificSuffix',
          'phoneticFullName',
          'phoneticGivenName',
          'phoneticMiddleName',
          'phoneticFamilyName',
        ]),
        givenName: args.givenName ?? previous.givenName ?? '',
        familyName: args.familyName ?? previous.familyName ?? '',
      },
    ];
  }
  if (args.organization !== undefined)
    body.organizations = args.organization === null ? [] : [{ name: args.organization }];
  if (args.notes !== undefined)
    body.biographies = args.notes === null ? [] : [{ value: args.notes, contentType: 'TEXT_PLAIN' }];
  if (!Object.keys(body).length) throw new Error('Specify at least one contact field.');
  return body;
}
const person = (resourceName: string) => `/people/v1/people/${enc(resourceName.slice('people/'.length))}`;

export const googleOfficeOperations: OfficeOperation[] = [
  operation(
    'docs_read',
    'files_read',
    true,
    'Read Google Docs text across nested tabs, tables, headers and footnotes. Use nextOffset until null for the full text. Embedded images are marked, not interpreted.',
    z.strictObject({
      documentId: id,
      tabId: id.optional(),
      offset: z.number().int().min(0).max(100_000_000).default(0),
      limit: z.number().int().min(1).max(50_000).default(20_000),
      expectedRevisionId: revision.optional(),
    }),
    async (a, api) => {
      const doc = await api(query(docs(a.documentId), { includeTabsContent: true }));
      if (a.expectedRevisionId && doc.revisionId !== a.expectedRevisionId)
        throw new Error('Document changed while reading. Restart from offset 0.');
      const result = documentText(doc, a.tabId);
      return {
        documentId: doc.documentId,
        title: doc.title,
        revisionId: doc.revisionId,
        tabs: result.tabs,
        text: result.text.slice(a.offset, a.offset + a.limit),
        totalCharacters: result.text.length,
        nextOffset: a.offset + a.limit < result.text.length ? a.offset + a.limit : null,
      };
    },
  ),
  operation(
    'docs_create',
    'documents_write',
    false,
    'Create an empty Google Doc. Append text in a separate call; returns the new document ID.',
    z.strictObject({ title }),
    (a, api) => api('/docs/v1/documents', json('POST', { title: a.title })),
  ),
  operation(
    'docs_append',
    'documents_write',
    false,
    'Append plain text to a Google Doc body, optionally a specific tab. Read first and pass its revision ID to avoid overwriting concurrent work.',
    z.strictObject({ documentId: id, tabId: id.optional(), text: text.min(1), requiredRevisionId: revision }),
    (a, api) =>
      api(
        `${docs(a.documentId)}:batchUpdate`,
        json('POST', {
          writeControl: { requiredRevisionId: a.requiredRevisionId },
          requests: [{ insertText: { endOfSegmentLocation: a.tabId ? { tabId: a.tabId } : {}, text: a.text } }],
        }),
      ),
  ),
  operation(
    'docs_replace_text',
    'documents_write',
    false,
    'Replace every exact occurrence of text in a Google Doc, optionally within one tab. Case-sensitive; no regex. Requires the revision from a preceding read.',
    z.strictObject({
      documentId: id,
      tabId: id.optional(),
      find: text.min(1),
      replace: text,
      requiredRevisionId: revision,
    }),
    (a, api) =>
      api(
        `${docs(a.documentId)}:batchUpdate`,
        json('POST', {
          writeControl: { requiredRevisionId: a.requiredRevisionId },
          requests: [
            {
              replaceAllText: {
                containsText: { text: a.find, matchCase: true },
                replaceText: a.replace,
                ...(a.tabId ? { tabsCriteria: { tabIds: [a.tabId] } } : {}),
              },
            },
          ],
        }),
      ),
  ),
  operation(
    'sheets_create',
    'sheets_write',
    false,
    'Create a Google spreadsheet with named worksheet tabs.',
    z.strictObject({
      title,
      sheetTitles: z
        .array(
          z
            .string()
            .min(1)
            .max(100)
            .regex(/^[^\[\]:*?/\\]+$/),
        )
        .min(1)
        .max(20)
        .default(['Sheet1'])
        .refine((v) => new Set(v.map((s) => s.toLowerCase())).size === v.length, 'Worksheet names must be distinct.'),
    }),
    (a, api) =>
      api(
        '/sheets/v4/spreadsheets',
        json('POST', {
          properties: { title: a.title },
          sheets: a.sheetTitles.map((title: string) => ({ properties: { title } })),
        }),
      ),
  ),
  operation(
    'sheets_metadata',
    'sheets_read',
    true,
    'List worksheet names, IDs and grid dimensions without downloading cells.',
    z.strictObject({ spreadsheetId: id }),
    (a, api) =>
      api(
        query(sheet(a.spreadsheetId), {
          fields: 'spreadsheetId,spreadsheetUrl,properties(title,locale,timeZone),sheets(properties)',
        }),
      ),
  ),
  operation(
    'sheets_read',
    'sheets_read',
    true,
    'Read up to 10000 cells using an explicit A1 rectangle. Select FORMULA to inspect formulas, or FORMATTED_VALUE for displayed text.',
    z.strictObject({
      spreadsheetId: id,
      range,
      valueRenderOption: z.enum(['FORMATTED_VALUE', 'UNFORMATTED_VALUE', 'FORMULA']).default('FORMATTED_VALUE'),
    }),
    (a, api) =>
      api(
        query(`${sheet(a.spreadsheetId)}/values/${enc(a.range)}`, {
          valueRenderOption: a.valueRenderOption,
          majorDimension: 'ROWS',
        }),
      ),
  ),
  operation(
    'sheets_update',
    'sheets_write',
    false,
    'Write a bounded cell rectangle. RAW preserves text literally (including leading =); choose USER_ENTERED explicitly to calculate formulas. Null skips cells; empty string clears a cell.',
    z.strictObject(sheetInput),
    (a, api) => {
      const size = rangeSize(a.range)!;
      if (a.values.length > size.rows || a.values.some((row: unknown[]) => row.length > size.columns))
        throw new Error('Values extend outside the selected range.');
      return api(
        query(`${sheet(a.spreadsheetId)}/values/${enc(a.range)}`, { valueInputOption: a.valueInputOption }),
        json('PUT', { range: a.range, majorDimension: 'ROWS', values: a.values }),
      );
    },
  ),
  operation(
    'sheets_append',
    'sheets_write',
    false,
    'Append rows after the detected table in an explicit A1 search range. INSERT_ROWS may extend the sheet. RAW is the default; formulas require explicit USER_ENTERED.',
    z.strictObject(sheetInput),
    (a, api) => {
      if (a.values.some((row: unknown[]) => row.length > rangeSize(a.range)!.columns))
        throw new Error('Values extend outside the selected columns.');
      return api(
        query(`${sheet(a.spreadsheetId)}/values/${enc(a.range)}:append`, {
          valueInputOption: a.valueInputOption,
          insertDataOption: 'INSERT_ROWS',
        }),
        json('POST', { majorDimension: 'ROWS', values: a.values }),
      );
    },
  ),
  operation(
    'slides_create',
    'slides_write',
    false,
    'Create an empty Google Slides presentation.',
    z.strictObject({ title }),
    (a, api) => api('/slides/v1/presentations', json('POST', { title: a.title })),
  ),
  operation(
    'slides_read',
    'slides_read',
    true,
    'Read a bounded page of slide structures and text, including tables and speaker notes. Use nextOffset until null.',
    z.strictObject({
      presentationId: id,
      offset: z.number().int().min(0).max(100_000).default(0),
      limit: z.number().int().min(1).max(20).default(5),
      expectedRevisionId: revision.optional(),
    }),
    async (a, api) => {
      const presentation = await api(slides(a.presentationId));
      if (a.expectedRevisionId && presentation.revisionId !== a.expectedRevisionId)
        throw new Error('Presentation changed while reading. Restart from offset 0.');
      const items = presentation.slides ?? [];
      return {
        presentationId: presentation.presentationId,
        title: presentation.title,
        revisionId: presentation.revisionId,
        pageSize: presentation.pageSize,
        slides: items.slice(a.offset, a.offset + a.limit),
        totalSlides: items.length,
        nextOffset: a.offset + a.limit < items.length ? a.offset + a.limit : null,
      };
    },
  ),
  operation(
    'slides_add_text_slide',
    'slides_write',
    false,
    'Add one basic title-and-body text slide sized to the current deck. Requires the current revision; returns the created slide ID. This does not generate images or charts.',
    z.strictObject({
      presentationId: id,
      title,
      body: text,
      insertionIndex: z.number().int().min(0).max(10_000).optional(),
      requiredRevisionId: revision,
    }),
    async (a, api) => {
      const presentation = await api(query(slides(a.presentationId), { fields: 'presentationId,revisionId,pageSize' }));
      if (presentation.revisionId !== a.requiredRevisionId)
        throw new Error('Presentation changed since it was read. Read it again before adding a slide.');
      const width = presentation.pageSize?.width;
      const height = presentation.pageSize?.height;
      if (
        !['EMU', 'PT'].includes(width?.unit) ||
        width?.unit !== height?.unit ||
        !(width?.magnitude > 0) ||
        !(height?.magnitude > 0) ||
        !Number.isFinite(width.magnitude) ||
        !Number.isFinite(height.magnitude)
      )
        throw new Error('The presentation did not return a valid page size.');
      const key = `pugport_${randomUUID().replaceAll('-', '')}`;
      const slideId = `${key}_slide`,
        titleId = `${key}_title`,
        bodyId = `${key}_body`;
      const shape = (objectId: string, top: number, h: number) => ({
        createShape: {
          objectId,
          shapeType: 'TEXT_BOX',
          elementProperties: {
            pageObjectId: slideId,
            size: {
              width: { magnitude: width.magnitude * 0.86, unit: width.unit },
              height: { magnitude: height.magnitude * h, unit: height.unit },
            },
            transform: {
              scaleX: 1,
              scaleY: 1,
              shearX: 0,
              shearY: 0,
              translateX: width.magnitude * 0.07,
              translateY: height.magnitude * top,
              unit: width.unit,
            },
          },
        },
      });
      // Explicit shapes work even for custom themes without TITLE_AND_BODY placeholders.
      const requests: any[] = [
        {
          createSlide: {
            objectId: slideId,
            ...(a.insertionIndex !== undefined ? { insertionIndex: a.insertionIndex } : {}),
          },
        },
        shape(titleId, 0.07, 0.2),
        { insertText: { objectId: titleId, text: a.title } },
        {
          updateTextStyle: {
            objectId: titleId,
            textRange: { type: 'ALL' },
            style: { bold: true, fontSize: { magnitude: 28, unit: 'PT' } },
            fields: 'bold,fontSize',
          },
        },
      ];
      if (a.body)
        requests.push(
          shape(bodyId, 0.3, 0.62),
          { insertText: { objectId: bodyId, text: a.body } },
          {
            updateTextStyle: {
              objectId: bodyId,
              textRange: { type: 'ALL' },
              style: { fontSize: { magnitude: 18, unit: 'PT' } },
              fields: 'fontSize',
            },
          },
        );
      const result = await api(
        `${slides(a.presentationId)}:batchUpdate`,
        json('POST', { writeControl: { requiredRevisionId: a.requiredRevisionId }, requests }),
      );
      return { ...result, slideId };
    },
  ),
  operation(
    'slides_replace_text',
    'slides_write',
    false,
    'Replace exact case-sensitive text in selected slides (or the whole deck if omitted). Requires the current revision; no regex.',
    z.strictObject({
      presentationId: id,
      slideIds: z.array(id).min(1).max(100).optional(),
      find: text.min(1),
      replace: text,
      requiredRevisionId: revision,
    }),
    (a, api) =>
      api(
        `${slides(a.presentationId)}:batchUpdate`,
        json('POST', {
          writeControl: { requiredRevisionId: a.requiredRevisionId },
          requests: [
            {
              replaceAllText: {
                containsText: { text: a.find, matchCase: true },
                replaceText: a.replace,
                ...(a.slideIds ? { pageObjectIds: a.slideIds } : {}),
              },
            },
          ],
        }),
      ),
  ),
  operation(
    'calendar_list',
    'calendar_read',
    true,
    'List available Google calendars. Continue with the returned nextPageToken when present.',
    z.strictObject({ pageToken: token, pageSize }),
    (a, api) => api(query('/calendar/v3/users/me/calendarList', { maxResults: a.pageSize, pageToken: a.pageToken })),
  ),
  operation(
    'calendar_freebusy',
    'calendar_read',
    true,
    'Check busy times for up to 50 explicitly named calendars. Provider errors mean availability is unknown, not free. This never creates an event.',
    z
      .strictObject({ calendarIds: z.array(id).min(1).max(50), timeMin: timestamp, timeMax: timestamp })
      .refine((a) => Date.parse(a.timeMax) > Date.parse(a.timeMin), 'timeMax must be after timeMin.'),
    (a, api) =>
      api(
        '/calendar/v3/freeBusy',
        json('POST', {
          timeMin: a.timeMin,
          timeMax: a.timeMax,
          calendarExpansionMax: 50,
          items: a.calendarIds.map((id: string) => ({ id })),
        }),
      ),
  ),
  operation(
    'calendar_events_list',
    'calendar_read',
    true,
    'List occurrences in an explicit time window, sorted by start time. Page through nextPageToken. RFC3339 timestamps require a timezone offset.',
    z
      .strictObject({
        calendarId,
        timeMin: timestamp,
        timeMax: timestamp,
        query: z.string().max(1000).optional(),
        pageToken: token,
        pageSize,
      })
      .refine((a) => Date.parse(a.timeMax) > Date.parse(a.timeMin), 'timeMax must be after timeMin.'),
    (a, api) =>
      api(
        query(`${calendar(a.calendarId)}/events`, {
          timeMin: a.timeMin,
          timeMax: a.timeMax,
          q: a.query,
          maxResults: a.pageSize,
          pageToken: a.pageToken,
          singleEvents: true,
          orderBy: 'startTime',
        }),
      ),
  ),
  operation(
    'calendar_event_read',
    'calendar_read',
    true,
    'Read an event including its ETag, attendees and recurrence details before editing.',
    z.strictObject({ calendarId, eventId: id }),
    (a, api) => api(`${calendar(a.calendarId)}/events/${enc(a.eventId)}`),
  ),
  operation(
    'calendar_event_create',
    'calendar_write',
    false,
    'Create a calendar event. Attendees receive invitations with sendUpdates=all (default). All-day end dates are exclusive. No recurrence or conferencing is inferred.',
    z.strictObject({ calendarId, ...eventFields, sendUpdates }),
    (a, api) =>
      api(query(`${calendar(a.calendarId)}/events`, { sendUpdates: a.sendUpdates }), json('POST', eventBody(a))),
  ),
  operation(
    'calendar_event_update',
    'calendar_write',
    false,
    'Patch only supplied event fields. Attendees replaces the attendee list. Requires the ETag from a read; updating a recurring master affects the series. Guest notifications default to all.',
    z.strictObject({ calendarId, eventId: id, etag, ...eventPatch, sendUpdates }),
    (a, api) =>
      api(
        query(`${calendar(a.calendarId)}/events/${enc(a.eventId)}`, { sendUpdates: a.sendUpdates }),
        json('PATCH', eventBody(a), { 'If-Match': a.etag }),
      ),
  ),
  operation(
    'calendar_event_delete',
    'calendar_write',
    false,
    'Delete one event by ID and current ETag. A recurring master deletes the series; use an occurrence ID to delete only that occurrence. Sends cancellation to guests by default.',
    z.strictObject({ calendarId, eventId: id, etag, sendUpdates }),
    async (a, api) => {
      await api(query(`${calendar(a.calendarId)}/events/${enc(a.eventId)}`, { sendUpdates: a.sendUpdates }), {
        method: 'DELETE',
        headers: { 'If-Match': a.etag },
      });
      return { deleted: true, calendarId: a.calendarId, eventId: a.eventId };
    },
  ),
  operation(
    'tasks_lists',
    'tasks_read',
    true,
    'List Google Tasks lists, continuing with nextPageToken when present.',
    z.strictObject({ pageToken: token, pageSize }),
    (a, api) => api(query('/tasks/v1/users/@me/lists', { maxResults: a.pageSize, pageToken: a.pageToken })),
  ),
  operation(
    'tasks_list_create',
    'tasks_write',
    false,
    'Create a named Google Tasks list.',
    z.strictObject({ title }),
    (a, api) => api('/tasks/v1/users/@me/lists', json('POST', { title: a.title })),
  ),
  operation(
    'tasks_list',
    'tasks_read',
    true,
    'List tasks, including completed/hidden tasks only when requested. Continue with nextPageToken.',
    z.strictObject({
      taskListId,
      pageToken: token,
      pageSize,
      showCompleted: z.boolean().default(false),
      showHidden: z.boolean().default(false),
    }),
    (a, api) =>
      api(
        query(tasks(a.taskListId), {
          maxResults: a.pageSize,
          pageToken: a.pageToken,
          showCompleted: a.showCompleted,
          showHidden: a.showHidden,
        }),
      ),
  ),
  operation(
    'tasks_read',
    'tasks_read',
    true,
    'Read one task, including ETag and assignment information.',
    z.strictObject({ taskListId, taskId: id }),
    (a, api) => api(`${tasks(a.taskListId)}/${enc(a.taskId)}`),
  ),
  operation(
    'tasks_create',
    'tasks_write',
    false,
    'Create a task, optionally under a parent task. dueDate is date-only: Google Tasks does not preserve the time of day.',
    z.strictObject({ taskListId, parentTaskId: id.optional(), ...taskFields }),
    (a, api) => api(query(tasks(a.taskListId), { parent: a.parentTaskId }), json('POST', taskBody(a))),
  ),
  operation(
    'tasks_update',
    'tasks_write',
    false,
    'Patch task title, notes, completion or date-only due date. Null dueDate clears it. Requires current ETag.',
    z.strictObject({ taskListId, taskId: id, etag, ...taskFields, title: title.optional() }),
    (a, api) => api(`${tasks(a.taskListId)}/${enc(a.taskId)}`, json('PATCH', taskBody(a), { 'If-Match': a.etag })),
  ),
  operation(
    'tasks_delete',
    'tasks_write',
    false,
    'Delete a task by ID and ETag. Assigned tasks from Docs or Chat are rejected to avoid also deleting their source task.',
    z.strictObject({ taskListId, taskId: id, etag }),
    async (a, api) => {
      const path = `${tasks(a.taskListId)}/${enc(a.taskId)}`;
      const task = await api(path);
      if (task.etag !== a.etag) throw new Error('Task changed since it was read. Read it again before deleting.');
      if (task.assignmentInfo) throw new Error('Delete assigned tasks in their original Docs or Chat surface.');
      await api(path, { method: 'DELETE', headers: { 'If-Match': a.etag } });
      return { deleted: true, taskListId: a.taskListId, taskId: a.taskId };
    },
  ),
  operation(
    'contacts_list',
    'contacts_read',
    true,
    'List saved Google contacts with names, emails, phone numbers, organizations and notes. Page through nextPageToken.',
    z.strictObject({ pageToken: token, pageSize }),
    (a, api) =>
      api(
        query('/people/v1/people/me/connections', {
          personFields,
          pageSize: a.pageSize,
          pageToken: a.pageToken,
          sources: 'READ_SOURCE_TYPE_CONTACT',
        }),
      ),
  ),
  operation(
    'contacts_search',
    'contacts_read',
    true,
    'Search saved Google contacts by name, email, phone or organization prefix. Returns at most 30 matches; use contacts_list for a complete paginated address book.',
    z.strictObject({
      query: z.string().trim().min(1).max(1000),
      pageSize: z.number().int().min(1).max(30).default(20),
    }),
    async (a, api) => {
      const path = '/people/v1/people:searchContacts';
      // Required by People API to refresh the contact-search cache before matching.
      await api(query(path, { query: '', readMask: personFields, pageSize: 1 }));
      return api(query(path, { query: a.query, readMask: personFields, pageSize: a.pageSize }));
    },
  ),
  operation(
    'contacts_read',
    'contacts_read',
    true,
    'Read a saved contact including the person ETag and contact-source metadata needed for edits.',
    z.strictObject({ resourceName: personId }),
    (a, api) => api(query(person(a.resourceName), { personFields, sources: 'READ_SOURCE_TYPE_CONTACT' })),
  ),
  operation(
    'contacts_create',
    'contacts_write',
    false,
    'Create a Google contact. Only specified fields are written; this never sends a message.',
    z.strictObject(contactFields),
    (a, api) => api(query('/people/v1/people:createContact', { personFields }), json('POST', contactBody(a))),
  ),
  operation(
    'contacts_update',
    'contacts_write',
    false,
    'Update specified Google contact fields. Email/phone arrays replace those fields. Null organization or notes clears them. Requires person ETag from a preceding read.',
    z.strictObject({ resourceName: personId, etag, ...contactFields }),
    async (a, api) => {
      const existing = await api(query(person(a.resourceName), { personFields, sources: 'READ_SOURCE_TYPE_CONTACT' }));
      if (existing.etag !== a.etag)
        throw new Error('Contact changed since it was read. Read it again before updating.');
      const source = existing.metadata?.sources?.find((s: any) => s.type === 'CONTACT');
      if (!source?.id || !source?.etag) throw new Error('This person has no editable contact source.');
      const body = contactBody(a, existing);
      const updatePersonFields = Object.keys(body).join(',');
      return api(
        query(`${person(a.resourceName)}:updateContact`, { updatePersonFields, personFields }),
        json('PATCH', { ...body, metadata: { sources: [{ type: 'CONTACT', id: source.id, etag: source.etag }] } }),
      );
    },
  ),
  operation(
    'contacts_delete',
    'contacts_write',
    false,
    'Delete one saved Google contact. This does not message that person. Deletion has no provider-side revision precondition.',
    z.strictObject({ resourceName: personId }),
    async (a, api) => {
      await api(`${person(a.resourceName)}:deleteContact`, { method: 'DELETE' });
      return { deleted: true, resourceName: a.resourceName };
    },
  ),
];
