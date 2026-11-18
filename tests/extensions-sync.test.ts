import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExtensionHub, extensions } from '../src/server/extensions.ts';
import { desktopPermissionChange } from '../src/server/permission-change.ts';
import { discoverPaths } from '../src/server/extension-sync.ts';

async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-sync-'));
  const paths = discoverPaths({ platform: process.platform, home, appData: path.join(home, 'app'), env: {} });
  const hub = new ExtensionHub(path.join(home, 'extensions'), []);
  const put = async (file: string, text: string) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
  };
  return { home, paths, hub, put };
}

test('sync holds stdio, exposes skills, removes and restores sources, and persists dismissals', async () => {
  const { home, paths, hub, put } = await fixture();
  const skill = path.join(paths.agentsSkills, 'example', 'SKILL.md');
  const config = JSON.stringify({
    mcpServers: {
      local: {
        command: 'never-start-synthetic',
        args: ['sk-synthetic-TEST-0001'],
        env: { KEY: 'sk-synthetic-TEST-0001' },
        headers: { Authorization: 'Bearer synthetic-HDR-0002' },
      },
    },
  });
  await put(skill, '---\nname: example\ndescription: example skill\n---\nsynthetic body');
  await put(paths.claudeConfig, config);
  await hub.syncOnce(paths);
  const initial = hub.list();
  const tool = initial.find((item) => item.kind === 'mcp')!;
  const skillItem = initial.find((item) => item.kind === 'skill')!;
  assert.equal(tool.kind === 'mcp' && tool.needsApproval, true);
  assert.deepEqual(
    tool.sync?.sources.map(({ origin, file, key }) => ({ origin, file, key })),
    [{ origin: 'claude', file: paths.claudeConfig, key: 'local' }],
  );
  assert.equal((tool.sync?.sources[0] as { label?: string })?.label, 'Claude Code');
  assert.deepEqual(await hub.check(tool.id), []);
  assert.equal(
    hub.bridgeTools(true).some((item) => String(item.name).startsWith('mcp_')),
    false,
  );
  assert.match(hub.skillHint('example')!, /example/);
  assert.match(JSON.stringify(await hub.call('use_skill', { name: 'example' }, true)), /synthetic body/);
  assert.doesNotMatch(JSON.stringify(initial), /sk-synthetic-TEST-0001|synthetic-HDR-0002/);
  await hub.setEnabled(skillItem.id, false);
  await hub.setEnabled(tool.id, false);
  await put(skill, '---\nname: example\ndescription: updated example skill\n---\nnew body');
  await put(paths.claudeConfig, config.replace('never-start-synthetic', 'changed-synthetic-command'));
  await hub.syncOnce(paths);
  assert.equal(hub.all().find((item) => item.id === skillItem.id)?.enabled, false);
  const updated = hub.all().find((item) => item.id === tool.id);
  assert.equal(updated?.kind === 'mcp' && updated.command, 'changed-synthetic-command');
  assert.equal(updated?.enabled, false);
  assert.deepEqual(await hub.check(tool.id), []);
  await fs.unlink(paths.claudeConfig);
  await hub.syncOnce(paths);
  assert.ok(hub.list().find((item) => item.id === tool.id)?.sync?.removedAt);
  await put(paths.claudeConfig, config);
  await hub.syncOnce(paths);
  assert.equal(hub.list().find((item) => item.id === tool.id)?.sync?.removedAt, undefined);
  await hub.remove(skillItem.id);
  assert.ok(await fs.stat(skill));
  const saved = JSON.parse(await fs.readFile(path.join(home, 'extensions', 'extensions.json'), 'utf8')) as {
    dismissed: string[];
  };
  assert.ok(saved.dismissed.includes(`agents|${paths.agentsSkills}|example`));
  const reloaded = new ExtensionHub(path.join(home, 'extensions'), []);
  await reloaded.syncOnce(paths);
  assert.equal(
    reloaded.all().some((item) => item.id === skillItem.id || item.name === 'example'),
    false,
  );
  await hub.stopAll();
  await reloaded.stopAll();
});

