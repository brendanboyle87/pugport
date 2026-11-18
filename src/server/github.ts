import { addAbortListener } from 'node:events';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import type { ExtensionTool, McpExtension } from '../shared/extensions.ts';
import { McpConnection, type ToolContent } from './mcp-client.ts';
import { execFile } from './platform/test-process.ts';
import { findExecutable } from './platform/executables.ts';

export { githubNeedsApproval } from './github-tiers.ts';

export const githubMcpUrl = 'https://api.githubcopilot.com/mcp/';
export const githubToolsets = 'repos,issues,pull_requests,actions';
export type GitHubState = 'off' | 'connected' | 'gh-missing' | 'not-signed-in' | 'error';
export type GitHubStatus = { enabled: boolean; state: GitHubState; login?: string };
export type GitHubTokenSource = (signal?: AbortSignal) => Promise<{ token: string; login?: string }>;
type Connection = Pick<McpConnection, 'listTools' | 'callTool' | 'close'>;
const run = promisify(execFile);
const failure = (state: GitHubState = 'error') =>
  Object.assign(
    new Error(
      state === 'gh-missing'
        ? 'GitHub CLI (gh) is not installed.'
        : state === 'not-signed-in'
          ? 'GitHub CLI is not signed in.'
          : 'GitHub connection failed.',
    ),
    { state },
  );
const errorState = (error: unknown): GitHubState => {
  const value = error as { code?: unknown; state?: unknown };
  if (value?.code === 'ENOENT' || value?.state === 'gh-missing') return 'gh-missing';
  if (typeof value?.code === 'number' || value?.state === 'not-signed-in') return 'not-signed-in';
  return 'error';
};

export const ghTokenSource: GitHubTokenSource = async (signal) => {
  const fallback = 'C:\\Program Files\\GitHub CLI\\gh.exe';
  const command = findExecutable('gh') ?? (process.platform === 'win32' && existsSync(fallback) ? fallback : 'gh');
  const options = {
    windowsHide: true,
    timeout: 15_000,
    signal,
    encoding: 'utf8' as const,
    env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
  };
  let token: string;
  try {
    token = (await run(command, ['auth', 'token', '--hostname', 'github.com'], options)).stdout.trim();
    if (!token) throw failure('not-signed-in');
  } catch (error) {
    throw failure(errorState(error));
  }
  let login: string | undefined;
  try {
    login = (await run(command, ['config', 'get', '-h', 'github.com', 'user'], options)).stdout.trim() || undefined;
  } catch {
    /* Login is optional local metadata. */
  }
  return { token, login };
};

export class GitHubConnection {
  private cached: ExtensionTool[] = [];
  private connection?: Connection;
  private credentials?: { token: string; login?: string };
  private pending?: Promise<void>;
  private abort?: AbortController;
  private generation = 0;
  private credentialVersion = 0;
  private refreshedAt = 0;
  private stopped = false;
  private state: GitHubState = 'off';

  constructor(
    private options: {
      enabled: () => boolean;
      tokenSource?: GitHubTokenSource;
      connect?: (config: McpExtension) => Connection;
      fetch?: typeof fetch;
    },
  ) {}

  private enabled() {
    return !this.stopped && this.options.enabled();
  }

  tools(): ExtensionTool[] {
    if (!this.enabled()) return [];
    if (!this.cached.length && !this.pending && Date.now() - this.refreshedAt > 60_000) this.warm();
    return this.cached;
  }

  toolNames(write: boolean): string[] {
    return this.tools()
      .filter((tool) => write || tool.readOnly)
      .map((tool) => 'github_' + tool.name);
  }

  async defaultBranch(args: Record<string, unknown>, signal?: AbortSignal): Promise<string | undefined> {
    const { owner, repo } = args;
    if (
      !this.enabled() ||
      !this.credentials ||
      typeof owner !== 'string' ||
      !/^[\w.-]+$/.test(owner) ||
      typeof repo !== 'string' ||
      !/^[\w.-]+$/.test(repo)
    )
      return undefined;
    try {
      const response = await (this.options.fetch ?? fetch)(`https://api.github.com/repos/${owner}/${repo}`, {
        headers: { Authorization: 'Bearer ' + this.credentials.token },
        redirect: 'error',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
      });
      if (!response.ok) return undefined;
      const body = await response.json();
      return typeof body?.default_branch === 'string' && body.default_branch ? body.default_branch : undefined;
    } catch {
      return undefined;
    }
  }

  async fetchJson(path: string, signal?: AbortSignal): Promise<unknown> {
    if (
      !this.enabled() ||
      !this.credentials ||
      !/^\/repos\/[\w.-]+\/[\w.-]+(?:\/[\w.-]+)+$/.test(path) ||
      path.split('/').includes('..')
    )
      return undefined;
    try {
      const response = await (this.options.fetch ?? fetch)(`https://api.github.com${path}`, {
        headers: { Authorization: 'Bearer ' + this.credentials.token, Accept: 'application/vnd.github+json' },
        redirect: 'error',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
      });
      return response.ok ? await response.json() : undefined;
    } catch {
      return undefined;
    }
  }

