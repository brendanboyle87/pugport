import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { OfficeApi, OfficeOperation } from './connector-office.ts';

// Official v1 APIs: Gmail messages.modify/trash/untrash, labels.create;
// Drive files.create/update; Graph message move/update, mailFolders, driveItem update/delete/put-content.
const id = z
  .string()
  .min(1)
  .max(500)
  .refine((s) => !/[\x00-\x1f]/.test(s) && !['.', '..'].includes(s));
const name = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((s) => !/[\x00-\x1f/\\]/.test(s) && !['.', '..'].includes(s));
const labelName = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((s) => !/[\x00-\x1f\x7f]/.test(s));
const etag = z
  .string()
  .min(1)
  .max(1000)
  .refine((s) => !/[\x00-\x1f\x7f*]/.test(s));
const version = z.string().regex(/^\d{1,40}$/);
const enc = encodeURIComponent;
const json = (method: string, value: unknown, headers?: Record<string, string>): RequestInit => ({
  method,
  body: JSON.stringify(value),
  headers,
});
const op = (value: OfficeOperation) => value;
const fileFields = 'id,name,mimeType,parents,trashed,size,modifiedTime,webViewLink,version';
const graphItem = (itemId: string) => (itemId === 'root' ? '/me/drive/root' : `/me/drive/items/${enc(itemId)}`);
const folderFields = 'id,displayName,parentFolderId,childFolderCount,totalItemCount,unreadItemCount';
const graphFileFields = 'id,name,eTag,file,folder,parentReference,size,webUrl';
const fileSchema = z.object({ id }).strict();

function googleFileMeta(api: OfficeApi, itemId: string) {
  return api(`/drive/v3/files/${enc(itemId)}?fields=${fileFields}&supportsAllDrives=true`);
}
async function googleVersion(api: OfficeApi, itemId: string, expected: string) {
  const file = await googleFileMeta(api, itemId);
  if (file.version === undefined || !version.safeParse(String(file.version)).success)
    throw new Error('Drive did not return a valid file version; no changes were made.');
  if (String(file.version) !== expected)
    throw new Error('File changed since it was read; read it again before modifying.');
  return file;
}

