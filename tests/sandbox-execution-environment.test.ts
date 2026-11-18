import assert from 'node:assert/strict';
import test from 'node:test';
import { mxcExecutionEnvironment } from '../src/server/sandbox/execution-environment.ts';
import { prepareMxcRequest } from '../src/server/sandbox/helper-sdk.ts';

const home = 'C:\\Users\\fixture';
const defaults: NodeJS.ProcessEnv = {
  SystemRoot: 'C:\\Windows',
  WINDIR: 'C:\\Windows',
  USERPROFILE: home,
  LOCALAPPDATA: `${home}\\AppData\\Local`,
  APPDATA: `${home}\\AppData\\Roaming`,
  PATH: 'C:\\Windows\\System32;C:\\Tools',
  PATHEXT: '.EXE;.CMD',
  TEMP: 'C:\\Temp',
  TMP: 'C:\\Temp',
  ANTHROPIC_API_KEY: 'synthetic-host-key',
  OPENAI_API_KEY: 'synthetic-host-key',
  GROK_HOME: 'C:\\private\\default-grok',
  CODEX_HOME: 'C:\\private\\default-codex',
  CLAUDE_CONFIG_DIR: 'C:\\private\\default-claude',
  HOME: 'C:\\private\\default-home',
};

test('partial MXC environments receive Windows system variables without restoring credentials or provider homes', () => {
  const source = { PATH: 'D:\\selected-tools', PI_CODING_AGENT_DIR: 'D:\\accounts\\pi' };
  const snapshot = structuredClone(source);
  const env = mxcExecutionEnvironment(source, defaults, home);
  assert.equal(env.PATH, source.PATH);
  assert.equal(env.PI_CODING_AGENT_DIR, source.PI_CODING_AGENT_DIR);
  assert.equal(env.LOCALAPPDATA, defaults.LOCALAPPDATA);
  assert.equal(env.APPDATA, defaults.APPDATA);
  assert.equal(env.SystemRoot, defaults.SystemRoot);
  assert.equal(env.USERPROFILE, home);
  for (const name of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GROK_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'HOME'])
    assert.equal(env[name], undefined, name);
  assert.deepEqual(source, snapshot);
});

test('account-scoped variables, credentials and private temp paths survive repair', () => {
  const source = {
    APPDATA: 'D:\\accounts\\cursor\\AppData\\Roaming',
    LOCALAPPDATA: 'D:\\accounts\\cursor\\AppData\\Local',
    CLAUDE_CONFIG_DIR: 'D:\\accounts\\claude',
    GROK_HOME: 'D:\\accounts\\grok',
    GROK_AUTH_PATH: 'D:\\accounts\\grok\\auth.json',
    OPENAI_API_KEY: 'synthetic-selected-key',
    ANTHROPIC_API_KEY: '',
    TEMP: 'D:\\private-run',
  };
  const env = mxcExecutionEnvironment(source, defaults, home);
  for (const [key, value] of Object.entries(source)) assert.equal(env[key], value, key);
  assert.equal(env.TMP, source.TEMP);
  assert.equal(env.TMPDIR, source.TEMP);
});

test('Windows system lookup is case-insensitive and never adds conflicting case variants', () => {
  const source = { Path: 'D:\\tools', localappdata: 'D:\\local', appdata: 'D:\\roaming', systemroot: 'D:\\Windows' };
  const env = mxcExecutionEnvironment(source, defaults, home);
  assert.equal(env.Path, source.Path);
  assert.equal(env.PATH, undefined);
  assert.equal(env.localappdata, source.localappdata);
  assert.equal(env.LOCALAPPDATA, undefined);
  assert.equal(env.appdata, source.appdata);
  assert.equal(env.APPDATA, undefined);
  assert.equal(env.WINDIR, source.systemroot);
});

test('absent defaults derive usable Windows system directories and required LOCALAPPDATA', () => {
  const env = mxcExecutionEnvironment({}, {}, home);
  assert.equal(env.SystemRoot, 'C:\\Windows');
  assert.equal(env.WINDIR, 'C:\\Windows');
  assert.equal(env.USERPROFILE, home);
  assert.equal(env.HOMEDRIVE, 'C:');
  assert.equal(env.HOMEPATH, '\\Users\\fixture');
  assert.equal(env.LOCALAPPDATA, `${home}\\AppData\\Local`);
  assert.equal(env.APPDATA, `${home}\\AppData\\Roaming`);
  assert.equal(env.COMSPEC, 'C:\\Windows\\System32\\cmd.exe');
  assert.match(env.PATH!, /C:\\Windows\\System32/);
  assert.equal(env.PATHEXT, '.COM;.EXE;.BAT;.CMD');
  assert.equal(env.TEMP, `${home}\\AppData\\Local\\Temp`);
  assert.equal(env.TMP, env.TEMP);
  assert.equal(env.TMPDIR, env.TEMP);
});

test('blank system variables are repaired once while undefined credential removals remain removed', () => {
  const env = mxcExecutionEnvironment(
    { localappdata: '', LOCALAPPDATA: undefined, Path: ' ', OPENAI_API_KEY: undefined },
    defaults,
    home,
  );
  assert.equal(env.LOCALAPPDATA, defaults.LOCALAPPDATA);
  assert.equal(env.localappdata, undefined);
  assert.equal(env.PATH, defaults.PATH);
  assert.equal(env.Path, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
});

test('SDK mapping repairs omitted explicit environment without inheriting host credentials', async () => {
  const wire = await prepareMxcRequest({
    command: 'synthetic-never-executed',
    containment: { type: 'processcontainer' },
    inheritDefaultEnvironment: false,
  });
  const environment = new Map<string, string>(
    (wire.process.env as string[]).map((entry) => {
      const separator = entry.indexOf('=');
      return [entry.slice(0, separator), entry.slice(separator + 1)];
    }),
  );
  assert.ok(environment.get('LOCALAPPDATA'));
  assert.ok(environment.get('SystemRoot'));
  assert.equal(wire.process.inheritDefaultEnv ?? false, false);
  for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GROK_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR'])
    assert.equal(environment.has(key), false, key);
});