test('unapproved synced stdio does not read the approval salt', async () => {
  const { paths, hub, put } = await fixture();
  await put(paths.claudeConfig, JSON.stringify({ mcpServers: { held: { command: 'synthetic' } } }));
  await hub.syncOnce(paths);
  const internal = hub as unknown as { existingSalt: () => Buffer | undefined };
  internal.existingSalt = () => {
    throw new Error('salt must not be read');
  };
  const view = hub.list()[0];
  assert.equal(view?.kind === 'mcp' && view.needsApproval, true);
  await hub.stopAll();
});

test('unchanged fingerprint skips reads and overlapping scans serialize', async () => {
  const { paths, hub, put } = await fixture();
  await put(path.join(paths.agentsSkills, 'x', 'SKILL.md'), '---\nname: x\ndescription: x\n---\nbody');
  let reads = 0;
  const spy = {
    ...fs,
    readFile: (async (...args: Parameters<typeof fs.readFile>) => {
      reads++;
      return fs.readFile(...args);
    }) as typeof fs.readFile,
  };
  await Promise.all([hub.syncOnce(paths, spy), hub.syncOnce(paths, spy)]);
  const first = reads;
  assert.ok(first > 0);
  await hub.syncOnce(paths, spy);
  assert.equal(reads, first);
  assert.equal(hub.all().length, 1);
  await hub.stopAll();
});

test('sync runs after 5 seconds and every 10 minutes, unrefs and clears both timers', async () => {
  const { hub } = await fixture();
  const original = { setTimeout, setInterval, clearTimeout, clearInterval };
  const timers: { callback: () => void; delay: number; unrefed: boolean; cleared: boolean }[] = [];
  const make = (callback: () => void, delay: number) => {
    const timer = {
      callback,
      delay,
      unrefed: false,
      cleared: false,
      unref() {
        this.unrefed = true;
        return this;
      },
    };
    timers.push(timer);
    return timer as unknown as NodeJS.Timeout;
  };
  let runs = 0;
  hub.syncOnce = async () => {
    runs++;
  };
  globalThis.setTimeout = ((callback: () => void, delay: number) => make(callback, delay)) as typeof setTimeout;
  globalThis.setInterval = ((callback: () => void, delay: number) => make(callback, delay)) as typeof setInterval;
  globalThis.clearTimeout = ((timer: unknown) => {
    (timer as (typeof timers)[number]).cleared = true;
  }) as typeof clearTimeout;
  globalThis.clearInterval = ((timer: unknown) => {
    (timer as (typeof timers)[number]).cleared = true;
  }) as typeof clearInterval;
  try {
    hub.startSync('synthetic');
    hub.startSync('synthetic');
    assert.equal(timers.length, 1);
    assert.equal(timers[0]?.delay, 5000);
    assert.equal(timers[0]?.unrefed, true);
    assert.equal(runs, 0);
    timers[0]!.callback();
    assert.equal(runs, 1);
    assert.equal(timers[1]?.delay, 600000);
    assert.equal(timers[1]?.unrefed, true);
    timers[1]!.callback();
    assert.equal(runs, 2);
    await hub.stopAll();
    assert.equal(timers[1]?.cleared, true);
    hub.startSync('synthetic');
    await hub.stopAll();
    assert.equal(timers[2]?.cleared, true);
  } finally {
    Object.assign(globalThis, original);
  }
});

