import { Readable } from 'node:stream';
import sharp from 'sharp';
import { markupLimits, type MarkupCrop } from '../shared/markup.ts';
import type { MessageQuote } from '../shared/quotes.ts';
import type { Attachments } from './attachments.ts';

/** Crops belong to the conversation, but only the markup quote exposes their ids. */
export async function markupCrops(
  attachments: Attachments,
  conversationId: string,
  quotes: MessageQuote[],
  attachmentIds: string[],
): Promise<MessageQuote[]> {
  let count = 0;
  const result: MessageQuote[] = [];
  for (const quote of quotes) {
    if (!quote.markup) {
      result.push(quote);
      continue;
    }
    const markup = { ...quote.markup, crops: [] as MarkupCrop[] };
    result.push({ ...quote, markup });
    if (count >= markupLimits.crops) continue;
    try {
      const matches = attachmentIds
        .map((id) => attachments.get(conversationId, id))
        .filter((file) => file.name === markup.attachment);
      if (matches.length !== 1 || matches[0]!.kind !== 'image') continue;
      const file = matches[0]!;
      const { data, info } = await sharp(file.path, { limitInputPixels: 40_000_000 })
        .raw()
        .toBuffer({ resolveWithObject: true });
      const { width, height, channels } = info;
      for (const mark of markup.marks) {
        if (count >= markupLimits.crops) break;
        try {
          const x0 = Math.round(mark.box.x0 * width),
            y0 = Math.round(mark.box.y0 * height);
          const x1 = Math.round(mark.box.x1 * width),
            y1 = Math.round(mark.box.y1 * height);
          const pad = Math.max(32, 0.2 * Math.max(x1 - x0, y1 - y0));
          const w = Math.max(200, x1 - x0 + 2 * pad),
            h = Math.max(200, y1 - y0 + 2 * pad);
          const left = Math.max(0, Math.floor((x0 + x1 - w) / 2)),
            top = Math.max(0, Math.floor((y0 + y1 - h) / 2));
          const right = Math.min(width, Math.ceil((x0 + x1 + w) / 2)),
            bottom = Math.min(height, Math.ceil((y0 + y1 + h) / 2));
          const buffer = await sharp(data, { raw: { width, height, channels } })
            .extract({ left, top, width: right - left, height: bottom - top })
            .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
            // JPEG has no alpha: transparent areas would turn black.
            .flatten({ background: '#ffffff' })
            .jpeg({ quality: 85 })
            .toBuffer();
          const stem = markup.attachment.replace(/\.[^.]*$/, '').slice(0, 180);
          const saved = await attachments.saveStream(
            conversationId,
            { name: `${stem}-${mark.n}.jpg`, mimeType: 'image/jpeg' },
            Readable.from([buffer]),
          );
          markup.crops.push({ n: mark.n, attachmentId: saved.id, name: saved.name });
          count++;
        } catch {
          console.warn('Markup crop skipped', mark.n);
        }
      }
    } catch {
      console.warn('Markup image unavailable; sending its text only');
    }
  }
  return result;
}
