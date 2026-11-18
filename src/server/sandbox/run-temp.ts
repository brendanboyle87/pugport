import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

export function executionEnvironment(source: NodeJS.ProcessEnv, temporary?: string, bridgeToken?: string) {
  const env = { ...source };
  if (temporary) {
    for (const key of Object.keys(env)) if (/^(?:TEMP|TMP|TMPDIR)$/i.test(key)) delete env[key];
    env.TEMP = env.TMP = env.TMPDIR = temporary;
  }
  if (bridgeToken !== undefined) env.COMBORUNNER_AGENT_TOKEN = bridgeToken;
  return env;
}

export async function createRunTemp(provider: string) {
  if (!/^[a-z]+$/.test(provider)) throw new Error('invalid-sandbox-provider');
  const parent = await realpath(tmpdir());
  const directory = await mkdtemp(join(parent, `pugport-${provider}-`));
  return {
    directory,
    async dispose() {
      // Only the directory we created, never a replaced junction or its target.
      const actual = await realpath(directory);
      if (
        actual !== resolve(directory) ||
        dirname(actual) !== parent ||
        !basename(actual).startsWith(`pugport-${provider}-`)
      )
        throw new Error('unsafe-sandbox-temp');
      await rm(actual, { recursive: true, force: true });
    },
  };
}