test('HTTP sync checks a synthetic server and closes it when removed', async () => {
  const { paths, hub, put } = await fixture();
  const previous = globalThis.fetch;
  let lists = 0;
  let checked!: () => void;
  const autoChecked = new Promise<void>((resolve) => {
    checked = resolve;
  });
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { id?: number; method: string };
    if (request.id === undefined) return new Response(null, { status: 202 });
    const result =
      request.method === 'initialize'
        ? { protocolVersion: '2025-03-26' }
        : { tools: [{ name: 'synthetic', description: 'synthetic tool', inputSchema: { type: 'object' } }] };
    if (request.method === 'tools/list') {
      lists++;
      checked();
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), {
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    await put(
      paths.claudeConfig,
      JSON.stringify({
        mcpServers: {
          remote: {
            url: 'https://example.invalid/?key=sk-synthetic-TEST-0001',
            headers: { Authorization: 'Bearer synthetic-HDR-0002' },
          },
        },
      }),
    );
    await hub.syncOnce(paths);
    const item = hub.all()[0]!;
    await autoChecked;
    await hub.check(item.id);
    assert.ok(lists >= 1);
    assert.equal(item.enabled, true);
    const view = hub.list()[0];
    assert.equal(view?.kind === 'mcp' && view.needsApproval, false);
    assert.ok(hub.bridgeTools(true).some((tool) => String(tool.name).startsWith('mcp_')));
    assert.doesNotMatch(JSON.stringify(hub.list()), /sk-synthetic-TEST-0001|synthetic-HDR-0002/);
    const internals = hub as unknown as { connections: Map<string, unknown> };
    assert.equal(internals.connections.has(item.id), true);
    await fs.unlink(paths.claudeConfig);
    await hub.syncOnce(paths);
    assert.ok(hub.list()[0]?.sync?.removedAt);
    assert.equal(internals.connections.has(item.id), false);
    assert.equal(
      hub.bridgeTools(true).some((tool) => String(tool.name).startsWith('mcp_')),
      false,
    );
  } finally {
    await hub.stopAll();
    globalThis.fetch = previous;
  }
});

