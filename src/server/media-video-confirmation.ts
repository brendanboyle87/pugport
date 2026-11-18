import { spawn } from './platform/test-process.ts';
import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { findMediaExecutables, runMediaCommand } from './media-decoder.ts';
import type { MediaFileStamp } from './media-confirmation.ts';
import { fileIdentity, sameIno } from './platform/file-identity.ts';

export const videoConfirmationVersion = 'full-video-confirmation-v1-native-grid';
export type FullVideoConfirmationOptions = {
  /** Candidate time zero maps to this position in the retained original. No approximate offset search. */
  retainedOffsetSeconds?: number;
  expectedStamps?: readonly [MediaFileStamp, MediaFileStamp];
  signal?: AbortSignal;
  appRoot?: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  timeoutMs?: number;
  onProgress?: (progress: { stage: 'video' | 'audio' | 'statistical' | 'quality'; frames?: number }) => void;
};
export type FullVideoDuplicateConfirmation = {
  version: typeof videoConfirmationVersion;
  verified: boolean;
  /** This module never mutates either source. Statistical resemblance alone remains a review item. */
  recycleEligible: boolean;
  assessment: 'identical-native-grid' | 'full-interval-statistical-match' | 'different' | 'uncertain';
  candidate: string;
  retained: string;
  stamps: [MediaFileStamp, MediaFileStamp];
  retainedOffsetSeconds: number;
  reason?: string;
  coverage?: {
    candidateFrames: number;
    retainedFrames: number;
    allCandidateFramesCompared: boolean;
    timingVerified: boolean;
    timingToleranceSeconds: number;
    decodedPixelsEqual: boolean;
    candidateDurationSeconds: number;
    retainedInterval: [number, number];
    frameTimelineDigest: string;
  };
  audio?: {
    covered: boolean;
    method: 'absent-in-both' | 'identical-full-pcm';
    samples: number;
    sha256?: string;
    timingVerified?: boolean;
    samplesIdentical?: boolean;
  };
  metadataCovered?: boolean;
  auxiliary?: {
    decodedFramesScanned: [number, number];
    packetsScanned: [number, number];
    supported: boolean;
    reasons: string[];
    nativeChromaLocations?: [string, string];
  };
  quality?: {
    retainedResolutionNotLower: boolean;
    /** An exact native-grid match establishes no lost candidate pixels, without claiming extra detail. */
    candidateNativeGridPreserved: boolean;
    actualQualityEstablished: boolean;
    basis: 'identical-every-native-pixel-and-frame' | 'statistical-comparison-needs-quality-review';
    candidateDimensions: [number, number];
    retainedDimensions: [number, number];
    measurements?: {
      /** First-plane (luma) measurements only; this direction never establishes overall quality or recycle eligibility. */
      method: 'all-frame-blurdetect-blockdetect-common-and-native-grids';
      allFramesMeasured: boolean;
      frames: number;
      commonGrid: { candidate: VideoQualityMetrics; retained: VideoQualityMetrics };
      nativeGrid: { candidate: VideoQualityMetrics; retained: VideoQualityMetrics };
      /** Lower blur width and block artifact scores are better; native blur is normalized by width. */
      direction: 'retained-dominates' | 'uncertain';
      commonGridNonworseFrames: number;
      normalizedNativeNonworseFrames: number;
      tolerances: { blurRatio: number; blockRatio: number; blurAbsolute: number; blockAbsolute: number };
      reason: string;
    };
  };
  statistical?: {
    allFramesCompared: boolean;
    frames: number;
    minimumSsim: number;
    meanSsim: number;
    minimumPsnr: number;
    meanPsnr: number;
    thresholdPassed: boolean;
    thresholds: { minimumSsim: number; meanSsim: number; minimumPsnr: number };
    /** These metrics cannot rule out tiny unique overlays, metadata, or quality tradeoffs mathematically. */
    reviewRequired: true;
  };
};
export type VideoQualityMetrics = {
  meanBlurWidth: number;
  maximumBlurWidth: number;
  /** Horizontal blur width divided by native/common-grid width; compares visible blur across resolutions. */
  meanNormalizedBlurWidth: number;
  meanBlockArtifacts: number;
  maximumBlockArtifacts: number;
};
type ProbeStream = {
  codec_type?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  sample_aspect_ratio?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  time_base?: string;
  duration?: string;
  nb_frames?: string;
  start_time?: string;
  field_order?: string;
  sample_rate?: string;
  sample_fmt?: string;
  channels?: number;
  channel_layout?: string;
  color_range?: string;
  color_space?: string;
  color_transfer?: string;
  color_primaries?: string;
  chroma_location?: string;
  tags?: Record<string, string>;
  disposition?: Record<string, number>;
  side_data_list?: Array<Record<string, unknown>>;
};
type Probe = {
  streams: ProbeStream[];
  chapters?: unknown[];
  format?: { duration?: string; tags?: Record<string, string> };
};
type Snapshot = { stamp: MediaFileStamp; identity: string };
const samePath = (a: string, b: string) =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const inside = (file: string, root: string) => {
  const tail = relative(root, file);
  return !tail || (!isAbsolute(tail) && tail !== '..' && !tail.startsWith(`..${sep}`));
};
const sameStamp = (a: MediaFileStamp, b: MediaFileStamp) =>
  a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && sameIno(a.ino, b.ino);
// A sole unspecified channel has no ordering ambiguity; preserve any explicitly declared single-channel role.
const audioLayout = (layout: string | undefined, channels: number) =>
  channels === 1 && (!layout || layout === 'unknown' || layout === 'N/A') ? 'mono' : layout;
