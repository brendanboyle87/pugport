import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  collectProcessOutput,
  resolveExecutable,
  spawnTarget,
  terminateProcess,
} from '../src/server/adapters/process.ts';
import { findExecutable } from '../src/server/platform/executables.ts';
import { currentHost } from '../src/server/platform/host.ts';

// Finder, the Dock and launchd start the app with PATH=/usr/bin:/bin:/usr/sbin:/sbin. npm's Codex is a
// `#!/usr/bin/env node` script that PugPort finds in a search folder, and node lives next to it.
test(
  'a #!/usr/bin/env node CLI found only through the search folders starts with a minimal PATH',
  { skip: process.platform === 'win32' && 'Windows starts programs without a shebang', timeout: 20_000 },
  async (t) => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'pugport-cli-path-')));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const prefix = join(root, 'npm');
    const bin = join(prefix, 'bin');
    // An empty folder stands in for the minimal PATH, so a node in /usr/bin cannot hide the bug.
    const empty = join(root, 'empty');
    mkdirSync(bin, { recursive: true });
    mkdirSync(empty);
    symlinkSync(process.execPath, join(bin, 'node'));
    const cli = join(bin, 'fake-cli');
    writeFileSync(cli, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ path: process.env.PATH }));\n');
    chmodSync(cli, 0o755);
    // `npm config set prefix` puts global CLIs in <prefix>/bin, one of the search folders.
    const env = { ...process.env, PATH: empty, npm_config_prefix: prefix };
    const command = findExecutable('fake-cli', { ...currentHost(), env });
    assert.equal(command, cli, 'found through the search folders, not PATH');

    const target = { id: 'fake', provider: 'codex' as const, label: 'Fake', environment: 'native' as const };
    const child = await spawnTarget({ ...target, enabled: true, command: command! }, ['--version'], { env });
    let stdout: string;
    try {
      ({ stdout } = await collectProcessOutput(child, 10_000));
    } finally {
      await terminateProcess(child);
    }
    const seen = JSON.parse(stdout).path.split(':');
    assert.deepEqual(seen.slice(0, 2), [empty, bin], "PATH as given first, then the CLI's own folder");
  },
);

// An MCP extension (`npx`, `uvx`) or a hand-typed executor command is a bare name, not a found path.
test(
  'a bare command name found only in the search folders starts with a minimal PATH',
  { skip: process.platform === 'win32' && 'Windows looks only on PATH', timeout: 20_000 },
  async (t) => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'pugport-cli-path-')));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const prefix = join(root, 'npm');
    const bin = join(prefix, 'bin');
    const empty = join(root, 'empty');
    mkdirSync(bin, { recursive: true });
    mkdirSync(empty);
    symlinkSync(process.execPath, join(bin, 'node'));
    const cli = join(bin, 'fake-npx');
    writeFileSync(cli, "#!/usr/bin/env node\nprocess.stdout.write('started');\n");
    chmodSync(cli, 0o755);
    // The search folders come from the app's own environment, here npm's prefix.
    const saved = process.env.npm_config_prefix;
    process.env.npm_config_prefix = prefix;
    t.after(() => {
      if (saved === undefined) delete process.env.npm_config_prefix;
      else process.env.npm_config_prefix = saved;
    });
    const env = { ...process.env, PATH: empty };
    assert.equal(await resolveExecutable('fake-npx', env), cli, 'found in the search folders, not PATH');
    const first = join(root, 'first');
    mkdirSync(first);
    writeFileSync(join(first, 'fake-npx'), '');
    chmodSync(join(first, 'fake-npx'), 0o755);
    assert.equal(await resolveExecutable('fake-npx', { ...env, PATH: first }), join(first, 'fake-npx'), 'PATH wins');

    const target = { id: 'extension-fake', provider: 'codex' as const, label: 'Fake', environment: 'native' as const };
    const child = await spawnTarget({ ...target, enabled: true, command: 'fake-npx' }, [], { env });
    let stdout: string;
    try {
      ({ stdout } = await collectProcessOutput(child, 10_000));
    } finally {
      await terminateProcess(child);
    }
    assert.equal(stdout, 'started');
  },
);