  async status(): Promise<GitHubStatus> {
    this.tools();
    return {
      enabled: this.enabled(),
      state: this.enabled() ? this.state : 'off',
      ...(this.enabled() && this.credentials?.login ? { login: this.credentials.login } : {}),
    };
  }

  warm(): void {
    if (this.enabled()) void this.refresh().catch(() => undefined);
  }

  private refresh(freshToken = false, reconnect = false): Promise<void> {
    if (this.pending) return this.pending;
    const generation = this.generation;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    const active = () => this.enabled() && generation === this.generation;
    const task = (async () => {
      let token = this.credentials?.token;
      try {
        if (!active()) throw failure();
        if (freshToken || !this.credentials) {
          let credentials: Awaited<ReturnType<GitHubTokenSource>>;
          try {
            credentials = await (this.options.tokenSource ?? ghTokenSource)(signal);
          } catch (error) {
            throw failure(errorState(error));
          }
          if (!active()) throw failure();
          if (!credentials.token.trim()) throw failure('not-signed-in');
          this.credentials = credentials;
          token = credentials.token;
          this.credentialVersion++;
        }
        if (reconnect) {
          const previous = this.connection;
          this.connection = undefined;
          await previous?.close();
        }
        if (!active()) throw failure();
        const connection =
          this.connection ??
          (this.options.connect ?? ((config) => new McpConnection(config)))({
            kind: 'mcp',
            id: 'github',
            name: 'GitHub',
            transport: 'http',
            url: githubMcpUrl,
            headers: { Authorization: 'Bearer ' + this.credentials!.token, 'X-MCP-Toolsets': githubToolsets },
            enabled: true,
            source: 'github',
            installedAt: new Date().toISOString(),
          });
        this.connection = connection;
        const tools = await connection.listTools();
        if (!active()) {
          await connection.close();
          throw failure();
        }
        this.cached = tools;
        this.state = 'connected';
      } catch (error) {
        const safeError = token && String(error).includes(token) ? failure() : error;
        if (active()) {
          this.cached = [];
          this.state = errorState(error);
          const connection = this.connection;
          this.connection = undefined;
          this.credentials = undefined;
          await connection?.close().catch(() => undefined);
        }
        throw safeError;
      } finally {
        if (generation === this.generation) this.refreshedAt = Date.now();
      }
    })();
    this.pending = task;
    void task
      .finally(() => {
        if (this.pending === task) this.pending = undefined;
      })
      .catch(() => undefined);
    return task;
  }

  async call(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ content: ToolContent; isError: boolean }> {
    if (!this.enabled() || !this.cached.some((tool) => tool.name === name))
      throw new Error('GitHub tool is not available.');
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      if (!this.connection && this.pending) await this.waitForRefresh(this.pending, signal);
      if (!this.enabled() || !this.cached.some((tool) => tool.name === name) || !this.connection) throw failure();
      const connection = this.connection;
      const credentialVersion = this.credentialVersion;
      const token = this.credentials?.token;
      try {
        return await connection.callTool(name, args, signal);
      } catch (error) {
        const status = (error as { status?: number })?.status;
        if (attempt || (status !== 401 && status !== 404))
          throw token && String(error).includes(token) ? failure() : error;
        if (this.pending) {
          try {
            await this.waitForRefresh(this.pending, signal);
          } catch {
            signal?.throwIfAborted();
            if (!this.enabled()) throw failure();
          }
        }
        signal?.throwIfAborted();
        if (status === 401 && this.credentialVersion === credentialVersion)
          await this.waitForRefresh(this.refresh(true, true), signal);
        else if (this.connection === connection) await this.waitForRefresh(this.refresh(false, true), signal);
        else if (this.pending) await this.waitForRefresh(this.pending, signal);
      }
    }
  }

  private async waitForRefresh(pending: Promise<void>, signal?: AbortSignal) {
    if (!signal) return pending;
    signal.throwIfAborted();
    let listener: ReturnType<typeof addAbortListener> | undefined;
    try {
      await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          listener = addAbortListener(signal, () => reject(failure()));
        }),
      ]);
    } finally {
      listener?.[Symbol.dispose]();
    }
  }

  async setEnabled(on: boolean): Promise<GitHubStatus> {
    if (!on) await this.close();
    else {
      this.stopped = false;
      await this.refresh().catch(() => undefined);
    }
    return this.status();
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.generation++;
    this.abort?.abort();
    this.pending = undefined;
    this.cached = [];
    this.credentials = undefined;
    this.state = 'off';
    this.refreshedAt = 0;
    const connection = this.connection;
    this.connection = undefined;
    await connection?.close().catch(() => undefined);
  }
}
