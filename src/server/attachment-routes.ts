import type { Express } from 'express';
import { Attachments, AttachmentUploadError } from './attachments.ts';

export const isAttachmentUpload = (method: string, path: string) =>
  method === 'POST' && /^\/api\/conversations\/[^/]+\/attachments$/.test(path);

/** Register before JSON parsing: documents may themselves have application/json content. */
export function attachmentUploadRoute(app: Express, attachments: Attachments) {
  app.post('/api/conversations/:id/attachments', async (req, res) => {
    try {
      let name: string;
      try {
        name = decodeURIComponent(req.get('x-attachment-name') ?? '');
      } catch {
        throw new AttachmentUploadError('附件文件名无效。');
      }
      const attachment = await attachments.saveStream(
        req.params.id,
        {
          name,
          mimeType: req.get('content-type')?.split(';')[0] ?? '',
          originalId: typeof req.query.original === 'string' ? req.query.original : undefined,
        },
        req,
      );
      res.status(201).json(attachment);
    } catch (error) {
      if (!req.complete) {
        res.setHeader('Connection', 'close');
        res.once('finish', () => req.destroy());
      }
      res.status(error instanceof AttachmentUploadError ? error.status : 400).json({ error: (error as Error).message });
    }
  });
}
