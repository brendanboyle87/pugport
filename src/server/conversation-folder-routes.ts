import type { Express } from 'express';
import { z } from 'zod';
import type { ConversationFolders } from './conversation-folders.ts';

export function conversationFolderRoutes(app: Express, folders: ConversationFolders) {
  const name = z.object({ name: z.string().trim().min(1).max(60) }).strict();
  app.get('/api/conversation-folders', (_req, res) => res.json(folders.list()));
  app.post('/api/conversation-folders', (req, res) => res.status(201).json(folders.create(name.parse(req.body).name)));
  app.patch('/api/conversation-folders/:id', (req, res) =>
    res.json(folders.rename(req.params.id, name.parse(req.body).name)),
  );
  app.delete('/api/conversation-folders/:id', (req, res) => {
    folders.remove(req.params.id);
    res.json({ deleted: true });
  });
  app.patch('/api/conversations/:id/folder', (req, res) => {
    const { folderId } = z.object({ folderId: z.string().uuid().nullable() }).strict().parse(req.body);
    res.json(folders.move(req.params.id, folderId ?? undefined));
  });
  app.post('/api/conversation-folders/classify', (req, res) =>
    res.status(202).json(
      folders.classify(
        z
          .object({
            requestId: z.string().uuid().optional(),
            includeFiled: z.boolean().optional(),
          })
          .strict()
          .parse(req.body),
      ),
    ),
  );
  app.get('/api/conversation-folders/jobs/:id', (req, res) => res.json(folders.getJob(req.params.id)));
  app.post('/api/conversation-folders/jobs/:id/undo', (req, res) => {
    z.object({}).strict().parse(req.body);
    res.json(folders.undo(req.params.id));
  });
  app.post('/api/conversation-folders/jobs/:id/cancel', (req, res) => {
    z.object({}).strict().parse(req.body);
    res.json(folders.cancel(req.params.id));
  });
}
