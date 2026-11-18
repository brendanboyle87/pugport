import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { OfficeApi, OfficeOperation } from './connector-office.ts';
import type { ConnectorCapability } from '../shared/connectors.ts';
import {
  appendPresentationSlide,
  appendWord,
  createPresentation,
  createWord,
  createWorkbook,
  officePackageLimit,
  readPresentation,
  readWord,
  replacePresentationText,
  replaceWordParagraph,
} from './connectors-office-xml.ts';

const id = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((v) => !/[\x00-\x1f]/.test(v) && v !== '.' && v !== '..');
const short = z.string().trim().min(1).max(500);
const text = z.string().max(50_000);
const pageFields = {
  pageSize: z.number().int().min(1).max(100).default(50),
  cursor: z.string().max(16_000).optional(),
};
const fileFields = { fileId: id, driveId: id.optional() };
const etag = z
  .string()
  .min(1)
  .max(500)
  .refine((v) => v.trim() !== '*' && !/[\x00-\x1f]/.test(v));
const filename = (extension: string) =>
  z
    .string()
    .min(extension.length + 1)
    .max(180)
    .refine(
      (v) =>
        v.toLowerCase().endsWith(extension) &&
        !/[\x00-\x1f<>:"/\\|?*]/.test(v) &&
        !v.endsWith(' ') &&
        v !== '.' &&
        v !== '..',
      `Use a plain ${extension} filename, not a path.`,
    );
const paragraphs = z
  .array(z.string().max(10_000))
  .min(1)
  .max(500)
  .refine((v) => v.reduce((sum, p) => sum + p.length, 0) <= 100_000, 'Use at most 100,000 text characters.');
const slide = z.object({ title: z.string().max(200), paragraphs: z.array(z.string().max(3_000)).max(20) }).strict();
const locationFields = { driveId: id.optional(), parentFolderId: id.optional() };
const instant = z.string().datetime({ offset: true });
const dateTime = z
  .object({ dateTime: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?$/), timeZone: short })
  .strict();
const body = z.object({ contentType: z.enum(['text', 'html']).default('text'), content: text }).strict();
const address = z.string().regex(/^\$?[A-Z]{1,3}\$?[1-9]\d{0,6}(?::\$?[A-Z]{1,3}\$?[1-9]\d{0,6})?$/i);
const cell = z.union([z.string().max(32_767), z.number().finite(), z.boolean(), z.null()]);
const matrix = z
  .array(z.array(cell).min(1).max(100))
  .min(1)
  .max(1_000)
  .refine(
    (rows) => rows.every((r) => r.length === rows[0].length) && rows.length * rows[0].length <= 10_000,
    'Use a rectangular range of at most 10,000 cells.',
  );
const formulaMatrix = z
  .array(z.array(z.string().max(8_192).nullable()).min(1).max(100))
  .min(1)
  .max(1_000)
  .refine(
    (rows) => rows.every((r) => r.length === rows[0].length) && rows.length * rows[0].length <= 10_000,
    'Use a rectangular range of at most 10,000 cells.',
  );
const enc = (v: string) => encodeURIComponent(v).replace(/'/g, '%27');
const json = (method: string, value?: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  ...(value === undefined ? {} : { body: JSON.stringify(value) }),
});
const drivePath = (a: { driveId?: string }) => (a.driveId ? `/drives/${enc(a.driveId)}` : '/me/drive');
const filePath = (a: { driveId?: string; fileId: string }) => `${drivePath(a)}/items/${enc(a.fileId)}`;

function operation(
  name: string,
  capability: ConnectorCapability,
  readOnly: boolean,
  description: string,
  schema: z.ZodObject<any>,
  run: OfficeOperation['run'],
): OfficeOperation {
  return { name: `connector_microsoft_${name}`, provider: 'microsoft', capability, readOnly, description, schema, run };
}

