import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, mkdtemp, open } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildProblemReport,
  validateProblemReport,
  validateProblemImages,
  type ProblemReportPayload,
  type ProblemReportImage,
  type ProblemReportSummary,
  type ProblemReportInboxItem,
} from '../shared/problem-report.ts';
import type { AppState } from '../shared/types.ts';

type SavedReport = ProblemReportSummary & {
  payload: ProblemReportPayload;
  images: ProblemReportImage[];
  secret?: string;
  attempts: number;
  retryAt: number;
  uploaded: number;
};
type Options = {
  directory: string;
  url: string;
  publishableKey: string;
  fetch?: typeof fetch;
  now?: () => number;
  session: () => { userId: string; accessToken: string; sessionId?: string } | undefined;
  context: (
    taskId?: string,
    includeConversation?: boolean,
    conversationId?: string,
  ) => Promise<{ state: Pick<AppState, 'app' | 'runtimes'>; task?: unknown; conversation?: unknown }>;
  diagnose: (report: ProblemReportInboxItem, directory: string) => Promise<string>;
  changed?: () => void;
};

/** Reads a bounded tail even when a log has grown past its usual rotation size. */
async function errorTail(path: string) {
  try {
    const file = await open(path, 'r');
    try {
      const { size } = await file.stat();
      const bytes = Buffer.alloc(Math.min(size, 128 * 1024));
      await file.read(bytes, 0, bytes.length, size - bytes.length);
      return bytes.toString('utf8').split(/\r?\n/).slice(-200).join('\n');
    } finally {
      await file.close();
    }
  } catch {
    return '';
  }
}

