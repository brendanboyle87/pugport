import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { remoteServerExpiry, type RemoteServerView, type RemoteServersView } from '../src/shared/remote-servers.ts';
import {
  parseProbe,
  probeScript,
  readRemoteServers,
  remoteCheckIntervalMs,
  RemoteServerMonitor,
} from '../src/server/remote-servers.ts';
import { RemoteServerCards, remoteServerExpiryLabel } from '../src/ui/RemoteServers.tsx';
import { findNode, nextTurn, uiBundle, uiHarness } from './helpers/ui-harness.ts';

// Synthetic machines and fake SSH only. A zone with a UTC offset and a clock change (11-01), so mixing up local
// and UTC days shows.
process.env.TZ = 'America/New_York';
const lateEvening = new Date(2026, 9, 25, 23, 30).getTime();
const earlyMorning = new Date(2026, 9, 25, 0, 5).getTime();

test('days left count calendar days on this computer, not 24-hour spans', () => {
  for (const now of [lateEvening, earlyMorning]) {
    assert.deepEqual(remoteServerExpiry('2026-11-09', now), { state: 'later', days: 15, date: '2026-11-09' });
    assert.deepEqual(remoteServerExpiry('2026-11-08', now), { state: 'soon', days: 14, date: '2026-11-08' });
    assert.deepEqual(remoteServerExpiry('2026-10-26', now), { state: 'soon', days: 1, date: '2026-10-26' });
    assert.deepEqual(remoteServerExpiry('2026-10-25', now), { state: 'soon', days: 0, date: '2026-10-25' });
    assert.deepEqual(remoteServerExpiry('2026-10-24', now), { state: 'expired', days: -1, date: '2026-10-24' });
    // Across the clock change and a year end.
    assert.deepEqual(remoteServerExpiry('2026-11-20', now), { state: 'later', days: 26, date: '2026-11-20' });
    assert.deepEqual(remoteServerExpiry('2027-01-01', now), { state: 'later', days: 68, date: '2027-01-01' });
  }
  for (const value of [undefined, '', '2026-02-30', '2026-11-9', '11/09/2026', '2026-11-09T00:00:00Z'])
    assert.deepEqual(remoteServerExpiry(value, lateEvening), { state: 'unknown' });
});

test('expiry labels say days left, today, expired or not recorded', () => {
  const label = (expiresOn?: string) => remoteServerExpiryLabel(remoteServerExpiry(expiresOn, lateEvening));
  assert.equal(label('2026-11-09'), '还剩 15 天');
  assert.equal(label('2026-10-26'), '还剩 1 天');
  assert.equal(label('2026-10-25'), '今天到期');
  assert.equal(label('2026-10-01'), '已到期');
  assert.equal(label(undefined), '到期日未记录');
});

