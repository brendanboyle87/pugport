import { Buffer } from 'node:buffer';

export const diagnosticBodyLimit = 512 * 1024;
const duration = 30 * 60 * 1000;
const markerInterval = 10_000;
const jsonType = (type: string) => /^application\/(?:[\w.-]+\+)?json$/i.test(type.split(';')[0].trim());
// Next.js server actions answer with React Server Component rows ("<id>:<json>" per line).
const rscType = (type: string) => /^text\/x-component$/i.test(type.split(';')[0].trim());
const bodyType = (type: string) => jsonType(type) || rscType(type);
const privateKey =
  /^(?:headers|requestheaders|responseheaders|cookie|cookies|set-cookie|authorization|proxy-authorization)$/i;
const numeric = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const iso = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;
type ShapeEntry = { path: string[]; type: string; value?: unknown; length?: number };

function shape(value: unknown, values: boolean): ShapeEntry[] {
  const entries: ShapeEntry[] = [];
  function visit(item: unknown, path: string[]) {
    if (entries.length >= 4096 || path.length > 64) return;
    if (Array.isArray(item)) {
      entries.push({ path, type: 'array', length: item.length });
      item.slice(0, 3).forEach((child, i) => visit(child, [...path, String(i)]));
    } else if (item !== null && typeof item === 'object') {
      entries.push({ path, type: 'object' });
      for (const [key, child] of Object.entries(item)) if (!privateKey.test(key)) visit(child, [...path, key]);
    } else {
      const type = item === null ? 'null' : typeof item;
      // RSC encodes dates as "$D<iso>".
      const date = typeof item === 'string' ? item.replace(/^\$D/, '') : '';
      const safe =
        typeof item !== 'string' || numeric.test(item) || (iso.test(date) && Number.isFinite(Date.parse(date)))
          ? item
          : `<string len=${item.length}>`;
      entries.push({ path, type, ...(values ? { value: safe } : {}) });
    }
  }
  visit(value, []);
  return entries;
}

export function responseShape(body: string, contentType: string, size: number, base64 = false) {
  if (!bodyType(contentType) || size > diagnosticBodyLimit) return;
  // Check before decoding, then check decoded bytes too (compressed transfers can be small).
  if (base64 && body.length > Math.ceil(diagnosticBodyLimit / 3) * 4) return;
  const decoded = base64 ? Buffer.from(body, 'base64').toString('utf8') : body;
  if (Buffer.byteLength(decoded) > diagnosticBodyLimit) return;
  if (rscType(contentType)) {
    const rows: ShapeEntry[] = [];
    for (const line of decoded.split('\n')) {
      const row = /^([0-9a-f]+):(.*)$/i.exec(line);
      if (!row) continue;
      try {
        for (const entry of shape(JSON.parse(row[2]), true))
          rows.push({ ...entry, path: [`row:${row[1]}`, ...entry.path] });
      } catch {
        /* Non-JSON rows (module refs, text chunks) are skipped. */
      }
    }
    return rows.length ? rows : undefined;
  }
  try {
    return shape(JSON.parse(decoded), true);
  } catch {
    return;
  }
}

