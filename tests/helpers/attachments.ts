import { Readable } from 'node:stream';
import type { Attachments } from '../../src/server/attachments.ts';

/** Existing synthetic fixtures encode tiny images inline; production always receives raw streams. */
export function saveAttachment(
  files: Attachments,
  conversationId: string,
  input: { name: string; mimeType: string; dataBase64: string },
) {
  return files.saveStream(conversationId, input, Readable.from([Buffer.from(input.dataBase64, 'base64')]));
}