function fraction(value: string | undefined): number {
  const match = /^(\d+)\/(\d+)$/.exec(value ?? '');
  if (!match || Number(match[2]) === 0) throw new Error('Unknown or invalid video timing.');
  return Number(match[1]) / Number(match[2]);
}
async function fileSnapshot(file: string, roots: readonly string[]): Promise<Snapshot> {
  if (!roots.some((root) => inside(file, root))) throw new Error('Video confirmation is outside the explicit scope.');
  const info = await lstat(file, { bigint: true });
  const { dev, ino } = fileIdentity(info);
  const ordinary = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || !samePath(await realpath(file), file))
    throw new Error('Video path is not a regular original file.');
  if (
    ordinary.size !== Number(info.size) ||
    ordinary.ino !== Number(info.ino) ||
    Math.abs(ordinary.mtimeMs - Number(info.mtimeNs) / 1e6) > 0.001 ||
    Math.abs(ordinary.ctimeMs - Number(info.ctimeNs) / 1e6) > 0.001
  )
    throw new Error('Video changed while reading its source stamp.');
  const stamp = { size: ordinary.size, mtimeMs: ordinary.mtimeMs, ctimeMs: ordinary.ctimeMs, ino: String(ino) };
  if (!Number.isSafeInteger(stamp.size) || stamp.size <= 0) throw new Error('Invalid encoded video size.');
  return { stamp, identity: [dev, ino, info.size, info.mtimeNs, info.ctimeNs].join(':') };
}
const demuxers = 'mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,asf,flv,mpegts,mpeg';
const input = (path: string, seek = 0) => [
  ...(seek ? ['-ss', seek.toFixed(9)] : []),
  '-threads',
  '1',
  '-protocol_whitelist',
  'file,pipe',
  '-format_whitelist',
  demuxers,
  '-noautorotate',
  '-i',
  path,
];
const prefix = [
  '-nostdin',
  '-hide_banner',
  '-v',
  'error',
  '-xerror',
  '-filter_threads',
  '1',
  '-filter_complex_threads',
  '1',
];

