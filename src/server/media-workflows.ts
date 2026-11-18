import { assertTestUrl } from './platform/under-test.ts';
import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { dirname, join } from 'node:path';
import type { Express } from 'express';
import {
  builtinMediaWorkflows,
  mediaWorkflowSchema,
  parseMediaWorkflow,
  type MediaWorkflowEntry,
  type MediaWorkflowPreview,
} from '../shared/media-workflows.ts';

const maxBytes = 64 * 1024;
const previewLifetime = 10 * 60 * 1000;

/** Excludes non-global address ranges, including IPv4-mapped IPv6 and transition ranges. */
export function publicWorkflowAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b! >= 64 && b! <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b! >= 16 && b! <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (family !== 6) return false;
  // Global unicast currently uses 2000::/3; block documentation and transition addresses within it.
  const [first, second] = address
    .toLowerCase()
    .split(':')
    .map((part) => parseInt(part || '0', 16));
  return (
    first! >= 0x2000 &&
    first! <= 0x3fff &&
    first !== 0x2002 &&
    first !== 0x3fff &&
    !(first === 0x2001 && (second === 0 || second === 2 || second === 0xdb8 || (second! >= 0x10 && second! <= 0x2f)))
  );
}

export function workflowDownloadUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error('请输入公开的 HTTPS 流程文件地址。');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443') ||
    url.href.length > 2048 ||
    url.hash ||
    !hostname ||
    /(?:^|\.)(?:localhost|local|internal|home|lan|test|invalid)$/.test(hostname) ||
    (!isIP(hostname) && !hostname.includes('.')) ||
    (isIP(hostname) && !publicWorkflowAddress(hostname))
  )
    throw new Error('只允许公开的 HTTPS 地址，不能使用本机、内网、凭据或自定义端口。');
  return url;
}

type DownloadResult = { text: string; source: string };
type HttpResult = { text?: string; redirect?: string };
type DownloadDependencies = {
  resolve?: (hostname: string) => Promise<LookupAddress[]>;
  get?: (url: URL, selected: LookupAddress, deadline: number) => Promise<HttpResult>;
};
export async function downloadMediaWorkflow(
  input: string,
  dependencies: DownloadDependencies = {},
): Promise<DownloadResult> {
  const deadline = Date.now() + 15_000;
  let url = workflowDownloadUrl(input);
  for (let redirects = 0; redirects <= 3; redirects++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('流程下载超时，请稍后重试。');
    if (!dependencies.get || !dependencies.resolve) assertTestUrl(url);
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    let dnsTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      dnsTimer = setTimeout(() => reject(new Error('流程地址解析超时。')), remaining);
      dnsTimer.unref();
    });
    const addresses = await Promise.race([
      dependencies.resolve ? dependencies.resolve(hostname) : lookup(hostname, { all: true, verbatim: true }),
      timeout,
    ]).finally(() => clearTimeout(dnsTimer));
    if (!addresses.length || addresses.some((item) => !publicWorkflowAddress(item.address)))
      throw new Error('流程地址指向本机或内网，不能下载。');
    const selected = addresses[0]!;
    const result = dependencies.get
      ? await dependencies.get(url, selected, deadline)
      : await new Promise<HttpResult>((resolve, reject) => {
          const req = request(
            url,
            {
              method: 'GET',
              family: selected.family,
              headers: { Accept: 'application/json', 'User-Agent': 'PugPort-workflow-import/1' },
              // Pin the checked DNS answer for the connection; TLS still verifies the original hostname.
              lookup: (_host, _options, callback) => callback(null, selected.address, selected.family),
            },
            (res) => {
              if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0)) {
                const redirect = res.headers.location;
                res.destroy();
                return redirect ? resolve({ redirect }) : reject(new Error('流程下载重定向缺少目标地址。'));
              }
              if (res.statusCode !== 200) {
                res.destroy();
                reject(new Error(`流程下载失败（HTTP ${res.statusCode}）。`));
                return;
              }
              const contentType = (res.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
              // Raw GitHub/GitLab JSON is commonly served as text/plain; the strict JSON parser follows.
              if (
                !['application/json', 'text/plain', 'application/octet-stream'].includes(contentType) &&
                !contentType.endsWith('+json')
              ) {
                res.destroy();
                reject(new Error('地址返回的不是 JSON 流程文件。'));
                return;
              }
              if (Number(res.headers['content-length'] ?? 0) > maxBytes) {
                res.destroy();
                reject(new Error('流程文件不能超过 64 KB。'));
                return;
              }
              const chunks: Buffer[] = [];
              let bytes = 0;
              res.on('data', (chunk: Buffer) => {
                bytes += chunk.length;
                if (bytes > maxBytes) {
                  res.destroy(new Error('流程文件不能超过 64 KB。'));
                  return;
                }
                chunks.push(chunk);
              });
              res.on('end', () => resolve({ text: Buffer.concat(chunks).toString('utf8') }));
              res.on('error', reject);
            },
          );
          const timer = setTimeout(
            () => req.destroy(new Error('流程下载超时，请稍后重试。')),
            Math.max(1, deadline - Date.now()),
          );
          req.on('close', () => clearTimeout(timer));
          req.on('error', reject);
          req.end();
        });
    if (result.redirect) {
      url = workflowDownloadUrl(new URL(result.redirect, url).href);
      continue;
    }
    if (typeof result.text !== 'string' || Buffer.byteLength(result.text, 'utf8') > maxBytes)
      throw new Error('流程文件不能超过 64 KB。');
    return { text: result.text!, source: url.href };
  }
  throw new Error('流程地址重定向次数过多。');
}