test('install, configure, rename, setEnabled and remove wait for an active scan', async () => {
  const { home, paths, hub, put } = await fixture();
  const scanFile = path.join(paths.agentsSkills, 'scan', 'SKILL.md');
  const manualFile = path.join(home, 'manual', 'SKILL.md');
  await put(scanFile, '---\nname: scan\ndescription: scan\n---\nbody');
  await put(manualFile, '---\nname: manual\ndescription: manual\n---\nbody');
  await put(
    path.join(home, 'extensions', 'extensions.json'),
    JSON.stringify({
      version: 1,
      items: [
        {
          kind: 'mcp',
          id: 'existing',
          name: 'existing',
          transport: 'stdio',
          command: 'synthetic',
          env: {},
          source: 'synthetic',
          enabled: true,
          installedAt: '2026-01-01',
        },
      ],
    }),
  );
  const preview = await hub.preview(path.dirname(manualFile));
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const scanning = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const delayed = {
    ...fs,
    readFile: (async (...args: Parameters<typeof fs.readFile>) => {
      if (String(args[0]) === scanFile) {
        entered();
        await gate;
      }
      return fs.readFile(...args);
    }) as typeof fs.readFile,
  };
  const scan = hub.syncOnce(paths, delayed);
  try {
    await scanning;
    const completed: string[] = [];
    const install = hub.install(preview.token, [preview.drafts[0]!.key]).then(() => {
      completed.push('install');
    });
    const configure = hub.configure('existing', { KEY: 'sk-synthetic-TEST-0001' }).then(() => {
      completed.push('configure');
    });
    const rename = hub.rename('existing', 'renamed').then(() => {
      completed.push('rename');
    });
    const disable = hub.setEnabled('existing', false).then(() => {
      completed.push('setEnabled');
    });
    const remove = hub.remove('existing').then(() => {
      completed.push('remove');
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(completed, []);
    assert.equal(hub.all().find((item) => item.id === 'existing')?.enabled, true);
    release();
    await Promise.all([scan, install, configure, rename, disable, remove]);
    assert.deepEqual(completed, ['install', 'configure', 'rename', 'setEnabled', 'remove']);
    assert.ok(hub.all().some((item) => item.name === 'manual'));
    assert.equal(
      hub.all().some((item) => item.id === 'existing'),
      false,
    );
  } finally {
    release();
    await scan.catch(() => undefined);
    await hub.stopAll();
  }
});

test('adopted managed copy is removed but its source folder is kept', async () => {
  const { paths, hub, put } = await fixture();
  const source = path.join(paths.agentsSkills, 'example', 'SKILL.md');
  await put(source, '---\nname: example\ndescription: example\n---\nbody');
  const preview = await hub.preview(path.dirname(source));
  const [id] = await hub.install(preview.token, [preview.drafts[0]!.key]);
  const before = hub.all().find((item) => item.id === id)!;
  assert.equal(before.kind, 'skill');
  if (before.kind !== 'skill') throw new Error('expected skill');
  assert.equal(before.managed, true);
  const copy = before.path;
  await hub.syncOnce(paths);
  assert.ok(hub.all().find((item) => item.id === id)?.sync);
  await hub.remove(id!);
  assert.ok(await fs.stat(source));
  await assert.rejects(fs.stat(copy), { code: 'ENOENT' });
  await hub.stopAll();
});

test('config-only sync does not reread unchanged managed skill copies', async () => {
  const { paths, hub, put } = await fixture();
  const source = path.join(paths.agentsSkills, 'example', 'SKILL.md');
  await put(source, '---\nname: example\ndescription: example\n---\nbody');
  const preview = await hub.preview(path.dirname(source));
  const [id] = await hub.install(preview.token, [preview.drafts[0]!.key]);
  const item = hub.all().find((entry) => entry.id === id)!;
  if (item.kind !== 'skill') throw new Error('expected skill');
  const copy = item.path;
  await put(paths.claudeConfig, '{}');
  let copyReads = 0;
  const spy = {
    ...fs,
    readFile: (async (...args: Parameters<typeof fs.readFile>) => {
      if (String(args[0]).startsWith(copy + path.sep)) copyReads++;
      return fs.readFile(...args);
    }) as typeof fs.readFile,
  };
  await hub.syncOnce(paths, spy);
  assert.ok(copyReads > 0);
  copyReads = 0;
  await put(paths.claudeConfig, '{"mcpServers":{}}');
  await hub.syncOnce(paths, spy);
  assert.equal(copyReads, 0);
  await put(path.join(copy, 'extra.txt'), 'changed');
  await put(paths.claudeConfig, '{"mcpServers":{},"changed":true}');
  await hub.syncOnce(paths, spy);
  assert.ok(copyReads > 0);
  await hub.stopAll();
});

test('a manual skill is adopted, removed from offers when missing, and restored', async () => {
  const { home, paths, hub, put } = await fixture();
  const file = path.join(paths.agentsSkills, 'adopt', 'SKILL.md');
  const body = '---\nname: adopt\ndescription: synthetic skill\n---\nbody';
  await put(file, body);
  await put(
    path.join(home, 'extensions', 'extensions.json'),
    JSON.stringify({
      version: 1,
      items: [
        {
          kind: 'skill',
          id: 'manual',
          name: 'adopt',
          description: 'synthetic skill',
          path: path.dirname(file),
          source: path.dirname(file),
          managed: false,
          enabled: true,
          installedAt: '2026-01-01',
        },
      ],
    }),
  );
  await hub.syncOnce(paths);
  assert.equal(hub.all().length, 1);
  assert.equal(hub.all()[0]?.id, 'manual');
  await fs.unlink(file);
  await hub.syncOnce(paths);
  assert.ok(hub.all()[0]?.sync?.removedAt);
  assert.equal(hub.skillHint('adopt'), undefined);
  await assert.rejects(hub.call('use_skill', { name: 'adopt' }, true));
  await put(file, body);
  await hub.syncOnce(paths);
  assert.equal(hub.all()[0]?.sync?.removedAt, undefined);
  assert.match(hub.skillHint('adopt')!, /adopt/);
  await hub.stopAll();
});

test('sync logs and errors do not disclose synthetic configuration values', async () => {
  const { paths, hub, put } = await fixture();
  await put(
    paths.claudeConfig,
    JSON.stringify({
      mcpServers: {
        x: {
          command: 'node',
          env: { KEY: 'sk-synthetic-TEST-0001' },
          headers: { Authorization: 'Bearer synthetic-HDR-0002' },
        },
      },
    }),
  );
  const lines: string[] = [];
  const previousLog = console.log;
  const previousWarn = console.warn;
  const previousError = console.error;
  console.log = (...args: unknown[]) => {
    lines.push(args.join(' '));
  };
  console.warn = (...args: unknown[]) => {
    lines.push(args.join(' '));
  };
  console.error = (...args: unknown[]) => {
    lines.push(args.join(' '));
  };
  try {
    await hub.syncOnce(paths);
    assert.deepEqual(lines, ['extensions sync: 1 added, 0 updated, 0 removed']);
    await hub.syncOnce(paths);
    assert.equal(lines.length, 1);
    const broken = {
      ...fs,
      stat: (async () => {
        throw new Error('sk-synthetic-TEST-0001');
      }) as typeof fs.stat,
      readdir: (async () => {
        throw new Error('Bearer synthetic-HDR-0002');
      }) as typeof fs.readdir,
    };
    await hub.syncOnce(paths, broken);
    assert.doesNotMatch(lines.join('\n'), /sk-synthetic-TEST-0001|synthetic-HDR-0002/);
    // A rejected serialization operation is converted to a fixed error by syncOnce.
    const failingHub = new ExtensionHub(path.join(paths.agentsSkills, 'missing', '\0'), []);
    const originalSecrets = process.env.COMBORUNNER_SECRETS_DIR;
    process.env.COMBORUNNER_SECRETS_DIR = path.join(paths.agentsSkills, 'failing-hub-secrets');
    try {
      await assert.rejects(failingHub.syncOnce(paths), (error: Error) => error.message === 'extensions sync failed');
      await failingHub.stopAll();
    } finally {
      if (originalSecrets === undefined) delete process.env.COMBORUNNER_SECRETS_DIR;
      else process.env.COMBORUNNER_SECRETS_DIR = originalSecrets;
    }
    await put(paths.claudeConfig, JSON.stringify({ mcpServers: { x: { command: 'new-synthetic-command' } } }));
    await hub.syncOnce(paths);
    await fs.unlink(paths.claudeConfig);
    await hub.syncOnce(paths);
    const changes = lines.filter((line) => /^extensions sync: \d+ added/.test(line));
    assert.ok(changes.every((line) => /^extensions sync: \d+ added, \d+ updated, \d+ removed$/.test(line)));
    assert.ok(changes.some((line) => line === 'extensions sync: 0 added, 1 updated, 0 removed'));
    assert.ok(changes.some((line) => line === 'extensions sync: 0 added, 0 updated, 1 removed'));
  } finally {
    console.log = previousLog;
    console.warn = previousWarn;
    console.error = previousError;
    await hub.stopAll();
  }
});

test('HTTP check errors and list metadata do not expose synthetic keys', async () => {
  const { paths, hub, put } = await fixture();
  const previous = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('sk-synthetic-TEST-0001 Bearer synthetic-HDR-0002');
  }) as typeof fetch;
  try {
    await put(
      paths.claudeConfig,
      JSON.stringify({
        mcpServers: {
          remote: {
            url: 'https://example.invalid/?key=sk-synthetic-TEST-0001',
            headers: { Authorization: 'Bearer synthetic-HDR-0002' },
          },
        },
      }),
    );
    await hub.syncOnce(paths);
    const item = hub.list()[0]!;
    assert.equal(item.sync?.sources[0]?.file, paths.claudeConfig);
    await assert.rejects(hub.check(item.id), (error: Error) => {
      assert.doesNotMatch(error.message, /sk-synthetic-TEST-0001|synthetic-HDR-0002/);
      return true;
    });
    assert.doesNotMatch(JSON.stringify(hub.list()), /sk-synthetic-TEST-0001|synthetic-HDR-0002/);
  } finally {
    await hub.stopAll();
    globalThis.fetch = previous;
  }
});