export class ProblemReports {
  private reports: SavedReport[] = [];
  private incoming: ProblemReportInboxItem[] = [];
  private installId = '';
  private ready?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private sessionId?: string;
  private sessionKey?: string;
  private diagnoses: Record<string, string> = {};
  private denied = false;
  private owner = false;
  private lastAdmin = -Infinity;
  private lastStatus = -Infinity;
  private ticking?: Promise<void>;
  private serial: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(private readonly options: Options) {}
  private now() {
    return (this.options.now ?? Date.now)();
  }
  private init() {
    return (this.ready ??= (async () => {
      await mkdir(this.options.directory, { recursive: true });
      try {
        const saved = JSON.parse(await readFile(join(this.options.directory, 'problem-reports.json'), 'utf8'));
        this.installId = saved.installId;
        this.reports = saved.reports;
        this.diagnoses = saved.diagnoses ?? {};
        let migrated = false;
        for (const report of this.reports) {
          if (saved.version !== 2) {
            report.images = report.images.slice(report.uploaded);
            migrated = true;
          }
          if (!report.secret && !report.id) {
            report.secret = randomBytes(32).toString('hex');
            migrated = true;
          }
        }
        if (migrated) await this.save();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        this.installId = randomUUID();
        await this.save();
      }
    })());
  }
  private async save() {
    const path = join(this.options.directory, 'problem-reports.json');
    await writeFile(
      `${path}.tmp`,
      JSON.stringify({ version: 2, installId: this.installId, reports: this.reports, diagnoses: this.diagnoses }),
      {
        mode: 0o600,
      },
    );
    await rename(`${path}.tmp`, path);
    this.options.changed?.();
  }
  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = this.serial.then(action, action);
    this.serial = result.catch(() => {});
    return result;
  }
  start() {
    if (this.timer || this.closed) return;
    // Initialization and network work run after startup, never from state projection.
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick()
        .catch(() => {})
        .finally(() => this.start());
    }, 30_000);
    this.timer.unref();
  }
  close() {
    this.closed = true;
    clearTimeout(this.timer);
  }
  private syncSession() {
    const session = this.options.session();
    const key = session && `${session.userId}:${session.sessionId ?? ''}`;
    if (key !== this.sessionKey) {
      this.sessionKey = key;
      this.sessionId = session?.userId;
      this.denied = false;
      this.owner = false;
      this.lastAdmin = -Infinity;
      this.incoming = [];
    }
    return session;
  }
  count() {
    this.syncSession();
    return this.incoming.length;
  }
  async preview(input: {
    description?: string;
    taskId?: string;
    includeConversation?: boolean;
    conversationId?: string;
  }) {
    await this.init();
    if (typeof input.description !== 'string' || input.description.length > 4000) throw Error('INVALID_DESCRIPTION');
    const context = await this.options.context(input.taskId, input.includeConversation === true, input.conversationId);
    return buildProblemReport({
      ...context,
      installId: this.installId,
      description: input.description,
      errors: await errorTail(join(this.options.directory, 'logs', 'backend.log')),
    });
  }
  async list(): Promise<ProblemReportSummary[]> {
    await this.init();
    return this.reports.map(({ localId, id, description, status, fixedIn, imageCount }) => ({
      localId,
      id,
      description,
      status,
      fixedIn,
      imageCount,
    }));
  }
  inbox() {
    this.syncSession();
    return structuredClone(this.incoming);
  }
  async submit(payload: ProblemReportPayload, images: ProblemReportImage[]) {
    await this.init();
    validateProblemReport(payload, images);
    if (payload.installId !== this.installId) throw Error('INVALID_INSTALL');
    return this.exclusive(async () => {
      const report: SavedReport = {
        localId: randomUUID(),
        description: payload.description,
        status: 'draft',
        imageCount: images.length,
        payload: structuredClone(payload),
        images: structuredClone(images),
        secret: randomBytes(32).toString('hex'),
        attempts: 0,
        retryAt: 0,
        uploaded: 0,
      };
      this.reports.push(report);
      await this.save();
      await this.send(report);
      return (await this.list()).find((item) => item.localId === report.localId)!;
    });
  }
  async addFiles(localId: string, images: ProblemReportImage[]) {
    await this.init();
    validateProblemImages(images);
    return this.exclusive(async () => {
      const report = this.reports.find((item) => item.localId === localId);
      if (!report) throw Error('REPORT_NOT_FOUND');
      if (report.imageCount + images.length > 4) throw Error('TOO_MANY_IMAGES');
      report.images.push(...structuredClone(images));
      report.imageCount += images.length;
      report.retryAt = 0;
      report.status = 'draft';
      await this.save();
      await this.send(report);
      return (await this.list()).find((item) => item.localId === localId)!;
    });
  }
  private async request(path: string, init: RequestInit = {}, admin = false) {
    const session = this.syncSession();
    const sessionKey = this.sessionKey;
    const response = await (this.options.fetch ?? fetch)(
      `${this.options.url.replace(/\/$/, '')}/functions/v1/${admin ? 'report-problem-admin' : 'report-problem'}${path}`,
      {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
        headers: {
          apikey: this.options.publishableKey,
          'Content-Type': 'application/json',
          ...(admin && session ? { Authorization: `Bearer ${session.accessToken}` } : {}),
          ...init.headers,
        },
      },
    );
    if (admin) {
      this.syncSession();
      if (this.sessionKey !== sessionKey) throw Error('OWNER_SESSION_CHANGED');
      if (response.status === 403) {
        this.denied = true;
        this.owner = false;
        this.incoming = [];
      }
    }
    if (!response.ok) throw Error(`REPORT_HTTP_${response.status}`);
    return response.json();
  }
  private async send(report: SavedReport) {
    try {
      if (!report.id) {
        const result = await this.request('', {
          method: 'POST',
          headers: { 'x-report-secret': report.secret! },
          body: JSON.stringify(report.payload),
        });
        if (!/^PP-\d+$/.test(result.id) || result.secret !== report.secret) throw Error('INVALID_RELAY_RESPONSE');
        report.id = result.id;
        await this.save();
      }
      if (report.images.length) {
        await this.request(`/${report.id}/files`, {
          method: 'POST',
          headers: { 'x-report-secret': report.secret! },
          body: JSON.stringify({ images: report.images }),
        });
        report.uploaded += report.images.length;
        report.images = [];
      }
      if (report.status !== 'fixed') report.status = 'sent';
      report.attempts = 0;
      report.retryAt = 0;
    } catch {
      report.attempts++;
      report.retryAt = this.now() + Math.min(6 * 3600_000, 30_000 * 2 ** Math.min(report.attempts - 1, 10));
    }
    await this.save();
  }
  async tick(focus = false) {
    if (this.ticking) return this.ticking;
    this.ticking = this.exclusive(async () => {
      await this.init();
      for (const report of this.reports)
        if ((report.status === 'draft' || report.images.length) && report.retryAt <= this.now())
          await this.send(report);
      if (this.now() - this.lastStatus >= 6 * 3600_000) {
        this.lastStatus = this.now();
        for (const report of this.reports.filter((item) => item.id && item.status !== 'fixed')) {
          try {
            const result = await this.request(`/${report.id}/status`, {
              headers: { 'x-report-secret': report.secret! },
            });
            if (result.status === 'fixed') {
              report.status = 'fixed';
              report.fixedIn = result.fixedIn;
              await this.save();
            }
          } catch {
            /* The next scheduled check retries an unavailable relay. */
          }
        }
      }
      const session = this.syncSession();
      const sessionKey = this.sessionKey;
      if (!session || this.denied || this.now() - this.lastAdmin < (focus ? 15_000 : 5 * 60_000)) return;
      this.lastAdmin = this.now();
      try {
        const result = await this.request('', {}, true);
        this.syncSession();
        if (this.sessionKey !== sessionKey) return;
        this.owner = true;
        this.incoming = result.reports.map(({ diagnostics: _diagnostics, ...row }: ProblemReportInboxItem) => ({
          ...row,
          taskId: this.diagnoses[row.id],
        }));
        this.options.changed?.();
      } catch {
        /* 403 disables this session; transient failures wait for the next poll. */
      }
    }).finally(() => {
      this.ticking = undefined;
    });
    return this.ticking;
  }
  async setStatus(id: string, status: string, fixedIn?: string) {
    if (!this.syncSession() || this.denied || !this.owner) throw Error('OWNER_REQUIRED');
    if (!['fixed', 'ignored'].includes(status) || (status === 'fixed' && (!fixedIn?.trim() || fixedIn.length > 120)))
      throw Error('INVALID_STATUS');
    await this.request(
      `/${encodeURIComponent(id)}/status`,
      { method: 'POST', body: JSON.stringify({ status, fixedIn }) },
      true,
    );
    this.incoming = this.incoming.filter((item) => item.id !== id);
    this.options.changed?.();
  }
  async diagnose(id: string) {
    const session = this.syncSession();
    const sessionKey = this.sessionKey;
    if (!session || this.denied || !this.owner) throw Error('OWNER_REQUIRED');
    const summary = this.incoming.find((item) => item.id === id);
    if (!summary) throw Error('REPORT_NOT_FOUND');
    const { report } = (await this.request(`/${encodeURIComponent(id)}`, {}, true)) as {
      report: ProblemReportInboxItem;
    };
    this.syncSession();
    if (this.sessionKey !== sessionKey || !this.owner) throw Error('OWNER_REQUIRED');
    if (report?.id !== id || !report.diagnostics || !Array.isArray(report.images))
      throw Error('INVALID_RELAY_RESPONSE');
    const directory = await mkdtemp(join(tmpdir(), 'pugport-report-'));
    await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
    for (const [index, url] of report.images.entries()) {
      const parsed = new URL(url);
      if (
        parsed.origin !== new URL(this.options.url).origin ||
        !parsed.pathname.startsWith('/storage/v1/object/sign/problem-report-files/')
      )
        throw Error('INVALID_IMAGE_URL');
      const response = await (this.options.fetch ?? fetch)(url, {
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw Error('IMAGE_DOWNLOAD_FAILED');
      const reader = response.body?.getReader();
      if (!reader) throw Error('IMAGE_DOWNLOAD_FAILED');
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.length;
          if (size > 1024 * 1024) throw Error('IMAGE_TOO_LARGE');
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel();
      }
      const bytes = Buffer.concat(chunks);
      await writeFile(join(directory, `image-${index + 1}`), bytes, { mode: 0o600 });
    }
    this.syncSession();
    if (this.sessionKey !== sessionKey || !this.owner) throw Error('OWNER_REQUIRED');
    report.taskId = await this.options.diagnose(report, directory);
    summary.taskId = report.taskId;
    this.diagnoses[id] = report.taskId;
    await this.exclusive(() => this.save());
    return { taskId: report.taskId };
  }
}
