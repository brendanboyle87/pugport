import type { Express } from 'express';
import { z } from 'zod';
import type { Conversation } from '../shared/types.ts';
import { modDiagnosticSchema } from '../shared/mod-debug.ts';
import { modeIdSchema, modeVersionSchema } from '../shared/conversation-modes.ts';
import { modPermissionSchema, type ModManifest } from '../shared/mods-manifest.ts';
import { ModeConflict } from './conversation-modes.ts';
import type { ModWorkspaces } from './mod-workspaces.ts';

/** Mods author workspaces. Mount after the existing loopback/origin/token checks and bounded JSON parser. */
export function registerModWorkspaceRoutes(
  app: Express,
  workspaces: ModWorkspaces,
  host: {
    setWorkMode(conversationId: string): void;
    /** An ordinary new chat, for Edit in chat when the original chat was deleted. */
    createChat(title: string): Promise<Conversation>;
    openFolder(path: string): void;
    exportMod(modeId: string, version: string): ModManifest;
  },
) {
  const record = (id: string) => {
    const value = workspaces.get(
      z
        .string()
        .regex(/^[0-9a-f]{10}$/)
        .parse(id),
    );
    if (!value) throw Object.assign(new Error('Mod 工作文件夹记录不存在。'), { status: 404 });
    return value;
  };
  /** The chat's folder; `path` is Change… (a folder the user picked), checked against projects and PugPort data. */
  app.post('/api/mod-workspaces', (req, res) => {
    const { conversationId, path } = z
      .object({ conversationId: z.string().uuid(), path: z.string().min(1).max(4000).optional() })
      .strict()
      .parse(req.body);
    host.setWorkMode(conversationId);
    res.status(201).json(workspaces.ensure(conversationId, path));
  });
  /** Edit in chat for a Mod that has no workspace (imported as JSON): a new Mods author chat with it unpacked. */
  app.post('/api/mod-workspaces/from-mod', async (req, res) => {
    const { modeId, version } = z.object({ modeId: modeIdSchema, version: modeVersionSchema }).strict().parse(req.body);
    const manifest = host.exportMod(modeId, version);
    const chat = await host.createChat(manifest.title);
    host.setWorkMode(chat.id);
    await workspaces.fromManifest(chat.id, manifest);
    res.status(201).json(workspaces.chat(chat.id));
  });
  app.get('/api/mod-workspaces/:id', (req, res) => res.json(record(req.params.id)));
  app.post('/api/mod-workspaces/:id/reveal', (req, res) => {
    z.object({})
      .strict()
      .parse(req.body ?? {});
    host.openFolder(record(req.params.id).path);
    res.json({ ok: true });
  });
  /** The chat that edits this build: the original one, or a new Mods author chat bound to the same folder. */
  app.post('/api/mod-workspaces/:id/edit', async (req, res) => {
    z.object({})
      .strict()
      .parse(req.body ?? {});
    const value = record(req.params.id);
    try {
      const chat = workspaces.forConversation(value.conversationId);
      if (chat?.id === value.id) {
        host.setWorkMode(value.conversationId);
        return res.json(workspaces.chat(value.conversationId));
      }
    } catch {
      // The original chat was deleted; a new one takes over the folder.
    }
    const created = await host.createChat(value.modId ?? 'Mod');
    workspaces.attach(value.id, created.id);
    res.json(workspaces.chat(created.id));
  });
  /** Batches from the renderer's Mod frames; the body parser for this path stops at 64 KiB. */
  app.post('/api/mod-workspaces/:id/diagnostics', (req, res) => {
    const { entries } = z
      .object({ entries: z.array(modDiagnosticSchema).min(1).max(200) })
      .strict()
      .parse(req.body);
    res.json({ count: workspaces.addDiagnostics(record(req.params.id).id, entries) });
  });
  app.post('/api/conversations/:id/mod-approval', (req, res) => {
    const answer = z
      .object({
        approved: z.boolean(),
        modeId: modeIdSchema,
        version: modeVersionSchema,
        permissions: z.array(modPermissionSchema).max(20),
      })
      .strict()
      .parse(req.body);
    try {
      res.json(workspaces.approve(req.params.id, answer));
    } catch (error) {
      if (!(error instanceof ModeConflict)) throw error;
      res.status(409).json({ error: error.message });
    }
  });
}