test('native confirmation approves only the current synced stdio signature', async () => {
  const { home, paths, hub, put } = await fixture();
  const previousDir = process.env.COMBORUNNER_SECRETS_DIR;
  process.env.COMBORUNNER_SECRETS_DIR = path.join(home, 'secrets');
  const priorDescribe = extensions.describeApproveCommand;
  const priorApprove = extensions.approve;
  extensions.describeApproveCommand = hub.describeApproveCommand.bind(hub);
  extensions.approve = hub.approve.bind(hub);
  try {
    const server = path.join(home, 'fake-stdio.mjs');
    await put(
      server,
      `import { createInterface } from 'node:readline';
createInterface({ input: process.stdin }).on('line', line => {
 const m = JSON.parse(line); if (m.id === undefined) return;
 const result = m.method === 'initialize' ? {protocolVersion:'2025-06-18'} : {tools:[{name:'echo',description:'synthetic',inputSchema:{type:'object'}}]};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
});`,
    );
    const config = (extra: string[] = []) =>
      JSON.stringify({
        mcpServers: {
          local: { command: process.execPath, args: [server, ...extra] },
        },
      });
    await put(paths.claudeConfig, config());
    await hub.syncOnce(paths);
    const item = hub.list()[0]!;
    assert.equal(item.kind === 'mcp' && item.needsApproval, true);
    assert.deepEqual(await hub.check(item.id), []);
    assert.equal(hub.toolNames(true).length, 0);
    const change = { kind: 'extension-command', action: 'approve', id: item.id };
    const workspace = { controller: {} } as never;
    const description = await desktopPermissionChange(workspace, change, false);
    assert.match(description, /^允许 MCP 工具启动程序\n/);
    await desktopPermissionChange(workspace, change, true, description);
    await hub.check(item.id);
    assert.ok(hub.toolNames(true).some((name) => name.includes('__echo_')));
    const approved = hub.list()[0];
    assert.equal(approved?.kind === 'mcp' && approved.needsApproval, false);
    const stored = await fs.readFile(path.join(home, 'extensions', 'extensions.json'), 'utf8');
    const json = JSON.parse(stored) as { items: { launchApproval: string }[] };
    assert.match(json.items[0]!.launchApproval, /^[a-f0-9]{64}$/);
    assert.equal((await fs.readFile(path.join(home, 'secrets', 'extension-launch-salt'), 'utf8')).length, 64);
    const reloaded = new ExtensionHub(path.join(home, 'extensions'), []);
    const reloadedView = reloaded.list()[0];
    assert.equal(reloadedView?.kind === 'mcp' && reloadedView.needsApproval, false);
    await reloaded.stopAll();
    await put(paths.claudeConfig, config(['changed']));
    await hub.syncOnce(paths);
    const updated = hub.list()[0];
    assert.equal(updated?.kind === 'mcp' && updated.needsApproval, true);
    assert.equal(hub.toolNames(true).length, 0);
    assert.deepEqual(await hub.check(item.id), []);
    const oldDescription = await desktopPermissionChange(workspace, change, false);
    await put(paths.claudeConfig, config(['changed', 'again']));
    await hub.syncOnce(paths);
    await assert.rejects(desktopPermissionChange(workspace, change, true, oldDescription));
    await put(
      paths.claudeConfig,
      JSON.stringify({ mcpServers: { planted: { command: process.execPath, args: [server] } } }),
    );
    await hub.syncOnce(paths);
    const planted = hub.list().find((entry) => entry.name === 'planted');
    assert.equal(planted?.kind === 'mcp' && planted.needsApproval, true);
    assert.deepEqual(await hub.check(planted!.id), []);
  } finally {
    extensions.describeApproveCommand = priorDescribe;
    extensions.approve = priorApprove;
    if (previousDir === undefined) delete process.env.COMBORUNNER_SECRETS_DIR;
    else process.env.COMBORUNNER_SECRETS_DIR = previousDir;
    await hub.stopAll();
  }
});

