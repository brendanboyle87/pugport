import './platform/under-test.ts';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { RuntimeTarget } from '../shared/types.ts';
import type { ExtensionTool, McpExtension } from '../shared/extensions.ts';
import { APP_NAME, APP_VERSION } from '../shared/identity.ts';
import { spawnTarget, terminateProcess } from './adapters/process.ts';

/*
 * A small MCP client for the tools the user installs: a local command speaking JSON-RPC over stdio, or a
 * remote address over streamable HTTP. PugPort keeps one connection per installed tool and shares it
 * between runs, so a server that takes seconds to start (npx, uvx) starts once, not on every task.
 */

type Row = Record<string, unknown>;
type Pending = { resolve: (value: Row) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
export type ToolContent = Row[];

const protocolVersion = '2025-06-18';
const environmentReference = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;
const secretName = /key|token|secret|password|auth/i;
export const maxMcpResponseBytes = 32 * 1024 * 1024;
const object = (value: unknown): Row =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};

export class McpConnection {
  private child?: ChildProcessWithoutNullStreams;
  private buffer = '';
  private bufferBytes = 0;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private session?: string;
  private ready?: Promise<void>;
  private runtime?: McpExtension;
  private secrets = new Set<string>();
  private resultSecrets = new Set<string>();
  /** The last lines the server wrote to stderr: the only clue when it fails to start. */
  private stderr = '';
  private stderrPending = '';
  closed = false;
  lastUsed = Date.now();

  constructor(
    readonly config: McpExtension,
    private options: { startTimeoutMs?: number; callTimeoutMs?: number; maxResponseBytes?: number } = {},
  ) {
    for (const [name, value] of [...Object.entries(config.env ?? {}), ...Object.entries(config.headers ?? {})])
      this.remember(value, secretName.test(name));
    for (const value of [
      ...Object.values(config.secretValues?.args ?? {}),
      ...Object.values(config.secretValues?.url ?? {}),
    ])
      this.remember(value, true);
  }

  private remember(value: string, forResult = false) {
    if (value.length >= 4) {
      this.secrets.add(value);
      if (forResult) this.resultSecrets.add(value);
    }
  }

  private redact(text: string, values = this.secrets) {
    for (const value of [...values].sort((a, b) => b.length - a.length)) text = text.split(value).join('***');
    return text;
  }

  private safeError(error: unknown) {
    this.collectExpandedSecrets();
    const original = asError(error);
    const safe = new Error(this.redact(original.message));
    const status = (original as Error & { status?: number }).status;
    if (typeof status === 'number') Object.assign(safe, { status });
    return safe;
  }

  private collectExpandedSecrets() {
    // Collect expansions first, including fields after a missing variable, before any error can escape.
    const fields: [string, boolean][] = [
      ...[...Object.entries(this.config.env ?? {}), ...Object.entries(this.config.headers ?? {})].map(
        ([name, value]): [string, boolean] => [value, secretName.test(name)],
      ),
      ...[
        ...Object.values(this.config.secretValues?.args ?? {}),
        ...Object.values(this.config.secretValues?.url ?? {}),
      ].map((value): [string, boolean] => [value, true]),
      ...(this.config.args ?? []).map((value): [string, boolean] => [value, false]),
      [this.config.url ?? '', false],
    ];
    for (const [value, sensitive] of fields) {
      for (const match of value.matchAll(environmentReference)) {
        const expanded = process.env[match[1]!] || match[2];
        if (expanded !== undefined) this.remember(expanded, sensitive || secretName.test(match[1]!));
      }
    }
  }