/** Pipes apply backpressure: at most one pipe chunk plus a bounded partial line is kept per child. */
function streamed(
  command: string,
  args: string[],
  signal: AbortSignal,
  timeoutMs: number,
  observeLog?: (line: string) => void,
) {
  signal.throwIfAborted();
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true });
  let stopped: Error | undefined,
    stderr = '',
    logBuffer = '',
    logFailure = false,
    logFailureLine = '';
  const kill = (error: Error) => {
    stopped ??= error;
    child.kill('SIGKILL');
    // Windows close waits for stdio. An iterator suspended at yield may leave a killed child's pipe unread.
    child.stdout.destroy();
    child.stderr.destroy();
  };
  const abort = () => kill(new Error('Video confirmation cancelled.'));
  const timer = setTimeout(() => kill(new Error('Complete video confirmation timed out.')), timeoutMs);
  signal.addEventListener('abort', abort, { once: true });
  child.stderr.on('data', (part: Buffer) => {
    const text = part.toString();
    stderr = (stderr + text).slice(-4096);
    if (observeLog) {
      logBuffer += text;
      let at: number;
      while ((at = logBuffer.indexOf('\n')) >= 0) {
        const line = logBuffer.slice(0, at);
        logBuffer = logBuffer.slice(at + 1);
        try {
          if (line.length > 16384) throw new Error('Unbounded decoder diagnostic.');
          if (
            /\[(?:warning|error|fatal|panic)\]/.test(line) &&
            !/\[warning\] Guessed Channel Layout: mono\s*$/.test(line)
          ) {
            logFailure = true;
            logFailureLine = line.slice(0, 256);
          }
          observeLog(line);
        } catch (error) {
          kill(error instanceof Error ? error : new Error(String(error)));
          return;
        }
      }
      if (logBuffer.length > 16384) kill(new Error('Unbounded decoder diagnostic.'));
    }
  });
  const done = new Promise<{ code: number | null; error?: Error }>((resolveDone) => {
    child.once('error', (error) => {
      stopped ??= error;
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      resolveDone({ code, ...(stopped ? { error: stopped } : {}) });
    });
  });
  async function finish() {
    const result = await done;
    if (result.error) throw result.error;
    if (result.code !== 0) throw new Error(`Complete decoder failed (${result.code ?? 'signal'}).`);
    if (observeLog && logBuffer.trim()) throw new Error('Incomplete native audio diagnostic record.');
    if (observeLog ? logFailure : stderr.trim())
      throw new Error(
        `Decoder reported errors during complete verification.${logFailureLine ? ' ' + logFailureLine : ''}`,
      );
  }
  async function* lines() {
    let buffer = '';
    for await (const chunk of child.stdout) {
      signal.throwIfAborted();
      buffer += Buffer.from(chunk).toString('utf8');
      let at: number;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (line.length > 16384) throw new Error('Invalid decoder line.');
        if (line) yield line;
      }
      if (buffer.length > 16384) throw new Error('Unbounded decoder line.');
    }
    if (buffer.trim()) yield buffer.trim();
    await finish();
  }
  return { child, done, finish, lines, kill };
}
async function* hashedFrames(process: ReturnType<typeof streamed>) {
  let tb: number | undefined;
  for await (const line of process.lines()) {
    const header = /^#tb\s+0:\s*(\d+)\/(\d+)/.exec(line);
    if (header) {
      tb = Number(header[1]) / Number(header[2]);
      continue;
    }
    if (line.startsWith('#')) continue;
    const fields = line.split(',').map((value) => value.trim());
    if (fields.length !== 6 || fields[0] !== '0' || !tb || !Number.isFinite(tb) || !/^[a-f0-9]{64}$/i.test(fields[5]!))
      throw new Error('Invalid full-frame hash record.');
    const frame = {
      pts: Number(fields[2]),
      duration: Number(fields[3]),
      size: Number(fields[4]),
      hash: fields[5]!,
      tb,
    };
    if (
      !Number.isSafeInteger(frame.pts) ||
      !Number.isSafeInteger(frame.duration) ||
      frame.duration <= 0 ||
      !Number.isSafeInteger(frame.size) ||
      frame.size <= 0
    )
      throw new Error('Invalid full-frame timing.');
    yield frame;
  }
}
function meaningfulTags(tags: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries(tags ?? {})
      .filter(([key, value]) => {
        const name = key.toLowerCase();
        if (['encoder', 'duration', 'major_brand', 'minor_version', 'compatible_brands', 'language'].includes(name))
          return name === 'language' && value !== 'und';
        if (name === 'handler_name' && ['VideoHandler', 'SoundHandler'].includes(value)) return false;
        return true;
      })
      .map(([key, value]) => [key.toLowerCase(), value]),
  );
}
function metadataCovered(source: Probe, retained: Probe): boolean {
  const covered = (a: Record<string, string> | undefined, b: Record<string, string> | undefined) =>
    Object.entries(meaningfulTags(a)).every(([key, value]) => meaningfulTags(b)[key] === value);
  const dispositionCovered = source.streams.every((stream) => {
    const other = retained.streams.find((s) => s.codec_type === stream.codec_type);
    const keys = new Set([...Object.keys(stream.disposition ?? {}), ...Object.keys(other?.disposition ?? {})]);
    return [...keys].every((key) => (stream.disposition?.[key] ?? 0) === (other?.disposition?.[key] ?? 0));
  });
  return (
    dispositionCovered &&
    covered(source.format?.tags, retained.format?.tags) &&
    source.streams.every((stream) =>
      covered(stream.tags, retained.streams.find((other) => other.codec_type === stream.codec_type)?.tags),
    )
  );
}
function validateProbe(probe: Probe) {
  if (
    !Array.isArray(probe.streams) ||
    probe.streams.filter((s) => s.codec_type === 'video').length !== 1 ||
    probe.streams.filter((s) => s.codec_type === 'audio').length > 1 ||
    probe.streams.some((s) => !['video', 'audio'].includes(s.codec_type ?? '')) ||
    (probe.chapters?.length ?? 0) > 0
  )
    throw new Error('Independent streams, subtitles, attachments or chapters require separate preservation.');
  const video = probe.streams.find((s) => s.codec_type === 'video')!;
  if (
    !video.width ||
    !video.height ||
    video.width * video.height > 8_294_400 ||
    !['yuv420p', 'yuv422p', 'yuv444p', 'rgb24', 'gray'].includes(video.pix_fmt ?? '')
  )
    throw new Error('Unsupported full-resolution, alpha, colour or HDR video.');
  if (['smpte2084', 'arib-std-b67'].includes(video.color_transfer ?? ''))
    throw new Error('PQ/HLG HDR transfer requires separate preservation.');
  if (video.field_order && !['unknown', 'progressive'].includes(video.field_order))
    throw new Error('Interlaced video requires separate verification.');
  if (
    video.side_data_list?.some(
      (data) =>
        data.rotation !== undefined || /display matrix|mastering|content light/i.test(String(data.side_data_type)),
    )
  )
    throw new Error('Rotation or HDR metadata requires separate verification.');
  if (video.sample_aspect_ratio && !['1:1', 'N/A'].includes(video.sample_aspect_ratio))
    throw new Error('Non-square video pixels require separate verification.');
  const fps = fraction(video.avg_frame_rate),
    nominal = fraction(video.r_frame_rate);
  if (
    !Number.isFinite(fps) ||
    fps <= 0 ||
    fps > 120 ||
    Math.abs(fps - nominal) > 1e-9 ||
    Math.abs(Number(video.start_time ?? '0')) > 0.001
  )
    throw new Error('Variable or shifted video timing requires separate verification.');
  const duration = Number(video.duration ?? probe.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 86400)
    throw new Error('Unknown or excessive full video duration.');
  const audio = probe.streams.find((s) => s.codec_type === 'audio');
  if (
    audio &&
    (!['u8', 'u8p', 's16', 's16p', 's32', 's32p', 'flt', 'fltp', 'dbl', 'dblp'].includes(audio.sample_fmt ?? '') ||
      !audio.channels ||
      audio.channels > 8 ||
      !Number(audio.sample_rate) ||
      Number(audio.sample_rate) > 192000 ||
      Math.abs(Number(audio.start_time ?? '0')) > 0.001)
  )
    throw new Error('Unsupported audio layout or shifted audio timing.');
  if (
    audio &&
    ((audio.channels! > 1 && (!audio.channel_layout || audio.channel_layout === 'unknown')) ||
      audio.side_data_list?.length)
  )
    throw new Error('Unknown channel layout or audio auxiliary metadata requires separate preservation.');
  if (video.side_data_list?.length)
    throw new Error('Unsupported video stream auxiliary metadata requires separate preservation.');
  return { video, audio, fps, duration };
}

/**
 * Complete, read-only candidate-to-survivor verification. All decoded candidate frames/times and all
 * candidate PCM samples are accounted for. Only exact native-grid preservation is recycle eligible;
 * ordinary lossy duplicates receive full-interval statistical evidence and an explicit quality-review flag.
 */
