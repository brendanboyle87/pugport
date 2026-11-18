import { spawn } from './platform/test-process.ts';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import sharp from 'sharp';
import { findExecutable } from './discovery.ts';
import { differenceHash } from './image-search.ts';
import { prepareQuery, matchQuery, releaseQuery } from './image-match.ts';
import { runtimeDirectories } from '../../scripts/runtime-paths.mjs';

export const mediaSide = 72;
export type FrameSignature = { time: number; hash: string; colours: number[]; texture: number };
export type VideoMetadata = { duration: number; width?: number; height?: number; hasAudio?: boolean };
export interface MediaDecoder {
  /** Stable numerical-pipeline identity, separate from the human-facing description. */
  cacheIdentity?: string;
  image(path: string, signal: AbortSignal): Promise<FrameSignature>;
  probe(path: string, signal: AbortSignal): Promise<VideoMetadata>;
  frame(path: string, time: number, signal: AbortSignal): Promise<FrameSignature>;
  compareImages?(a: string, b: string, signal: AbortSignal): Promise<{ geometricInliers: number }>;
  description: string;
}

/** No pixels or base64 media enter the model context or the persistent checkpoint. */
export function frameSignature(rgb: Buffer, time = 0): FrameSignature {
  if (rgb.length !== mediaSide * mediaSide * 3) throw new Error('Unexpected decoded frame size.');
  const colours = Array<number>(12).fill(0);
  let sum = 0,
    squares = 0;
  for (let i = 0; i < rgb.length; i += 3) {
    const grey = rgb[i]! * 0.299 + rgb[i + 1]! * 0.587 + rgb[i + 2]! * 0.114;
    sum += grey;
    squares += grey * grey;
    for (let channel = 0; channel < 3; channel++) colours[channel * 4 + Math.min(3, rgb[i + channel]! >> 6)]!++;
  }
  const count = rgb.length / 3;
  return {
    time,
    hash: differenceHash(rgb, mediaSide),
    colours: colours.map((value) => Math.round((value / count) * 1000) / 1000),
    texture: Math.sqrt(Math.max(0, squares / count - (sum / count) ** 2)),
  };
}

/** Own direct child only, no shell, no network protocols, bounded output/time, never writes frames to disk. */
export function runMediaCommand(
  command: string,
  args: string[],
  signal: AbortSignal,
  options: {
    maxOutput?: number;
    timeoutMs?: number;
    allowNonzero?: boolean;
  } = {},
): Promise<{ stdout: Buffer; stderr: string; code: number | null }> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    const chunks: Buffer[] = [];
    let bytes = 0,
      stderr = '',
      stopped: Error | undefined;
    const stop = (error: Error) => {
      stopped ??= error;
      child.kill('SIGKILL');
    };
    const abort = () => stop(new Error('Media analysis cancelled.'));
    const timer = setTimeout(() => stop(new Error('Local media decoder timed out.')), options.timeoutMs ?? 25_000);
    signal.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (part: Buffer) => {
      bytes += part.length;
      if (bytes > (options.maxOutput ?? 512 * 1024)) stop(new Error('Local media decoder exceeded output limit.'));
      else chunks.push(part);
    });
    child.stderr.on('data', (part: Buffer) => {
      stderr = (stderr + part.toString('utf8')).slice(-16_384);
    });
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    };
    child.once('error', (error) => {
      cleanup();
      reject(error);
    });
    child.once('close', (code) => {
      cleanup();
      if (stopped) reject(stopped);
      else if (code !== 0 && !options.allowNonzero)
        reject(new Error(`Local media decoder failed (exit ${code ?? 'signal'}).`));
      else resolve({ stdout: Buffer.concat(chunks), stderr, code });
    });
    if (signal.aborted) abort();
  });
}

function executable(path: string | undefined): string | undefined {
  return path && isAbsolute(path) && existsSync(path) && (process.platform !== 'win32' || /\.exe$/i.test(path))
    ? path
    : undefined;
}