// Batch 3 moves env and header values into the secrets file; batch 2 ships only together with it.
test('synced stdio configuration does not persist synthetic secrets in extensions.json', async () => {
  const { home, paths, hub, put } = await fixture();
  try {
    await put(
      paths.claudeConfig,
      JSON.stringify({
        mcpServers: {
          local: {
            command: 'synthetic',
            env: { KEY: 'sk-synthetic-TEST-0001' },
          },
        },
      }),
    );
    await hub.syncOnce(paths);
    const stored = await fs.readFile(path.join(home, 'extensions', 'extensions.json'), 'utf8');
    assert.equal(stored.includes('sk-synthetic-TEST-0001'), false, 'synthetic secret must not be persisted');
  } finally {
    await hub.stopAll();
  }
});

test('manual stdio adoption approves its existing signature', async () => {
  const { home, paths, hub, put } = await fixture();
  const previousDir = process.env.COMBORUNNER_SECRETS_DIR;
  process.env.COMBORUNNER_SECRETS_DIR = path.join(home, 'secrets');
  try {
    const server = path.join(home, 'fake.mjs');
    await put(
      server,
      `import { createInterface } from 'node:readline'; createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);if(m.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:m.method==='initialize'?{protocolVersion:'2025-06-18'}:{tools:[{name:'echo',description:'synthetic',inputSchema:{type:'object'}}]}})+'\\n')});`,
    );
    const def = { command: process.execPath, args: [server] };
    await put(
      path.join(home, 'extensions', 'extensions.json'),
      JSON.stringify({
        version: 1,
        items: [
          {
            kind: 'mcp',
            id: 'manual',
            name: 'local',
            transport: 'stdio',
            ...def,
            source: 'synthetic',
            enabled: true,
            installedAt: '2026-01-01',
          },
        ],
      }),
    );
    await hub.check('manual');
    assert.ok(hub.toolNames(true).length);
    await put(paths.claudeConfig, JSON.stringify({ mcpServers: { local: def } }));
    await hub.syncOnce(paths);
    const item = hub.list()[0];
    assert.equal(item?.id, 'manual');
    assert.equal(item?.kind === 'mcp' && item.needsApproval, false);
    await hub.check('manual');
    assert.ok(hub.toolNames(true).length);
  } finally {
    if (previousDir === undefined) delete process.env.COMBORUNNER_SECRETS_DIR;
    else process.env.COMBORUNNER_SECRETS_DIR = previousDir;
    await hub.stopAll();
  }
});

