import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { execFile } from '../platform/test-process.ts';
import { findExecutable } from '../platform/executables.ts';
import { failureReason } from './audit.ts';

export type GhCredential = { kind: 'app'; token: string } | { kind: 'gh-login' } | { kind: 'none' };
type Options = { input?: string; timeoutMs?: number; signal?: AbortSignal };
export type Gh = {
  run(args: string[], options?: Options): Promise<{ code: number; stdout: string; stderr: string }>;
  json<T>(schema: z.ZodType<T>, args: string[], options?: Options): Promise<T>;
  text(args: string[], options?: Options): Promise<string>;
};
export const ghNotWritable = 'GitHub maintenance has no App credential; writes are skipped.';
type GhOptions = { tmpRoot: string; exec?: typeof execFile };
export function createReadGh(input: GhOptions & { credential: () => Promise<GhCredential> }): Gh {
  return createGh(input);
}
export function createWriteGh(input: GhOptions & { appToken: () => Promise<string | undefined> }): Gh {
  return createGh({
    ...input,
    credential: async () => {
      const token = await input.appToken();
      if (!token) throw new Error(ghNotWritable);
      return { kind: 'app', token };
    },
  });
}
export function createOwnerGh(input: GhOptions): Gh {
  return createGh({ ...input, credential: async () => ({ kind: 'gh-login' }) });
}
function createGh(input: GhOptions & { credential: () => Promise<GhCredential> }): Gh {
  const gh: Gh = {
    async run(args, options = {}) {
      const credential = await input.credential();
      if (credential.kind === 'none') throw new Error('GitHub credential unavailable');
      const token = credential.kind === 'app' ? credential.token : '';
      const clean = (value: string) => (token ? value.replaceAll(token, '[redacted]') : value);
      const diagnostic = (value: string) => (value.trim() ? failureReason(clean(value)) : '');
      await mkdir(input.tmpRoot, { recursive: true });
      const cwd = await mkdtemp(join(input.tmpRoot, 'pugport-maintainer-'));
      try {
        const env = { ...process.env };
        // Keep repository and credential selection local to this invocation.
        for (const key of Object.keys(env))
          if (
            /^GIT_/i.test(key) ||
            /^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|GH_HOST|GH_DEBUG|GH_CONFIG_DIR)$/i.test(
              key,
            )
          )
            delete env[key];
        Object.assign(env, {
          GH_PROMPT_DISABLED: '1',
          GH_NO_UPDATE_NOTIFIER: '1',
          GH_PAGER: 'cat',
          GIT_CEILING_DIRECTORIES: input.tmpRoot,
        });
        if (token) {
          env.GH_CONFIG_DIR = await mkdtemp(join(cwd, 'config-'));
          env.GH_TOKEN = token;
        }
        return await new Promise<Awaited<ReturnType<Gh['run']>>>((resolve, reject) => {
          const child = (input.exec ?? execFile)(
            findExecutable('gh') ?? 'gh',
            args,
            {
              cwd,
              env,
              windowsHide: true,
              maxBuffer: 8 * 1024 * 1024,
              encoding: 'utf8',
              timeout: options.timeoutMs ?? 60_000,
              signal: options.signal,
            },
            (error, stdout, stderr) => {
              if (error && typeof error.code !== 'number') reject(new Error(diagnostic(error.message)));
              else
                resolve({
                  code: error ? Number(error.code) : 0,
                  stdout: clean(String(stdout)),
                  stderr: diagnostic(String(stderr)),
                });
            },
          );
          child.stdin?.on('error', () => undefined);
          child.stdin?.end(options.input ?? '');
        });
      } catch (error) {
        throw new Error(diagnostic(String(error)));
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    },
    async text(args, options) {
      const result = await gh.run(args, options);
      if (result.code !== 0) throw new Error(result.stderr || `gh exited with code ${result.code}`);
      return result.stdout;
    },
    async json(schema, args, options) {
      const text = await gh.text(args, options);
      try {
        return schema.parse(JSON.parse(text));
      } catch {
        throw new Error('Invalid GitHub response');
      }
    },
  };
  return gh;
}
export const rateLimit = (gh: Gh) =>
  gh.json(z.object({ remaining: z.number().nonnegative(), reset: z.number().nonnegative() }), [
    'api',
    'rate_limit',
    '--jq',
    '{remaining:.resources.core.remaining,reset:.resources.core.reset}',
  ]);