function requestShape(body?: string) {
  if (!body || Buffer.byteLength(body) > diagnosticBodyLimit) return;
  try {
    const parsed = JSON.parse(body);
    const result: { keys: ShapeEntry[]; operationName?: string; query?: string } = { keys: shape(parsed, false) };
    const graphql =
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      ((typeof parsed.query === 'string' &&
        /^\s*(?:(?:query|mutation|subscription|fragment)\b|\{)/.test(parsed.query)) ||
        (parsed.extensions?.persistedQuery && typeof parsed.extensions.persistedQuery === 'object'));
    if (graphql) {
      if (typeof parsed.operationName === 'string' && /^[_A-Za-z][_0-9A-Za-z]*$/.test(parsed.operationName))
        result.operationName = parsed.operationName;
      if (
        typeof parsed.query === 'string' &&
        /^\s*(?:(?:query|mutation|subscription|fragment)\b|\{)/.test(parsed.query)
      ) {
        // Remove block/escaped/unfinished literals and comments before taking the first line.
        result.query = parsed.query
          .replace(
            /"""(?:\\[\s\S]|(?!""")[\s\S])*(?:"""|$)|"(?:\\[\s\S]|[^"\\])*(?:"|$)|#[^\r\n]*/g,
            (literal: string) => literal.replace(/[^\r\n]/g, ''),
          )
          .split(/\r?\n/)[0]
          .slice(0, 120);
      }
    }
    return result;
  } catch {
    return;
  }
}

export function diagnosticRequest(
  request: { url: string; method: string; postData?: string },
  resourceType: string,
  origins: string[],
  now: number,
) {
  if (!['XHR', 'Fetch'].includes(resourceType)) return;
  try {
    const url = new URL(request.url);
    if (!['http:', 'https:'].includes(url.protocol)) return;
    const allowed = origins.some((origin) => {
      try {
        return new URL(origin).origin === url.origin;
      } catch {
        return false;
      }
    });
    if (!allowed && url.hostname !== 'muse.ai' && !url.hostname.endsWith('.muse.ai')) return;
    return {
      time: new Date(now).toISOString(),
      method: request.method,
      origin: url.origin,
      path: url.pathname,
      queryNames: [...new Set(url.searchParams.keys())],
      resourceType,
      requestBody: requestShape(request.postData),
    };
  } catch {
    return;
  }
}

/** One budget and marker cache for the entire bridge lifetime, including reopened windows. */
export class NetworkDiagnosticRun {
  private checked = -Infinity;
  private enabled = false;
  private started?: number;
  private lines = 0;
  constructor(
    private readonly io: { markerExists: () => boolean; append: (line: string) => void; now?: () => number },
  ) {}
  now() {
    return this.io.now?.() ?? Date.now();
  }
  active() {
    const now = this.now();
    if (now - this.checked >= markerInterval) {
      this.checked = now;
      try {
        this.enabled = this.io.markerExists();
      } catch {
        this.enabled = false;
      }
      if (this.enabled) this.started ??= now;
    }
    return this.enabled && this.lines < 300 && this.started !== undefined && now - this.started < duration;
  }
  record(line: object) {
    if (!this.active()) return;
    // Reserve synchronously: concurrent body reads cannot overrun the file budget.
    this.lines++;
    try {
      this.io.append(JSON.stringify(line) + '\n');
    } catch {
      this.lines = 300;
    }
  }
}

type DebuggerPort = {
  isAttached(): boolean;
  attach(version: string): void;
  detach(): void;
  sendCommand(method: string, params?: object): Promise<any>;
  on(event: string, listener: (...args: any[]) => void): unknown;
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
};
type Pending = {
  request: NonNullable<ReturnType<typeof diagnosticRequest>>;
  status?: number;
  contentType: string;
  size: number;
};

function responseMetadata(response: any) {
  // Retain only the media type, never other headers or content-type parameters.
  const contentType = Object.entries(response.headers ?? {}).find(([key]) => key.toLowerCase() === 'content-type')?.[1];
  return {
    status: response.status,
    contentType: String(contentType ?? response.mimeType ?? '')
      .split(';')[0]
      .trim(),
  };
}

/** Passive CDP observer; ports keep tests independent of Electron and disk. */
export function observeMuseNetwork(options: {
  run: NetworkDiagnosticRun;
  debugger: DebuggerPort;
  origin: string;
  currentUrl: () => string;
  every?: (tick: () => void) => () => void;
}) {
  const { run, debugger: debug } = options;
  const pending = new Map<string, Pending>();
  let attached = false;
  let closed = false;
  let generation = 0;
  const release = () => {
    generation++;
    pending.clear();
    debug.removeListener('message', message);
    debug.removeListener('detach', detached);
    const owned = attached;
    attached = false;
    if (owned) {
      try {
        debug.detach();
      } catch {
        /* Window may already be gone. */
      }
    }
  };
  const detached = () => {
    attached = false;
    release();
  };
  const finish = async (id: string, size: number, failed = false) => {
    const item = pending.get(id);
    pending.delete(id);
    if (!item || !attached || !run.active()) return;
    const epoch = generation;
    item.size = Math.max(item.size, size);
    let responseBody;
    if (!failed && bodyType(item.contentType) && item.size <= diagnosticBodyLimit) {
      try {
        const result = await debug.sendCommand('Network.getResponseBody', { requestId: id });
        responseBody = responseShape(result.body, item.contentType, item.size, result.base64Encoded);
      } catch {
        /* Missing/evicted bodies still leave useful metadata. */
      }
    }
    if (attached && epoch === generation && run.active()) {
      run.record({
        ...item.request,
        status: item.status ?? null,
        contentType: item.contentType,
        responseSize: item.size,
        responseBody,
      });
      if (!run.active()) release();
    }
  };
  const message = (_event: unknown, method: string, params: any) => {
    if (!attached || !run.active()) {
      release();
      return;
    }
    const id = params.requestId;
    if (method === 'Network.requestWillBeSent') {
      // Redirect hops reuse the id; never carry an allowed origin into a disallowed hop.
      const previous = pending.get(id);
      if (previous && params.redirectResponse) {
        run.record({
          ...previous.request,
          ...responseMetadata(params.redirectResponse),
          responseSize: params.redirectResponse.encodedDataLength ?? previous.size,
        });
      }
      pending.delete(id);
      if (!run.active()) {
        release();
        return;
      }
      const request = diagnosticRequest(params.request, params.type, [options.origin, options.currentUrl()], run.now());
      if (request && pending.size < 300) pending.set(id, { request, contentType: '', size: 0 });
    } else if (method === 'Network.responseReceived') {
      const item = pending.get(id);
      if (item) {
        Object.assign(item, responseMetadata(params.response));
      }
    } else if (method === 'Network.dataReceived') {
      const item = pending.get(id);
      if (item) item.size += Math.max(0, params.dataLength ?? 0);
    } else if (method === 'Network.loadingFinished') void finish(id, params.encodedDataLength ?? 0);
    else if (method === 'Network.loadingFailed') void finish(id, 0, true);
  };
  const tick = () => {
    if (closed) return;
    if (!run.active()) {
      if (attached) release();
      return;
    }
    try {
      if (attached || debug.isAttached()) return;
      debug.attach('1.3');
      attached = true;
      debug.on('message', message);
      debug.on('detach', detached);
      const epoch = ++generation;
      void debug
        .sendCommand('Network.enable', {
          maxTotalBufferSize: diagnosticBodyLimit * 2,
          maxResourceBufferSize: diagnosticBodyLimit,
          maxPostDataSize: diagnosticBodyLimit,
        })
        .catch(() => {
          if (epoch === generation) release();
        });
    } catch {
      release();
    }
  };
  tick();
  const cancel = options.every
    ? options.every(tick)
    : (() => {
        const timer = setInterval(tick, markerInterval);
        timer.unref();
        return () => clearInterval(timer);
      })();
  return () => {
    closed = true;
    cancel();
    release();
  };
}
