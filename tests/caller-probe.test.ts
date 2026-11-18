import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createCallerProbe, type CallerProbeDependencies } from '../src/mcp/caller-probe.ts';

function fixture(platform = 'win32') {
  const opened: string[] = [];
  const calls: { file: string; args: string[]; timeout: number }[] = [];
  const files = new Map<string, string>();
  let time = 0;
  const deps: CallerProbeDependencies = {
    platform,
    ppid: 100,
    env: {
      CLAUDECODE: 'private-value',
      CLAUDE_CODE_ENTRYPOINT: 'private-entry',
      GROK_SANDBOX: 'private-sandbox',
      CODEX_HOME: platform === 'win32' ? 'C:\\custom-codex' : '/custom-codex',
      GEMINI_CLI_HOME: 'never-open-this',
      PUGPORT_CALLER: 'codex',
      UNRELATED_SECRET: 'private-secret',
    },
    cwd: () => (platform === 'win32' ? 'C:\\project' : '/project'),
    home: () => (platform === 'win32' ? 'C:\\Users\\fixture' : '/home/fixture'),
    now: () => time,
    fs: {
      readFile: async (path) => {
        opened.push(path);
        if (!files.has(path)) throw new Error('missing');
        return files.get(path)!;
      },
      readlink: async (path) => {
        opened.push(path);
        if (!files.has(path)) throw new Error('missing');
        return files.get(path)!;
      },
    },
    run: async (file, args, timeout) => {
      calls.push({ file, args, timeout });
      return JSON.stringify(
        Array.from({ length: 5 }, (_, i) => ({
          ExecutablePath: i === 0 ? 'C:\\Windows\\cmd.exe' : 'C:\\tools\\codex.exe',
          CommandLine: '"C:\\tools\\codex.exe" exec -s workspace-write',
          ParentProcessId: 101 + i,
        })),
      );
    },
  };
  return {
    deps,
    calls,
    files,
    opened,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

test('Windows queries one chain, skips shims and caches concurrent calls', async () => {
  const f = fixture();
  const probe = createCallerProbe(f.deps);
  const pending = probe();
  assert.equal(probe(), pending);
  const result = await pending;
  assert.equal(await probe(), result);
  assert.equal(f.calls.length, 1);
  assert.equal(result.chain.length, 4);
  assert.deepEqual(result.chain[0].args, ['exec', '-s', 'workspace-write']);
  assert.equal(f.calls[0].file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.deepEqual(f.calls[0].args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
  assert.match(f.calls[0].args[3], /\b100\b/);
  assert.match(f.calls[0].args[3], /ConvertTo-Json/);
});

test('Windows real probe script returns an array for one row', { skip: process.platform !== 'win32' }, async () => {
  const f = fixture();
  f.deps.ppid = process.pid;
  f.deps.env.SystemRoot = process.env.SystemRoot;
  f.deps.run = async (file, args, timeout) => {
    args[3] = args[3].replace('-lt 5', '-lt 1');
    const { stdout } = await promisify(execFile)(file, args, { timeout, windowsHide: true });
    const rows = JSON.parse(stdout);
    assert.ok(Array.isArray(rows));
    assert.equal(rows.length, 1);
    return stdout;
  };
  assert.equal((await createCallerProbe(f.deps)()).chain.length, 1);
});

test('ten second budget does not cache an empty timeout', async () => {
  const f = fixture();
  const run = f.deps.run;
  f.deps.run = async (...args) => {
    const output = await run(...args);
    f.advance(10_000);
    return output;
  };
  const probe = createCallerProbe(f.deps);
  const result = await probe();
  assert.equal(f.calls[0].timeout, 10_000);
  assert.equal(result.chain.length, 0);
  assert.equal(result.timedOut, true);
  assert.equal(f.opened.length, 0);
  await probe();
  assert.equal(f.calls.length, 2);
});

test('a timeout while reading configuration is not cached even with a process chain', async () => {
  const f = fixture();
  const read = f.deps.fs.readFile;
  f.deps.fs.readFile = async (path) => {
    f.advance(10_000);
    return read(path);
  };
  const probe = createCallerProbe(f.deps);
  const result = await probe();
  assert.ok(result.chain.length);
  assert.equal(result.timedOut, true);
  await probe();
  assert.equal(f.calls.length, 2);
});

test('fractional monotonic clock values still produce valid integer child-process timeouts', async () => {
  const f = fixture();
  f.deps.now = () => {
    f.advance(0.125);
    return 123.125 + f.calls.length * 0.125;
  };
  await createCallerProbe(f.deps)();
  assert.ok(f.calls.every((call) => Number.isInteger(call.timeout) && call.timeout > 0 && call.timeout <= 10_000));
});

test('only env names and the caller marker are returned; config reads use the exact allowlist', async () => {
  const f = fixture();
  const allowed = [
    'C:\\custom-codex\\config.toml',
    'C:\\Users\\fixture\\.claude\\settings.json',
    'C:\\project\\.claude\\settings.json',
    'C:\\project\\.claude\\settings.local.json',
    'C:\\Users\\fixture\\.grok\\config.toml',
  ];
  f.files.set('C:\\Users\\fixture\\.gemini\\settings.json', '{"unused":true}');
  for (const path of allowed) f.files.set(path, path.endsWith('.json') ? '{}' : '');
  const result = await createCallerProbe(f.deps)();
  assert.deepEqual(f.opened, allowed);
  assert.deepEqual(result.envNames, []);
  assert.equal(result.pugportCaller, 'codex');
  assert.doesNotMatch(JSON.stringify(result), /private-|custom-codex|never-open-this/);
  assert.equal(result.config?.claudeSettings?.length, 3);
  assert.ok(f.opened.every((path) => !/auth\.json|\.credentials\.json|\.claude\.json|oauth/i.test(path)));
});

test('off returns an empty cached probe with no IO, cwd or home access', async () => {
  const f = fixture();
  f.deps.env.PUGPORT_MCP_PROBE = 'off';
  f.deps.cwd = f.deps.home = () => {
    throw new Error('must not run');
  };
  const probe = createCallerProbe(f.deps);
  assert.deepEqual(await probe(), { chain: [], envNames: [] });
  assert.equal(f.opened.length + f.calls.length, 0);
});

test('POSIX proc preserves argv and parent cwd, stops cycles, reads only allowed config files', async () => {
  const f = fixture('linux');
  f.files.set('/proc/100/cmdline', '/usr/bin/codex\0exec\0-C\0/mnt/c/project with spaces\0');
  f.files.set('/proc/100/stat', '100 (name with ) parentheses) S 100 0 0');
  f.files.set('/proc/100/cwd', '/mnt/c/project');
  const result = await createCallerProbe(f.deps)();
  assert.equal(result.cwd, '/mnt/c/project');
  assert.deepEqual(result.chain, [{ exe: '/usr/bin/codex', args: ['exec', '-C', '/mnt/c/project with spaces'] }]);
  assert.equal(f.calls.length, 0);
  assert.ok(f.opened.includes('/mnt/c/project/.claude/settings.local.json'));
  assert.ok(!f.opened.some((path) => /environ|auth|credentials|\.claude\.json/.test(path)));
});

test('macOS ps fallback and missing configs fail softly, default CODEX_HOME is used', async () => {
  const f = fixture('darwin');
  delete f.deps.env.CODEX_HOME;
  f.deps.run = async (file, args, timeout) => {
    f.calls.push({ file, args, timeout });
    return ' 0 /opt/claude --add-dir "/project with spaces"';
  };
  const result = await createCallerProbe(f.deps)();
  assert.deepEqual(result.chain, [{ exe: '/opt/claude', args: ['--add-dir', '/project with spaces'] }]);
  assert.deepEqual(f.calls[0].args, ['-o', 'ppid=,command=', '-p', '100']);
  assert.ok(f.opened.includes('/home/fixture/.codex/config.toml'));
  assert.equal(result.config, undefined);
});

test('lookup failures and invalid PIDs never trigger broad process queries', async () => {
  for (const ppid of [0, -1, NaN, 1.5, 100]) {
    const f = fixture();
    f.deps.ppid = ppid;
    f.deps.run = async (file, args, timeout) => {
      f.calls.push({ file, args, timeout });
      throw new Error('fixture failure');
    };
    const probe = createCallerProbe(f.deps);
    const result = await probe();
    assert.deepEqual(result.chain, []);
    assert.notEqual(result.timedOut, true);
    assert.notEqual(await probe(), result);
    assert.equal(f.calls.length, ppid === 100 ? 2 : 0);
  }
});
