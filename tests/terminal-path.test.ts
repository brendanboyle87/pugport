import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { fakeHost, fakeFs } from './helpers/fake-host.ts';
import {
  registryPathChange,
  terminalPath,
  terminalPathReadScript,
  terminalPathWriteScript,
  terminalProfile,
  terminalWrapper,
  profileLine,
  type RegistryPath,
} from '../src/server/platform/terminal-path.ts';
import {
  autoAddTerminalPath,
  shouldAutoAddTerminalPath,
  terminalCommandRoutes,
} from '../src/server/terminal-command.ts';
import { findNode, nextTurn, text, uiBundle, uiHarness } from './helpers/ui-harness.ts';
import { listenForFetch } from './helpers/fetch-port.ts';

const folder = 'C:\\Pug 端\\dist\\bin';
test('Windows preserves raw variables and registry kind, appends once, and removes only its entries', () => {
  for (const kind of ['String', 'ExpandString'] as const) {
    const original = { raw: '%TOOLS%;C:\\Other;', exists: true, kind };
    const added = registryPathChange(original, folder, 'add', {});
    assert.equal(added.value, original.raw + folder);
    assert.equal(added.kind, kind);
    assert.equal(registryPathChange({ raw: added.value, kind, exists: true }, folder, 'add', {}).changed, false);
    const duplicate = { ...original, raw: `%TOOLS%;${folder.toUpperCase()}\\;C:\\Other;${folder}` };
    assert.equal(registryPathChange(duplicate, folder, 'add', {}).changed, false);
    assert.equal(registryPathChange(duplicate, folder, 'remove', {}).value, '%TOOLS%;C:\\Other');
    const expanded = { ...original, raw: '%PUGROOT%\\DIST\\bin\\;%TOOLS%' };
    assert.equal(registryPathChange(expanded, folder, 'status', { PugRoot: 'C:\\Pug 端' }).installed, true);
  }
  assert.equal(registryPathChange({ raw: '', kind: 'String', exists: false }, folder, 'add', {}).kind, 'ExpandString');
});

function scriptValues(script: string) {
  return [...script.matchAll(/FromBase64String\('([A-Za-z0-9+/=]*)'\)/g)].map((match) =>
    Buffer.from(match[1]!, 'base64').toString('utf8'),
  );
}