/** Read installed locations only. An imageio installation can supply ffmpeg without ffprobe. */
export function findMediaExecutables(appRoot: string, explicit: { ffmpegPath?: string; ffprobePath?: string } = {}) {
  const name = (base: string) => (process.platform === 'win32' ? `${base}.exe` : base);
  const dirs = runtimeDirectories(appRoot, 'ffmpeg').flatMap((dir: string) => [dir, join(dir, 'bin')]);
  let ffmpeg =
    executable(explicit.ffmpegPath) ??
    dirs.map((dir: string) => executable(join(dir, name('ffmpeg')))).find(Boolean) ??
    executable(findExecutable('ffmpeg'));
  if (!ffmpeg && process.platform === 'win32') {
    const parents = [
      process.env.SystemDrive ? `${process.env.SystemDrive}/` : 'C:/',
      join(process.env.LOCALAPPDATA ?? homedir(), 'Programs', 'Python'),
    ];
    for (const parent of parents) {
      let pythons: string[] = [];
      try {
        pythons = readdirSync(parent)
          .filter((entry) => /^Python\d+(?:-\d+)?$/i.test(entry))
          .slice(0, 12);
      } catch {
        /* Not installed. */
      }
      for (const python of pythons) {
        const directory = join(parent, python, 'Lib', 'site-packages', 'imageio_ffmpeg', 'binaries');
        try {
          ffmpeg = readdirSync(directory)
            .filter((entry) => /^ffmpeg.*\.exe$/i.test(entry))
            .sort()
            .map((entry) => executable(join(directory, entry)))
            .find(Boolean);
        } catch {
          /* Another Python installation may have the package. */
        }
        if (ffmpeg) break;
      }
      if (ffmpeg) break;
    }
  }
  const ffprobe =
    executable(explicit.ffprobePath) ??
    (ffmpeg ? executable(join(dirname(ffmpeg), name('ffprobe'))) : undefined) ??
    executable(findExecutable('ffprobe'));
  return { ffmpeg, ffprobe };
}

