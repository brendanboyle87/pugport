type RelayOptions = { url: string; serviceKey: string; ownerUserId?: string; fetch?: typeof fetch };
type Row = Record<string, unknown>;
const encoder = new TextEncoder();
const bucket = 'problem-report-files';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function reportHash(text: string | Uint8Array): Promise<string> {
  const bytes = typeof text === 'string' ? encoder.encode(text) : text;
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function reportFingerprint(diagnostics: unknown): Promise<string | null> {
  if (!diagnostics || typeof diagnostics !== 'object') return null;
  const evidence = diagnostics as Row;
  const task: string[] = [];
  const strings = (value: unknown): string[] =>
    typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(strings) : [];
  const taskErrors = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(taskErrors);
    else if (value && typeof value === 'object') {
      const row = value as Row;
      const errors = strings(row.errorDetail || row.error || row.errors).filter((text) => text.trim());
      if (errors.length)
        task.push(...errors.map((text) => text + (typeof row.stack === 'string' ? '\n' + row.stack : '')));
      for (const [key, item] of Object.entries(row))
        if (!['error', 'errorDetail', 'errors', 'stack'].includes(key) && item && typeof item === 'object')
          taskErrors(item);
    }
  };
  taskErrors(evidence.task);
  const lines = (task.length ? task.at(-1)! : strings(evidence.errors).join('\n')).split(/\r?\n/);
  const isError = (line: string) => !/^\s*at\s/.test(line) && /\b(?:error|exception|failed|failure)\b/i.test(line);
  let index = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isError(lines[i])) {
      index = i;
      break;
    }
  }
  if (index < 0 && task.length) index = lines.findIndex((line) => line.trim() && !/^\s*at\s/.test(line));
  if (index < 0) return null;
  const frame = lines.slice(index + 1).find((line) => /^\s*at\s+/.test(line)) ?? '';
  const normalize = (text: string) => {
    const codes: string[] = [];
    let normalized = text
      .replace(/\b(?:http|status(?:[ _-]?code)?|(?:error[ _-]?)?code)\s*[:=]?\s*\d{3}\b/gi, (code) => {
        codes.push(code.toLowerCase().replace(/\s+/g, ' '));
        return `__semantic_${String.fromCharCode(65 + codes.length - 1)}__`;
      })
      .replace(/\b\d{4}-\d{2}-\d{2}[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?/g, '')
      .replace(/\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g, '')
      .replace(/(?:[A-Z]:[\\/]|\/(?:[^\s/]+\/)|~[\\/])[^\s)]+/gi, '[path]')
      .replace(/\b(?:[a-f0-9]{8}-[a-f0-9-]{27,}|0x[a-f0-9]+|[a-f0-9]{8,})\b/gi, '[id]')
      .replace(/\d+/g, '#')
      .replace(/\s+/g, ' ')
      .trim();
    codes.forEach((code, index) => {
      normalized = normalized.replace(`__semantic_${String.fromCharCode(65 + index)}__`, code);
    });
    return normalized;
  };
  return reportHash(`${normalize(lines[index])}\n${normalize(frame)}`);
}