export const managementOperations: OfficeOperation[] = [
  op({
    name: 'connector_google_mail_labels',
    provider: 'google',
    capability: 'mail_read',
    readOnly: true,
    description: 'List Gmail labels and IDs for classifying mail.',
    schema: z.object({}).strict(),
    run: (_a, api) => api('/gmail/v1/users/me/labels'),
  }),
  op({
    name: 'connector_google_mail_create_label',
    provider: 'google',
    capability: 'mail_manage',
    readOnly: false,
    description:
      'Create a Gmail label after confirmation; slash separates nested labels. Does not create automatic inbox rules.',
    schema: z.object({ name: labelName }).strict(),
    run: (a, api) =>
      api(
        '/gmail/v1/users/me/labels',
        json('POST', { name: a.name, labelListVisibility: 'labelShow', messageListVisibility: 'show' }),
      ),
  }),
  op({
    name: 'connector_google_mail_modify',
    provider: 'google',
    capability: 'mail_manage',
    readOnly: false,
    description:
      'Classify one Gmail message with labels, mark read/unread, star/unstar or archive. Use removeLabelIds=[INBOX] to archive, UNREAD to mark read. No permanent deletion or sending.',
    schema: z
      .object({ id, addLabelIds: z.array(id).max(20).default([]), removeLabelIds: z.array(id).max(20).default([]) })
      .strict(),
    run: (a, api) => {
      if (!a.addLabelIds.length && !a.removeLabelIds.length) throw new Error('Specify labels to add or remove.');
      if (a.addLabelIds.some((label: string) => a.removeLabelIds.includes(label)))
        throw new Error('A label cannot be added and removed together.');
      return api(
        `/gmail/v1/users/me/messages/${enc(a.id)}/modify`,
        json('POST', { addLabelIds: a.addLabelIds, removeLabelIds: a.removeLabelIds }),
      );
    },
  }),
  ...(['trash', 'untrash'] as const).map((action) =>
    op({
      name: `connector_google_mail_${action}`,
      provider: 'google',
      capability: 'mail_manage',
      readOnly: false,
      description:
        action === 'trash'
          ? 'Move one Gmail message to Trash after confirmation. Never permanently deletes.'
          : 'Restore one Gmail message from Trash.',
      schema: fileSchema,
      run: (a, api) => api(`/gmail/v1/users/me/messages/${enc(a.id)}/${action}`, json('POST', {})),
    }),
  ),
  op({
    name: 'connector_microsoft_mail_folders',
    provider: 'microsoft',
    capability: 'mail_read',
    readOnly: true,
    description: 'List Outlook mail folders or children of a folder. Use nextCursor for additional pages.',
    schema: z
      .object({
        parentId: id.optional(),
        cursor: z.string().max(12000).optional(),
        limit: z.number().int().min(1).max(100).default(50),
      })
      .strict(),
    run: async (a, api) => {
      const path = a.parentId ? `/me/mailFolders/${enc(a.parentId)}/childFolders` : '/me/mailFolders';
      const url = graphPage(a.cursor, path, a.limit, folderFields) ?? `${path}?$top=${a.limit}&$select=${folderFields}`;
      const result = await api(url);
      return {
        folders: result.value ?? [],
        nextCursor: graphCursor(result['@odata.nextLink'], path, a.limit, folderFields),
      };
    },
  }),
  op({
    name: 'connector_microsoft_mail_create_folder',
    provider: 'microsoft',
    capability: 'mail_manage',
    readOnly: false,
    description: 'Create an Outlook mailbox folder after confirmation.',
    schema: z.object({ name, parentId: id.optional() }).strict(),
    run: (a, api) =>
      api(
        a.parentId ? `/me/mailFolders/${enc(a.parentId)}/childFolders` : '/me/mailFolders',
        json('POST', { displayName: a.name }),
      ),
  }),
  op({
    name: 'connector_microsoft_mail_modify',
    provider: 'microsoft',
    capability: 'mail_manage',
    readOnly: false,
    description:
      "Mark an Outlook message read/unread, set categories or a flag after confirmation. categories replaces that message's category list.",
    schema: z
      .object({
        id,
        isRead: z.boolean().optional(),
        categories: z.array(z.string().min(1).max(200)).max(20).optional(),
        flag: z.enum(['notFlagged', 'complete', 'flagged']).optional(),
      })
      .strict(),
    run: (a, api) => {
      if (a.isRead === undefined && a.categories === undefined && a.flag === undefined)
        throw new Error('Specify a change.');
      return api(
        `/me/messages/${enc(a.id)}`,
        json('PATCH', {
          isRead: a.isRead,
          categories: a.categories,
          flag: a.flag ? { flagStatus: a.flag } : undefined,
        }),
      );
    },
  }),
  op({
    name: 'connector_microsoft_mail_move',
    provider: 'microsoft',
    capability: 'mail_manage',
    readOnly: false,
    description:
      'Move one Outlook message to a folder after confirmation. destinationId can be archive, inbox or deleteditems (recycle bin). Returns its new message ID. No permanent deletion.',
    schema: z.object({ id, destinationId: id }).strict(),
    run: (a, api) => api(`/me/messages/${enc(a.id)}/move`, json('POST', { destinationId: a.destinationId })),
  }),
  op({
    name: 'connector_google_files_metadata',
    provider: 'google',
    capability: 'files_read',
    readOnly: true,
    description: 'Read Drive file/folder metadata, parents and current version before rename, move or trash.',
    schema: fileSchema,
    run: (a, api) => googleFileMeta(api, a.id),
  }),
  op({
    name: 'connector_google_files_list_folder',
    provider: 'google',
    capability: 'files_read',
    readOnly: true,
    description: 'List children in one Google Drive folder, including folders; use nextCursor until absent.',
    schema: z
      .object({
        parentId: id.default('root'),
        cursor: z.string().max(10000).optional(),
        limit: z.number().int().min(1).max(100).default(50),
      })
      .strict(),
    run: async (a, api) => {
      const parent = a.parentId.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      const p = new URLSearchParams({
        q: `'${parent}' in parents and trashed = false`,
        pageSize: String(a.limit),
        fields: `nextPageToken,files(${fileFields})`,
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true',
      });
      if (a.cursor) p.set('pageToken', a.cursor);
      const result = await api(`/drive/v3/files?${p}`);
      return { files: result.files ?? [], nextCursor: result.nextPageToken };
    },
  }),
  op({
    name: 'connector_google_files_create_folder',
    provider: 'google',
    capability: 'files_write',
    readOnly: false,
    description: 'Create a Google Drive folder inside the specified parent.',
    schema: z.object({ name, parentId: id.default('root') }).strict(),
    run: (a, api) =>
      api(
        `/drive/v3/files?fields=${fileFields}&supportsAllDrives=true`,
        json('POST', { name: a.name, mimeType: 'application/vnd.google-apps.folder', parents: [a.parentId] }),
      ),
  }),
  op({
    name: 'connector_google_files_create_text',
    provider: 'google',
    capability: 'files_write',
    readOnly: false,
    description:
      'Create a new UTF-8 text/Markdown/CSV/JSON file in Drive. Never overwrites an existing file; Drive permits duplicate names.',
    schema: z
      .object({
        name,
        parentId: id.default('root'),
        text: z.string().max(12000),
        mimeType: z.enum(['text/plain', 'text/markdown', 'text/csv', 'application/json']).default('text/plain'),
      })
      .strict(),
    run: (a, api) => {
      const boundary = `pugport_${randomUUID()}`;
      const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: a.name, parents: [a.parentId], mimeType: a.mimeType })}\r\n--${boundary}\r\nContent-Type: ${a.mimeType}; charset=UTF-8\r\n\r\n${a.text}\r\n--${boundary}--`;
      return api(`/upload/drive/v3/files?uploadType=multipart&fields=${fileFields}&supportsAllDrives=true`, {
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body,
      });
    },
  }),
  op({
    name: 'connector_google_files_update',
    provider: 'google',
    capability: 'files_write',
    readOnly: false,
    description:
      'Rename or move a Drive file/folder after confirmation. Read metadata first and supply version. Version is a preflight check, not an atomic lock. Move replaces current parents.',
    schema: z.object({ id, version, name: name.optional(), parentId: id.optional() }).strict(),
    run: async (a, api) => {
      if (!a.name && !a.parentId) throw new Error('Specify a new name or parent.');
      const file = await googleVersion(api, a.id, a.version);
      if (a.parentId === a.id) throw new Error('A folder cannot contain itself.');
      const p = new URLSearchParams({ fields: fileFields, supportsAllDrives: 'true' });
      if (a.parentId && !(file.parents ?? []).includes(a.parentId)) {
        p.set('addParents', a.parentId);
        if (file.parents?.length) p.set('removeParents', file.parents.join(','));
      }
      return api(`/drive/v3/files/${enc(a.id)}?${p}`, json('PATCH', { name: a.name }));
    },
  }),
  op({
    name: 'connector_google_files_trash',
    provider: 'google',
    capability: 'files_write',
    readOnly: false,
    description:
      'Move a Drive file/folder to Trash or restore it after confirmation. Folder trash affects its contents. Never permanently deletes. Read current version first; preflight is not an atomic lock.',
    schema: z.object({ id, version, trashed: z.boolean() }).strict(),
    run: async (a, api) => {
      await googleVersion(api, a.id, a.version);
      return api(
        `/drive/v3/files/${enc(a.id)}?fields=${fileFields}&supportsAllDrives=true`,
        json('PATCH', { trashed: a.trashed }),
      );
    },
  }),
  op({
    name: 'connector_microsoft_files_metadata',
    provider: 'microsoft',
    capability: 'files_read',
    readOnly: true,
    description: 'Read OneDrive item metadata and eTag before editing or recycling.',
    schema: fileSchema,
    run: (a, api) => api(`${graphItem(a.id)}?$select=${graphFileFields}`),
  }),
  op({
    name: 'connector_microsoft_files_list_folder',
    provider: 'microsoft',
    capability: 'files_read',
    readOnly: true,
    description: 'List OneDrive folder children. Follow nextCursor to continue.',
    schema: z
      .object({
        parentId: id.default('root'),
        cursor: z.string().max(12000).optional(),
        limit: z.number().int().min(1).max(100).default(50),
      })
      .strict(),
    run: async (a, api) => {
      const base = a.parentId === 'root' ? '/me/drive/root/children' : `${graphItem(a.parentId)}/children`;
      const result = await api(
        graphPage(a.cursor, base, a.limit, graphFileFields) ?? `${base}?$top=${a.limit}&$select=${graphFileFields}`,
      );
      return {
        files: result.value ?? [],
        nextCursor: graphCursor(result['@odata.nextLink'], base, a.limit, graphFileFields),
      };
    },
  }),
  op({
    name: 'connector_microsoft_files_create_folder',
    provider: 'microsoft',
    capability: 'files_write',
    readOnly: false,
    description: 'Create a OneDrive folder, failing if the name already exists.',
    schema: z.object({ name, parentId: id.default('root') }).strict(),
    run: (a, api) =>
      api(
        a.parentId === 'root' ? '/me/drive/root/children' : `${graphItem(a.parentId)}/children`,
        json('POST', { name: a.name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }),
      ),
  }),
  op({
    name: 'connector_microsoft_files_create_text',
    provider: 'microsoft',
    capability: 'files_write',
    readOnly: false,
    description: 'Create a new UTF-8 text file in OneDrive; fails on a name conflict.',
    schema: z.object({ name, parentId: id.default('root'), text: z.string().max(12000) }).strict(),
    run: (a, api) =>
      api(
        `${a.parentId === 'root' ? '/me/drive/root' : graphItem(a.parentId)}:/${enc(a.name)}:/content?@microsoft.graph.conflictBehavior=fail`,
        { method: 'PUT', headers: { 'Content-Type': 'text/plain; charset=UTF-8' }, body: a.text },
      ),
  }),
  op({
    name: 'connector_microsoft_files_update',
    provider: 'microsoft',
    capability: 'files_write',
    readOnly: false,
    description:
      'Rename or move a OneDrive file/folder within the same drive; read metadata eTag first to avoid overwriting a concurrent change. Does not move between drives.',
    schema: z.object({ id, etag, name: name.optional(), parentId: id.optional() }).strict(),
    run: async (a, api) => {
      if (!a.name && !a.parentId) throw new Error('Specify a new name or parent.');
      if (a.id === 'root') throw new Error('The OneDrive root cannot be renamed or moved.');
      let parentId = a.parentId;
      // Graph accepts root in resource paths but requires its actual ID in parentReference.
      if (parentId === 'root') {
        const root = await api('/me/drive/root?$select=id');
        parentId = id.parse(root?.id);
      }
      if (parentId === a.id) throw new Error('A folder cannot contain itself.');
      return api(
        `${graphItem(a.id)}?@microsoft.graph.conflictBehavior=fail`,
        json(
          'PATCH',
          { name: a.name, parentReference: parentId ? { id: parentId } : undefined },
          { 'If-Match': a.etag },
        ),
      );
    },
  }),
  op({
    name: 'connector_microsoft_files_trash',
    provider: 'microsoft',
    capability: 'files_write',
    readOnly: false,
    description:
      'Move a OneDrive item to the recycle bin after confirmation. A folder affects all its contents. Read eTag first. No permanent delete.',
    schema: z.object({ id, etag }).strict(),
    run: (a, api) => {
      if (a.id === 'root') throw new Error('The OneDrive root cannot be recycled.');
      return api(graphItem(a.id), { method: 'DELETE', headers: { 'If-Match': a.etag } });
    },
  }),
];

// Cursors can only return to the same official collection. No token is sent to a user-supplied origin.
function graphPage(cursor: string | undefined, path: string, limit: number, select: string): string | undefined {
  if (!cursor) return undefined;
  if (cursor.length > 12000 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error('Invalid pagination cursor.');
  let url: URL;
  try {
    url = new URL(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Invalid pagination cursor.');
  }
  if (
    url.origin !== 'https://graph.microsoft.com' ||
    url.username ||
    url.password ||
    url.hash ||
    url.pathname !== '/v1.0' + path
  )
    throw new Error('Invalid pagination cursor for this collection.');
  const allowed = new Set(['$top', '$select', '$skip', '$skiptoken', '$skipToken']);
  if ([...url.searchParams.keys()].some((key) => !allowed.has(key))) throw new Error('Invalid pagination parameters.');
  for (const key of allowed)
    if (url.searchParams.getAll(key).length > 1) throw new Error('Duplicate pagination parameters.');
  const top = url.searchParams.get('$top');
  if (top !== null && (!/^[1-9]\d*$/.test(top) || Number(top) > limit))
    throw new Error('Pagination exceeds the requested page size.');
  const skip = url.searchParams.get('$skip');
  if (skip !== null && (!/^\d+$/.test(skip) || !Number.isSafeInteger(Number(skip))))
    throw new Error('Invalid pagination offset.');
  const selected = url.searchParams.get('$select');
  if (selected !== null && selected.split(',').sort().join(',') !== select.split(',').sort().join(','))
    throw new Error('Pagination cannot change the selected fields.');
  if (!top) url.searchParams.set('$top', String(limit));
  if (!selected) url.searchParams.set('$select', select);
  return url.pathname.slice('/v1.0'.length) + url.search;
}
function graphCursor(value: string | undefined, path: string, limit: number, select: string): string | undefined {
  if (!value) return undefined;
  const cursor = Buffer.from(value).toString('base64url');
  graphPage(cursor, path, limit, select);
  return cursor;
}
