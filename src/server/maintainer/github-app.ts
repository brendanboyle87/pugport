import { createPrivateKey, createSign } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { secretsDirectory } from '../api-providers.ts';
import { repositorySchema } from './config.ts';

const idSchema = z.string().regex(/^\d{1,12}$/);
const configSchema = z.object({ appId: idSchema, installationId: idSchema.optional() }).strict();
export type GitHubAppConfig = z.infer<typeof configSchema>;
export const appFiles = (dir = secretsDirectory()) => ({
  config: join(dir, 'github-app.json'),
  key: join(dir, 'github-app.pem'),
});

export function appJwt(appId: string, pem: string, now = Date.now()): string {
  const seconds = Math.floor(now / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const input = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: seconds - 60, exp: seconds + 540, iss: appId })}`;
  try {
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType !== 'rsa') throw new Error('Invalid key type');
    return `${input}.${createSign('RSA-SHA256').update(input).sign(key, 'base64url')}`;
  } catch {
    throw new Error('github-app.pem must contain a valid RSA private key');
  }
}

const unreachable = 'Could not reach GitHub';
const rejected = 'GitHub rejected the App key (wrong App ID or key)';

export class GitHubAppAuth {
  private cachedToken?: {
    value: string;
    expiresAt: number;
    repository: string | undefined;
    appId: string;
    installationId?: string;
  };
  private installation?: { appId: string; repository: string; id: string };
  private login?: { appId: string; value: string };
  private issue?: string;
  private fileIssue?: string;
  private readonly files;
  private readonly now;

  constructor(
    private readonly deps: {
      dir?: string;
      repository: () => string | undefined;
      fetch?: typeof fetch;
      now?: () => number;
      platform?: NodeJS.Platform;
    },
  ) {
    this.files = appFiles(deps.dir);
    this.now = deps.now ?? Date.now;
  }

  async configured(): Promise<boolean> {
    try {
      await Promise.all([stat(this.files.config), stat(this.files.key)]);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ENOENT';
    }
  }

  private async credentials(): Promise<{ config: GitHubAppConfig; jwt: string } | undefined> {
    this.fileIssue = undefined;
    if (!(await this.configured())) {
      this.forget();
      this.installation = undefined;
      this.login = undefined;
      this.issue = undefined;
      return undefined;
    }
    try {
      let config: GitHubAppConfig;
      try {
        config = configSchema.parse(JSON.parse(await readFile(this.files.config, 'utf8')));
      } catch {
        throw new Error('github-app.json must contain a valid App ID and optional installation ID');
      }
      const info = await stat(this.files.key);
      if (!info.isFile() || info.size > 16 * 1024)
        throw new Error('github-app.pem must be a regular file of at most 16 kB');
      if ((this.deps.platform ?? process.platform) !== 'win32' && (info.mode & 0o077) !== 0)
        throw new Error('github-app.pem must be readable only by you (chmod 600)');
      const pem = await readFile(this.files.key, 'utf8');
      if (
        Buffer.byteLength(pem) > 16 * 1024 ||
        !/-----BEGIN (RSA )?PRIVATE KEY-----[\s\S]+-----END \1PRIVATE KEY-----/.test(pem)
      )
        throw new Error('github-app.pem must contain a valid RSA private key');
      return { config, jwt: appJwt(config.appId, pem, this.now()) };
    } catch (error) {
      this.forget();
      // Only our fixed messages may cross the credential boundary.
      this.fileIssue =
        error instanceof Error &&
        [
          'github-app.json must contain a valid App ID and optional installation ID',
          'github-app.pem must be a regular file of at most 16 kB',
          'github-app.pem must be readable only by you (chmod 600)',
          'github-app.pem must contain a valid RSA private key',
        ].includes(error.message)
          ? error.message
          : 'Could not read GitHub App files';
      return undefined;
    }
  }

  async problem(): Promise<string | undefined> {
    await this.credentials();
    return this.fileIssue ?? this.issue;
  }

  private async request(path: string, jwt: string, signal?: AbortSignal, repository?: string): Promise<unknown> {
    let response: Response;
    try {
      const timeout = AbortSignal.timeout(15_000);
      response = await (this.deps.fetch ?? fetch)(`https://api.github.com${path}`, {
        method: path.endsWith('/access_tokens') ? 'POST' : 'GET',
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        ...(path.endsWith('/access_tokens') ? { body: '{}' } : {}),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        redirect: 'error',
      });
    } catch {
      throw new Error(unreachable);
    }
    if (response.status === 401 || response.status === 403) {
      this.forget();
      throw new Error(rejected);
    }
    if (response.status === 404 && repository) throw new Error(`The GitHub App is not installed on ${repository}`);
    if (!response.ok) throw new Error('GitHub App request failed');
    try {
      return await response.json();
    } catch (error) {
      throw new Error(error instanceof SyntaxError ? 'Invalid GitHub App response' : unreachable);
    }
  }

  async token(signal?: AbortSignal): Promise<string | undefined> {
    const repository = this.deps.repository();
    if (this.cachedToken?.repository !== repository) this.forget();
    if (signal?.aborted) return undefined;
    if (this.cachedToken && this.cachedToken.expiresAt - this.now() >= 10 * 60_000) return this.cachedToken.value;
    const credentials = await this.credentials();
    if (!credentials) return undefined;
    const { config, jwt } = credentials;
    if (
      this.cachedToken &&
      (this.cachedToken.appId !== config.appId || this.cachedToken.installationId !== config.installationId)
    )
      this.forget();
    try {
      let id = config.installationId;
      if (!id) {
        if (!repositorySchema.safeParse(repository).success) throw new Error('A valid GitHub repository is required');
        if (this.installation?.appId === config.appId && this.installation.repository === repository) {
          id = this.installation.id;
        } else {
          const result = z
            .object({ id: z.number().int().positive().max(999_999_999_999) })
            .safeParse(await this.request(`/repos/${repository}/installation`, jwt, signal, repository));
          if (!result.success) throw new Error('Invalid GitHub App response');
          id = String(result.data.id);
          this.installation = { appId: config.appId, repository: repository!, id };
        }
      }
      const result = z
        .object({ token: z.string().min(1), expires_at: z.string().datetime({ offset: true }) })
        .safeParse(await this.request(`/app/installations/${id}/access_tokens`, jwt, signal));
      if (!result.success || Date.parse(result.data.expires_at) <= this.now())
        throw new Error('Invalid GitHub App response');
      this.cachedToken = {
        value: result.data.token,
        expiresAt: Date.parse(result.data.expires_at),
        repository,
        ...config,
      };
      this.issue = undefined;
      return this.cachedToken.value;
    } catch (error) {
      this.issue = (error as Error).message;
      if (!signal?.aborted && this.issue === unreachable && this.cachedToken && this.cachedToken.expiresAt > this.now())
        return this.cachedToken.value;
      return undefined;
    }
  }

  async botLogin(signal?: AbortSignal): Promise<string | undefined> {
    if (signal?.aborted) return undefined;
    const credentials = await this.credentials();
    if (!credentials) return undefined;
    const { config, jwt } = credentials;
    if (this.login?.appId === config.appId) return this.login.value;
    try {
      const result = z
        .object({ slug: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/) })
        .safeParse(await this.request('/app', jwt, signal));
      if (!result.success) throw new Error('Invalid GitHub App response');
      this.login = { appId: config.appId, value: `${result.data.slug}[bot]` };
      this.issue = undefined;
      return this.login.value;
    } catch (error) {
      this.issue = (error as Error).message;
      return undefined;
    }
  }

  forget(): void {
    this.cachedToken = undefined;
  }
}