test('Windows production flow reads, lets TS decide, and only writes changes in the original kind', async () => {
  for (const initial of [
    { raw: '%TOOLS%;C:\\Other', kind: 'ExpandString', exists: true },
    { raw: '%TOOLS%;C:\\Other', kind: 'String', exists: true },
    { raw: '', kind: 'String', exists: false },
  ] as const) {
    let registry: RegistryPath = { ...initial };
    const host = fakeHost('win32', { fs: fakeFs({ existsSync: () => true }) });
    for (const [action, expectedCalls] of [
      ['status', 1],
      ['add', 2],
      ['add', 1],
      ['remove', 2],
    ] as const) {
      let calls = 0;
      const result = await terminalPath('C:\\Pug 端', action, host, async (script, failureMessage) => {
        calls++;
        assert.equal(failureMessage, '无法修改 PATH{0}');
        assert.doesNotMatch(
          script,
          /Normalize|ExpandEnvironmentVariables|setx|reg\.exe|SetEnvironmentVariable\('Path'/,
        );
        if (calls === 1) {
          assert.equal(script, terminalPathReadScript);
          assert.doesNotMatch(script, /SetValue|SetEnvironmentVariable/);
          return JSON.stringify(registry);
        }
        const expectedKind = initial.exists ? initial.kind : 'ExpandString';
        const expectedValue = action === 'add' ? initial.raw + (initial.raw ? ';' : '') + folder : initial.raw;
        assert.deepEqual(scriptValues(script), [registry.raw, expectedKind, expectedValue, expectedKind]);
        assert.match(script, /if \(\$raw -cne .* -or \$exists -ne .* -or \$kind -cne /);
        assert.match(script, /changedMeanwhile = \$true[\s\S]*else \{[\s\S]*SetValue\('Path'/);
        assert.match(script, /SetEnvironmentVariable\('PUGPORT_REFRESH',\$null,'User'\)/);
        registry = { raw: expectedValue, kind: expectedKind, exists: true };
        return JSON.stringify({ changedMeanwhile: false });
      });
      assert.equal(calls, expectedCalls);
      assert.equal(result.installed, action === 'add');
    }
    assert.equal(registry.raw, initial.raw);
    await assert.rejects(terminalPath('C:\\Synthetic', 'status', host), /under test/);
  }
});

test('Windows passes smart quotes as base64 and reports concurrent edits for retry', async () => {
  const root = 'C:\\Tom’s ‘端’ PugPort';
  const state: RegistryPath = { raw: 'C:\\Other', kind: 'ExpandString', exists: true };
  const next = root + '\\dist\\bin';
  const write = terminalPathWriteScript(state, next, state.kind);
  assert.doesNotMatch(write, /[‘’]/);
  assert.deepEqual(scriptValues(write), [state.raw, state.kind, next, state.kind]);
  let calls = 0;
  await assert.rejects(
    terminalPath(root, 'add', fakeHost('win32', { fs: fakeFs({ existsSync: () => true }) }), async () => {
      calls++;
      return JSON.stringify(calls === 1 ? state : { changedMeanwhile: true });
    }),
    /PATH 已被其他程序修改，请重试/,
  );
  assert.equal(calls, 2);
});

test('a manually added Windows folder is installed; a missing target never reports installed or writes', async () => {
  let available = true;
  let calls = 0;
  const host = fakeHost('win32', { fs: fakeFs({ existsSync: () => available }) });
  const read = async () => {
    calls++;
    return JSON.stringify({ raw: folder.toUpperCase() + '\\', kind: 'String', exists: true });
  };
  assert.equal((await terminalPath('C:\\Pug 端', 'status', host, read)).installed, true);
  available = false;
  assert.equal((await terminalPath('C:\\Pug 端', 'status', host, read)).installed, false);
  await assert.rejects(terminalPath('C:\\Pug 端', 'add', host, read), /还没有构建/);
  assert.equal(calls, 2);
});

function fixture(platform: 'darwin' | 'linux', shell: string) {
  const files = new Map<string, string>();
  const links = new Map<string, string>();
  const modes = new Map<string, number>();
  const writes: string[] = [];
  const missing = () => {
    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  };
  const host = fakeHost(platform, {
    env: { SHELL: `/bin/${shell}` },
    fs: fakeFs({
      existsSync: (file: string) => files.has(links.get(file) ?? file),
      readFileSync: (file: string) => files.get(links.get(file) ?? file) ?? missing(),
      promises: {
        mkdir: async () => {},
        writeFile: async (file: string, value: string) => {
          assert.equal(links.has(file), false, 'never follow a symlink when writing');
          writes.push(file);
          files.set(file, value);
        },
        appendFile: async (file: string, value: string) => {
          writes.push(file);
          files.set(file, (files.get(file) ?? '') + value);
        },
        chmod: async (file: string, mode: number) => {
          modes.set(file, mode);
        },
        unlink: async (file: string) => {
          writes.push(`unlink:${file}`);
          files.delete(file);
          links.delete(file);
        },
      },
    }),
  });
  const root = "/opt/Pug 端's";
  files.set(host.path.join(root, 'dist/bin/pugport'), 'launcher');
  return { files, links, modes, writes, host, root };
}

test('profile selection follows SHELL and platform, including both macOS bash branches', () => {
  for (const [platform, shell, expected] of [
    ['darwin', 'zsh', '.zprofile'],
    ['linux', 'zsh', '.zshrc'],
    ['darwin', 'bash', '.profile'],
    ['linux', 'bash', '.bashrc'],
  ] as const) {
    const { host, files } = fixture(platform, shell);
    assert.equal(terminalProfile(host), host.path.join(host.home, expected));
    if (platform === 'darwin' && shell === 'bash') {
      const bash = host.path.join(host.home, '.bash_profile');
      files.set(bash, 'existing');
      assert.equal(terminalProfile(host), bash);
    }
  }
});

for (const platform of ['darwin', 'linux'] as const) {
  test(`${platform}: moving the app allows replacing or removing its old wrapper`, async () => {
    const { root, host, files, writes } = fixture(platform, 'zsh');
    const wrapper = host.path.join(host.home, '.local/bin/pugport');
    const old = terminalWrapper('/Downloads/PugPort.app', host);
    const profile = terminalProfile(host)!;
    files.set(wrapper, old);
    files.set(profile, profileLine + '\n');
    assert.equal((await terminalPath(root, 'status', host)).installed, false);
    assert.equal((await terminalPath(root, 'add', host)).installed, true);
    assert.equal(files.get(wrapper), terminalWrapper(root, host));
    assert.ok(writes.indexOf(`unlink:${wrapper}`) < writes.indexOf(wrapper));
    files.set(wrapper, old);
    await terminalPath(root, 'remove', host);
    assert.equal(files.has(wrapper), false);
    assert.equal(files.get(profile), '');
  });

  test(`${platform}: a dangling symlink is unlinked before the wrapper is written`, async () => {
    const { root, host, files, links, writes } = fixture(platform, 'bash');
    const wrapper = host.path.join(host.home, '.local/bin/pugport');
    links.set(wrapper, '/synthetic/missing-target');
    await terminalPath(root, 'add', host);
    assert.ok(writes.indexOf(`unlink:${wrapper}`) < writes.indexOf(wrapper));
    assert.equal(files.has('/synthetic/missing-target'), false);
    assert.equal(links.has(wrapper), false);
    assert.equal(files.get(wrapper), terminalWrapper(root, host));
  });

  test(`${platform}: quoted executable wrapper, idempotent marker and surgical removal`, async () => {
    const { root, host, files, modes } = fixture(platform, 'bash');
    const profile = terminalProfile(host)!;
    const original = '# user config\r\nexport MY_VAR=1\r\n';
    files.set(profile, original);
    if (platform === 'linux') files.set(host.path.join(host.home, '.profile'), '# ~/.local/bin already mentioned');
    const wrapper = host.path.join(host.home, '.local/bin/pugport');
    assert.equal((await terminalPath(root, 'status', host)).installed, false);
    assert.equal((await terminalPath(root, 'add', host)).installed, true);
    assert.equal(files.get(wrapper), "#!/bin/sh\nexec '/opt/Pug 端'\"'\"'s/dist/bin/pugport' \"$@\"\n");
    assert.equal(modes.get(wrapper), 0o755);
    await terminalPath(root, 'add', host);
    assert.equal(files.get(profile), original + profileLine + '\n');
    assert.equal((await terminalPath(root, 'status', host)).installed, true);
    files.delete(host.path.join(root, 'dist/bin/pugport'));
    assert.equal((await terminalPath(root, 'status', host)).installed, false);
    await terminalPath(root, 'remove', host);
    assert.equal(files.has(wrapper), false);
    assert.equal(files.get(profile), original);
  });
}

test('other shells write nothing and expose a manual command; foreign wrappers are preserved', async () => {
  for (const shell of ['fish', 'unknown']) {
    const f = fixture('linux', shell);
    const info = await terminalPath(f.root, 'add', f.host);
    assert.equal(info.automatic, false);
    assert.match(info.manualLine!, shell === 'fish' ? /^fish_add_path -- / : /^export PATH=/);
    assert.deepEqual(f.writes, []);
  }
  const bash = fixture('linux', 'bash');
  const wrapper = bash.host.path.join(bash.host.home, '.local/bin/pugport');
  bash.files.set(wrapper, '#!/bin/sh\necho user-owned\n');
  await assert.rejects(terminalPath(bash.root, 'add', bash.host), /其他安装/);
  await terminalPath(bash.root, 'remove', bash.host);
  assert.equal(bash.files.get(wrapper), '#!/bin/sh\necho user-owned\n');
  assert.match(terminalWrapper(bash.root, bash.host), /^#!\/bin\/sh\nexec /);
});

test('automatic PATH only for an undecided installed desktop', () => {
  assert.equal(shouldAutoAddTerminalPath('C:/PugPort/resources/app', 'desktop', '1', false, false), true);
  assert.equal(
    shouldAutoAddTerminalPath('/Applications/PugPort.app/Contents/Resources/app', 'desktop', '1', false, false),
    true,
  );
  assert.equal(shouldAutoAddTerminalPath('C:/PugPort/resources/app', 'desktop', '1', true, false), false);
  assert.equal(shouldAutoAddTerminalPath('C:/dev/app', 'desktop', '1', false, false), false);
  assert.equal(shouldAutoAddTerminalPath('/Volumes/PugPort/resources/app', 'desktop', '1', false, false), false);
  assert.equal(
    shouldAutoAddTerminalPath('/AppTranslocation/PugPort/resources/app', 'desktop', '1', false, false),
    false,
  );
  assert.equal(shouldAutoAddTerminalPath('C:/PugPort/resources/app', 'desktop', '1', false, true), false);
});

test('automatic PATH records before scheduling one addition', async () => {
  let decided = false;
  let addCount = 0;
  let callback: (() => void) | undefined;
  const deps = {
    save: () => {
      decided = true;
    },
    add: async () => {
      addCount++;
    },
    schedule: (run: () => void) => {
      callback = run;
    },
  };
  autoAddTerminalPath('C:/PugPort/resources/app', 'desktop', '1', decided, false, deps);
  assert.equal(decided, true);
  assert.equal(addCount, 0);
  assert.ok(callback);
  callback();
  await Promise.resolve();
  assert.equal(addCount, 1);
  autoAddTerminalPath('C:/PugPort/resources/app', 'desktop', '1', decided, false, deps);
  assert.equal(addCount, 1);
});

test('real readers and writers refuse all actions under test; routes use injectable reads too', async (t) => {
  for (const action of ['status', 'add', 'remove'] as const)
    await assert.rejects(terminalPath('/synthetic', action), /under test.*PATH access/);
  const app = express();
  const actions: string[] = [];
  let saved = 0;
  terminalCommandRoutes(app, {
    root: '/synthetic',
    // A removal is remembered, so the desktop never adds the command back on its own.
    save: () => {
      saved++;
    },
    path: async (_root, action) => {
      actions.push(action!);
      return { folder: '/synthetic/dist/bin', automatic: true, installed: action === 'add' };
    },
  });
  const server = await listenForFetch(app);
  t.after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/external/terminal-command`;
  for (const method of ['GET', 'POST', 'DELETE']) assert.equal((await fetch(url, { method })).status, 200);
  assert.deepEqual(actions, ['status', 'add', 'remove']);
  assert.equal(saved, 1);
});

test('terminal row renders while checking, retries errors and puts manual copy in the main control', async () => {
  const code = await uiBundle('src/ui/Extensions.tsx');
  const copied: string[] = [];
  const h = uiHarness(code, {
    Error,
    navigator: {
      clipboard: {
        writeText: async (line: string) => {
          copied.push(line);
        },
      },
    },
  });
  let fail = true;
  const props = {
    notify() {},
    api: async () => {
      if (fail) throw new Error('fake profile read denied');
      return {
        folder: '/synthetic/dist/bin',
        installed: false,
        automatic: false,
        manualLine: 'fish_add_path /synthetic/dist/bin',
      };
    },
  };
  const initial = h.render('TerminalCommand', props);
  assert.equal(initial.props.control.props.disabled, true);
  assert.ok(text(initial.props.control).includes('正在检查…'));
  await nextTurn();
  let tree = h.render('TerminalCommand', props);
  assert.equal(findNode(tree, (node) => node.props.role === 'alert')!.props.children, 'fake profile read denied');
  fail = false;
  tree.props.control.props.onClick();
  await nextTurn();
  tree = h.render('TerminalCommand', props);
  assert.equal(tree.props.control.props.children, '复制命令');
  assert.ok(text(tree.props.children).includes('复制命令，在终端里运行。'));
  tree.props.control.props.onClick();
  await nextTurn();
  assert.deepEqual(copied, ['fish_add_path /synthetic/dist/bin']);
  h.unmount();
});

test('already installed on GET does not show the post-add terminal restart hint', async () => {
  const h = uiHarness(await uiBundle('src/ui/Extensions.tsx'));
  const props = { notify() {}, api: async () => ({ folder: '/synthetic/dist/bin', automatic: true, installed: true }) };
  h.render('TerminalCommand', props);
  await nextTurn();
  const tree = h.render('TerminalCommand', props);
  assert.equal(tree.props.status, '已加入');
  assert.equal(text(tree.props.children).includes('新开一个终端窗口'), false);
  h.unmount();
});

test('unknown shells explain that export must be saved in the shell configuration', async () => {
  const h = uiHarness(await uiBundle('src/ui/Extensions.tsx'));
  const props = {
    notify() {},
    api: async () => ({
      folder: '/synthetic/dist/bin',
      installed: false,
      automatic: false,
      manualLine: 'export PATH=/synthetic/dist/bin:"$PATH"',
    }),
  };
  h.render('TerminalCommand', props);
  await nextTurn();
  const tree = h.render('TerminalCommand', props);
  assert.ok(text(tree.props.children).includes('把下面这一行加到 shell 的配置文件里'));
  assert.equal(text(tree.props.children).includes('复制命令，在终端里运行。'), false);
  h.unmount();
});
