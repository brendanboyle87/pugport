import { open, stat } from 'node:fs/promises';
import sharp from 'sharp';
import type { ExecuteContext, RunAttachment } from '../shared/types.ts';
import { attachmentLimits } from '../shared/attachments.ts';

export const maxWebpHeaderChunks = 16;
export const maxWebpHeaderBytes = 64 * 1024;

export async function attachmentDimensions(
  path: string,
  mimeType: string,
): Promise<{ width?: number; height?: number }> {
  if (mimeType !== 'image/webp') {
    const { width, height } = await sharp(path, { limitInputPixels: false }).metadata();
    return { width, height };
  }
  // libvips retains WebP file handles on Windows. Read just its RIFF frame header instead.
  // https://developers.google.com/speed/webp/docs/riff_container
  const file = await open(path, 'r');
  try {
    const size = (await file.stat()).size;
    if (size < 20) throw new Error('runtime-image-input-invalid');
    const buf = Buffer.alloc(Math.min(size, 12 + maxWebpHeaderBytes));
    const { bytesRead } = await file.read(buf, 0, buf.length, 0);
    if (bytesRead < 20 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP')
      throw new Error('runtime-image-input-invalid');
    const riffEnd = 8 + buf.readUInt32LE(4);
    if (riffEnd > size) throw new Error('runtime-image-input-invalid');
    const scanLimit = Math.min(bytesRead, riffEnd);
    for (let offset = 12, chunks = 0; offset + 8 <= scanLimit && chunks < maxWebpHeaderChunks; chunks++) {
      const kind = buf.toString('ascii', offset, offset + 4),
        length = buf.readUInt32LE(offset + 4),
        avail = scanLimit - offset;
      if (offset + 8 + length > riffEnd) break;
      if (kind === 'VP8X' && length >= 10 && avail >= 18)
        return { width: buf.readUIntLE(offset + 12, 3) + 1, height: buf.readUIntLE(offset + 15, 3) + 1 };
      if (
        kind === 'VP8 ' &&
        length >= 10 &&
        avail >= 18 &&
        buf.subarray(offset + 11, offset + 14).equals(Buffer.from([0x9d, 0x01, 0x2a]))
      )
        return { width: buf.readUInt16LE(offset + 14) & 0x3fff, height: buf.readUInt16LE(offset + 16) & 0x3fff };
      if (kind === 'VP8L' && length >= 5 && avail >= 13 && buf[offset + 8] === 0x2f) {
        const bits = buf.readUInt32LE(offset + 9);
        return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
      }
      offset += 8 + length + (length & 1);
    }
    throw new Error('runtime-image-input-invalid');
  } finally {
    await file.close();
  }
}

/** All byte-based adapters share the same companion; Codex reads the untouched original path. */
export async function executorImage(
  image: RunAttachment,
  executor: string,
  ctx: Pick<ExecuteContext, 'emit'>,
  budget = { bytes: 0 },
) {
  // Anthropic's API takes at most 5 MB of base64 per image, about 3.75 MB of file; Pi may reach it too.
  const limit = (executor === 'claude' || executor === 'pi' ? 3.75 : 5) * 1024 * 1024;
  const usable = async (file: NonNullable<RunAttachment['fitted']>) => {
    const info = await stat(file.path);
    if (!info.isFile() || !info.size) throw new Error('runtime-image-input-invalid');
    const dimensions = file.width && file.height ? file : await attachmentDimensions(file.path, file.mimeType);
    if (info.size > limit) return false;
    return Math.max(dimensions.width ?? Infinity, dimensions.height ?? Infinity) <= attachmentLimits.imageLongEdge;
  };
  const selected =
    image.mimeType !== 'image/gif' && image.fitted && (await usable(image.fitted).catch(() => false))
      ? image.fitted
      : (await usable(image))
        ? image
        : undefined;
  if (selected) {
    const bytes = (await stat(selected.path)).size;
    if (budget.bytes + bytes <= 20 * 1024 * 1024) {
      budget.bytes += bytes;
      return selected;
    }
    ctx.emit({
      at: new Date().toISOString(),
      type: 'status',
      text: `${image.name}：本次请求图片总量超过 20 MB，已跳过此图片；原件仍保留。`,
    });
    return undefined;
  }
  const note =
    image.mimeType === 'image/gif'
      ? `${image.name}：GIF 原件超过 ${executor} 的图片限制，未重新编码；原件仍可按路径读取。`
      : `${image.name}：原件超过 ${executor} 的图片限制，且没有可用的缩图副本；请重新添加图片。原件仍保留。`;
  ctx.emit({ at: new Date().toISOString(), type: 'status', text: note });
  return undefined;
}