test('the list file: missing is empty, a BOM is fine, broken or misspelt says where without throwing', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pugport-remote-servers-'));
  const file = join(directory, 'remote-servers.json');
  try {
    assert.deepEqual(await readRemoteServers(file), { servers: [], file });
    const servers = [
      {
        name: 'test-arm',
        provider: 'Example Cloud',
        region: 'region-a',
        expiresOn: '2026-11-09',
        credit: '$12',
        note: 'Log out first',
        ssh: 'test-arm',
        services: ['actions.runner.*'],
        statusCommand: 'uptime',
      },
      { name: 'test-vps', spec: '2 vCPU' },
    ];
    writeFileSync(file, '\uFEFF' + JSON.stringify({ servers }));
    assert.deepEqual(await readRemoteServers(file), { servers, file });
    const broken: Array<[string, string | undefined]> = [
      ['{', undefined],
      [JSON.stringify({ servers: [{ name: 'a' }, { name: 'b', expiresAt: '2026-11-09' }] }), 'servers.1'],
      [JSON.stringify({ servers: [{ name: 'a', expiresOn: '2026-02-30' }] }), 'servers.0.expiresOn'],
      [JSON.stringify({ servers: [{ name: '' }] }), 'servers.0.name'],
      [JSON.stringify({ servers: [{ name: 'a', ssh: '-oProxyCommand=calc' }] }), 'servers.0.ssh'],
      [JSON.stringify({ servers: [{ name: 'a', services: ["x'; rm -rf ~"] }] }), 'servers.0.services.0'],
      [JSON.stringify({ servers: [{ name: 'a', statusCommand: 'one\ntwo' }] }), 'servers.0.statusCommand'],
    ];
    for (const [content, errorAt] of broken) {
      writeFileSync(file, content);
      assert.deepEqual(await readRemoteServers(file), {
        servers: [],
        file,
        error: '远程服务器列表格式无效。',
        ...(errorAt ? { errorAt } : {}),
      });
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the probe only reads: no installs, writes or sudo, and quotes what the owner configured', () => {
  const script = probeScript({
    services: ['actions.runner.*', 'nginx', 'backup.service'],
    statusCommand: "echo 'it''s' | head -n1",
  });
  // The one redirect drops the status command's errors.
  assert.doesNotMatch(script.replace('2>/dev/null', ''), /sudo|apt|install|\brm\b|>|\btee\b|curl|wget/);
  assert.match(script, /systemctl list-units --type=service --all --no-legend --plain 'actions\.runner\.\*'/);
  assert.match(script, /--plain 'nginx\.service'/);
  assert.match(script, /--plain 'backup\.service'/);
  assert.match(script, /timeout 5 sh -c 'echo '\\''it'\\'''\\''s'\\'' \| head -n1' <\/dev\/null 2>/);
  assert.match(script, /exit 0\n$/);
  assert.doesNotMatch(probeScript({}), /systemctl|status \$/);
});

test('without an ssh client the box shows why, and nothing is started', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pugport-remote-no-ssh-'));
  const file = join(directory, 'remote-servers.json');
  writeFileSync(file, JSON.stringify({ servers: [{ name: 'test-arm', ssh: 'test-arm' }] }));
  const path = process.env.PATH;
  process.env.PATH = '';
  try {
    const live = (await new RemoteServerMonitor(file).view(true)).servers[0].live!;
    assert.equal(live.online, false);
    assert.equal(live.reason, '找不到 ssh 命令。');
  } finally {
    process.env.PATH = path;
    rmSync(directory, { recursive: true, force: true });
  }
});

const probeOutput = [
  'cpu  1000 0 500 8000 500 0 0 0 0 0',
  'cpu  1300 0 600 8550 550 0 0 0 0 0',
  'memory-total 32768000',
  'memory-available 8192000',
  'disk 100000000 60000000',
  'cores 8',
  'arch aarch64',
  'service actions.runner.example-org-repo.test-arm-ci-1.service active',
  'service actions.runner.example-org-repo.test-arm-ci-2.service failed',
  'service backup.service inactive',
  'status heavy job : none',
].join('\n');

test('probe output becomes CPU busy share, memory, disk, services and the status line', () => {
  assert.deepEqual(parseProbe(probeOutput), {
    // 1000 jiffies passed, 600 of them idle or waiting.
    cpuPercent: 40,
    memoryTotal: 32768000 * 1024,
    memoryAvailable: 8192000 * 1024,
    diskTotal: 100000000 * 1024,
    diskFree: 60000000 * 1024,
    cores: 8,
    arch: 'aarch64',
    services: [
      { name: 'test-arm-ci-1', state: 'active' },
      { name: 'test-arm-ci-2', state: 'failed' },
      { name: 'backup', state: 'inactive' },
    ],
    status: 'heavy job : none',
  });
  assert.deepEqual(parseProbe('cpu  1 2 3\nmemory-total x\ndisk\ncores -1\nstatus \n'), {
    memoryTotal: undefined,
    diskTotal: undefined,
    diskFree: undefined,
    cores: undefined,
  });
});