// A stdio server whose `get_info` tool echoes its LOG_LEVEL and the `dir` argument.
async function infoServer(home: string) {
  const server = path.join(home, 'info.mjs');
  await fs.writeFile(
    server,
    `import { createInterface } from 'node:readline';
createInterface({ input: process.stdin }).on('line', line => {
 const m = JSON.parse(line); if (m.id === undefined) return;
 const result = m.method === 'initialize' ? {protocolVersion:'2025-06-18'}
  : m.method === 'tools/list' ? {tools:[{name:'get_info',description:'level',inputSchema:{type:'object',properties:{info:{type:'string'}}}}]}
  : {content:[{type:'text',text:'level '+process.env.LOG_LEVEL+' at '+m.params.arguments.dir}]};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
});`,
  );
  return server;
}

async function withSecrets<T>(home: string, work: () => Promise<T>) {
  const previous = process.env.COMBORUNNER_SECRETS_DIR;
  process.env.COMBORUNNER_SECRETS_DIR = path.join(home, 'secrets');
  try {
    return await work();
  } finally {
    if (previous === undefined) delete process.env.COMBORUNNER_SECRETS_DIR;
    else process.env.COMBORUNNER_SECRETS_DIR = previous;
  }
}

test('a hanging server does not delay setEnabled on another item', async () => {
  const { home, hub, put } = await fixture();
  const hang = path.join(home, 'hang.mjs');
  await put(hang, 'process.stdin.resume();');
  const stdio = (id: string, command: string, args: string[]) => ({
    kind: 'mcp',
    id,
    name: id,
    transport: 'stdio',
    command,
    args,
    source: 'synthetic',
    enabled: true,
    installedAt: '2026-01-01',
  });
  await put(
    path.join(home, 'extensions', 'extensions.json'),
    JSON.stringify({ version: 1, items: [stdio('hang', process.execPath, [hang]), stdio('other', 'synthetic', [])] }),
  );
  const hanging = hub.check('hang').catch(() => undefined);
  try {
    const finished = await Promise.race([
      hub.setEnabled('other', false).then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000).unref()),
    ]);
    assert.equal(finished, true);
    assert.equal(hub.all().find((item) => item.id === 'other')?.enabled, false);
  } finally {
    const stopping = Date.now();
    await hub.stopAll();
    await hanging;
    assert.ok(Date.now() - stopping < 5000);
  }
});