export function createMediaDecoder(
  appRoot: string,
  paths: { ffmpegPath?: string; ffprobePath?: string } = {},
): MediaDecoder {
  const { ffmpeg, ffprobe } = findMediaExecutables(appRoot, paths);
  const binaryStamp = (path: string | undefined) => {
    if (!path) return null;
    try {
      const info = statSync(path, { bigint: true });
      return [
        process.platform === 'win32' ? path.toLowerCase() : path,
        String(info.dev),
        String(info.ino),
        String(info.size),
        String(info.mtimeNs),
        String(info.ctimeNs),
      ];
    } catch {
      return null;
    }
  };
  const cacheIdentity = createHash('sha256')
    .update(JSON.stringify(['rgb72-dhash-colour-v1', binaryStamp(ffmpeg), binaryStamp(ffprobe), sharp.versions]))
    .digest('hex');
  // A renamed playlist must not make the decoder follow file: segments outside the named scope.
  // These are self-contained container demuxers only; hls/concat/image2 are deliberately absent.
  const input = (path: string) => [
    '-protocol_whitelist',
    'file,pipe',
    '-format_whitelist',
    'mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,asf,flv,mpegts,mpeg',
    '-i',
    path,
  ];
  const videoPixels = async (path: string, time: number, signal: AbortSignal) => {
    if (!ffmpeg) throw new Error('FFmpeg is not installed; video visual analysis is not covered.');
    const prefix = ['-nostdin', '-hide_banner', '-v', 'error', '-threads', '1', '-filter_threads', '1'];
    const outputArgs = [
      '-map',
      '0:v:0',
      '-frames:v',
      '1',
      '-an',
      '-sn',
      '-dn',
      '-vf',
      `scale=${mediaSide}:${mediaSide}`,
      '-pix_fmt',
      'rgb24',
      '-f',
      'rawvideo',
      'pipe:1',
    ];
    const read = (seek: string[], after: string[] = []) =>
      runMediaCommand(ffmpeg, [...prefix, ...seek, ...input(path), ...after, ...outputArgs], signal, {
        maxOutput: mediaSide * mediaSide * 3,
      });
    let output = await read(['-ss', time.toFixed(4)]);
    if (!output.stdout.length)
      output =
        time > 10
          ? await read(['-ss', (time - 10).toFixed(4)], ['-ss', '10'])
          : await read([], ['-ss', time.toFixed(4)]);
    if (!output.stdout.length) output = await read(['-ss', Math.max(0, time - 2).toFixed(4)]);
    if (!output.stdout.length && time > 10 && time <= 60) output = await read([], ['-ss', time.toFixed(4)]);
    if (!output.stdout.length) throw new Error(`No video frame could be read near ${time.toFixed(1)}s.`);
    return output.stdout;
  };
  return {
    cacheIdentity,
    description: ffmpeg
      ? 'Sharp + FFmpeg（本地抽样；不上传、不生成帧文件）'
      : 'Sharp；未找到 FFmpeg，视频仅做文件哈希，画面对比未覆盖',
    async image(path, signal) {
      signal.throwIfAborted();
      const operation = sharp(path, { limitInputPixels: 50_000_000, failOn: 'error', pages: 1 }).timeout({
        seconds: 15,
      });
      const metadata = await operation.metadata();
      if ((metadata.pages ?? 1) > 1) throw new Error('Animated/multipage image: visual comparison is not covered.');
      const abort = () => operation.destroy();
      signal.addEventListener('abort', abort, { once: true });
      try {
        const data = await operation
          .rotate()
          .removeAlpha()
          .toColourspace('srgb')
          .resize(mediaSide, mediaSide, { fit: 'fill' })
          .raw()
          .toBuffer();
        signal.throwIfAborted();
        return frameSignature(data);
      } finally {
        signal.removeEventListener('abort', abort);
      }
    },
    async compareImages(a, b, signal) {
      const grey = async (path: string) => {
        signal.throwIfAborted();
        const { data, info } = await sharp(path, { limitInputPixels: 50_000_000, pages: 1, failOn: 'error' })
          .timeout({ seconds: 15 })
          .rotate()
          .toColourspace('b-w')
          .resize(320, 320, { fit: 'inside', withoutEnlargement: true })
          .raw()
          .toBuffer({ resolveWithObject: true });
        signal.throwIfAborted();
        return { data, width: info.width, height: info.height };
      };
      const key = `media-${randomUUID()}`;
      try {
        await prepareQuery(key, await grey(a));
        signal.throwIfAborted();
        const geometricInliers = await matchQuery(key, await grey(b));
        signal.throwIfAborted();
        return { geometricInliers };
      } finally {
        await releaseQuery(key).catch(() => {});
      }
    },
    async probe(path, signal) {
      if (!ffmpeg) throw new Error('FFmpeg is not installed; video visual analysis is not covered.');
      if (ffprobe) {
        const output = await runMediaCommand(
          ffprobe,
          [
            '-v',
            'error',
            ...input(path),
            '-show_entries',
            'format=duration:stream=codec_type,width,height,duration',
            '-of',
            'json',
          ],
          signal,
        );
        const parsed = JSON.parse(output.stdout.toString('utf8')) as {
          format?: { duration?: string };
          streams?: Array<{ codec_type?: string; width?: number; height?: number; duration?: string }>;
        };
        const video = parsed.streams?.find((stream) => stream.codec_type === 'video');
        const duration = Number(parsed.format?.duration ?? video?.duration);
        if (!video || !Number.isFinite(duration) || duration <= 0)
          throw new Error('Video duration/stream is unavailable.');
        return {
          duration,
          width: video.width,
          height: video.height,
          hasAudio: parsed.streams?.some((stream) => stream.codec_type === 'audio'),
        };
      }
      const output = await runMediaCommand(ffmpeg, ['-nostdin', '-hide_banner', ...input(path)], signal, {
        allowNonzero: true,
      });
      const duration = output.stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      const dimensions = output.stderr.match(/Video:[^\r\n]*?\b(\d{2,6})x(\d{2,6})\b/);
      if (!duration || !/Video:/.test(output.stderr)) throw new Error('Video duration/stream is unavailable.');
      return {
        duration: Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]),
        width: dimensions ? Number(dimensions[1]) : undefined,
        height: dimensions ? Number(dimensions[2]) : undefined,
        hasAudio: /Audio:/.test(output.stderr),
      };
    },
    async frame(path, time, signal) {
      return frameSignature(await videoPixels(path, time, signal), time);
    },
  };
}