test('boxes are checked over SSH only on refresh, at most every few minutes, and keep readings when offline', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pugport-remote-monitor-'));
  const file = join(directory, 'remote-servers.json');
  writeFileSync(
    file,
    JSON.stringify({
      servers: [
        { name: 'test-arm', ssh: 'test-arm', services: ['actions.runner.*'] },
        { name: 'test-static', expiresOn: '2026-11-09' },
      ],
    }),
  );
  let clock = Date.parse('2026-10-25T17:00:00Z');
  const calls: string[] = [];
  let answer: () => Promise<string> = async () => probeOutput;
  const monitor = new RemoteServerMonitor(
    file,
    (alias, script) => {
      calls.push(alias);
      assert.match(script, /actions\.runner/);
      return answer();
    },
    () => clock,
  );
  try {
    const first = await monitor.view(false);
    assert.equal(calls.length, 0);
    assert.equal(first.servers[0].live, undefined);
    // Two refreshes at once share one check.
    const [checked] = await Promise.all([monitor.view(true), monitor.view(true)]);
    assert.deepEqual(calls, ['test-arm']);
    const live = checked.servers[0].live!;
    assert.equal(live.online, true);
    assert.equal(live.cpuPercent, 40);
    assert.equal(live.checkedAt, '2026-10-25T17:00:00.000Z');
    assert.equal(live.lastSeenAt, '2026-10-25T17:00:00.000Z');
    assert.equal(checked.servers[1].live, undefined);

    clock += remoteCheckIntervalMs - 1;
    await monitor.view(true);
    assert.equal(calls.length, 1);

    clock += 1;
    answer = async () => {
      throw Object.assign(new Error('ssh exited 255'), { code: 255 });
    };
    const offline = (await monitor.view(true)).servers[0].live!;
    assert.equal(calls.length, 2);
    assert.equal(offline.online, false);
    assert.equal(offline.reason, '连不上：SSH 登录失败或主机没响应。');
    assert.equal(offline.lastSeenAt, '2026-10-25T17:00:00.000Z');
    assert.equal(offline.checkedAt, new Date(clock).toISOString());
    assert.equal(offline.cpuPercent, 40);

    clock += remoteCheckIntervalMs;
    answer = async () => {
      throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
    };
    assert.equal((await monitor.view(true)).servers[0].live!.reason, '检查超时');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

const servers: RemoteServerView[] = [
  { name: 'test-vps', provider: 'Example VPS', spec: '6 vCPU · 8 GB', purpose: 'CI runner' },
  { name: 'test-later', provider: 'Example Cloud', region: 'region-a', expiresOn: '2026-12-01' },
  {
    name: 'test-soon',
    provider: 'Example Cloud',
    region: 'region-b',
    spec: '8 vCPU ARM64 · 32 GB',
    purpose: 'Test box',
    expiresOn: '2026-11-08',
    credit: 'CA$120',
    note: 'Log out of the CLIs first',
  },
  { name: 'test-gone', expiresOn: '2026-10-20' },
];
const cards = (view?: RemoteServersView) =>
  renderToStaticMarkup(
    createElement(RemoteServerCards, {
      view,
      now: lateEvening,
      onOpen() {},
      notify() {},
      api: async () => {
        throw new Error('Unexpected API request');
      },
    }),
  );

test('remote server cards: soonest first, highlighted within 14 days, expired marked, no date last', () => {
  assert.equal(cards(undefined), '');
  assert.equal(cards({ servers: [], file: 'remote-servers.json' }), '');
  const html = cards({ servers, file: 'remote-servers.json' });
  assert.match(
    html,
    /<section aria-label="远程服务器" class="web-quota-section remote-server-section"><h2>远程服务器<\/h2>/,
  );
  assert.deepEqual(
    [...html.matchAll(/<h3 translate="no" title="([^"]+)">\1<\/h3>/g)].map((match) => match[1]),
    ['test-gone', 'test-soon', 'test-later', 'test-vps'],
  );
  assert.match(html, /class="quota-card compact-quota-card remote-server-card expired"/);
  assert.match(html, /class="plan-badge remote-server-expiry expired">已到期</);
  assert.match(html, /class="quota-card compact-quota-card remote-server-card soon"/);
  assert.match(html, /class="plan-badge remote-server-expiry soon">还剩 14 天</);
  assert.match(html, /class="plan-badge remote-server-expiry later">还剩 37 天</);
  assert.match(html, /class="plan-badge remote-server-expiry unknown">到期日未记录</);
  assert.match(html, /<time dateTime="2026-11-08" translate="no">到期日 2026-11-08<\/time>/);
  assert.equal((html.match(/<footer/g) ?? []).length, 3);
  assert.match(html, /<p class="quota-note" translate="no">Example Cloud · region-b<\/p>/);
  assert.match(html, /<p class="remote-server-spec" translate="no">8 vCPU ARM64 · 32 GB<\/p>/);
  assert.match(html, /<p class="remote-server-purpose" translate="no">Test box<\/p>/);
  assert.match(html, /<p class="remote-server-credit" translate="no">剩余赠金 CA\$120<\/p>/);
  assert.match(html, /<p class="remote-server-note" translate="no">Log out of the CLIs first<\/p>/);
  assert.equal((html.match(/没有 SSH 别名，不读实时状态/g) ?? []).length, 4);
  assert.doesNotMatch(html, /device-resource|inline-error/);
  const failed = cards({
    servers: [],
    file: 'C:\\data\\remote-servers.json',
    error: '远程服务器列表格式无效。',
    errorAt: 'servers.1.expiresOn',
  });
  assert.match(
    failed,
    /role="alert"><span>远程服务器列表格式无效。<\/span><code translate="no">C:\\data\\remote-servers.json → servers.1.expiresOn<\/code>/,
  );
});

test('live cards show CPU, memory and disk like device cards; offline keeps the last readings dimmed', () => {
  const reading = { ...parseProbe(probeOutput), checkedAt: '2026-10-25T17:00:00Z', lastSeenAt: '2026-10-25T17:00:00Z' };
  const box = { name: 'test-arm', ssh: 'test-arm', expiresOn: '2026-11-08' };
  const online = cards({ servers: [{ ...box, live: { ...reading, online: true } }], file: 'f' });
  assert.match(online, /<div class="remote-server-live"><div class="device-resources">/);
  assert.match(online, /CPU<\/span><strong>40%/);
  assert.match(online, /内存<\/span><strong>75%/);
  assert.match(online, /磁盘<\/span><strong>40%/);
  assert.match(online, /<small title="8 核 · aarch64" translate="no">/);
  assert.match(online, /<small title="23.4 \/ 31.3 GiB" translate="no">/);
  assert.match(online, /<small title="57.2 GB 可用 \/ 95.4 GB" translate="no">/);
  assert.match(
    online,
    /class="device-quota-chip healthy" title="active"><span translate="no">test-arm-ci-1<\/span> 运行中/,
  );
  assert.match(
    online,
    /class="device-quota-chip danger" title="failed"><span translate="no">test-arm-ci-2<\/span> 失败/,
  );
  assert.match(online, /class="device-quota-chip unknown" title="inactive"><span translate="no">backup<\/span> 已停止/);
  assert.match(online, /<p class="remote-server-status" translate="no" title="heavy job : none">heavy job : none<\/p>/);
  assert.match(online, /<span class="device-status online">在线<\/span><time dateTime="2026-10-25T17:00:00Z"/);
  assert.doesNotMatch(online, /opacity|没有 SSH 别名/);

  const offline = cards({
    servers: [
      {
        ...box,
        live: { ...reading, online: false, checkedAt: '2026-10-25T17:10:00Z', reason: '检查超时' },
      },
    ],
    file: 'f',
  });
  assert.match(offline, /<div class="remote-server-live" style="opacity:0.55">/);
  assert.match(offline, /CPU<\/span><strong>—/);
  assert.match(offline, /<small title="8 核 · aarch64"/);
  assert.match(offline, /<p class="remote-server-reason">检查超时<\/p>/);
  assert.match(offline, /<span class="device-status ">离线<\/span><time dateTime="2026-10-25T17:00:00Z"/);

  const checking = cards({ servers: [box], file: 'f' });
  assert.match(checking, /<span class="device-status">正在检查…<\/span>/);
  assert.match(checking, /CPU<\/span><strong>—/);
});

test('remote servers load the last readings, then refresh every minute while visible, keeping them on failure', async () => {
  let tick!: () => void;
  const document = { visibilityState: 'visible' };
  const h = uiHarness(await uiBundle('src/ui/RemoteServers.tsx'), {
    document,
    setInterval: (fn: () => void, ms: number) => {
      assert.ok(ms === 60_000 || ms === 3000);
      if (ms === 60_000) tick = fn;
      return ms;
    },
  });
  const calls: string[] = [];
  const view = { servers, file: 'remote-servers.json' };
  let fail = false;
  const props = {
    now: lateEvening,
    devices: [],
    reload: async () => {},
    onOpen() {},
    api: async (path: string, _body: unknown, method: string) => {
      if (path === '/api/remote-servers/enrollments') return { enrollments: [] };
      calls.push(`${method} ${path}`);
      if (fail) throw new Error('offline');
      return view;
    },
  };
  const shown = () => findNode(h.render('RemoteServers', props), (node) => node.type?.name === 'RemoteServerCards');
  h.render('RemoteServers', props);
  await nextTurn();
  await nextTurn();
  assert.deepEqual(calls, ['GET /api/remote-servers', 'GET /api/remote-servers?refresh=1']);
  assert.deepEqual(JSON.parse(JSON.stringify(shown()!.props.view)), view);
  document.visibilityState = 'hidden';
  tick();
  assert.equal(calls.length, 2);
  document.visibilityState = 'visible';
  fail = true;
  tick();
  await nextTurn();
  assert.equal(calls.length, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(shown()!.props.view)), view);
  h.unmount();
});