test('a synced tool whose name contains an env value can still be called', async () => {
  const { home, paths, hub, put } = await fixture();
  await withSecrets(home, async () => {
    try {
      const server = await infoServer(home);
      const dir = path.join(home, 'data');
      await put(
        paths.claudeConfig,
        JSON.stringify({
          mcpServers: { local: { command: process.execPath, args: [server, dir], env: { LOG_LEVEL: 'info' } } },
        }),
      );
      await hub.syncOnce(paths);
      const id = hub.all()[0]!.id;
      await hub.approve(id, hub.describeApproveCommand(id, true));
      const tools = await hub.check(id);
      assert.equal(tools[0]?.name, 'get_info');
      assert.deepEqual(tools[0]?.inputSchema, { type: 'object', properties: { info: { type: 'string' } } });
      const name = hub.toolNames(true).find((entry) => entry.includes('get_info'))!;
      assert.ok(name);
      const result = await hub.call(name, { dir }, true);
      assert.equal(result.isError, false);
      assert.equal(result.content[0]?.text, `level info at ${dir}`);
    } finally {
      await hub.stopAll();
    }
  });
});

test('configure then a sync keeps the filled value and the approval', async () => {
  const { home, paths, hub, put } = await fixture();
  const priorDescribe = extensions.describeConfigureCommand;
  const priorConfigure = extensions.configure;
  extensions.describeConfigureCommand = hub.describeConfigureCommand.bind(hub);
  extensions.configure = hub.configure.bind(hub);
  await withSecrets(home, async () => {
    try {
      const server = await infoServer(home);
      const config = JSON.stringify({
        mcpServers: { local: { command: process.execPath, args: [server], env: { LOG_LEVEL: '${LOG_LEVEL}' } } },
      });
      await put(paths.claudeConfig, config);
      await hub.syncOnce(paths);
      const id = hub.all()[0]!.id;
      const held = hub.list()[0];
      assert.equal(held?.kind === 'mcp' && held.needsApproval, true);
      const change = { kind: 'extension-command', action: 'configure', id, values: { LOG_LEVEL: 'info' } };
      const workspace = { controller: {} } as never;
      const description = await desktopPermissionChange(workspace, change, false);
      assert.match(description, /^允许 MCP 工具启动程序\n/);
      await desktopPermissionChange(workspace, change, true, description);
      await put(paths.claudeConfig, config);
      await hub.syncOnce(paths);
      const item = hub.all()[0];
      assert.equal(item?.kind === 'mcp' && item.env?.LOG_LEVEL, 'info');
      const view = hub.list()[0];
      assert.equal(view?.kind === 'mcp' && view.needsApproval, false);
      assert.equal((await hub.check(id))[0]?.name, 'get_info');
      assert.ok(hub.toolNames(true).some((name) => name.includes('get_info')));
    } finally {
      extensions.describeConfigureCommand = priorDescribe;
      extensions.configure = priorConfigure;
      await hub.stopAll();
    }
  });
});

test('replacing a held synced stdio item with the same command still asks for confirmation', async () => {
  const { home, paths, hub, put } = await fixture();
  await withSecrets(home, async () => {
    try {
      const server = await infoServer(home);
      const config = JSON.stringify({ mcpServers: { local: { command: process.execPath, args: [server] } } });
      await put(paths.claudeConfig, config);
      await hub.syncOnce(paths);
      const held = hub.list()[0]!;
      assert.equal(held.kind === 'mcp' && held.needsApproval, true);
      const preview = await hub.preview(config);
      const key = preview.drafts[0]!.key;
      const options = { [key]: { replaceId: held.id } };
      assert.notEqual(hub.describeInstallCommands(preview.token, [key], {}, options), '');
      assert.throws(() => hub.assertInstallNarrowing(preview.token, [key], {}, options));
      await assert.rejects(hub.install(preview.token, [key], {}, options, { expected: '' }));
      const after = hub.list()[0];
      assert.equal(after?.id, held.id);
      assert.equal(after?.kind === 'mcp' && after.needsApproval, true);
      assert.deepEqual(await hub.check(held.id), []);
    } finally {
      await hub.stopAll();
    }
  });
});