  private prepare() {
    const expand = (value: string) =>
      value.replace(environmentReference, (_, name: string, fallback: string | undefined) => {
        const replacement = process.env[name] || fallback;
        if (replacement === undefined) throw new Error(`需要设置环境变量 ${name}，或在这里填写它的值`);
        this.remember(replacement);
        return replacement;
      });
    const fill = (value: string, values?: Record<string, string>) =>
      expand(
        value.replace(/\{\{secret:(\d+)\}\}/g, (_, key: string) => {
          if (values?.[key] === undefined) throw new Error('工具凭据缺失，请重新填写设置。');
          return values[key];
        }),
      );
    const fields = (values?: Record<string, string>) =>
      values && Object.fromEntries(Object.entries(values).map(([key, value]) => [key, expand(value)]));
    this.collectExpandedSecrets();
    this.runtime = {
      ...this.config,
      env: fields(this.config.env),
      headers: fields(this.config.headers),
      args: this.config.args?.map((value) => fill(value, this.config.secretValues?.args)),
      url: this.config.url === undefined ? undefined : fill(this.config.url, this.config.secretValues?.url),
    };
  }

  /** Starts the server and completes the handshake once; later callers share it. */
  start(): Promise<void> {
    this.ready ??= this.open().catch(async (error: unknown) => {
      await this.close();
      throw this.safeError(error);
    });
    return this.ready;
  }

