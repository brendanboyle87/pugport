/*
 * When a photo was taken: the EXIF capture date a camera or phone writes into the picture (local time, as
 * the device showed it). Pictures without one (screenshots, edited or downloaded images) fall back to the
 * file's modified date, which the callers decide.
 */

/** Seconds since 1970 from an EXIF block (as `sharp().metadata().exif` gives it), or undefined. */
export function exifCaptureTime(exif: Buffer | undefined): number | undefined {
  if (!exif || exif.length < 14) return undefined;
  try {
    const base = exif.toString('latin1', 0, 6) === 'Exif\0\0' ? 6 : 0;
    const order = exif.toString('latin1', base, base + 2);
    if (order !== 'II' && order !== 'MM') return undefined;
    const little = order === 'II';
    const u16 = (offset: number) => (little ? exif.readUInt16LE(base + offset) : exif.readUInt16BE(base + offset));
    const u32 = (offset: number) => (little ? exif.readUInt32LE(base + offset) : exif.readUInt32BE(base + offset));
    /** The tags of one directory: tag → the offset of its 12-byte entry. */
    const directory = (offset: number) => {
      const tags = new Map<number, number>();
      if (offset < 8 || base + offset + 2 > exif.length) return tags;
      const count = Math.min(u16(offset), 500);
      for (let index = 0; index < count; index++) {
        const entry = offset + 2 + index * 12;
        if (base + entry + 12 > exif.length) break;
        tags.set(u16(entry), entry);
      }
      return tags;
    };
    const text = (entry: number | undefined) => {
      if (entry === undefined || u16(entry + 2) !== 2) return undefined;
      const count = u32(entry + 4);
      const start = count <= 4 ? entry + 8 : u32(entry + 8);
      if (count > 64 || base + start + count > exif.length) return undefined;
      return exif.toString('latin1', base + start, base + start + count).replace(/\0+$/, '');
    };
    const first = directory(u32(4));
    const pointer = first.get(0x8769);
    const details = pointer !== undefined ? directory(u32(pointer + 8)) : new Map<number, number>();
    // Taken, then digitized, then the file's own date-time.
    for (const value of [text(details.get(0x9003)), text(details.get(0x9004)), text(first.get(0x0132))]) {
      const seconds = parseExifDate(value);
      if (seconds !== undefined) return seconds;
    }
  } catch {
    /* A damaged block has no usable date. */
  }
  return undefined;
}

/** "2024:07:15 18:30:05" (local time) → seconds; blank or impossible dates → undefined. */
export function parseExifDate(value: string | undefined): number | undefined {
  const match = /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(value?.trim() ?? '');
  if (!match) return undefined;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (year < 1980 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60)
    return undefined;
  const time = new Date(year, month - 1, day, hour, minute, second).getTime();
  // Cameras with an unset clock write dates in the future; those say nothing.
  return Number.isFinite(time) && time <= Date.now() + 2 * 86_400_000 ? Math.floor(time / 1000) : undefined;
}

export type DateRange = { from?: number; to?: number; label: string };

/**
 * A range from what an executor writes: "2024", "2024-07", "2024-07-15" (also with / or .), each covering
 * the whole year, month or day; `to` is inclusive.
 */
export function dateRange(from: unknown, to: unknown): DateRange | undefined {
  const period = (value: unknown, name: string) => {
    if (value === undefined || value === null || value === '') return undefined;
    const match = /^(\d{4})(?:[-/.](\d{1,2})(?:[-/.](\d{1,2}))?)?$/.exec(String(value).trim());
    if (!match) throw new Error(`${name} 需要写成 2024、2024-07 或 2024-07-15 这样的日期。`);
    const [year, month, day] = [
      Number(match[1]),
      match[2] ? Number(match[2]) : undefined,
      match[3] ? Number(match[3]) : undefined,
    ];
    if ((month !== undefined && (month < 1 || month > 12)) || (day !== undefined && (day < 1 || day > 31)))
      throw new Error(`${name} 不是有效的日期：${String(value)}`);
    const start = new Date(year, (month ?? 1) - 1, day ?? 1);
    const end =
      day !== undefined
        ? new Date(year, month! - 1, day + 1)
        : month !== undefined
          ? new Date(year, month, 1)
          : new Date(year + 1, 0, 1);
    return {
      start: Math.floor(start.getTime() / 1000),
      end: Math.floor(end.getTime() / 1000) - 1,
      text: String(value).trim(),
    };
  };
  const start = period(from, 'from');
  const end = period(to, 'to');
  if (!start && !end) return undefined;
  const range: DateRange = {
    ...(start ? { from: start.start } : {}),
    ...(end ? { to: end.end } : {}),
    label:
      start && end
        ? start.text === end.text
          ? start.text
          : `${start.text} 至 ${end.text}`
        : start
          ? `${start.text} 以后`
          : `${end!.text} 以前`,
  };
  if (range.from !== undefined && range.to !== undefined && range.from > range.to) throw new Error('from 晚于 to。');
  return range;
}

export const inRange = (seconds: number, range: DateRange) =>
  (range.from === undefined || seconds >= range.from) && (range.to === undefined || seconds <= range.to);