async function readBody(request: Request, max: number): Promise<Row> {
  if (Number(request.headers.get('content-length')) > max) throw new HttpError(413, 'Request too large');
  if (!request.body) throw new HttpError(400, 'JSON body required');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new HttpError(413, 'Request too large');
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error();
    return value;
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

function textField(value: unknown, max: number, name: string): string {
  if (typeof value !== 'string' || value.length > max) throw new HttpError(400, `Invalid ${name}`);
  return value;
}

function decodeImage(value: unknown): { bytes: Uint8Array; mime: string; extension: string } {
  const dataUrl = value && typeof value === 'object' ? (value as Row).dataUrl : undefined;
  if (typeof dataUrl !== 'string') throw new HttpError(400, 'Invalid image');
  const match = /^data:image\/(jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match || match[2].length % 4 !== 0) throw new HttpError(400, 'JPEG or WebP required');
  if (match[2].length > Math.ceil(1048576 / 3) * 4) throw new HttpError(413, 'Image exceeds 1 MB');
  const bytes = Uint8Array.from(atob(match[2]), (char) => char.charCodeAt(0));
  if (bytes.length > 1048576) throw new HttpError(413, 'Image exceeds 1 MB');
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const webp =
    new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF' && new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP';
  if (!(match[1] === 'jpeg' ? jpeg : webp)) throw new HttpError(400, 'Invalid image content');
  return { bytes, mime: `image/${match[1]}`, extension: match[1] === 'jpeg' ? 'jpg' : 'webp' };
}

export function createProblemReportHandler(options: RelayOptions, admin = false) {
  const fetcher = options.fetch ?? fetch;
  const base = options.url.replace(/\/$/, '');
  async function backend(path: string, init: RequestInit = {}) {
    const response = await fetcher(`${base}${path}`, {
      ...init,
      headers: {
        apikey: options.serviceKey,
        authorization: `Bearer ${options.serviceKey}`,
        'content-type': 'application/json',
        ...init.headers,
      },
      signal: AbortSignal.timeout(15000),
      redirect: 'error',
    });
    if (!response.ok) {
      const message = await response.text();
      if (message.includes('RATE_LIMIT')) throw new HttpError(429, 'Too many reports');
      if (message.includes('IMAGE_LIMIT')) throw new HttpError(400, 'At most 4 images per report');
      if (message.includes('DIAGNOSTICS_LIMIT')) throw new HttpError(413, 'Diagnostics exceed 200 KB');
      if (message.includes('REPORT_NOT_FOUND')) throw new HttpError(404, 'Report not found');
      throw new HttpError(502, 'Report service unavailable');
    }
    const content = await response.text();
    return content ? JSON.parse(content) : null;
  }
  const rpc = (name: string, body: unknown) =>
    backend(`/rest/v1/rpc/${name}`, { method: 'POST', body: JSON.stringify(body) });
  async function adminReports(rows: Row[], detail = false) {
    const ids = rows.map((row) => row.id).join(',');
    const files: Row[] = ids
      ? await backend(
          `/rest/v1/problem_report_files?ready=eq.true&report_id=in.(${ids})&select=report_id,path&limit=400`,
        )
      : [];
    const signed: Row[] = files.length
      ? await backend(`/storage/v1/object/sign/${bucket}`, {
          method: 'POST',
          body: JSON.stringify({ paths: files.map((file) => file.path), expiresIn: 600 }),
        })
      : [];
    const images = new Map<unknown, string[]>();
    for (const file of files) {
      const url = signed.find((item) => item.path === file.path)?.signedURL;
      if (typeof url !== 'string') throw new HttpError(502, 'Report service unavailable');
      const list = images.get(file.report_id) ?? [];
      list.push(base + '/storage/v1' + url);
      images.set(file.report_id, list);
    }
    return rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      description: row.description,
      ...(detail ? { diagnostics: row.diagnostics } : {}),
      version: row.version,
      os: row.os,
      status: row.status,
      fixedIn: row.fixed_in,
      duplicateOf: row.duplicate_of,
      // Count duplicates within this bounded Inbox window.
      duplicateCount: rows.filter((item) => item.duplicate_of === row.id).length,
      images: images.get(row.id) ?? [],
    }));
  }
  async function report(id: string, request: Request) {
    const secret = request.headers.get('x-report-secret');
    if (!secret || !/^[a-f0-9]{64}$/.test(secret)) throw new HttpError(404, 'Report not found');
    const rows = await backend(
      `/rest/v1/problem_reports?id=eq.${id}&secret_hash=eq.${await reportHash(secret)}&select=id,status,fixed_in,duplicate_of`,
    );
    if (!rows.length) throw new HttpError(404, 'Report not found');
    return rows[0] as Row;
  }
  return async (request: Request): Promise<Response> => {
    try {
      const prefix = admin ? 'report-problem-admin' : 'report-problem';
      const pathname = new URL(request.url).pathname;
      const marker = pathname.indexOf(`/${prefix}`);
      const path = (marker < 0 ? pathname : pathname.slice(marker + prefix.length + 1)).replace(/\/$/, '');
      const route = /^\/(PP-\d+)\/(files|status)$/.exec(path);
      if (admin) {
        const authorization = request.headers.get('authorization');
        if (!authorization?.startsWith('Bearer ')) throw new HttpError(401, 'Authentication required');
        const auth = await fetcher(`${base}/auth/v1/user`, {
          headers: { apikey: options.serviceKey, authorization },
          signal: AbortSignal.timeout(15000),
          redirect: 'error',
        });
        if (!auth.ok) throw new HttpError(401, 'Authentication required');
        const user = (await auth.json()) as { id?: string };
        // OWNER_USER_ID wins when set; otherwise owners are rows in problem_report_admins.
        const owner = options.ownerUserId
          ? user.id === options.ownerUserId
          : !!user.id &&
            /^[0-9a-f-]{36}$/i.test(user.id) &&
            ((await backend(`/rest/v1/problem_report_admins?user_id=eq.${user.id}&select=user_id`)) as Row[]).length >
              0;
        if (!owner) throw new HttpError(403, 'Owner only');
        const detailId = /^\/(PP-\d+)$/.exec(path)?.[1];
        if (request.method === 'GET' && (path === '' || detailId)) {
          const fields = 'id,created_at,description,version,os,status,fixed_in,duplicate_of';
          const rows: Row[] = await backend(
            detailId
              ? `/rest/v1/problem_reports?id=eq.${detailId}&select=${fields},diagnostics&limit=1`
              : `/rest/v1/problem_reports?status=in.(new,seen)&select=${fields}&order=created_at.desc,id.desc&limit=100`,
          );
          if (detailId && !rows.length) throw new HttpError(404, 'Report not found');
          const reports = await adminReports(rows.slice(0, detailId ? 1 : 100), !!detailId);
          return json(detailId ? { report: reports[0] } : { reports });
        }
        if (request.method === 'POST' && route?.[2] === 'status') {
          const body = await readBody(request, 2048);
          if (!['new', 'seen', 'fixed', 'ignored'].includes(String(body.status)))
            throw new HttpError(400, 'Invalid status');
          const fixedIn = body.status === 'fixed' ? textField(body.fixedIn, 120, 'fixed version').trim() : null;
          if (body.status === 'fixed' && !fixedIn) throw new HttpError(400, 'Fixed version required');
          const rows = await backend(`/rest/v1/problem_reports?id=eq.${route[1]}&select=id`, {
            method: 'PATCH',
            headers: { Prefer: 'return=representation' },
            body: JSON.stringify({ status: body.status, fixed_in: fixedIn }),
          });
          if (!rows.length) throw new HttpError(404, 'Report not found');
          return json({ status: body.status, fixedIn });
        }
      } else {
        if (request.method === 'POST' && path === '') {
          const body = await readBody(request, 240 * 1024);
          const installId = textField(body.installId, 128, 'install ID');
          if (!/^[A-Za-z0-9_-]{16,128}$/.test(installId)) throw new HttpError(400, 'Invalid install ID');
          const description = textField(body.description, 4000, 'description');
          const version = textField(body.version, 120, 'version');
          const os = textField(body.os, 120, 'OS');
          if (!body.diagnostics || typeof body.diagnostics !== 'object' || Array.isArray(body.diagnostics))
            throw new HttpError(400, 'Invalid diagnostics');
          if (encoder.encode(JSON.stringify(body.diagnostics)).length > 204800)
            throw new HttpError(413, 'Diagnostics exceed 200 KB');
          const secret = request.headers.get('x-report-secret');
          if (!secret || !/^[a-f0-9]{64}$/.test(secret)) throw new HttpError(400, 'Invalid report secret');
          // The gateway must replace X-Forwarded-For; a missing address shares a conservative quota.
          const ip = request.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown';
          const id = await rpc('create_problem_report', {
            p_install_hash: await reportHash(installId),
            p_ip_hash: await reportHash(ip),
            p_version: version,
            p_os: os,
            p_description: description,
            p_diagnostics: JSON.stringify(body.diagnostics),
            p_secret_hash: await reportHash(secret),
            p_fingerprint: await reportFingerprint(body.diagnostics),
          });
          return json({ id, secret }, 201);
        }
        if (route && request.method === 'GET' && route[2] === 'status') {
          let row = await report(route[1], request);
          if (row.duplicate_of && row.status !== 'fixed') {
            const original = await backend(`/rest/v1/problem_reports?id=eq.${row.duplicate_of}&select=status,fixed_in`);
            if (original[0]?.status === 'fixed') row = original[0];
          }
          return json({ status: row.status, fixedIn: row.fixed_in });
        }
        if (route && request.method === 'POST' && route[2] === 'files') {
          await report(route[1], request);
          const body = await readBody(request, 6 * 1024 * 1024);
          if (!Array.isArray(body.images) || !body.images.length || body.images.length > 4)
            throw new HttpError(400, 'At most 4 images per report');
          const images = body.images.map(decodeImage);
          const paths = await Promise.all(
            images.map(async (image) => `${route[1]}/${await reportHash(image.bytes)}.${image.extension}`),
          );
          await rpc('reserve_problem_report_files', {
            p_id: route[1],
            p_secret_hash: await reportHash(request.headers.get('x-report-secret')!),
            p_paths: paths,
          });
          for (let i = 0; i < images.length; i++) {
            await backend(`/storage/v1/object/${bucket}/${paths[i]}`, {
              method: 'POST',
              headers: { 'content-type': images[i].mime, 'x-upsert': 'true' },
              body: new Uint8Array(images[i].bytes),
            });
            await backend(`/rest/v1/problem_report_files?path=eq.${paths[i]}`, {
              method: 'PATCH',
              body: JSON.stringify({ ready: true }),
            });
          }
          return json({ uploaded: images.length });
        }
      }
      return json({ error: 'Not found' }, 404);
    } catch (error) {
      return json(
        { error: error instanceof HttpError ? error.message : 'Report service unavailable' },
        error instanceof HttpError ? error.status : 502,
      );
    }
  };
}