  private async open() {
    this.prepare();
    const config = this.runtime!;
    if (config.transport === 'stdio') {
      if (!config.command) throw new Error('没有填写启动命令。');
      // The process helper resolves npx.cmd and friends without a shell and stops the whole process tree.
      const target = {
        id: `extension-${config.id}`,
        provider: 'pi',
        label: config.name,
        command: config.command,
        environment: 'native',
        enabled: true,
      } as RuntimeTarget;
      const env = { ...process.env, ...config.env };
      const child = await spawnTarget(target, config.args ?? [], { cwd: config.cwd, env });
      this.child = child;
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => this.receive(chunk));
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => this.appendStderr(chunk));
      child.once('close', () => this.fail(new Error(this.exitReason())));
    } else if (!config.url || !/^https?:\/\//i.test(config.url))
      throw new Error('地址需要以 http:// 或 https:// 开头。');
    const init = await this.request(
      'initialize',
      {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: 'pugport', title: APP_NAME, version: APP_VERSION },
      },
      this.options.startTimeoutMs ?? 120_000,
    );
    if (!init.protocolVersion) throw new Error('它没有按 MCP 协议回应。');
    await this.notify('notifications/initialized');
  }

  private appendStderr(chunk: string) {
    const text = this.redact(this.stderrPending + chunk);
    let pending = 0;
    for (const secret of this.secrets) {
      for (let length = Math.min(secret.length - 1, text.length); length > pending; length--) {
        if (text.endsWith(secret.slice(0, length))) {
          pending = length;
          break;
        }
      }
    }
    this.stderrPending = pending ? text.slice(-pending) : '';
    this.stderr = (this.stderr + text.slice(0, text.length - pending)).slice(-2000);
  }

  private exitReason() {
    const last = this.redact(this.stderr + this.stderrPending)
      .slice(-2000)
      .trim()
      .split(/\r?\n/)
      .slice(-3)
      .join(' ')
      .slice(0, 300);
    return last ? `工具进程已退出：${last}` : '工具进程已退出。';
  }

  async listTools(): Promise<ExtensionTool[]> {
    await this.start();
    const tools: ExtensionTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = await this.request('tools/list', cursor ? { cursor } : {});
      for (const item of Array.isArray(result.tools) ? result.tools : []) {
        const tool = object(item);
        if (typeof tool.name !== 'string' || !tool.name) continue;
        tools.push({
          name: tool.name,
          description: typeof tool.description === 'string' ? tool.description.slice(0, 1000) : '',
          readOnly: object(tool.annotations).readOnlyHint === true,
          inputSchema: object(tool.inputSchema),
        });
      }
      cursor = typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined;
      if (!cursor) break;
    }
    return tools;
  }

  async callTool(
    name: string,
    args: Row,
    signal?: AbortSignal,
    validate?: () => void,
  ): Promise<{ content: ToolContent; isError: boolean }> {
    try {
      signal?.throwIfAborted();
      const starting = this.start();
      if (!signal) await starting;
      else
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const finish = (error?: unknown) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener('abort', abort);
            if (error !== undefined) reject(error);
            else resolve();
          };
          const abort = () => finish(signal.reason ?? new Error('已取消。'));
          signal.addEventListener('abort', abort, { once: true });
          // Initialization is shared by other runs and may not receive an MCP cancellation notification.
          // Only this caller's wait ends; it must never send the tool request after being cancelled.
          starting.then(() => finish(), finish);
          if (signal.aborted) abort();
        });
      signal?.throwIfAborted();
      validate?.();
      const result = await this.request('tools/call', { name, arguments: args }, this.options.callTimeoutMs, signal);
      const content = Array.isArray(result.content) ? result.content.map(object) : [];
      if (!content.length && result.structuredContent !== undefined)
        content.push({ type: 'text', text: JSON.stringify(result.structuredContent) });
      const isError = result.isError === true;
      const redactContent = (value: unknown): unknown => {
        if (typeof value === 'string') return this.redact(value, this.resultSecrets);
        if (Array.isArray(value)) return value.map(redactContent);
        if (value && typeof value === 'object')
          return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactContent(child)]));
        return value;
      };
      return { content: isError ? content.map((item) => redactContent(item) as Row) : content, isError };
    } catch (error) {
      throw this.safeError(error);
    }
  }

  private request(method: string, params: Row, timeoutMs = 300_000, signal?: AbortSignal): Promise<Row> {
    if (this.closed) return Promise.reject(new Error('连接已关闭。'));
    this.lastUsed = Date.now();
    const id = this.nextId++;
    const message = { jsonrpc: '2.0', id, method, params };
    return new Promise<Row>((resolve, reject) => {
      const transport = new AbortController();
      let sent = false;
      let settled = false;
      const cancel = (error: Error) => {
        if (settled) return;
        // Cancellation is best-effort at the server; it is not a rollback of work already done.
        // The MCP initialize request must not receive a cancellation notification.
        if (sent && method !== 'initialize')
          void this.notify('notifications/cancelled', { requestId: id, reason: error.message }).catch(() => undefined);
        transport.abort(error);
        settle(() => reject(error));
      };
      const abort = () => cancel(new Error('已取消。'));
      const settle = (finish: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        this.pending.delete(id);
        transport.abort();
        finish();
      };
      const timer = setTimeout(() => cancel(new Error(`等了 ${Math.round(timeoutMs / 1000)} 秒没有回应。`)), timeoutMs);
      if (signal?.aborted) return abort();
      signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(id, {
        resolve: (value) => settle(() => resolve(value)),
        reject: (error) => settle(() => reject(this.safeError(error))),
        timer,
      });
      sent = true;
      if (this.child) this.child.stdin.write(`${JSON.stringify(message)}\n`);
      else
        void this.post(message, transport.signal).catch((error: unknown) =>
          this.pending.get(id)?.reject(asError(error)),
        );
    }).catch((error: unknown) => {
      throw this.safeError(error);
    });
  }

  private async notify(method: string, params?: Row) {
    const message = { jsonrpc: '2.0', method, ...(params ? { params } : {}) };
    if (this.child) this.child.stdin.write(`${JSON.stringify(message)}\n`);
    else await this.post(message, AbortSignal.timeout(3000)).catch(() => undefined);
  }

  /** Streamable HTTP: the reply is JSON or an event stream carrying it. */
  private async post(message: Row, signal?: AbortSignal) {
    const response = await fetch(this.runtime!.url!, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': protocolVersion,
        ...(this.session ? { 'mcp-session-id': this.session } : {}),
        ...this.runtime?.headers,
      },
      body: JSON.stringify(message),
      signal,
    });
    this.session = response.headers.get('mcp-session-id') ?? this.session;
    if (response.status === 401 || response.status === 403)
      throw Object.assign(new Error('对方要求登录或密钥无效。'), { status: response.status });
    if (!response.ok && response.status !== 202)
      throw Object.assign(new Error(`对方返回 HTTP ${response.status}。`), { status: response.status });
    if (message.id === undefined || response.status === 202) return;
    const limit = this.options.maxResponseBytes ?? maxMcpResponseBytes;
    const type = response.headers.get('content-type') ?? '';
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (!type.includes('text/event-stream') && declared > limit) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error('工具返回的内容过大。');
    }
    const reader = response.body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    let text = '';
    let bytes = 0;
    const readChunk = async () => {
      const { value, done } = await reader.read();
      if (done) return false;
      bytes += value.byteLength;
      if (!type.includes('text/event-stream') && bytes > limit) {
        await reader.cancel().catch(() => undefined);
        throw new Error('工具返回的内容过大。');
      }
      text += decoder.decode(value, { stream: true });
      return true;
    };
    if (type.includes('text/event-stream')) {
      // Read events until the reply to this request arrives; other events are notifications.
      while (await readChunk()) {
        let end: number;
        let dispatched = false;
        while ((end = text.search(/\r?\n\r?\n/)) >= 0) {
          dispatched = true;
          const block = text.slice(0, end);
          const separator = /^\r?\n\r?\n/.exec(text.slice(end))![0];
          text = text.slice(end + separator.length);
          if (Buffer.byteLength(block) > limit) {
            await reader.cancel().catch(() => undefined);
            throw new Error('工具返回的内容过大。');
          }
          bytes -= Buffer.byteLength(block + separator);
          const data = block
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
          if (data) this.dispatch(data);
          if (!this.pending.has(Number(message.id))) {
            await reader.cancel().catch(() => undefined);
            return;
          }
        }
        if (dispatched) bytes = Math.max(bytes, Buffer.byteLength(text));
        if (bytes > limit) {
          await reader.cancel().catch(() => undefined);
          throw new Error('工具返回的内容过大。');
        }
      }
      return;
    }
    while (await readChunk()) {}
    text += decoder.decode();
    this.dispatch(text);
  }

  private receive(chunk: string) {
    if (this.closed) return;
    const limit = this.options.maxResponseBytes ?? maxMcpResponseBytes;
    const parts = chunk.split('\n');
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      this.bufferBytes += Buffer.byteLength(part);
      if (this.bufferBytes > limit) {
        this.buffer = '';
        this.fail(new Error('工具返回的内容过大。'));
        return;
      }
      this.buffer += part;
      if (i < parts.length - 1) {
        const line = this.buffer.trim();
        this.buffer = '';
        this.bufferBytes = 0;
        if (line) this.dispatch(line);
      }
    }
  }

  private dispatch(text: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return; // Servers sometimes log to stdout; it is not a reply.
    }
    for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
      const message = object(item);
      // A request from the server (sampling, roots): this client offers none of those.
      if (message.method && message.id !== undefined) {
        const reply = { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } };
        if (this.child) this.child.stdin.write(`${JSON.stringify(reply)}\n`);
        continue;
      }
      const waiter = typeof message.id === 'number' ? this.pending.get(message.id) : undefined;
      if (!waiter) continue;
      const error = object(message.error);
      if (message.error) waiter.reject(new Error(String(error.message ?? '工具返回错误。')));
      else waiter.resolve(object(message.result));
    }
  }

  private fail(error: Error) {
    for (const waiter of [...this.pending.values()]) waiter.reject(error);
    this.closed = true;
  }

  async close() {
    this.closed = true;
    for (const waiter of [...this.pending.values()]) waiter.reject(new Error('连接已关闭。'));
    const child = this.child;
    this.child = undefined;
    if (child) await terminateProcess(child).catch(() => undefined);
    else if (this.session && this.runtime?.url)
      await fetch(this.runtime.url, {
        method: 'DELETE',
        headers: { 'mcp-session-id': this.session, ...this.runtime?.headers },
        signal: AbortSignal.timeout(3000),
      }).catch(() => undefined);
  }
}

const asError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));
