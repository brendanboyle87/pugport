import { spawn } from './platform/test-process.ts';
import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { findMediaExecutables } from './media-decoder.ts';
import type { MediaFileStamp } from './media-confirmation.ts';
import { fileIdentity, sameIno } from './platform/file-identity.ts';

export const compressedVideoConfirmationVersion = 'compressed-packet-interval-v1';
export type CompressedVideoConfirmationOptions = {
  retainedOffsetSeconds?: number;
  expectedStamps?: readonly [MediaFileStamp, MediaFileStamp];
  signal?: AbortSignal;
  appRoot?: string;
  ffprobePath?: string;
  timeoutMs?: number;
  onProgress?: (progress: { stage: 'packets'; packets: number }) => void;
  /** Caller must durably archive the entire returned proof before recycling when this exception is used. */
  headerDatePolicy?: 'archive-original-dates-in-proof';
};
export type CompressedVideoConfirmation = {
  version: typeof compressedVideoConfirmationVersion;
  verified: boolean;
  recycleEligible: boolean;
  candidate: string;
  retained: string;
  stamps: [MediaFileStamp, MediaFileStamp];
  reason?: string;
  retainedOffsetSeconds: number;
  coverage?: {
    allCandidatePacketsCompared: boolean;
    payloadsEqual: boolean;
    extradataEqual: boolean;
    timingVerified: boolean;
    timingToleranceSeconds: number;
    tracks: Array<{ index: number; codec: string; packets: number; candidateInterval: [number, number] }>;
    timelineDigest: string;
  };
  /** Header dates may instead be preserved in the proof under the explicit durable-archive policy. */
  metadataCovered: boolean;
  auxiliary: {
    supported: boolean;
    packetSideDataCovered: boolean;
    containerPayloadsCovered: boolean;
    retainedOnlyTerminalZeroPadding?: {
      bytes: number;
      header: 'explicit-size32' | 'all-zero-eof';
      candidatePrefixBytesVerified?: number;
      candidatePrefixSha256?: string;
    };
    headerDateNormalization?: {
      basis: 'verified-mvhd-format-and-mdhd-stream-creation-time';
      policy: 'archive-original-dates-in-proof';
      requiresDurableArchive: true;
      originalDates: { candidate: HeaderDateEvidence; retained: HeaderDateEvidence };
    };
    reasons: string[];
  };
};

type Snapshot = { stamp: MediaFileStamp; identity: string };
type Stream = Record<string, unknown> & { index: number; codec_type: string; codec_name: string };
type Probe = { streams: Stream[]; chapters?: unknown[]; format?: Record<string, unknown> };
type Packet = { pts: number; dts: number; duration: number; size: number; hash: string; flags: string; side: string[] };
type HeaderDate = { path: string; version: number; rawCreationSeconds: string; rawModificationSeconds: string };
type HeaderDateEvidence = {
  formatCreationTime: string | null;
  streamCreationTimes: Array<string | null>;
  headers: HeaderDate[];
};
const tolerance = 0.000002; // ffprobe prints microsecond precision; never a frame-sized tolerance.
const samePath = (a: string, b: string) =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const inside = (path: string, root: string) => {
  const tail = relative(root, path);
  return !tail || (!isAbsolute(tail) && tail !== '..' && !tail.startsWith(`..${sep}`));
};
const sameStamp = (a: MediaFileStamp, b: MediaFileStamp) =>
  a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && sameIno(a.ino, b.ino);
async function snapshot(path: string, roots: readonly string[]): Promise<Snapshot> {
  if (!roots.some((root) => inside(path, root))) throw new Error('Packet confirmation is outside the explicit scope.');
  const info = await lstat(path, { bigint: true });
  const { dev, ino } = fileIdentity(info);
  const ordinary = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || !samePath(await realpath(path), path))
    throw new Error('Packet confirmation refuses nonregular files and path aliases.');
  if (!Number.isSafeInteger(ordinary.size) || ordinary.size < 1) throw new Error('Invalid media file size.');
  return {
    stamp: { size: ordinary.size, mtimeMs: ordinary.mtimeMs, ctimeMs: ordinary.ctimeMs, ino: String(ino) },
    identity: [dev, ino, info.size, info.mtimeNs, info.ctimeNs].join(':'),
  };
}

