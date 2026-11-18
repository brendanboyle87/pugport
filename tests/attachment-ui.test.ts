import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AttachmentScopeChanged,
  attachmentContentUrl,
  attachmentMimeType,
  externalAttachmentWarning,
  filesFromTransfer,
  selectAttachmentFiles,
  uploadDraftAttachments,
  type DraftAttachment,
} from '../src/ui/attachments.ts';
import { MessageAttachments } from '../src/ui/Workspace.tsx';
import type { Attachment } from '../src/shared/types.ts';

const draft = (file: File, id = file.name): DraftAttachment => ({ id, file });
const result = (id: string, name = 'fixture.png'): Attachment => ({
  id,
  name,
  mimeType: 'image/png',
  size: 4,
  kind: 'image',
});
const file = (name: string, type = 'application/octet-stream') => new File(['test'], name, { type });
const sized = (name: string, size: number, type = 'application/octet-stream') => ({ name, size, type }) as File;

test('external agent attachment preflight warns only for direct external requests with files', () => {
  for (const id of ['muse', 'grok-bot']) {
    assert.ok(externalAttachmentWarning(1, [{ kind: 'external', id, name: id }]));
  }
  assert.equal(externalAttachmentWarning(0, [{ kind: 'external', id: 'muse', name: 'Muse' }]), '');
  assert.equal(externalAttachmentWarning(1, [{ kind: 'executor', id: 'x', name: 'X' }]), '');
  assert.ok(externalAttachmentWarning(1, [], '@@Muse describe this'));
  assert.equal(externalAttachmentWarning(1, [], '@Muse is interesting'), '');
});

test('attachment intake enforces file/image/count/total limits before reading bytes and allows ordinary documents', () => {
  const files = [
    file('project.md', 'text/markdown'),
    file('spec.pdf', 'application/pdf'),
    file('report.docx'),
    file('截图.PNG', ''),
  ];
  const accepted = selectAttachmentFiles([], files);
  assert.deepEqual(accepted.accepted, files);
  assert.deepEqual(accepted.errors, []);
  assert.equal(attachmentMimeType(files[3]!), 'image/png');
  const rejected = selectAttachmentFiles(
    [],
    [
      sized('large.png', 50 * 1024 * 1024 + 1, 'image/png'),
      sized('large.pdf', 50 * 1024 * 1024 + 1),
      file('../secret.txt'),
      file('bad\0name.txt'),
    ],
  );
  assert.equal(rejected.accepted.length, 0);
  assert.equal(rejected.errors.length, 4);
  assert.equal(
    selectAttachmentFiles(
      [],
      Array.from({ length: 9 }, (_, i) => file(`file-${i}.txt`)),
    ).accepted.length,
    8,
  );
  const total = selectAttachmentFiles(
    Array.from({ length: 3 }, (_, i) => draft(sized(`${i}.pdf`, 50 * 1024 * 1024))),
    [sized('two.pdf', 50 * 1024 * 1024), file('three.txt')],
  );
  assert.equal(total.accepted.length, 1);
  assert.match(total.errors[0]!, /200 MB/);
});

test('clipboard file fallback and raw bytes preserve image bytes without swallowing normal text', async () => {
  const image = new File([new Uint8Array([0, 255, 1, 3])], 'paste.png', { type: 'image/png' });
  assert.equal(Buffer.from(await image.arrayBuffer()).toString('base64'), 'AP8BAw==');
  const transfer = {
    files: [],
    items: [
      { kind: 'string', getAsFile: () => null },
      { kind: 'file', getAsFile: () => image },
    ],
  } as unknown as DataTransfer;
  assert.deepEqual(filesFromTransfer(transfer), [image]);
  assert.deepEqual(
    filesFromTransfer({ files: [], items: [{ kind: 'string', getAsFile: () => null }] } as unknown as DataTransfer),
    [],
  );
});

test('attachment retry reuses completed uploads only in their original conversation', async () => {
  const items = [draft(file('one.png', 'image/png')), draft(file('two.png', 'image/png'))];
  const paths: string[] = [];
  let fail = true;
  const api = async <T>(path: string, body?: unknown): Promise<T> => {
    paths.push(path);
    const input = body as File;
    assert.ok(input instanceof File);
    assert.equal(await input.text(), 'test');
    if (input.name === 'two.png' && fail) {
      fail = false;
      throw new Error('fixture upload failed');
    }
    return result(`id-${input.name}`, input.name) as T;
  };
  const remember = (id: string, attachment: Attachment) => {
    const item = items.find((item) => item.id === id)!;
    item.uploaded = { conversationId: 'first', attachment };
  };
  await assert.rejects(
    uploadDraftAttachments(api, 'first', items, () => true, remember),
    /upload failed/,
  );
  const ids = await uploadDraftAttachments(api, 'first', items, () => true, remember);
  assert.deepEqual(ids, ['id-one.png', 'id-two.png']);
  assert.equal(paths.length, 3);
  await uploadDraftAttachments(
    api,
    'second',
    items,
    () => true,
    () => {},
  );
  assert.deepEqual(paths.slice(-2), ['/api/conversations/second/attachments', '/api/conversations/second/attachments']);
});

test('switching conversation during upload preserves the completed upload and stops further uploads', async () => {
  let current = true,
    calls = 0;
  const stored: string[] = [];
  const api = async <T>(): Promise<T> => {
    calls++;
    current = false;
    return result('first-upload') as T;
  };
  await assert.rejects(
    uploadDraftAttachments(
      api,
      'conversation',
      [draft(file('one.png')), draft(file('two.png'))],
      () => current,
      (_id, attachment) => stored.push(attachment.id),
    ),
    AttachmentScopeChanged,
  );
  assert.equal(calls, 1);
  assert.deepEqual(stored, ['first-upload']);
  await assert.rejects(
    uploadDraftAttachments(
      api,
      'conversation',
      [],
      () => false,
      () => {},
    ),
    AttachmentScopeChanged,
  );
});

test('message history renders only server-classified images inline and gives documents download links', () => {
  const html = renderToStaticMarkup(
    createElement(MessageAttachments, {
      conversationId: 'chat-one',
      attachments: [
        result('image-one'),
        { ...result('doc-one', 'notes.pdf'), mimeType: 'application/pdf', kind: 'file' },
      ],
    }),
  );
  assert.equal((html.match(/<img /g) ?? []).length, 1);
  assert.match(html, /download="notes.pdf"/);
  assert.match(html, /alt="fixture.png"/);
  assert.match(html, /aria-label="fixture.png"/);
  assert.doesNotMatch(html, /aria-label="复制图片 notes.pdf"/);
  assert.match(html, /width="112" height="112"/);
  assert.equal(
    attachmentContentUrl('chat/one', 'image?one'),
    '/api/conversations/chat%2Fone/attachments/image%3Fone/content',
  );
});

test('an attached picture opens a large preview instead of a download link', () => {
  const html = renderToStaticMarkup(
    createElement(MessageAttachments, { conversationId: 'chat-one', attachments: [result('image-one')] }),
  );
  assert.match(
    html,
    /<button type="button" class="message-attachment-link" title="查看大图 fixture.png" aria-label="fixture.png" data-names="true">/,
  );
  assert.doesNotMatch(html, /download="fixture.png"/);
});