export class MediaWorkflowStore {
  private readonly file: string;
  private saved: MediaWorkflowEntry[] = [];
  private storageError?: string;
  private readonly previews = new Map<string, MediaWorkflowPreview>();
  constructor(
    dataDir: string,
    private readonly download = downloadMediaWorkflow,
  ) {
    this.file = join(dataDir, 'media-workflows.json');
    if (!existsSync(this.file)) return;
    try {
      if (statSync(this.file).size > 4 * 1024 * 1024) throw new Error('保存的媒体流程文件过大。');
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (!Array.isArray(parsed) || parsed.length > 200) throw new Error('保存的媒体流程格式无效。');
      for (const row of parsed) {
        const item = row as Partial<MediaWorkflowEntry>;
        if (
          !item ||
          typeof item.id !== 'string' ||
          !/^[0-9a-f-]{36}$/.test(item.id) ||
          item.builtin !== false ||
          typeof item.source !== 'string' ||
          item.source.length > 2048 ||
          typeof item.updatedAt !== 'string'
        )
          throw new Error('保存的媒体流程格式无效。');
        this.saved.push({ ...item, workflow: mediaWorkflowSchema.parse(item.workflow) } as MediaWorkflowEntry);
      }
    } catch {
      this.saved = [];
      this.storageError = '保存的流程文件无法读取，原文件已保留。内置流程仍可使用；修复文件后才能保存自定义流程。';
    }
  }
  list(): { items: MediaWorkflowEntry[]; warning?: string } {
    return { items: structuredClone([...builtinMediaWorkflows, ...this.saved]), warning: this.storageError };
  }
  get(id: string): MediaWorkflowEntry {
    const item = [...builtinMediaWorkflows, ...this.saved].find((entry) => entry.id === id);
    if (!item) throw new Error('找不到这个媒体流程。');
    return structuredClone(item);
  }
  private persist(next: MediaWorkflowEntry[]) {
    if (this.storageError) throw new Error(this.storageError);
    mkdirSync(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    renameSync(temporary, this.file);
    this.saved = next;
  }
  save(value: unknown, id?: string, source?: string): MediaWorkflowEntry {
    const workflow = mediaWorkflowSchema.parse(value);
    source ??= this.saved.find((item) => item.id === id)?.source ?? '本机创建';
    if (typeof source !== 'string' || source.length > 2048 || /[\u0000-\u001f]/.test(source))
      throw new Error('流程来源无效。');
    if (id && !this.saved.some((item) => item.id === id)) throw new Error('内置流程不能覆盖，请另存副本。');
    if (!id && this.saved.length >= 200) throw new Error('最多保存 200 个自定义流程。');
    const item: MediaWorkflowEntry = {
      id: id ?? randomUUID(),
      builtin: false,
      workflow,
      source,
      updatedAt: new Date().toISOString(),
    };
    this.persist([...this.saved.filter((entry) => entry.id !== item.id), item]);
    return structuredClone(item);
  }
  remove(id: string) {
    if (!this.saved.some((item) => item.id === id)) throw new Error('内置流程不能删除。');
    this.persist(this.saved.filter((item) => item.id !== id));
  }
  async preview(input: { text?: string; url?: string }): Promise<MediaWorkflowPreview> {
    for (const [key, value] of this.previews) if (Date.parse(value.expiresAt) <= Date.now()) this.previews.delete(key);
    if (this.previews.size >= 20) throw new Error('预览过多，请先导入或稍后再试。');
    if ((typeof input.text === 'string') === (typeof input.url === 'string'))
      throw new Error('请选择文件内容或下载地址。');
    const downloaded = input.url ? await this.download(input.url) : { text: input.text!, source: '本机文件导入' };
    const workflow = parseMediaWorkflow(downloaded.text);
    const preview: MediaWorkflowPreview = {
      token: randomUUID(),
      workflow,
      source: downloaded.source,
      expiresAt: new Date(Date.now() + previewLifetime).toISOString(),
    };
    this.previews.set(preview.token, preview);
    return structuredClone(preview);
  }
  importPreview(token: string) {
    const preview = this.previews.get(token);
    if (!preview || Date.parse(preview.expiresAt) <= Date.now()) throw new Error('流程预览已过期，请重新预览。');
    const saved = this.save(preview.workflow, undefined, preview.source);
    this.previews.delete(token);
    return saved;
  }
  export(id: string) {
    return JSON.stringify(this.get(id).workflow, null, 2) + '\n';
  }
  options(id: string, folders: string[]) {
    return { ...this.get(id).workflow.parameters, folders: [...folders], recipeId: id };
  }
}

export function mountMediaWorkflowRoutes(app: Express, store: MediaWorkflowStore) {
  const error = (res: import('express').Response, reason: unknown) =>
    res.status(400).json({ error: reason instanceof Error ? reason.message : '流程操作失败。' });
  app.get('/api/media-workflows', (_req, res) => res.json(store.list()));
  app.post('/api/media-workflows/preview', async (req, res) => {
    try {
      res.json(await store.preview({ text: req.body?.text, url: req.body?.url }));
    } catch (reason) {
      error(res, reason);
    }
  });
  app.post('/api/media-workflows/import', (req, res) => {
    try {
      res.json({ item: store.importPreview(req.body?.token) });
    } catch (reason) {
      error(res, reason);
    }
  });
  app.post('/api/media-workflows/save', (req, res) => {
    try {
      res.json({ item: store.save(req.body?.workflow, req.body?.id) });
    } catch (reason) {
      error(res, reason);
    }
  });
  app.get('/api/media-workflows/:id/export', (req, res) => {
    try {
      res.type('application/json').send(store.export(req.params.id as string));
    } catch (reason) {
      error(res, reason);
    }
  });
  app.delete('/api/media-workflows/:id', (req, res) => {
    try {
      store.remove(req.params.id as string);
      res.json({ removed: true });
    } catch (reason) {
      error(res, reason);
    }
  });
}