// Shared process permit: concurrent confirmations also cannot create more than two ffprobe children.
let processes = 0;
const waiters: Array<() => void> = [];
// Reserve the paired-reader lane as one unit so two concurrent callers cannot each
// hold one process permit while waiting for the other's second permit.
let confirmationTail: Promise<void> = Promise.resolve();
async function permit(signal: AbortSignal) {
  signal.throwIfAborted();
  const release = () => {
    const next = waiters.shift();
    if (next) next();
    else processes--;
  };
  if (processes >= 2)
    await new Promise<void>((accept, reject) => {
      const ready = () => {
        signal.removeEventListener('abort', abort);
        accept();
      };
      const abort = () => {
        const i = waiters.indexOf(ready);
        if (i >= 0) waiters.splice(i, 1);
        reject(new Error('Packet confirmation cancelled.'));
      };
      waiters.push(ready);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  else processes++;
  if (signal.aborted) {
    release();
    signal.throwIfAborted();
  }
  return release;
}

/** Async stdout iteration supplies backpressure. Every line, record and diagnostic is bounded. */
async function* lines(executable: string, args: string[], signal: AbortSignal, timeoutMs: number) {
  const release = await permit(signal);
  const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let failure: Error | undefined;
  const close = new Promise<void>((accept) => {
    child.once('error', (error) => {
      failure = error;
    });
    child.once('close', (code) => {
      if (code !== 0) failure ??= new Error(`Packet probe failed (exit ${code}).`);
      accept();
    });
  });
  const stop = (error: Error) => {
    failure ??= error;
    child.kill('SIGKILL');
    child.stdout.destroy();
    child.stderr.destroy();
  };
  const abort = () => stop(new Error('Packet confirmation cancelled.'));
  const timer = setTimeout(() => stop(new Error('Packet confirmation timed out.')), timeoutMs);
  signal.addEventListener('abort', abort, { once: true });
  child.stderr.on('data', () => {}); // Drain diagnostics without retaining paths or unbounded bytes.
  let pending = '';
  try {
    if (signal.aborted) abort();
    for await (const chunk of child.stdout) {
      signal.throwIfAborted();
      pending += (chunk as Buffer).toString('utf8');
      let end: number;
      while ((end = pending.indexOf('\n')) >= 0) {
        if (end > 65536) throw new Error('Packet probe exceeded line limit.');
        const line = pending.slice(0, end).replace(/\r$/, '');
        pending = pending.slice(end + 1);
        yield line;
      }
      if (pending.length > 65536) throw new Error('Packet probe exceeded line limit.');
    }
    if (pending) yield pending;
    await close;
    if (failure) throw failure;
  } catch (error) {
    throw failure ?? error;
  } finally {
    child.kill('SIGKILL');
    child.stdout.destroy();
    child.stderr.destroy();
    await close;
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    release();
  }
}
// Force the self-contained MOV demuxer. It cannot auto-detect a playlist and read
// unrelated local media outside the caller's scope; external data refs stay disabled.
const baseArgs = [
  '-v',
  'error',
  '-protocol_whitelist',
  'file,pipe',
  '-f',
  'mov',
  '-enable_drefs',
  '0',
  '-show_data_hash',
  'sha256',
];
async function probe(executable: string, path: string, signal: AbortSignal, timeout: number): Promise<Probe> {
  let json = '';
  for await (const line of lines(
    executable,
    [...baseArgs, '-show_streams', '-show_format', '-show_chapters', '-of', 'json', path],
    signal,
    timeout,
  )) {
    json += line + '\n';
    if (json.length > 2 * 1024 * 1024) throw new Error('Packet metadata exceeded bounded output limit.');
  }
  return JSON.parse(json) as Probe;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
function tags(value: unknown, deferHeaderDate = false) {
  const result = { ...(value as Record<string, unknown> | undefined) };
  // Container bookkeeping and writing-tool identity do not alter the media or user-authored tags.
  for (const key of Object.keys(result))
    if (
      [
        'encoder',
        'major_brand',
        'minor_version',
        'compatible_brands',
        'duration',
        'number_of_frames',
        'number_of_bytes',
        'bps',
      ].includes(key.toLowerCase())
    )
      delete result[key];
  // This key is deferred only until its exact raw-header origin is verified below.
  // Opaque user-authored tag payloads remain covered by ordered raw box hashes.
  if (deferHeaderDate) delete result.creation_time;
  return result;
}
function descriptor(stream: Stream) {
  const result = { ...stream };
  for (const key of [
    'index',
    'id',
    'codec_tag',
    'codec_tag_string',
    'time_base',
    'start_pts',
    'start_time',
    'duration_ts',
    'duration',
    'bit_rate',
    'max_bit_rate',
    'nb_frames',
    'nb_read_frames',
    'nb_read_packets',
  ])
    delete result[key];
  result.tags = tags(result.tags, true);
  return result;
}

/** Ordinary, unfragmented MP4 only. Every mdat byte must belong to a referenced sample. */
async function mp4Coverage(path: string, counts: readonly number[], signal: AbortSignal) {
  const file = await open(path, 'r');
  const hashes: string[] = [],
    media: Array<[number, number]> = [],
    ranges: Array<[number, number]> = [];
  const trackTables: Array<Record<string, Buffer>> = [];
  const headerDates: HeaderDate[] = [];
  let boxes = 0,
    bytesRead = 0;
  let terminalZeroPaddingHash: string | undefined;
  let terminalZeroPaddingBytes: number | undefined;
  let terminalZeroPaddingHeader: 'explicit-size32' | 'all-zero-eof' | undefined;
  const size = (await file.stat()).size;
  async function read(start: number, length: number) {
    signal.throwIfAborted();
    bytesRead += length;
    if (bytesRead > 32 * 1024 * 1024 || length > 8 * 1024 * 1024)
      throw new Error('Container guard exceeded bounded metadata limit.');
    const buffer = Buffer.alloc(length);
    const result = await file.read(buffer, 0, length, start);
    if (result.bytesRead !== length) throw new Error('Truncated MP4 box.');
    return buffer;
  }
  async function walk(start: number, end: number, depth: number, trail: string, track?: Record<string, Buffer>) {
    if (depth > 12) throw new Error('MP4 box nesting exceeded limit.');
    while (start < end) {
      if (++boxes > 10000 || end - start < 8) throw new Error('Malformed or excessive MP4 boxes.');
      const head = await read(start, 8);
      const type = head.toString('latin1', 4, 8);
      let length = head.readUInt32BE(0),
        header = 8;
      if (length === 1) {
        const wide = (await read(start + 8, 8)).readBigUInt64BE();
        if (wide > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Unsafe MP4 size.');
        length = Number(wide);
        header = 16;
      }
      if (length === 0) length = end - start;
      if (length < header || length > end - start) throw new Error('MP4 box exceeds parent bounds.');
      const bodyStart = start + header,
        bodyEnd = start + length,
        key = `${trail}/${type}${type === 'trak' ? `[${trackTables.length}]` : ''}`;
      if (type === 'mdat' && depth === 0) media.push([bodyStart, bodyEnd]);
      else if (['free', 'skip', 'wide'].includes(type)) {
        /* Explicit container padding. */
      } else if (type === 'ftyp' && depth === 0) {
        const brands = await read(bodyStart, bodyEnd - bodyStart);
        if (brands.length < 8 || (brands.length - 8) % 4) throw new Error('Invalid MP4 brands.');
      } else if (['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf'].includes(type)) {
        let childTrack = track;
        if (type === 'trak') {
          childTrack = {};
          trackTables.push(childTrack);
        }
        await walk(bodyStart, bodyEnd, depth + 1, key, childTrack);
      } else {
        const body = await read(bodyStart, bodyEnd - bodyStart);
        if (type === 'dref') {
          if (
            body.length !== 20 ||
            body.readUInt32BE(0) !== 0 ||
            body.readUInt32BE(4) !== 1 ||
            body.readUInt32BE(8) !== 12 ||
            body.toString('latin1', 12, 16) !== 'url ' ||
            body.readUInt32BE(16) !== 1
          )
            throw new Error('External or unsupported MP4 data references require review.');
        }
        if (track && ['stsz', 'stco', 'co64', 'stsc'].includes(type)) {
          if (track[type]) throw new Error('Duplicate MP4 sample table.');
          track[type] = body;
        }
        if (['stts', 'ctts', 'stsc', 'stsz', 'stco', 'co64', 'stss'].includes(type) && trail.endsWith('/stbl')) {
          // Enumerated packet payload and PTS/DTS/duration maps cover these sample index tables.
        } else {
          // Normalize only creation/modification dates and the next unused track ID; preserve durations, flags, matrices,
          // sample descriptions, unknown boxes, edits and all opaque metadata payloads exactly.
          if (
            (type === 'mvhd' && trail === '/moov') ||
            (type === 'tkhd' && /^\/moov\/trak\[\d+\]$/.test(trail)) ||
            (type === 'mdhd' && /^\/moov\/trak\[\d+\]\/mdia$/.test(trail))
          ) {
            const version = body[0];
            if (version !== 0 && version !== 1) throw new Error('Unsupported MP4 header version.');
            const dateEnd = version === 0 ? 12 : 20;
            if (body.length < dateEnd + 12) throw new Error('Truncated MP4 timing header.');
            if (headerDates.some((date) => date.path === key)) throw new Error('Duplicate MP4 timing header.');
            headerDates.push({
              path: key,
              version,
              rawCreationSeconds: (version === 0 ? BigInt(body.readUInt32BE(4)) : body.readBigUInt64BE(4)).toString(),
              rawModificationSeconds: (version === 0
                ? BigInt(body.readUInt32BE(8))
                : body.readBigUInt64BE(12)
              ).toString(),
            });
            body.fill(0, 4, dateEnd);
            if (type === 'mvhd') body.fill(0, body.length - 4);
          }
          if (type === 'stsd' && trail.endsWith('/stbl')) {
            if (body.length < 16 || body.readUInt32BE(0) !== 0 || body.readUInt32BE(4) !== 1)
              throw new Error('Unsupported MP4 sample descriptions.');
            const entryLength = body.readUInt32BE(8),
              codec = body.toString('latin1', 12, 16);
            if (entryLength !== body.length - 8) throw new Error('Malformed MP4 sample description.');
            if (body.readUInt16BE(22) !== 1) throw new Error('Unsupported MP4 sample data-reference index.');
            const videoEntry = ['avc1', 'hvc1', 'hev1', 'av01', 'vp09', 'mp4v'].includes(codec);
            const audioEntry = ['mp4a', 'Opus', 'fLaC'].includes(codec);
            if (!videoEntry && !audioEntry) throw new Error('Unsupported MP4 sample entry.');
            let position = 8 + (videoEntry ? 86 : 36);
            if (position > body.length) throw new Error('Truncated MP4 sample entry.');
            while (position < body.length) {
              if (body.length - position < 8) throw new Error('Truncated MP4 codec box.');
              const childLength = body.readUInt32BE(position),
                childType = body.toString('latin1', position + 4, position + 8);
              if (childLength < 8 || childLength > body.length - position) throw new Error('Malformed MP4 codec box.');
              if (childType === 'btrt') {
                if (childLength !== 20) throw new Error('Unsupported MP4 bitrate box.');
                body.fill(0, position + 8, position + 20); // Buffer/peak/average bitrate bookkeeping.
              }
              position += childLength;
            }
          }
          const hash = `${key}:${createHash('sha256').update(body).digest('hex')}`;
          hashes.push(hash);
          // This is evidence for one directional exception, not a general unknown-box
          // allowlist. Keep it in the ordered hashes so candidate-side bytes stay covered.
          if (
            depth === 0 &&
            bodyEnd === size &&
            header === 8 &&
            (head.readUInt32BE(0) === length || head.every((byte) => byte === 0)) &&
            length >= 8 &&
            length <= 4096 &&
            type === '\0\0\0\0' &&
            body.every((byte) => byte === 0)
          ) {
            terminalZeroPaddingHash = hash;
            terminalZeroPaddingBytes = length;
            terminalZeroPaddingHeader = head.readUInt32BE(0) === length ? 'explicit-size32' : 'all-zero-eof';
          }
        }
      }
      start = bodyEnd;
    }
  }
  try {
    await walk(0, size, 0, '');
    if (!media.length || trackTables.length !== counts.length)
      throw new Error('Unsupported MP4 media/track structure.');
    for (let index = 0; index < trackTables.length; index++) {
      const table = trackTables[index]!,
        sz = table.stsz,
        offsets = table.stco ?? table.co64,
        sc = table.stsc;
      if (!sz || !offsets || !sc || sz.length < 12 || offsets.length < 8 || sc.length < 8)
        throw new Error('Missing MP4 sample accounting.');
      if (sz.readUInt32BE(0) || offsets.readUInt32BE(0) || sc.readUInt32BE(0))
        throw new Error('Unsupported MP4 sample table version.');
      const fixed = sz.readUInt32BE(4),
        samples = sz.readUInt32BE(8),
        chunks = offsets.readUInt32BE(4),
        entries = sc.readUInt32BE(4),
        stride = table.co64 ? 8 : 4;
      if (samples > 250000 || chunks > 250000 || ranges.length + chunks > 250000)
        throw new Error('MP4 sample accounting exceeded bounded table limit.');
      if (
        samples !== counts[index] ||
        sz.length !== 12 + (fixed ? 0 : samples * 4) ||
        offsets.length !== 8 + chunks * stride ||
        sc.length !== 8 + entries * 12 ||
        !entries ||
        !chunks
      )
        throw new Error('MP4 sample map does not cover all probed packets.');
      let sample = 0,
        entry = 0,
        previousFirst = 0;
      for (let e = 0; e < entries; e++) {
        const first = sc.readUInt32BE(8 + e * 12);
        if (
          first <= previousFirst ||
          (e === 0 && first !== 1) ||
          first > chunks ||
          !sc.readUInt32BE(12 + e * 12) ||
          sc.readUInt32BE(16 + e * 12) !== 1
        )
          throw new Error('Unsupported MP4 sample description/chunk map.');
        previousFirst = first;
      }
      for (let chunk = 1; chunk <= chunks; chunk++) {
        while (entry + 1 < entries && sc.readUInt32BE(8 + (entry + 1) * 12) <= chunk) entry++;
        const n = sc.readUInt32BE(12 + entry * 12);
        if (sample + n > samples) throw new Error('MP4 sample count overrun.');
        const position = table.co64
          ? Number(offsets.readBigUInt64BE(8 + (chunk - 1) * stride))
          : offsets.readUInt32BE(8 + (chunk - 1) * stride);
        let length = 0;
        for (let j = 0; j < n; j++) {
          const bytes = fixed || sz.readUInt32BE(12 + sample++ * 4);
          if (fixed) sample++;
          if (!bytes) throw new Error('Empty MP4 sample.');
          length += bytes;
        }
        if (!Number.isSafeInteger(position) || position + length > size) throw new Error('Unsafe MP4 sample offset.');
        ranges.push([position, position + length]);
      }
      if (sample !== samples) throw new Error('Unmapped MP4 samples.');
    }
    ranges.sort((a, b) => a[0] - b[0]);
    media.sort((a, b) => a[0] - b[0]);
    let index = 0;
    for (const [start, end] of media) {
      let cursor = start;
      while (index < ranges.length && ranges[index]![0] < end) {
        const range = ranges[index++]!;
        if (range[0] !== cursor || range[1] > end)
          throw new Error('Unreferenced or overlapping MP4 media payload requires review.');
        cursor = range[1];
      }
      if (cursor !== end) throw new Error('Unreferenced MP4 media payload requires review.');
    }
    if (index !== ranges.length) throw new Error('MP4 samples outside media boxes.');
    return { hashes, headerDates, terminalZeroPaddingHash, terminalZeroPaddingBytes, terminalZeroPaddingHeader };
  } finally {
    await file.close();
  }
}

/** An implicit EOF box is accepted only with literal preservation of the entire encoded candidate. */
async function exactEncodedPrefix(
  candidate: string,
  retained: string,
  extra: number,
  signal: AbortSignal,
  timeout: number,
) {
  const left = await open(candidate, 'r');
  let right: Awaited<ReturnType<typeof open>> | undefined;
  const deadline = Date.now() + timeout;
  const check = () => {
    signal.throwIfAborted();
    if (Date.now() >= deadline) throw new Error('Encoded prefix confirmation timed out.');
  };
  try {
    right = await open(retained, 'r');
    const a = await left.stat(),
      b = await right.stat();
    if (!Number.isSafeInteger(a.size) || b.size !== a.size + extra)
      throw new Error('Implicit zero-tail proof requires exact encoded prefix/suffix sizes.');
    const buffers = [Buffer.alloc(256 * 1024), Buffer.alloc(256 * 1024)];
    const hash = createHash('sha256');
    for (let position = 0; position < a.size;) {
      check();
      const length = Math.min(buffers[0]!.length, a.size - position);
      const reads = await Promise.all([
        left.read(buffers[0]!, 0, length, position),
        right.read(buffers[1]!, 0, length, position),
      ]);
      check();
      if (
        reads.some((read) => read.bytesRead !== length) ||
        !buffers[0]!.subarray(0, length).equals(buffers[1]!.subarray(0, length))
      )
        throw new Error(
          'Implicit zero-tail proof requires every candidate encoded byte preserved in the retained prefix.',
        );
      hash.update(buffers[0]!.subarray(0, length));
      position += length;
    }
    const tail = Buffer.alloc(extra);
    const suffix = await right.read(tail, 0, extra, a.size);
    check();
    if (suffix.bytesRead !== extra || !tail.every((byte) => byte === 0))
      throw new Error('Implicit EOF suffix must consist entirely of zero bytes.');
    return { bytes: a.size, sha256: hash.digest('hex') };
  } finally {
    await Promise.all([left.close(), ...(right ? [right.close()] : [])]);
  }
}
function verifyHeaderDateNormalization(a: Probe, b: Probe, left: HeaderDate[], right: HeaderDate[]) {
  const value = (object: unknown): string | null => {
    const date = (object as Record<string, unknown> | undefined)?.creation_time;
    if (date === undefined) return null;
    if (typeof date !== 'string') throw new Error('Unsupported creation_time tag value.');
    return date;
  };
  const evidence = (probe: Probe, headers: HeaderDate[]): HeaderDateEvidence => ({
    formatCreationTime: value(probe.format?.tags),
    streamCreationTimes: probe.streams.map((stream) => value(stream.tags)),
    headers,
  });
  const candidate = evidence(a, left),
    retained = evidence(b, right);
  const derived = (tag: string | null, headers: HeaderDate[], path: string) => {
    const header = headers.find((item) => item.path === path);
    if (!header) return false;
    const raw = BigInt(header.rawCreationSeconds);
    if (tag === null) return raw === 0n;
    // FFmpeg mov.c derives format creation_time from mvhd and stream creation_time
    // from mdhd. Reject v0's ambiguous Unix-epoch heuristic for dates before 1970.
    if (raw < 2082844800n || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.0{1,9})?Z$/.test(tag)) return false;
    const milliseconds = Date.parse(tag);
    return (
      Number.isSafeInteger(milliseconds) &&
      milliseconds % 1000 === 0 &&
      BigInt(milliseconds / 1000) + 2082844800n === raw
    );
  };
  const validatePair = (x: string | null, y: string | null, path: string) => {
    if (x !== y && (!derived(x, left, path) || !derived(y, right, path)))
      throw new Error('Differing creation_time is not exactly derived from the mapped MP4 header.');
  };
  validatePair(candidate.formatCreationTime, retained.formatCreationTime, '/moov/mvhd');
  for (let i = 0; i < a.streams.length; i++)
    validatePair(candidate.streamCreationTimes[i]!, retained.streamCreationTimes[i]!, `/moov/trak[${i}]/mdia/mdhd`);
  return {
    basis: 'verified-mvhd-format-and-mdhd-stream-creation-time' as const,
    originalDates: { candidate, retained },
    datesDiffer: canonical(candidate) !== canonical(retained),
  };
}

async function* packets(executable: string, path: string, stream: number, signal: AbortSignal, timeout: number) {
  const fields: Record<string, string> = {};
  let active = false,
    sideActive = false,
    bytes = 0;
  let side: string[] = [];
  for await (const line of lines(
    executable,
    [
      ...baseArgs,
      '-select_streams',
      String(stream),
      '-show_packets',
      '-show_entries',
      'packet=pts_time,dts_time,duration_time,size,flags,data_hash:packet_side_data',
      '-of',
      'default',
      path,
    ],
    signal,
    timeout,
  )) {
    if (line === '[PACKET]') {
      active = true;
      bytes = 0;
      side = [];
      for (const key of Object.keys(fields)) delete fields[key];
      continue;
    }
    if (line === '[/PACKET]') {
      if (!active || sideActive) throw new Error('Malformed packet record.');
      const numeric = (key: string) => {
        const n = Number(fields[key]);
        if (!fields[key] || !Number.isFinite(n)) throw new Error('Missing packet timestamp/sample map.');
        return n;
      };
      const packet: Packet = {
        pts: numeric('pts_time'),
        dts: numeric('dts_time'),
        duration: numeric('duration_time'),
        size: numeric('size'),
        hash: fields.data_hash ?? '',
        flags: fields.flags ?? '',
        side,
      };
      if (packet.duration <= 0 || packet.size <= 0 || !/^SHA256:[a-f0-9]{64}$/i.test(packet.hash))
        throw new Error('Unsupported packet payload or duration.');
      // Skip Samples exposes its complete scalar payload. Other side-data types may omit binary payloads.
      if (side.some((item) => item.startsWith('side_data_type=') && item !== 'side_data_type=Skip Samples'))
        throw new Error('Unsupported external packet side data.');
      if (
        side.length &&
        (!side.includes('side_data_type=Skip Samples') ||
          side.filter((item) => item.startsWith('side_data_type=')).length !== 1 ||
          !['skip_samples', 'discard_padding', 'skip_reason', 'discard_reason'].every((key) =>
            side.some((item) => item.startsWith(`${key}=`)),
          ))
      )
        throw new Error('Incomplete packet side-data payload.');
      active = false;
      yield packet;
      continue;
    }
    if (!active) {
      if (line.trim()) throw new Error('Unexpected probe packet output.');
      continue;
    }
    bytes += line.length;
    if (bytes > 131072) throw new Error('Packet record exceeded bounded output limit.');
    if (line === '[SIDE_DATA]') {
      sideActive = true;
      continue;
    }
    if (line === '[/SIDE_DATA]') {
      sideActive = false;
      continue;
    }
    if (sideActive) side.push(line);
    else {
      const i = line.indexOf('=');
      if (i <= 0) throw new Error('Malformed packet field.');
      fields[line.slice(0, i)] = line.slice(i + 1);
    }
  }
  if (active) throw new Error('Truncated packet output.');
}

/** Exact compressed access units include in-band SEI; reencoding never satisfies this proof. */
export async function confirmCompressedVideoDuplicate(
  candidate: string,
  retained: string,
  roots: readonly string[],
  options: CompressedVideoConfirmationOptions = {},
): Promise<CompressedVideoConfirmation> {
  const controller = new AbortController();
  const relay = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', relay, { once: true });
  if (options.signal?.aborted) relay();
  const offset = options.retainedOffsetSeconds ?? 0;
  const report: CompressedVideoConfirmation = {
    version: compressedVideoConfirmationVersion,
    candidate,
    retained,
    verified: false,
    recycleEligible: false,
    stamps: [
      { size: 0, mtimeMs: 0, ctimeMs: 0, ino: 0 },
      { size: 0, mtimeMs: 0, ctimeMs: 0, ino: 0 },
    ],
    retainedOffsetSeconds: offset,
    metadataCovered: false,
    auxiliary: { supported: false, packetSideDataCovered: false, containerPayloadsCovered: false, reasons: [] },
  };
  let unlock: (() => void) | undefined;
  const previous = confirmationTail;
  const lane = new Promise<void>((accept) => {
    unlock = accept;
  });
  confirmationTail = previous.then(() => lane);
  try {
    await new Promise<void>((accept, reject) => {
      const abort = () => {
        controller.signal.removeEventListener('abort', abort);
        reject(new Error('Packet confirmation cancelled.'));
      };
      previous.then(() => {
        controller.signal.removeEventListener('abort', abort);
        accept();
      });
      controller.signal.addEventListener('abort', abort, { once: true });
      if (controller.signal.aborted) abort();
    });
    controller.signal.throwIfAborted();
    if (![candidate, retained, ...roots].every(isAbsolute) || !roots.length || !Number.isFinite(offset) || offset < 0)
      throw new Error('Absolute paths, explicit roots and a nonnegative interval offset are required.');
    candidate = resolve(candidate);
    retained = resolve(retained);
    if (samePath(candidate, retained)) throw new Error('The retained copy must be a different file.');
    const allowed: string[] = [];
    for (const root of roots) {
      const path = resolve(root),
        info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(path), path))
        throw new Error('Confirmation roots must not be aliases.');
      allowed.push(path);
    }
    const before = [await snapshot(candidate, allowed), await snapshot(retained, allowed)] as const;
    report.stamps = [before[0].stamp, before[1].stamp];
    if (before[0].identity.split(':').slice(0, 2).join(':') === before[1].identity.split(':').slice(0, 2).join(':'))
      throw new Error('The two paths refer to the same file identity.');
    if (options.expectedStamps && options.expectedStamps.some((stamp, i) => !sameStamp(stamp, before[i]!.stamp)))
      throw new Error('File changed since the candidate evidence was recorded.');
    const fresh = async () => {
      controller.signal.throwIfAborted();
      if (
        (await snapshot(candidate, allowed)).identity !== before[0].identity ||
        (await snapshot(retained, allowed)).identity !== before[1].identity
      )
        throw new Error('Media changed during packet confirmation.');
    };
    const executable = findMediaExecutables(options.appRoot ?? process.cwd(), options).ffprobe;
    if (!executable) throw new Error('Local ffprobe is unavailable.');
    const timeout = options.timeoutMs ?? 120000;
    if (!Number.isFinite(timeout) || timeout < 1 || timeout > 3600000) throw new Error('Invalid packet timeout.');
    // Sequential metadata leaves both process permits available for the paired streaming readers.
    const a = await probe(executable, candidate, controller.signal, timeout);
    const b = await probe(executable, retained, controller.signal, timeout);
    await fresh();
    if (!a.streams?.length || a.streams.length > 32 || a.streams.length !== b.streams?.length)
      throw new Error('All candidate and retained tracks must map exactly.');
    if (!a.streams.some((stream) => stream.codec_type === 'video')) throw new Error('No video track.');
    if (
      canonical(a.chapters ?? []) !== canonical(b.chapters ?? []) ||
      canonical(tags(a.format?.tags, true)) !== canonical(tags(b.format?.tags, true))
    )
      throw new Error('Meaningful container metadata or chapters differ.');
    const digest = createHash('sha256');
    const tracks: NonNullable<CompressedVideoConfirmation['coverage']>['tracks'] = [];
    const retainedCounts: number[] = [];
    let skippedDecodePrefix = false;
    let total = 0;
    for (let i = 0; i < a.streams.length; i++) {
      const ca = a.streams[i]!,
        rb = b.streams[i]!;
      if (ca.index !== i || rb.index !== i) throw new Error('Unsupported stream-to-container track ordering.');
      if (
        !['video', 'audio'].includes(ca.codec_type) ||
        !['h264', 'hevc', 'av1', 'vp9', 'mpeg4', 'aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le'].includes(
          ca.codec_name,
        )
      )
        throw new Error('Auxiliary or unsupported codec track requires review.');
      if (ca.side_data_list || rb.side_data_list)
        throw new Error('External stream side data requires complete payload review.');
      if (
        ca.codec_type === 'video' &&
        (typeof ca.extradata_hash !== 'string' || !/^SHA256:[a-f0-9]{64}$/i.test(ca.extradata_hash))
      )
        throw new Error('Missing codec extradata hash.');
      if (canonical(descriptor(ca)) !== canonical(descriptor(rb)))
        throw new Error('Codec extradata, track semantics or meaningful stream metadata differ.');
      const left = packets(executable, candidate, ca.index, controller.signal, timeout);
      let retainedCount = 0;
      const rawRight = packets(executable, retained, rb.index, controller.signal, timeout);
      const right = (async function* () {
        for await (const packet of rawRight) {
          retainedCount++;
          yield packet;
        }
      })();
      let count = 0,
        first = Infinity,
        last = -Infinity,
        previousDts = -Infinity;
      try {
        let rp = await right.next();
        for await (const cp of left) {
          const mapped = cp.pts + offset;
          // Walk only the prefix before this explicit interval, then compare contiguous decode-order packets.
          if (!count)
            while (!rp.done && rp.value.dts < cp.dts + offset - tolerance) {
              skippedDecodePrefix = true;
              rp = await right.next();
            }
          if (rp.done) throw new Error('Retained interval does not cover every candidate packet.');
          const p = rp.value;
          if (
            cp.dts < previousDts - tolerance ||
            Math.abs(mapped - p.pts) > tolerance ||
            Math.abs(cp.dts + offset - p.dts) > tolerance ||
            Math.abs(cp.duration - p.duration) > tolerance
          )
            throw new Error('Packet timestamp/sample maps differ.');
          if (
            cp.hash !== p.hash ||
            cp.size !== p.size ||
            cp.flags !== p.flags ||
            canonical(cp.side) !== canonical(p.side)
          )
            throw new Error('Compressed packet payload, flags or side data differ.');
          previousDts = cp.dts;
          first = Math.min(first, cp.pts);
          last = Math.max(last, cp.pts + cp.duration);
          digest.update(canonical([i, cp]));
          count++;
          total++;
          if (total % 256 === 0) {
            await fresh();
            options.onProgress?.({ stage: 'packets', packets: total });
          }
          rp = await right.next();
        }
        if (!count) throw new Error('Empty track cannot establish full interval coverage.');
        // No retained packet within the mapped candidate interval may be omitted.
        while (!rp.done) {
          if (rp.value.pts >= first + offset - tolerance && rp.value.pts < last + offset - tolerance)
            throw new Error('Retained interval has an unmatched packet.');
          rp = await right.next();
        }
      } finally {
        await left.return(undefined);
        await right.return(undefined);
      }
      tracks.push({ index: ca.index, codec: ca.codec_name, packets: count, candidateInterval: [first, last] });
      retainedCounts.push(retainedCount);
      await fresh();
    }
    options.onProgress?.({ stage: 'packets', packets: total });
    await fresh();
    report.verified = true;
    report.coverage = {
      allCandidatePacketsCompared: true,
      payloadsEqual: true,
      extradataEqual: true,
      timingVerified: true,
      timingToleranceSeconds: tolerance,
      tracks,
      timelineDigest: digest.digest('hex'),
    };
    report.auxiliary.packetSideDataCovered = true;
    try {
      if (offset !== 0 || skippedDecodePrefix)
        throw new Error('Mapped inter-frame clip requires independent decoder-reference-state confirmation.');
      if (!String(a.format?.format_name).includes('mp4') || !String(b.format?.format_name).includes('mp4'))
        throw new Error('Container auxiliary guard currently supports ordinary MP4/MOV only.');
      const candidateBoxes = await mp4Coverage(
        candidate,
        tracks.map((track) => track.packets),
        controller.signal,
      );
      const retainedBoxes = await mp4Coverage(retained, retainedCounts, controller.signal);
      const headerDates = verifyHeaderDateNormalization(a, b, candidateBoxes.headerDates, retainedBoxes.headerDates);
      const identicalBoxes = canonical(candidateBoxes.hashes) === canonical(retainedBoxes.hashes);
      const retainedOnlyTerminalPadding =
        retainedBoxes.terminalZeroPaddingHash !== undefined &&
        retainedBoxes.hashes.at(-1) === retainedBoxes.terminalZeroPaddingHash &&
        canonical(candidateBoxes.hashes) === canonical(retainedBoxes.hashes.slice(0, -1));
      if (!identicalBoxes && !retainedOnlyTerminalPadding)
        throw new Error(
          `Opaque metadata, edits, sample descriptions or auxiliary container boxes differ (${candidateBoxes.hashes.find((box, index) => box !== retainedBoxes.hashes[index])?.split(':')[0] ?? 'box count'}).`,
        );
      const prefix =
        !identicalBoxes && retainedOnlyTerminalPadding && retainedBoxes.terminalZeroPaddingHeader === 'all-zero-eof'
          ? await exactEncodedPrefix(
              candidate,
              retained,
              retainedBoxes.terminalZeroPaddingBytes!,
              controller.signal,
              timeout,
            )
          : undefined;
      await fresh();
      if (headerDates.datesDiffer) {
        if (options.headerDatePolicy !== 'archive-original-dates-in-proof')
          throw new Error('Differing original MP4 header dates require the explicit durable proof-archive policy.');
        report.auxiliary.headerDateNormalization = {
          basis: headerDates.basis,
          policy: 'archive-original-dates-in-proof',
          requiresDurableArchive: true,
          originalDates: headerDates.originalDates,
        };
      }
      if (!identicalBoxes && retainedOnlyTerminalPadding)
        report.auxiliary.retainedOnlyTerminalZeroPadding = {
          bytes: retainedBoxes.terminalZeroPaddingBytes!,
          header: retainedBoxes.terminalZeroPaddingHeader!,
          ...(prefix ? { candidatePrefixBytesVerified: prefix.bytes, candidatePrefixSha256: prefix.sha256 } : {}),
        };
      report.auxiliary.containerPayloadsCovered = true;
      report.auxiliary.supported = true;
      report.metadataCovered = true;
      report.recycleEligible = true;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      report.auxiliary.reasons.push(reason);
      report.reason = reason;
      // Mutation/cancellation invalidates even the packet proof established above.
      await fresh();
    }
  } catch (error) {
    report.verified = false;
    report.recycleEligible = false;
    report.reason = error instanceof Error ? error.message : String(error);
  } finally {
    controller.abort();
    options.signal?.removeEventListener('abort', relay);
    unlock?.();
  }
  return report;
}