function cursorPath(cursor: string, base: string, query: Record<string, string>, pageSize: number): string {
  let parsed: URL;
  try {
    parsed = new URL(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Invalid Microsoft continuation cursor.');
  }
  if (
    parsed.origin !== 'https://graph.microsoft.com' ||
    parsed.pathname !== `/v1.0${base}` ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  )
    throw new Error('Microsoft continuation cursor does not belong to this collection.');
  const allowed = new Set(['$skiptoken', '$skip', '$top', ...Object.keys(query)]);
  for (const key of parsed.searchParams.keys()) {
    if (!allowed.has(key) || parsed.searchParams.getAll(key).length !== 1)
      throw new Error('Unsupported or repeated Microsoft continuation parameter.');
    if (key in query && parsed.searchParams.get(key) !== query[key])
      throw new Error('Microsoft continuation cursor belongs to a different search or time interval.');
  }
  if (parsed.searchParams.has('$top') && !/^\d+$/.test(parsed.searchParams.get('$top')!))
    throw new Error('Invalid Microsoft page size.');
  const size = Number(parsed.searchParams.get('$top') || pageSize);
  if (size < 1 || size > pageSize || size > 100)
    throw new Error('Microsoft continuation page size exceeds the requested limit.');
  parsed.searchParams.set('$top', String(size));
  for (const [key, value] of Object.entries(query)) parsed.searchParams.set(key, value);
  return `${base}${parsed.search}`;
}
async function page(api: OfficeApi, base: string, a: any, query: Record<string, string> = {}) {
  const path = a.cursor
    ? cursorPath(a.cursor, base, query, a.pageSize)
    : `${base}?${new URLSearchParams({ ...query, $top: String(a.pageSize) })}`;
  const result = await api(path);
  const next = typeof result?.['@odata.nextLink'] === 'string' ? result['@odata.nextLink'] : undefined;
  let nextCursor: string | undefined;
  if (next) {
    if (next.length > 12_000) throw new Error('Microsoft continuation cursor is too large.');
    nextCursor = Buffer.from(next).toString('base64url');
    cursorPath(nextCursor, base, query, a.pageSize);
  }
  return { items: Array.isArray(result?.value) ? result.value : [], nextCursor, hasMore: Boolean(nextCursor) };
}

async function workbook(api: OfficeApi, a: any) {
  const drive = await api(`${drivePath(a)}?$select=id,driveType`);
  if (drive?.driveType === 'personal')
    throw new Error(
      'Microsoft Excel workbook APIs do not support personal OneDrive. Use an .xlsx file in OneDrive for Business or SharePoint.',
    );
  if (!['business', 'documentLibrary'].includes(drive?.driveType))
    throw new Error('The drive type could not be verified as OneDrive for Business or SharePoint.');
  return `${filePath(a)}/workbook`;
}

const officeMime = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
function fileResult(value: any) {
  return { id: value?.id, name: value?.name, webUrl: value?.webUrl, eTag: value?.eTag };
}
async function readPackage(api: OfficeApi, a: any, extension: 'docx' | 'pptx') {
  const metadata = await api(`${filePath(a)}?$select=id,name,size,eTag,webUrl`);
  if (typeof metadata?.name !== 'string' || !metadata.name.toLowerCase().endsWith(`.${extension}`))
    throw new Error(`This operation requires a .${extension} file.`);
  if (typeof metadata.size !== 'number' || metadata.size < 0 || metadata.size > officePackageLimit)
    throw new Error('Office file exceeds the 12 MiB limit or its size is unknown.');
  if (a.eTag && metadata.eTag !== a.eTag)
    throw new Error('This document changed since it was read. Read it again before editing.');
  const bytes = await api(`${filePath(a)}/content`, undefined, 'bytes');
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > officePackageLimit)
    throw new Error('Invalid or oversized Office file content.');
  return { metadata, bytes };
}
async function uploadPackage(api: OfficeApi, a: any, content: Uint8Array, extension: 'docx' | 'pptx' | 'xlsx') {
  const base = a.parentFolderId ? `${drivePath(a)}/items/${enc(a.parentFolderId)}` : `${drivePath(a)}/root`;
  const path = a.fileId
    ? `${filePath(a)}/content`
    : `${base}:/${enc(a.name)}:/content?@microsoft.graph.conflictBehavior=fail`;
  return fileResult(
    await api(path, {
      method: 'PUT',
      headers: { 'Content-Type': officeMime[extension], ...(a.fileId ? { 'If-Match': a.eTag } : {}) },
      body: new Uint8Array(content),
    }),
  );
}