export async function verifyFullVideoDuplicate(
  candidate: string,
  retained: string,
  roots: readonly string[],
  options: FullVideoConfirmationOptions = {},
): Promise<FullVideoDuplicateConfirmation> {
  const offset = options.retainedOffsetSeconds ?? 0;
  if (
    !isAbsolute(candidate) ||
    !isAbsolute(retained) ||
    !roots.length ||
    roots.some((root) => !isAbsolute(root)) ||
    !Number.isFinite(offset) ||
    offset < 0
  )
    throw new Error('Complete video confirmation requires explicit absolute scope and a nonnegative mapped offset.');
  const paths = [resolve(candidate), resolve(retained)] as const;
  if (samePath(...paths)) throw new Error('The retained video must be an independent file.');
  const allowed: string[] = [];
  for (const root of roots) {
    const actual = resolve(root),
      info = await lstat(actual);
    if (!info.isDirectory() || info.isSymbolicLink() || !samePath(actual, await realpath(actual)))
      throw new Error('Video roots may not be aliases.');
    allowed.push(actual);
  }
  const before = (await Promise.all(paths.map((path) => fileSnapshot(path, allowed)))) as [Snapshot, Snapshot];
  if (before[0].identity.split(':').slice(0, 2).join(':') === before[1].identity.split(':').slice(0, 2).join(':'))
    throw new Error('Video files refer to the same underlying original.');
  const result: FullVideoDuplicateConfirmation = {
    version: videoConfirmationVersion,
    verified: false,
    recycleEligible: false,
    assessment: 'uncertain',
    candidate: paths[0],
    retained: paths[1],
    stamps: [before[0].stamp, before[1].stamp],
    retainedOffsetSeconds: offset,
  };
  if (options.expectedStamps && options.expectedStamps.some((stamp, index) => !sameStamp(stamp, before[index]!.stamp)))
    throw new Error('Video changed since candidate discovery.');
  const controller = new AbortController(),
    signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const fresh = async () => {
    signal.throwIfAborted();
    for (let i = 0; i < 2; i++) {
      const current = await fileSnapshot(paths[i]!, allowed);
      if (current.identity !== before[i]!.identity) throw new Error('Video source changed during full confirmation.');
    }
  };
  const binaries = findMediaExecutables(options.appRoot ?? process.cwd(), options);
  if (!binaries.ffmpeg || !binaries.ffprobe)
    return { ...result, reason: 'FFmpeg and FFprobe are required for complete video confirmation.' };
  let checking = false;
  const timer = setInterval(() => {
    if (checking) return;
    checking = true;
    void fresh()
      .catch((error) => controller.abort(error))
      .finally(() => {
        checking = false;
      });
  }, 2000);
  timer.unref();
  const timeout = Math.max(1000, Math.min(options.timeoutMs ?? 900000, 3600000));
  const active = new Set<ReturnType<typeof streamed>>();
  const start = (args: string[], observeLog?: (line: string) => void) => {
    const process = streamed(binaries.ffmpeg!, args, signal, timeout, observeLog);
    active.add(process);
    return process;
  };
  const startProbe = (args: string[]) => {
    const process = streamed(binaries.ffprobe!, args, signal, timeout);
    active.add(process);
    return process;
  };
  const progress = (stage: 'video' | 'audio' | 'statistical' | 'quality', frames?: number) => {
    try {
      options.onProgress?.({ stage, ...(frames === undefined ? {} : { frames }) });
    } catch {
      /* Observation cannot decide proof. */
    }
  };
  try {
    await fresh();
    const probes = await Promise.all(
      paths.map(async (path) => {
        const output = await runMediaCommand(
          binaries.ffprobe!,
          [
            '-v',
            'error',
            '-protocol_whitelist',
            'file,pipe',
            '-format_whitelist',
            demuxers,
            '-show_streams',
            '-show_format',
            '-show_chapters',
            '-of',
            'json',
            path,
          ],
          signal,
          { maxOutput: 1024 * 1024, timeoutMs: 30000 },
        );
        if (output.stderr.trim()) throw new Error('Probe reported media errors.');
        return JSON.parse(output.stdout.toString()) as Probe;
      }),
    );
    const a = validateProbe(probes[0]!),
      b = validateProbe(probes[1]!);
    if (
      Math.abs(a.fps - b.fps) > 1e-9 ||
      offset + a.duration > b.duration + 0.001 ||
      Math.abs(offset * a.fps - Math.round(offset * a.fps)) > 1e-5
    )
      throw new Error('The full candidate does not map to an aligned retained interval.');
    if (
      a.video.pix_fmt !== b.video.pix_fmt ||
      ['color_range', 'color_space', 'color_transfer', 'color_primaries'].some(
        (key) => a.video[key as keyof ProbeStream] !== b.video[key as keyof ProbeStream],
      )
    )
      throw new Error('Colour format/profile differs; a conversion may hide unique data.');
    if (
      b.video.width! < a.video.width! ||
      b.video.height! < a.video.height! ||
      a.video.width! * b.video.height! !== a.video.height! * b.video.width!
    )
      throw new Error('Retained dimensions or aspect cannot preserve the candidate native grid.');
    if (
      !!a.audio !== !!b.audio ||
      (a.audio &&
        b.audio &&
        ['sample_rate', 'channels', 'channel_layout'].some(
          (key) => a.audio![key as keyof ProbeStream] !== b.audio![key as keyof ProbeStream],
        ))
    )
      throw new Error('Candidate audio is not represented by the retained layout.');
    result.metadataCovered = metadataCovered(probes[0]!, probes[1]!);
    if (!result.metadataCovered) throw new Error('Unique candidate metadata is not covered by the retained copy.');
    const scanAuxiliary = async (
      path: string,
      media: ReturnType<typeof validateProbe>,
      seek: number,
      coverageDuration?: number,
    ) => {
      const begin = Math.max(0, seek - 2);
      const process = startProbe([
        '-v',
        'error',
        '-threads',
        '1',
        '-protocol_whitelist',
        'file,pipe',
        '-format_whitelist',
        demuxers,
        ...(coverageDuration === undefined
          ? []
          : ['-read_intervals', `${begin.toFixed(9)}%${(seek + coverageDuration + 2 / media.fps).toFixed(9)}`]),
        '-show_frames',
        '-show_packets',
        '-show_entries',
        'packet=stream_index,pts,duration:packet_side_data=side_data_type:frame=media_type,pts,nb_samples,width,height,pix_fmt,sample_aspect_ratio,color_range,color_space,color_transfer,color_primaries,chroma_location,interlaced_frame,repeat_pict,sample_fmt,sample_rate,channels,channel_layout:frame_side_data=side_data_type',
        '-of',
        'compact=p=1:nk=0',
        path,
      ]);
      let decoded = 0,
        packets = 0,
        audioSamples = 0,
        firstAudioSample: number | undefined,
        audioEnd: number | undefined,
        audioTiming = true;
      let videoFrames = 0,
        chromaLocation: string | undefined;
      const reasons = new Set<string>();
      const rate = Number(media.audio?.sample_rate),
        audioTb = media.audio ? fraction(media.audio.time_base) : 0;
      for await (const line of process.lines()) {
        if (line.startsWith('packet|')) packets++;
        else if (line.startsWith('frame|')) {
          decoded++;
          const fields = Object.fromEntries(
            line
              .split('|')
              .slice(1)
              .filter((part) => part.includes('='))
              .map((part) => {
                const at = part.indexOf('=');
                return [part.slice(0, at), part.slice(at + 1)];
              }),
          );
          const normalize = (value: unknown) =>
            value === undefined || value === 'N/A' || value === 'unspecified' ? 'unknown' : String(value);
          if (fields.media_type === 'video') {
            const nativeChroma = normalize(fields.chroma_location),
              declaredChroma = normalize(media.video.chroma_location);
            if (!videoFrames++) chromaLocation = nativeChroma;
            if (
              Number(fields.width) !== media.video.width ||
              Number(fields.height) !== media.video.height ||
              fields.pix_fmt !== media.video.pix_fmt ||
              Number(fields.interlaced_frame) !== 0 ||
              Number(fields.repeat_pict) !== 0 ||
              nativeChroma !== chromaLocation ||
              (declaredChroma !== 'unknown' && nativeChroma !== declaredChroma) ||
              ['sample_aspect_ratio', 'color_range', 'color_space', 'color_transfer', 'color_primaries'].some(
                (key) => normalize(fields[key]) !== normalize(media.video[key as keyof ProbeStream]),
              )
            )
              throw new Error('Dynamic or unknown decoded video format cannot preserve every native pixel.');
          }
          if (fields.media_type === 'audio') {
            if (
              !media.audio ||
              fields.sample_fmt !== media.audio.sample_fmt ||
              Number(fields.channels) !== media.audio.channels ||
              (fields.sample_rate !== undefined && Number(fields.sample_rate) !== Number(media.audio.sample_rate)) ||
              audioLayout(fields.channel_layout, media.audio.channels!) !==
                audioLayout(media.audio.channel_layout, media.audio.channels!)
            )
              throw new Error('Dynamic decoded audio precision, rate or layout requires separate verification.');
            const pts = Number(fields.pts),
              samples = Number(fields.nb_samples),
              clock = pts * audioTb * rate,
              rounded = Math.round(clock);
            if (
              !Number.isSafeInteger(pts) ||
              !Number.isSafeInteger(samples) ||
              samples <= 0 ||
              !Number.isFinite(clock) ||
              Math.abs(clock - rounded) > 1e-4 ||
              (audioEnd !== undefined && rounded !== audioEnd)
            )
              audioTiming = false;
            if (firstAudioSample === undefined) firstAudioSample = rounded;
            audioEnd = rounded + samples;
            audioSamples += samples;
          }
        } else if (!line.startsWith('side_data|')) throw new Error('Unrecognized decoded auxiliary/timing record.');
        if (line.includes('side_data_type=')) {
          const type = /side_data_type=([^|]+)/.exec(line)?.[1] ?? 'Unknown auxiliary data';
          if (reasons.size < 8) reasons.add(type.slice(0, 128));
        }
        if (decoded > 20000000 || packets > 40000000)
          throw new Error('Complete auxiliary/timing scan exceeds its budget.');
      }
      if (!decoded) throw new Error('No decoded frames in auxiliary/timing scan.');
      if (
        media.audio &&
        (!audioSamples ||
          firstAudioSample === undefined ||
          audioEnd === undefined ||
          (coverageDuration === undefined && firstAudioSample !== 0))
      )
        audioTiming = false;
      return {
        decoded,
        packets,
        reasons: [...reasons],
        audioSamples,
        firstAudioSample,
        audioEnd,
        audioTiming,
        chromaLocation,
      };
    };
    // Stream lists omit in-band captions and decoded-frame side data. Keep all unsupported auxiliary content.
    const sourceAux = await scanAuxiliary(paths[0], a, 0);
    await fresh();
    const retainedAux = await scanAuxiliary(
      paths[1],
      b,
      offset,
      Math.max(a.duration, a.audio ? sourceAux.audioSamples / Number(a.audio.sample_rate) : 0),
    );
    await fresh();
    const chromaMatches = sourceAux.chromaLocation === retainedAux.chromaLocation;
    result.auxiliary = {
      decodedFramesScanned: [sourceAux.decoded, retainedAux.decoded],
      packetsScanned: [sourceAux.packets, retainedAux.packets],
      supported: chromaMatches && !sourceAux.reasons.length && !retainedAux.reasons.length,
      reasons: [
        ...new Set([
          ...sourceAux.reasons,
          ...retainedAux.reasons,
          ...(chromaMatches ? [] : ['Decoded chroma sample locations differ']),
        ]),
      ],
      nativeChromaLocations: [sourceAux.chromaLocation ?? 'unknown', retainedAux.chromaLocation ?? 'unknown'],
    };
    result.metadataCovered &&= result.auxiliary.supported;
    const audioStart = Math.round(offset * Number(a.audio?.sample_rate));
    const audioTiming =
      !a.audio ||
      (sourceAux.audioTiming &&
        retainedAux.audioTiming &&
        retainedAux.firstAudioSample !== undefined &&
        retainedAux.audioEnd !== undefined &&
        retainedAux.firstAudioSample <= audioStart &&
        retainedAux.audioEnd >= audioStart + sourceAux.audioSamples);
    const scale = `scale=${a.video.width}:${a.video.height}:flags=area+accurate_rnd+bitexact,format=${a.video.pix_fmt}`;
    const hashes = (path: string, seek: number, limit: boolean) => [
      ...prefix,
      ...input(path, seek),
      '-map',
      '0:v:0',
      '-an',
      '-sn',
      '-dn',
      '-vf',
      `setpts=PTS-STARTPTS,${scale}`,
      ...(limit ? ['-t', a.duration.toFixed(9)] : []),
      '-fps_mode',
      'passthrough',
      '-enc_time_base:v',
      'filter',
      '-c:v',
      'rawvideo',
      '-pix_fmt',
      a.video.pix_fmt!,
      '-f',
      'framehash',
      '-hash',
      'sha256',
      'pipe:1',
    ];
    await fresh();
    const leftProcess = start(hashes(paths[0], 0, false)),
      rightProcess = start(hashes(paths[1], offset, true));
    const left = hashedFrames(leftProcess),
      right = hashedFrames(rightProcess);
    let frames = 0,
      pixelsEqual = true,
      tolerance = 0;
    const timeline = createHash('sha256');
    while (true) {
      const [x, y] = await Promise.all([left.next(), right.next()]);
      if (x.done || y.done) {
        if (x.done !== y.done) throw new Error('Full decoded frame counts differ; a prefix match is insufficient.');
        break;
      }
      const l = x.value,
        r = y.value,
        tick = Math.max(l.tb, r.tb, 1e-9);
      if (tick > 0.001001) throw new Error('Video time base is too coarse for unambiguous frame alignment.');
      tolerance = Math.max(tolerance, tick);
      if (
        Math.abs(l.pts * l.tb - frames / a.fps) > tick + 1e-9 ||
        Math.abs(r.pts * r.tb - frames / a.fps) > tick + 1e-9 ||
        Math.abs(l.pts * l.tb - r.pts * r.tb) > tick + 1e-9 ||
        Math.abs(l.duration * l.tb - 1 / a.fps) > tick + 1e-9 ||
        Math.abs(r.duration * r.tb - 1 / a.fps) > tick + 1e-9 ||
        Math.abs(l.duration * l.tb - r.duration * r.tb) > tick + 1e-9 ||
        l.size !== r.size
      )
        throw new Error('Full frame timing or decoded dimensions differ; edits or missing frames remain possible.');
      pixelsEqual &&= l.hash === r.hash;
      timeline.update(`${frames}:${l.pts}:${l.duration}:${l.tb}:${r.pts}:${r.duration}:${r.tb}\n`);
      if (++frames > 10000000) throw new Error('Full-frame verification exceeds its explicit budget.');
      if (frames % 120 === 0) progress('video', frames);
    }
    if (frames < 1 || Math.abs(frames / a.fps - a.duration) > Math.max(tolerance, 0.001001))
      throw new Error('Candidate duration is not accounted for by every decoded frame.');
    result.coverage = {
      candidateFrames: frames,
      retainedFrames: frames,
      allCandidateFramesCompared: true,
      timingVerified: true,
      timingToleranceSeconds: tolerance,
      decodedPixelsEqual: pixelsEqual,
      candidateDurationSeconds: frames / a.fps,
      retainedInterval: [offset, offset + frames / a.fps],
      frameTimelineDigest: timeline.digest('hex'),
    };
    progress('video', frames);
    await fresh();
    const nativeIdentity = pixelsEqual && a.video.width === b.video.width && a.video.height === b.video.height;
    result.quality = {
      retainedResolutionNotLower: true,
      candidateNativeGridPreserved: pixelsEqual,
      actualQualityEstablished: nativeIdentity,
      basis: nativeIdentity ? 'identical-every-native-pixel-and-frame' : 'statistical-comparison-needs-quality-review',
      candidateDimensions: [a.video.width!, a.video.height!],
      retainedDimensions: [b.video.width!, b.video.height!],
    };
    if (!a.audio)
      result.audio = {
        covered: true,
        method: 'absent-in-both',
        samples: 0,
        timingVerified: true,
        samplesIdentical: true,
      };
    else {
      const rate = Number(a.audio.sample_rate),
        channels = a.audio.channels!;
      if (Math.abs(offset * rate - Math.round(offset * rate)) > 1e-5)
        throw new Error('Mapped audio boundary is not sample aligned.');
      const pcm = async (path: string, seek: number, nativeAudio: ProbeStream, samples?: number) => {
        let nativeAudioFrames = 0;
        const process = start(
          [
            ...prefix,
            '-loglevel',
            'level+info',
            '-nostats',
            ...input(path, seek),
            '-map',
            '0:a:0',
            '-vn',
            '-sn',
            '-dn',
            '-af',
            `ashowinfo${samples === undefined ? '' : `,atrim=end_sample=${samples}`}`,
            '-c:a',
            'pcm_f64le',
            '-f',
            'f64le',
            'pipe:1',
          ],
          (line) => {
            if (!line.includes('ashowinfo') || !line.includes(' n:')) return;
            const number = /\bn:(\d+)/.exec(line),
              format = /\bfmt:(\S+)/.exec(line),
              rateMatch = /\brate:(\d+)/.exec(line),
              channelsMatch = /\bchannels:(\d+)/.exec(line),
              layout = /\bchlayout:(\S+)/.exec(line);
            if (
              Number(number?.[1]) !== nativeAudioFrames++ ||
              format?.[1] !== nativeAudio.sample_fmt ||
              Number(rateMatch?.[1]) !== rate ||
              Number(channelsMatch?.[1]) !== channels ||
              audioLayout(layout?.[1], channels) !== audioLayout(nativeAudio.channel_layout, channels)
            )
              throw new Error('Dynamic native audio precision, rate or channel layout cannot be discarded.');
            if (nativeAudioFrames % 120 === 0) progress('audio', nativeAudioFrames);
          },
        );
        let bytes = 0;
        const hash = createHash('sha256');
        for await (const chunk of process.child.stdout) {
          signal.throwIfAborted();
          bytes += chunk.length;
          if (bytes > rate * channels * 8 * 86401) throw new Error('Audio confirmation exceeds its duration budget.');
          hash.update(chunk);
        }
        await process.finish();
        if (bytes % (channels * 8) !== 0 || !bytes || !nativeAudioFrames)
          throw new Error('Incomplete decoded audio samples or native descriptor verification.');
        return { samples: bytes / (channels * 8), hash: hash.digest('hex') };
      };
      progress('audio');
      const x = await pcm(paths[0], 0, a.audio),
        y = await pcm(paths[1], offset, b.audio!, x.samples);
      result.audio = {
        covered: audioTiming && x.samples === sourceAux.audioSamples && x.samples === y.samples && x.hash === y.hash,
        method: 'identical-full-pcm',
        samples: x.samples,
        sha256: x.hash,
        timingVerified: audioTiming,
        samplesIdentical: x.samples === y.samples && x.hash === y.hash,
      };
    }
    await fresh();
    if (nativeIdentity && result.audio.covered && result.metadataCovered) {
      result.verified = true;
      result.recycleEligible = true;
      result.assessment = 'identical-native-grid';
      return result;
    }
    if (pixelsEqual && !result.audio.covered) {
      result.reason =
        'Independent audio content or timestamp gaps/overlaps require review; visual matches cannot discard it.';
      return result;
    }
    // Non-exact encodings still receive an all-frame native FFmpeg comparison, never sparse thumbnails.
    const graph = `[0:v]setpts=PTS-STARTPTS,${scale},split=2[aS][aP];[1:v]setpts=PTS-STARTPTS,${scale},split=2[bS][bP];[aS][bS]ssim=stats_file=-:shortest=1:repeatlast=0[s];[aP][bP]psnr=stats_file=-:shortest=1:repeatlast=0[p]`;
    const statistical = start([
      ...prefix,
      ...input(paths[0]),
      ...input(paths[1], offset),
      '-t',
      a.duration.toFixed(9),
      '-filter_complex',
      graph,
      '-map',
      '[s]',
      '-map',
      '[p]',
      '-an',
      '-sn',
      '-dn',
      '-threads',
      '1',
      '-f',
      'null',
      'pipe:1',
    ]);
    let ssimFrames = 0,
      psnrFrames = 0,
      minimumSsim = 1,
      sumSsim = 0,
      minimumPsnr = Infinity,
      sumPsnr = 0;
    progress('statistical');
    for await (const line of statistical.lines()) {
      const number = /\bn:(\d+)/.exec(line);
      if (!number) throw new Error('Invalid full-frame statistical output.');
      const ssim = /\bAll:([\d.e+-]+)/.exec(line),
        psnr = /\bpsnr_avg:([\d.e+-]+|inf)/i.exec(line);
      if (ssim) {
        const value = Number(ssim[1]);
        if (!Number.isFinite(value) || Number(number[1]) !== ++ssimFrames)
          throw new Error('Missing or invalid all-frame SSIM records.');
        minimumSsim = Math.min(minimumSsim, value);
        sumSsim += value;
      } else if (psnr) {
        const value = psnr[1]!.toLowerCase() === 'inf' ? 100 : Number(psnr[1]);
        if (!Number.isFinite(value) || Number(number[1]) !== ++psnrFrames)
          throw new Error('Missing or invalid all-frame PSNR records.');
        minimumPsnr = Math.min(minimumPsnr, value);
        sumPsnr += value;
      } else throw new Error('Unrecognized full-frame metric output.');
    }
    if (ssimFrames !== frames || psnrFrames !== frames)
      throw new Error('Statistical comparison did not cover every candidate frame.');
    const thresholds = { minimumSsim: 0.98, meanSsim: 0.995, minimumPsnr: 35 };
    result.statistical = {
      allFramesCompared: true,
      frames,
      minimumSsim,
      meanSsim: sumSsim / frames,
      minimumPsnr,
      meanPsnr: sumPsnr / frames,
      thresholdPassed:
        minimumSsim >= thresholds.minimumSsim &&
        sumSsim / frames >= thresholds.meanSsim &&
        minimumPsnr >= thresholds.minimumPsnr,
      thresholds,
      reviewRequired: true,
    };
    await fresh();
    if (!result.statistical.thresholdPassed) {
      result.assessment = 'different';
      result.reason = 'At least one fully compared frame failed strict visual metrics; keep both copies.';
      return result;
    }
    // These native filters measure every frame in C, without raw full-resolution frames in JavaScript.
    // Common-grid scores control for resolution; native scores normalized by width expose fake upscales.
    type QualityFrame = { frame: number; time: number; blur: number; block: number };
    const qualityFrames = async function* (path: string, seek: number, common: boolean) {
      const filter = `setpts=PTS-STARTPTS,${common ? `${scale},` : ''}blurdetect,blockdetect,metadata=mode=print:file=-:direct=1`;
      const process = start([
        ...prefix,
        ...input(path, seek),
        '-t',
        a.duration.toFixed(9),
        '-map',
        '0:v:0',
        '-vf',
        filter,
        '-an',
        '-sn',
        '-dn',
        '-threads',
        '1',
        '-f',
        'null',
        'pipe:1',
      ]);
      let index = -1,
        record: Partial<QualityFrame> | undefined;
      for await (const line of process.lines()) {
        const header = /^frame:(\d+)\s+pts:-?\d+\s+pts_time:([\d.e+-]+)/.exec(line);
        if (header) {
          if (record) throw new Error('Incomplete all-frame quality record.');
          const frame = Number(header[1]),
            time = Number(header[2]);
          if (frame !== ++index || !Number.isFinite(time) || Math.abs(time - frame / a.fps) > 0.001001)
            throw new Error('Quality measurements do not map to every candidate frame.');
          record = { frame, time };
          continue;
        }
        const metric = /^lavfi\.(blur|block)=([\d.e+-]+)/.exec(line);
        if (!metric || !record) throw new Error('Invalid full-frame quality metric.');
        const value = Number(metric[2]);
        if (!Number.isFinite(value) || value < 0)
          throw new Error('Undefined quality on low-detail frames requires review.');
        const key = metric[1] as 'blur' | 'block';
        if (record[key] !== undefined) throw new Error('Duplicate full-frame quality metric.');
        record[key] = value;
        if (record.blur !== undefined && record.block !== undefined) {
          yield record as QualityFrame;
          record = undefined;
        }
      }
      if (record) throw new Error('Incomplete final quality record.');
    };
    const tolerances = { blurRatio: 1.05, blockRatio: 1.05, blurAbsolute: 0.05, blockAbsolute: 0.05 };
    const measured = async (common: boolean) => {
      const left = qualityFrames(paths[0], 0, common),
        right = qualityFrames(paths[1], offset, common);
      const sums = [
        { blur: 0, maximumBlur: 0, block: 0, maximumBlock: 0 },
        { blur: 0, maximumBlur: 0, block: 0, maximumBlock: 0 },
      ];
      let count = 0,
        nonworse = 0;
      const widths = [a.video.width!, common ? a.video.width! : b.video.width!];
      while (true) {
        const pair = await Promise.all([left.next(), right.next()]);
        if (pair[0].done || pair[1].done) {
          if (pair[0].done !== pair[1].done) throw new Error('Quality frame counts differ.');
          break;
        }
        const c = pair[0].value,
          r = pair[1].value;
        if (c.frame !== r.frame || Math.abs(c.time - r.time) > 0.001001)
          throw new Error('Quality frames are not aligned.');
        for (let i = 0; i < 2; i++) {
          const value = pair[i]!.value!;
          sums[i]!.blur += value.blur;
          sums[i]!.block += value.block;
          sums[i]!.maximumBlur = Math.max(sums[i]!.maximumBlur, value.blur);
          sums[i]!.maximumBlock = Math.max(sums[i]!.maximumBlock, value.block);
        }
        const candidateBlur = common ? c.blur : c.blur / widths[0]!,
          retainedBlur = common ? r.blur : r.blur / widths[1]!;
        const blurAllowance = common ? tolerances.blurAbsolute : tolerances.blurAbsolute / widths[0]!;
        if (
          retainedBlur <= candidateBlur * tolerances.blurRatio + blurAllowance &&
          r.block <= c.block * tolerances.blockRatio + tolerances.blockAbsolute
        )
          nonworse++;
        if (++count > frames) throw new Error('Quality comparison exceeds complete candidate interval.');
        if (count % 120 === 0) progress('quality', count);
      }
      if (count !== frames) throw new Error('Quality comparison did not measure every candidate frame.');
      const summary = sums.map((sum, index): VideoQualityMetrics => ({
        meanBlurWidth: sum.blur / count,
        maximumBlurWidth: sum.maximumBlur,
        meanNormalizedBlurWidth: sum.blur / count / widths[index]!,
        meanBlockArtifacts: sum.block / count,
        maximumBlockArtifacts: sum.maximumBlock,
      }));
      return { candidate: summary[0]!, retained: summary[1]!, nonworse };
    };
    progress('quality');
    const common = await measured(true);
    await fresh();
    const native = await measured(false);
    await fresh();
    const dominates = common.nonworse === frames && native.nonworse === frames;
    result.quality.measurements = {
      method: 'all-frame-blurdetect-blockdetect-common-and-native-grids',
      allFramesMeasured: true,
      frames,
      commonGrid: { candidate: common.candidate, retained: common.retained },
      nativeGrid: { candidate: native.candidate, retained: native.retained },
      direction: dominates ? 'retained-dominates' : 'uncertain',
      commonGridNonworseFrames: common.nonworse,
      normalizedNativeNonworseFrames: native.nonworse,
      tolerances,
      reason: dominates
        ? 'Retained blur/block metrics are no worse in every aligned common and normalized-native frame within explicit tolerances. This is numerical quality evidence, not proof that tiny unique overlays are absent.'
        : 'At least one aligned frame has a quality tradeoff or worse retained blur/block score; preserve both pending review.',
    };
    result.assessment = result.statistical.thresholdPassed ? 'full-interval-statistical-match' : 'different';
    result.reason = !result.auxiliary?.supported
      ? `Unsupported packet or decoded-frame auxiliary content (${result.auxiliary?.reasons.join(', ')}) requires separate preservation; retain both.`
      : !result.audio.covered
        ? 'Video fully compared, but independent or lossy-different audio needs full-stream correlation or review; retain both.'
        : result.statistical.thresholdPassed
          ? 'Every frame passed strict visual metrics; measured blur/block quality is attached, but tiny unique overlays or quality tradeoffs require review before recycling.'
          : 'At least one fully compared frame failed strict visual metrics; keep both copies.';
    return result;
  } catch (error) {
    signal.throwIfAborted();
    result.reason = error instanceof Error ? error.message : String(error);
    return result;
  } finally {
    clearInterval(timer);
    for (const process of active) process.kill(new Error('Video confirmation finished.'));
    await Promise.allSettled([...active].map((process) => process.done));
  }
}