function dimensions(value: string) {
  const match = /^(\$?)([A-Z]{1,3})\$?(\d+)(?::\$?([A-Z]{1,3})\$?(\d+))?$/i.exec(value)!;
  const col = (v: string) => [...v.toUpperCase()].reduce((sum, c) => sum * 26 + c.charCodeAt(0) - 64, 0);
  const left = col(match[2]),
    right = col(match[4] || match[2]);
  const top = Number(match[3]),
    bottom = Number(match[5] || match[3]);
  if (
    left > right ||
    top > bottom ||
    right > 16_384 ||
    bottom > 1_048_576 ||
    (bottom - top + 1) * (right - left + 1) > 10_000
  )
    throw new Error('Use a valid Excel range of at most 10,000 cells.');
  return { rows: bottom - top + 1, columns: right - left + 1 };
}

const attendees = z
  .array(
    z
      .object({
        emailAddress: z.object({ address: z.string().email().max(254), name: short.optional() }).strict(),
        type: z.enum(['required', 'optional', 'resource']).default('required'),
      })
      .strict(),
  )
  .max(100);
const eventFields = {
  subject: short,
  body: body.optional(),
  start: dateTime,
  end: dateTime,
  location: z.object({ displayName: short }).strict().optional(),
  attendees: attendees.optional(),
  isAllDay: z.boolean().optional(),
  reminderMinutesBeforeStart: z.number().int().min(0).max(40_320).optional(),
};
const taskFields = {
  title: short,
  body: body.optional(),
  dueDateTime: dateTime.nullable().optional(),
  importance: z.enum(['low', 'normal', 'high']).optional(),
  status: z.enum(['notStarted', 'inProgress', 'completed', 'waitingOnOthers', 'deferred']).optional(),
};
const contactFields = {
  givenName: z.string().max(200).optional(),
  surname: z.string().max(200).optional(),
  displayName: short.optional(),
  companyName: z.string().max(200).optional(),
  jobTitle: z.string().max(200).optional(),
  emailAddresses: z
    .array(z.object({ address: z.string().email().max(254), name: z.string().max(200).optional() }).strict())
    .max(10)
    .optional(),
  businessPhones: z.array(z.string().max(100)).max(10).optional(),
  mobilePhone: z.string().max(100).optional(),
  personalNotes: text.optional(),
};
const contact = z
  .object(contactFields)
  .strict()
  .refine(
    (a) => Boolean(a.givenName || a.surname || a.displayName || a.emailAddresses?.length),
    'Provide a contact name or email.',
  );

export const microsoftOfficeOperations: OfficeOperation[] = [
  operation(
    'word_read',
    'files_read',
    true,
    'Read body and table text from a .docx file up to 12 MiB, returning paragraph indices and eTag. Does not render images, headers, fields or complex layout.',
    z.object(fileFields).strict(),
    async (a, api) => {
      const { metadata, bytes } = await readPackage(api, a, 'docx');
      return { ...fileResult(metadata), ...readWord(bytes) };
    },
  ),
  operation(
    'word_create',
    'documents_write',
    false,
    'Create a basic .docx document from plain paragraphs. Fails if the chosen filename already exists; does not overwrite files.',
    z.object({ ...locationFields, name: filename('.docx'), paragraphs }).strict(),
    (a, api) => uploadPackage(api, a, createWord(a.paragraphs), 'docx'),
  ),
  operation(
    'word_append',
    'documents_write',
    false,
    'Append plain paragraphs to a .docx body, preserving other package parts. Supply eTag from word_read; concurrent changes are rejected.',
    z.object({ ...fileFields, eTag: etag, paragraphs }).strict(),
    async (a, api) => {
      const { bytes } = await readPackage(api, a, 'docx');
      return uploadPackage(api, a, appendWord(bytes, a.paragraphs), 'docx');
    },
  ),
  operation(
    'word_replace_paragraph',
    'documents_write',
    false,
    'Replace one exact plain body paragraph by zero-based index and expectedText. Rejects table paragraphs, mixed formatting, fields and other complex content. Uses eTag concurrency protection.',
    z
      .object({
        ...fileFields,
        eTag: etag,
        paragraphIndex: z.number().int().min(0).max(100_000),
        expectedText: z.string().max(50_000),
        replacementText: z.string().max(50_000),
      })
      .strict(),
    async (a, api) => {
      const { bytes } = await readPackage(api, a, 'docx');
      return uploadPackage(
        api,
        a,
        replaceWordParagraph(bytes, a.paragraphIndex, a.expectedText, a.replacementText),
        'docx',
      );
    },
  ),
  operation(
    'powerpoint_read',
    'slides_read',
    true,
    'Read slide text in presentation order from a .pptx file up to 12 MiB and return its eTag. Does not render images, charts, notes or animations.',
    z.object(fileFields).strict(),
    async (a, api) => {
      const { metadata, bytes } = await readPackage(api, a, 'pptx');
      return { ...fileResult(metadata), ...readPresentation(bytes) };
    },
  ),
  operation(
    'powerpoint_create',
    'slides_write',
    false,
    'Create a basic .pptx with title and body text on each slide. This is a plain text deck, not a rich presentation designer. Fails on existing filenames.',
    z
      .object({
        ...locationFields,
        name: filename('.pptx'),
        slides: z
          .array(slide)
          .min(1)
          .max(100)
          .refine((v) => JSON.stringify(v).length <= 200_000, 'Use at most 200,000 slide text characters.'),
      })
      .strict(),
    (a, api) => uploadPackage(api, a, createPresentation(a.slides), 'pptx'),
  ),
  operation(
    'powerpoint_append_slide',
    'slides_write',
    false,
    'Append one basic title-and-body slide, preserving existing slides. Supply current eTag. Complex layouts are not edited.',
    z.object({ ...fileFields, eTag: etag, slide }).strict(),
    async (a, api) => {
      const { bytes } = await readPackage(api, a, 'pptx');
      return uploadPackage(api, a, appendPresentationSlide(bytes, a.slide), 'pptx');
    },
  ),
  operation(
    'powerpoint_replace_text',
    'slides_write',
    false,
    'Replace exactly one matching text run on a zero-based slide. Duplicate text or text split over formatting runs is rejected. Preserves other slide content and checks eTag.',
    z
      .object({
        ...fileFields,
        eTag: etag,
        slideIndex: z.number().int().min(0).max(199),
        expectedText: z.string().min(1).max(50_000),
        replacementText: z.string().max(50_000),
      })
      .strict(),
    async (a, api) => {
      const { bytes } = await readPackage(api, a, 'pptx');
      return uploadPackage(
        api,
        a,
        replacePresentationText(bytes, a.slideIndex, a.expectedText, a.replacementText),
        'pptx',
      );
    },
  ),
  operation(
    'excel_create',
    'sheets_write',
    false,
    'Create a new blank .xlsx workbook in OneDrive for Business or SharePoint, then use excel_write to fill cells. Personal OneDrive is unsupported; existing filenames are never overwritten.',
    z
      .object({
        ...locationFields,
        name: filename('.xlsx'),
        worksheetName: z
          .string()
          .min(1)
          .max(31)
          .refine((v) => !/[\[\]:*?/\\]/.test(v))
          .default('Sheet1'),
      })
      .strict(),
    async (a, api) => {
      await workbook(api, { ...a, fileId: 'unused' });
      return uploadPackage(api, a, createWorkbook(a.worksheetName), 'xlsx');
    },
  ),
  operation(
    'excel_sheets',
    'sheets_read',
    true,
    'List worksheets in an existing .xlsx workbook in OneDrive for Business or SharePoint. Personal OneDrive is unsupported.',
    z.object({ ...fileFields, ...pageFields }).strict(),
    async (a, api) => page(api, `${await workbook(api, a)}/worksheets`, a),
  ),
  operation(
    'excel_read',
    'sheets_read',
    true,
    'Read up to 10,000 cells including values, text, formulas and formats. Supply an explicit worksheet and A1 range.',
    z.object({ ...fileFields, worksheetId: id, range: address }).strict(),
    async (a, api) => {
      dimensions(a.range);
      return api(`${await workbook(api, a)}/worksheets/${enc(a.worksheetId)}/range(address='${a.range}')`);
    },
  ),
  operation(
    'excel_write',
    'sheets_write',
    false,
    'Update a precise Excel range. Values and formulas must match range dimensions; null leaves a cell unchanged. Formulas are executable workbook content.',
    z
      .object({
        ...fileFields,
        worksheetId: id,
        range: address,
        values: matrix.optional(),
        formulas: formulaMatrix.optional(),
        numberFormat: formulaMatrix.optional(),
      })
      .strict()
      .refine((a) => a.values || a.formulas || a.numberFormat, 'Provide values, formulas or numberFormat.'),
    async (a, api) => {
      const size = dimensions(a.range);
      for (const entries of [a.values, a.formulas, a.numberFormat])
        if (entries && (entries.length !== size.rows || entries[0].length !== size.columns))
          throw new Error('Excel data dimensions must exactly match the requested range.');
      return api(
        `${await workbook(api, a)}/worksheets/${enc(a.worksheetId)}/range(address='${a.range}')`,
        json('PATCH', { values: a.values, formulas: a.formulas, numberFormat: a.numberFormat }),
      );
    },
  ),
  operation(
    'excel_add_sheet',
    'sheets_write',
    false,
    'Add one worksheet to an existing business or SharePoint .xlsx workbook.',
    z
      .object({
        ...fileFields,
        name: z
          .string()
          .min(1)
          .max(31)
          .refine((v) => !/[\[\]:*?/\\]/.test(v)),
      })
      .strict(),
    async (a, api) => api(`${await workbook(api, a)}/worksheets/add`, json('POST', { name: a.name })),
  ),
  operation(
    'excel_add_table',
    'sheets_write',
    false,
    'Create an Excel table from an explicit existing cell range.',
    z.object({ ...fileFields, worksheetId: id, range: address, hasHeaders: z.boolean() }).strict(),
    async (a, api) => {
      dimensions(a.range);
      return api(
        `${await workbook(api, a)}/worksheets/${enc(a.worksheetId)}/tables/add`,
        json('POST', { address: a.range, hasHeaders: a.hasHeaders }),
      );
    },
  ),
  operation(
    'calendars_list',
    'calendar_read',
    true,
    'List calendars available in the selected Microsoft account.',
    z.object(pageFields).strict(),
    (a, api) => page(api, '/me/calendars', a),
  ),
  operation(
    'calendar_events',
    'calendar_read',
    true,
    'Read calendar occurrences within an explicit date-time interval. Continue with nextCursor until hasMore is false.',
    z
      .object({ calendarId: id.optional(), start: instant, end: instant, ...pageFields })
      .strict()
      .refine(
        (a) => Date.parse(a.end) > Date.parse(a.start) && Date.parse(a.end) - Date.parse(a.start) <= 366 * 86_400_000,
        'The interval must be positive and at most 366 days.',
      ),
    (a, api) =>
      page(api, a.calendarId ? `/me/calendars/${enc(a.calendarId)}/calendarView` : '/me/calendarView', a, {
        startDateTime: a.start,
        endDateTime: a.end,
      }),
  ),
  operation(
    'calendar_read',
    'calendar_read',
    true,
    'Read one Microsoft calendar event, including attendees, body and recurrence details.',
    z.object({ eventId: id }).strict(),
    (a, api) => api(`/me/events/${enc(a.eventId)}`),
  ),
  operation(
    'calendar_create',
    'calendar_write',
    false,
    'Create a calendar event. Including attendees sends invitations to those people; confirm recipients and times before calling.',
    z.object({ calendarId: id.optional(), ...eventFields }).strict(),
    (a, api) => {
      const { calendarId, ...event } = a;
      return api(
        calendarId ? `/me/calendars/${enc(calendarId)}/events` : '/me/events',
        json('POST', { ...event, transactionId: randomUUID() }),
      );
    },
  ),
  operation(
    'calendar_update',
    'calendar_write',
    false,
    'Update selected event fields. Changes to meetings can notify attendees; confirm the exact event and changes.',
    z
      .object({
        eventId: id,
        changes: z
          .object(eventFields)
          .partial()
          .strict()
          .refine((a) => Object.keys(a).length > 0, 'Provide at least one change.'),
      })
      .strict(),
    (a, api) => api(`/me/events/${enc(a.eventId)}`, json('PATCH', a.changes)),
  ),
  operation(
    'calendar_delete',
    'calendar_write',
    false,
    'Delete one event. Deleting a meeting organized by this account sends cancellations to attendees.',
    z.object({ eventId: id }).strict(),
    async (a, api) => {
      await api(`/me/events/${enc(a.eventId)}`, json('DELETE'));
      return { deleted: true, eventId: a.eventId };
    },
  ),
  operation(
    'task_lists',
    'tasks_read',
    true,
    'List Microsoft To Do task lists.',
    z.object(pageFields).strict(),
    (a, api) => page(api, '/me/todo/lists', a),
  ),
  operation(
    'task_list_create',
    'tasks_write',
    false,
    'Create a named Microsoft To Do list.',
    z.object({ displayName: short }).strict(),
    (a, api) => api('/me/todo/lists', json('POST', a)),
  ),
  operation(
    'task_list_update',
    'tasks_write',
    false,
    'Rename one Microsoft To Do list.',
    z.object({ listId: id, displayName: short }).strict(),
    (a, api) => api(`/me/todo/lists/${enc(a.listId)}`, json('PATCH', { displayName: a.displayName })),
  ),
  operation(
    'task_list_delete',
    'tasks_write',
    false,
    'Delete a Microsoft To Do list and its contained tasks. Confirm the list and scope.',
    z.object({ listId: id }).strict(),
    async (a, api) => {
      await api(`/me/todo/lists/${enc(a.listId)}`, json('DELETE'));
      return { deleted: true, listId: a.listId };
    },
  ),
  operation(
    'tasks_list',
    'tasks_read',
    true,
    'List tasks in one Microsoft To Do list; continue with nextCursor for more.',
    z.object({ listId: id, ...pageFields }).strict(),
    (a, api) => page(api, `/me/todo/lists/${enc(a.listId)}/tasks`, a),
  ),
  operation(
    'task_read',
    'tasks_read',
    true,
    'Read one Microsoft To Do task.',
    z.object({ listId: id, taskId: id }).strict(),
    (a, api) => api(`/me/todo/lists/${enc(a.listId)}/tasks/${enc(a.taskId)}`),
  ),
  operation(
    'task_create',
    'tasks_write',
    false,
    'Create a Microsoft To Do task with optional due date and notes.',
    z.object({ listId: id, ...taskFields }).strict(),
    (a, api) => {
      const { listId, ...task } = a;
      return api(`/me/todo/lists/${enc(listId)}/tasks`, json('POST', task));
    },
  ),
  operation(
    'task_update',
    'tasks_write',
    false,
    'Update a task, including marking completed, without replacing unspecified fields.',
    z
      .object({
        listId: id,
        taskId: id,
        changes: z
          .object(taskFields)
          .partial()
          .strict()
          .refine((a) => Object.keys(a).length > 0, 'Provide at least one change.'),
      })
      .strict(),
    (a, api) => api(`/me/todo/lists/${enc(a.listId)}/tasks/${enc(a.taskId)}`, json('PATCH', a.changes)),
  ),
  operation(
    'task_delete',
    'tasks_write',
    false,
    'Delete one task from a Microsoft To Do list.',
    z.object({ listId: id, taskId: id }).strict(),
    async (a, api) => {
      await api(`/me/todo/lists/${enc(a.listId)}/tasks/${enc(a.taskId)}`, json('DELETE'));
      return { deleted: true, taskId: a.taskId };
    },
  ),
  operation(
    'contacts_list',
    'contacts_read',
    true,
    'List Outlook contacts. An optional name prefix filters display names; continue with nextCursor for more.',
    z.object({ ...pageFields, namePrefix: z.string().min(1).max(100).optional() }).strict(),
    (a, api) =>
      page(
        api,
        '/me/contacts',
        a,
        a.namePrefix ? { $filter: `startswith(displayName,'${a.namePrefix.replace(/'/g, "''")}')` } : {},
      ),
  ),
  operation(
    'contact_read',
    'contacts_read',
    true,
    'Read a single Outlook contact.',
    z.object({ contactId: id }).strict(),
    (a, api) => api(`/me/contacts/${enc(a.contactId)}`),
  ),
  operation(
    'contact_create',
    'contacts_write',
    false,
    'Create an Outlook contact in the selected account.',
    z.object({ contact }).strict(),
    (a, api) => api('/me/contacts', json('POST', a.contact)),
  ),
  operation(
    'contact_update',
    'contacts_write',
    false,
    'Update specified fields of one Outlook contact; omitted fields are preserved.',
    z
      .object({
        contactId: id,
        changes: z
          .object(contactFields)
          .strict()
          .refine((a) => Object.keys(a).length > 0, 'Provide at least one change.'),
      })
      .strict(),
    (a, api) => api(`/me/contacts/${enc(a.contactId)}`, json('PATCH', a.changes)),
  ),
  operation(
    'contact_delete',
    'contacts_write',
    false,
    'Delete one Outlook contact.',
    z.object({ contactId: id }).strict(),
    async (a, api) => {
      await api(`/me/contacts/${enc(a.contactId)}`, json('DELETE'));
      return { deleted: true, contactId: a.contactId };
    },
  ),
];
