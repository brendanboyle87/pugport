import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { mkdirSync, writeSync } from 'node:fs';
import { inspect } from 'node:util';
import { createServer as httpServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { createConnection, createServer as tcpServer } from 'node:net';
import { platform, release } from 'node:os';
import { join } from 'node:path';
import { app, BrowserWindow, shell } from 'electron';
import { createDesktopShell } from '../../src/electron/shell.ts';
import { installModFrameGuard } from '../../src/electron/mod-frame-guard.ts';
import { buildModSrcDoc } from '../../src/shared/mod-client-shim.ts';

let step = 'startup';
let finished = false;
let watchdog: ReturnType<typeof setTimeout> | undefined;
const log = (message: string) => writeSync(1, `${message}\n`);
const fatal = (kind: string, error: unknown) => {
  writeSync(2, `FAIL ModFrameGuard: ${step} / ${kind}\n${inspect(error, { depth: 8 })}\n`);
  clearTimeout(watchdog);
  app.exit(1);
};
const mark = (label: string) => {
  step = label;
  log(`STEP ModFrameGuard: ${step}`);
  clearTimeout(watchdog);
  watchdog = setTimeout(() => fatal('timeout', new Error('Step did not finish within 15s')), 15000);
};
process.on('unhandledRejection', (error) => fatal('unhandled rejection', error));
process.on('uncaughtException', (error) => fatal('uncaught exception', error));
// Calibration destroys the only window before guarded windows exist. Keep the harness alive on Windows.
app.on('window-all-closed', () => log(`LIFECYCLE ModFrameGuard: ${step} / window-all-closed`));
app.on('before-quit', () => log(`LIFECYCLE ModFrameGuard: ${step} / before-quit / finished=${finished}`));
app.on('will-quit', () => log(`LIFECYCLE ModFrameGuard: ${step} / will-quit / finished=${finished}`));
app.on('quit', (_event, code) => log(`EXIT ModFrameGuard: step=${step} code=${code} finished=${finished}`));
app.on('browser-window-created', (_event, window) => {
  window.on('closed', () => log(`LIFECYCLE ModFrameGuard: ${step} / window closed`));
  window.webContents.on('render-process-gone', (_event, details) => fatal('renderer gone', details));
  window.webContents.on('console-message', (details) => {
    if (details.level === 'error') log(`RENDERER ModFrameGuard: ${step} / ${details.message}`);
  });
});

const directory = process.argv.at(-1)!;
mkdirSync(join(directory, 'profile'), { recursive: true });
app.setPath('userData', join(directory, 'profile'));
// Test-only local DoH certificate and synthetic microphone; no OS devices or external receivers.
app.commandLine.appendSwitch('ignore-certificate-errors');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// A temporary self-signed certificate generated entirely in memory for the local DNS-over-HTTPS receiver.
function certificate() {
  const der = (tag: number, ...parts: Buffer[]) => {
    const body = Buffer.concat(parts);
    const size = body.length;
    const length = size < 128 ? [size] : size < 256 ? [0x81, size] : [0x82, size >> 8, size & 255];
    return Buffer.concat([Buffer.from([tag, ...length]), body]);
  };
  const seq = (...parts: Buffer[]) => der(0x30, ...parts);
  const oid = (hex: string) => der(6, Buffer.from(hex, 'hex'));
  const algorithm = seq(oid('2a864886f70d01010b'), der(5));
  const name = seq(der(0x31, seq(oid('550403'), der(0x0c, Buffer.from('localhost')))));
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const tbs = seq(
    der(0xa0, der(2, Buffer.from([2]))),
    der(2, Buffer.from([1])),
    algorithm,
    name,
    seq(der(0x17, Buffer.from('240101000000Z')), der(0x17, Buffer.from('491231235959Z'))),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    der(
      0xa3,
      seq(seq(oid('551d11'), der(4, seq(der(0x82, Buffer.from('localhost')), der(0x87, Buffer.from([127, 0, 0, 1])))))),
    ),
  );
  const bytes = seq(tbs, algorithm, der(3, Buffer.from([0]), sign('sha256', tbs, privateKey)));
  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    cert: `-----BEGIN CERTIFICATE-----\n${bytes
      .toString('base64')
      .match(/.{1,64}/g)!
      .join('\n')}\n-----END CERTIFICATE-----`,
  };
}

function dnsName(packet: Buffer) {
  let offset = 12;
  const labels: string[] = [];
  while (offset < packet.length && packet[offset]) {
    const length = packet[offset++]!;
    if (length > 63 || offset + length > packet.length) throw new Error('Invalid DNS question');
    labels.push(packet.subarray(offset, offset + length).toString());
    offset += length;
  }
  return labels.join('.');
}

// Calibrate the actual receiver over UDP, independently of Chromium's ICE interface selection and policy.
async function verifyStunReceiver(port: number) {
  const client = createSocket('udp4');
  const request = Buffer.alloc(20);
  request.writeUInt16BE(1, 0);
  request.writeUInt32BE(0x2112a442, 4);
  randomBytes(12).copy(request, 8);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await new Promise<Buffer>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('STUN receiver unverifiable: no UDP binding response in 5s')), 5000);
      client.once('error', reject);
      client.once('message', (packet, remote) => {
        if (remote.address !== '127.0.0.1' || remote.port !== port)
          return reject(new Error('STUN receiver unverifiable: response came from a different endpoint'));
        resolve(packet);
      });
      client.bind(0, '127.0.0.1', () => {
        client.send(request, port, '127.0.0.1', (error) => {
          if (error) reject(error);
        });
      });
    });
    assert.equal(response.length, 32);
    assert.equal(response.readUInt16BE(0), 0x0101, 'Binding success response');
    assert.equal(response.readUInt16BE(2), 12);
    assert.deepEqual(response.subarray(4, 20), request.subarray(4, 20), 'STUN cookie and transaction ID');
    assert.equal(response.readUInt16BE(20), 0x0020, 'XOR-MAPPED-ADDRESS');
    assert.equal(response.readUInt16BE(22), 8);
    assert.equal(response[25], 1, 'IPv4 address family');
    assert.equal(response.readUInt16BE(26) ^ 0x2112, client.address().port);
    assert.deepEqual(
      [...response.subarray(28)].map((value, index) => value ^ request[4 + index]!),
      [203, 0, 113, 1],
      'Synthetic mapped address',
    );
  } catch (cause) {
    throw new Error('STUN receiver unverifiable: local UDP binding control failed; no security acceptance', { cause });
  } finally {
    clearTimeout(timer);
    try {
      client.close();
    } catch {
      // A bind failure may already have closed the socket; preserve the calibration error.
    }
  }
}

async function main() {
  mark('wait for Electron ready');
  await app.whenReady();
  console.log(
    JSON.stringify({
      os: platform(),
      release: release(),
      electron: process.versions.electron,
      chromium: process.versions.chrome,
    }),
  );
  mark('start HTTP, DNS, UDP and TCP receivers');
  const requests: string[] = [];
  const dns: string[] = [];
  const stun: string[] = [];
  const tcp: string[] = [];
  const external: string[] = [];
  const browserRequests: string[] = [];
  const browserResponses: string[] = [];
  const downloads: string[] = [];
  const popups: string[] = [];
  const udp = createSocket('udp4');
  udp.on('message', (packet, remote) => {
    stun.push(`${remote.address}:${remote.port}`);
    // RFC 5389 Binding success with a synthetic XOR-MAPPED-ADDRESS.
    if (packet.length < 20 || packet.readUInt16BE(0) !== 1) return;
    const response = Buffer.alloc(32);
    response.writeUInt16BE(0x0101, 0);
    response.writeUInt16BE(12, 2);
    packet.copy(response, 4, 4, 20);
    response.writeUInt16BE(0x0020, 20);
    response.writeUInt16BE(8, 22);
    response[25] = 1;
    response.writeUInt16BE(remote.port ^ 0x2112, 26);
    [203, 0, 113, 1].forEach((value, index) => (response[28 + index] = value ^ [0x21, 0x12, 0xa4, 0x42][index]!));
    udp.send(response, remote.port, remote.address);
  });
  await new Promise<void>((resolve) => udp.bind(0, '127.0.0.1', resolve));
  const stunPort = udp.address().port;
  const turn = tcpServer((socket) => {
    tcp.push('connection');
    socket.on('data', () => tcp.push('data'));
    socket.end();
  });
  await new Promise<void>((resolve) => turn.listen(0, '127.0.0.1', resolve));
  const turnPort = (turn.address() as { port: number }).port;
  const doh = httpsServer(certificate(), async (request, response) => {
    const url = new URL(request.url!, 'https://localhost');
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const query = url.searchParams.has('dns')
      ? Buffer.from(url.searchParams.get('dns')!, 'base64url')
      : Buffer.concat(chunks);
    dns.push(dnsName(query));
    const answer = Buffer.from(query);
    answer.writeUInt16BE(0x8183, 2); // NXDOMAIN still proves the receiver saw the lookup.
    answer.writeUInt16BE(0, 6);
    answer.writeUInt16BE(0, 8);
    answer.writeUInt16BE(0, 10);
    response.writeHead(200, { 'Content-Type': 'application/dns-message' }).end(answer);
  });
  await new Promise<void>((resolve) => doh.listen(0, '127.0.0.1', resolve));
  const dohPort = (doh.address() as { port: number }).port;
  app.configureHostResolver({
    enableBuiltInResolver: true,
    secureDnsMode: 'secure',
    secureDnsServers: [`https://127.0.0.1:${dohPort}/dns-query{?dns}`],
  });
  const server = httpServer((request, response) => {
    if (request.url!.startsWith('/sink')) {
      requests.push(request.url!);
      response.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'text/plain' }).end('sink');
    } else {
      response.setHeader('Content-Type', 'text/html');
      response.end(
        '<!doctype html><html><body><a id="external" target="_blank" href="https://example.invalid/trusted">trusted link</a><div id="frames"></div></body></html>',
      );
    }
  });
  server.on('upgrade', (request, socket) => {
    requests.push(request.url!);
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const nonce = '1234567890abcdef'.repeat(3);
  const createWindow = (partition?: string) =>
    new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true, partition },
    });
  const peerScript = (policy: string) => `async function peer(candidates){
    const pc=new RTCPeerConnection({iceServers:[{urls:'stun:127.0.0.1:${stunPort}'},{urls:'stun:${policy}.mods-guard.example.com:${stunPort}'},{urls:'turn:127.0.0.1:${turnPort}?transport=tcp',username:'synthetic',credential:'synthetic'}]});
    pc.onicecandidate=e=>{if(e.candidate)candidates.push(e.candidate.candidate)};
    try {
      pc.createDataChannel('probe'); await pc.setLocalDescription(await pc.createOffer());
      await new Promise(r=>setTimeout(r,6000)); return candidates;
    } finally {pc.close();}
  }`;
  mark('create calibration window and load receiver');
  const calibration = createWindow('mods-guard-calibration');
  const calibrationSession = calibration.webContents.session;
  await calibration.loadURL(origin);
  mark('calibrate HTTP receiver');
  await calibration.webContents.executeJavaScript(`fetch('${origin}/sink/calibration').then(r=>r.text())`);
  mark('calibrate DNS receiver');
  await calibration.webContents.session.resolveHost('calibration.mods-guard.example.com').catch(() => {});
  mark('calibrate UDP STUN receiver');
  await verifyStunReceiver(stunPort);
  // The TCP receiver records connections; a Node connection verifies that path without Chromium policy.
  mark('calibrate TCP receiver');
  await new Promise<void>((resolve, reject) => {
    const client = createConnection({ host: '127.0.0.1', port: turnPort });
    const timer = setTimeout(() => {
      client.destroy(new Error('TURN TCP receiver unverifiable: local connection control timed out'));
    }, 5000);
    client.once('error', (cause) => reject(new Error('TURN TCP receiver unverifiable', { cause })));
    client.once('connect', () => client.end());
    client.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  assert.ok(requests.length > 0, 'HTTP receiver must observe a positive control');
  assert.ok(
    dns.some((name) => name === 'calibration.mods-guard.example.com'),
    'DNS receiver calibration failed; test is not security acceptance',
  );
  assert.ok(stun.length > 0, 'STUN receiver unverifiable: binding control was not recorded');
  assert.ok(tcp.length > 0, 'TURN TCP receiver unverifiable: connection control was not recorded');
  console.log('Receiver controls verified: HTTP, DNS, UDP STUN binding round trip and TCP connection');
  mark('close calibration window and drain receiver traffic');
  calibration.destroy();
  await sleep(250);
  requests.length = dns.length = stun.length = tcp.length = 0;
  shell.openExternal = async (url) => {
    external.push(url);
  };
  mark('create guarded desktop and second window');
  const desktop = createDesktopShell({
    dataDir: 'synthetic',
    diagnosticInfo: async () => ({}),
    reportProblem: async () => {},
    takeCrashRecord: () => undefined,
    origin,
    preload: join(directory, 'preload.cjs'),
    backend: {
      inspect: async () => ({ active: 0, queued: 0, waitingApproval: 0, scheduled: 0 }),
      stop: async () => {},
    },
    windowOptions: { show: false },
    desktopIntegration: false,
  });
  const windows = [desktop.window, createWindow()];
  installModFrameGuard(windows[1]!.webContents, origin, async (url) => {
    external.push(url);
  });
  for (const window of windows) {
    mark(`load guarded window ${windows.indexOf(window) + 1}`);
    // Hidden test windows still need the probe's ICE observation timer to run on time.
    window.webContents.setBackgroundThrottling(false);
    assert.notEqual(window.webContents.session, calibrationSession);
    assert.equal(window.webContents.getWebRTCIPHandlingPolicy(), 'disable_non_proxied_udp');
    window.webContents.on('did-create-window', (_child, details) => popups.push(String(details.url)));
    window.webContents.session.on('will-download', (_event, item) => downloads.push(item.getURL()));
    await window.loadURL(origin);
    mark(`attach network observer in window ${windows.indexOf(window) + 1}`);
    window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Network.enable');
    window.webContents.debugger.on('message', (_event, method, params) => {
      if (method === 'Network.requestWillBeSent' && String(params.request.url).includes('/sink'))
        browserRequests.push(params.request.url);
      if (method === 'Network.responseReceived' && String(params.response.url).includes('/sink'))
        browserResponses.push(params.response.url);
    });
    mark(`start Mod probes in window ${windows.indexOf(window) + 1}`);
    const code = `${peerScript('guarded-stun')};
      const reportError=error=>{document.body.dataset.error=String(error?.stack||error);console.error(document.body.dataset.error)};
      addEventListener('error',event=>reportError(event.error||event.message));
      addEventListener('unhandledrejection',event=>reportError(event.reason));
      const result={parent:false,storage:false,token:false,node:typeof require!=='undefined'||typeof process!=='undefined',preload:typeof comboRunnerDesktop!=='undefined',candidates:[],grants:[],capabilities:{},complete:false};
      const publish=()=>{document.body.dataset.result=JSON.stringify(result)};
      try { void parent.document.body; result.parent=true; } catch {}
      try { void parent.localStorage.length; result.storage=true; } catch {}
      try { result.token=parent.localStorage.getItem('synthetic-token')==='secret-fixture'; } catch {}
      publish();
      const attempt=fn=>{try {Promise.resolve(fn()).catch(()=>{});}catch{}};
      attempt(()=>fetch('${origin}/sink/fetch'));
      attempt(()=>{const xhr=new XMLHttpRequest();xhr.open('GET','${origin}/sink/xhr');xhr.send()});
      attempt(()=>new WebSocket('${origin.replace('http:', 'ws:')}/sink/socket'));
      attempt(()=>{new Image().src='${origin}/sink/image'});
      attempt(()=>{const form=document.createElement('form');form.action='${origin}/sink/form';document.body.append(form);form.submit()});
      attempt(()=>{const meta=document.createElement('meta');meta.httpEquiv='x-dns-prefetch-control';meta.content='on';document.head.append(meta);const link=document.createElement('link');link.rel='dns-prefetch';link.href='//guarded-prefetch.mods-guard.example.com';document.head.append(link)});
      attempt(()=>{const link=document.createElement('link');link.rel='preconnect';link.href='${origin}/sink/preconnect';document.head.append(link)});
      attempt(()=>window.open('${origin}/sink/popup'));
      attempt(()=>{top.location='${origin}/sink/top'});
      attempt(()=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob(['synthetic']));a.download='mod.txt';document.body.append(a);a.click()});
      attempt(()=>{const view=document.createElement('webview');view.src='${origin}/sink/webview';document.body.append(view)});
      const capabilities=[
        ['microphone',()=>navigator.mediaDevices.getUserMedia({audio:true})],
        ['camera',()=>navigator.mediaDevices.getUserMedia({video:true})],
        ['display-capture',()=>navigator.mediaDevices.getDisplayMedia({video:true})],
        ['clipboard',()=>navigator.clipboard.readText()],
        ['clipboard-write',()=>navigator.clipboard.writeText('blocked')],
        ['geolocation',()=>new Promise((yes,no)=>navigator.geolocation.getCurrentPosition(yes,no))],
        ['usb',()=>navigator.usb.requestDevice({filters:[]})],
        ['serial',()=>navigator.serial.requestPort()],
        ['hid',()=>navigator.hid.requestDevice({filters:[]})],
        ['bluetooth',()=>navigator.bluetooth.requestDevice({acceptAllDevices:true})],
        ['midi',()=>navigator.requestMIDIAccess({sysex:true})],
        ['notifications',async()=>{if(await Notification.requestPermission()!=='granted')throw Error('denied')}],
      ];
      const probe=async(name,fn,granted)=>{
        result.capabilities[name]={status:'pending'};publish();
        let value;
        try {value=await fn();}
        catch(error){result.capabilities[name]={status:'blocked',reason:String(error?.stack||error)};publish();return;}
        granted(value);
        result.capabilities[name]={status:'granted'};publish();
      };
      Promise.all([
        ...capabilities.map(([name,fn])=>probe(name,fn,()=>result.grants.push(name))),
        probe('webrtc',()=>peer(result.candidates),()=>{}),
      ]).then(()=>{result.complete=true;publish()}).catch(reportError);
    `;
    const srcdoc = buildModSrcDoc(
      {
        html: '<p>Mod fixture</p><link rel="dns-prefetch" href="//guarded-html.mods-guard.example.com">',
        css: `@import url('${origin}/sink/import'); body { background-image: url('${origin}/sink/css'); }`,
        js: code,
      },
      nonce,
    );
    await window.webContents.executeJavaScript(
      `localStorage.setItem('synthetic-token','secret-fixture');const frame=document.createElement('iframe');frame.sandbox='allow-scripts';frame.referrerPolicy='no-referrer';frame.srcdoc=${JSON.stringify(srcdoc)};document.getElementById('frames').append(frame);`,
    );
  }
  mark('wait for guarded network and capability probes');
  await sleep(7500);
  for (const window of windows) {
    mark(`read Mod results in window ${windows.indexOf(window) + 1}`);
    const frame = window.webContents.mainFrame.frames.find((entry) => entry.url === 'about:srcdoc');
    assert.ok(frame, 'Real Mod frame must load');
    // Read the child document directly; its opaque origin forbids parent DOM access.
    // A missing/pending result is never evidence that a capability was blocked.
    let result;
    const deadline = Date.now() + 12000;
    do {
      const snapshot = await frame.executeJavaScript(
        '({error:document.body.dataset.error??null,result:document.body.dataset.result??null})',
      );
      assert.ok(snapshot && typeof snapshot === 'object' && 'error' in snapshot && 'result' in snapshot);
      assert.ok(snapshot.error == null, `Mod probe failed: ${snapshot.error}`);
      assert.ok(snapshot.result == null || typeof snapshot.result === 'string', 'Mod result must be serialized JSON');
      result = snapshot.result == null ? null : JSON.parse(snapshot.result);
      if (result?.complete) break;
      await sleep(50);
    } while (Date.now() < deadline);
    assert.ok(
      result?.complete,
      `Mod probes did not finish in window ${windows.indexOf(window) + 1}: ${inspect(result)}`,
    );
    log(`RESULT ModFrameGuard window ${windows.indexOf(window) + 1}: ${JSON.stringify(result)}`);
    assert.deepEqual(
      {
        parent: result.parent,
        storage: result.storage,
        token: result.token,
        node: result.node,
        preload: result.preload,
      },
      { parent: false, storage: false, token: false, node: false, preload: false },
    );
    assert.deepEqual(result.grants, []);
    for (const name of [
      'microphone',
      'camera',
      'display-capture',
      'clipboard',
      'clipboard-write',
      'geolocation',
      'usb',
      'serial',
      'hid',
      'bluetooth',
      'midi',
      'notifications',
    ]) {
      assert.equal(result.capabilities[name]?.status, 'blocked', `${name} must explicitly reject in the Mod frame`);
    }
    assert.ok(['blocked', 'granted'].includes(result.capabilities.webrtc?.status), 'WebRTC probe must settle');
    assert.equal(
      result.candidates.some((candidate: string) => candidate.includes(' typ srflx ')),
      false,
    );
    assert.equal(
      await window.webContents.executeJavaScript('document.querySelector("iframe").sandbox.value'),
      'allow-scripts',
    );
    // Independent navigation attempts must not escape to data/blob/HTTP, even if CSP would allow navigation.
    const blobUrl = String(
      await frame.executeJavaScript("URL.createObjectURL(new Blob(['escaped'], {type: 'text/html'}))"),
    );
    for (const destination of [`${origin}/sink/navigation`, 'data:text/html,escaped', blobUrl]) {
      mark(`reject Mod navigation in window ${windows.indexOf(window) + 1}: ${destination}`);
      await frame.executeJavaScript(`try{location.href=${JSON.stringify(destination)}}catch{}`);
      await sleep(100);
      assert.equal(frame.url, 'about:srcdoc');
    }
    await frame.executeJavaScript(`URL.revokeObjectURL(${JSON.stringify(blobUrl)})`);
    // An intentionally weaker sandbox exercises Electron's initiating-frame checks independently.
    mark(`reject weaker sandbox escapes in window ${windows.indexOf(window) + 1}`);
    await window.webContents.executeJavaScript(
      `const adversary=document.createElement('iframe');adversary.sandbox='allow-scripts allow-popups allow-top-navigation';adversary.srcdoc='<p>guard probe</p>';document.body.append(adversary);`,
    );
    await sleep(100);
    const adversary = window.webContents.mainFrame.frames.at(-1)!;
    await adversary.executeJavaScript(
      `window.open('${origin}/sink/guard-popup');top.location='${origin}/sink/guard-top';`,
    );
    await sleep(100);
    assert.equal(window.webContents.getURL(), `${origin}/`);
    assert.deepEqual(external, []);
    mark(`allow main-frame microphone in window ${windows.indexOf(window) + 1}`);
    const microphone = await window.webContents.executeJavaScript(
      `navigator.mediaDevices.getUserMedia({audio:true}).then(s=>{const count=s.getAudioTracks().length;s.getTracks().forEach(t=>t.stop());return count})`,
    );
    assert.equal(microphone, 1, 'Main-frame synthetic microphone capture must remain available');
    mark(`allow main-frame navigation in window ${windows.indexOf(window) + 1}`);
    await window.webContents.executeJavaScript(`void setTimeout(()=>location.href='${origin}/?trusted=1',0)`);
    await sleep(200);
    assert.equal(window.webContents.getURL(), `${origin}/?trusted=1`);
  }
  mark('verify all receivers and escape counters');
  assert.deepEqual(requests, [], 'No HTTP or WebSocket traffic may reach the local receiver');
  assert.deepEqual(browserResponses, [], 'The browser must not receive a response for any Mod network probe');
  assert.deepEqual(
    dns.filter((name) => name.includes('guarded-')),
    [],
    'No Mod DNS lookups may reach the local receiver',
  );
  assert.deepEqual(stun, [], 'No Mod STUN datagrams may reach the receiver');
  assert.deepEqual(tcp, [], 'No Mod TURN TCP connections may reach the receiver');
  assert.deepEqual(downloads, []);
  assert.deepEqual(popups, []);
  assert.deepEqual(external, []);
  // A real input event, not element.click(), reaches the preload's main-frame-only external-link route.
  mark('allow trusted external link through preload');
  const contents = desktop.window.webContents;
  const point = await contents.executeJavaScript(
    `(()=>{const r=document.getElementById('external').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`,
  );
  contents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
  contents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
  await sleep(200);
  assert.deepEqual(external, ['https://example.invalid/trusted']);
  mark('allow trusted external navigation');
  await contents.executeJavaScript(`void setTimeout(()=>location.href='https://example.invalid/navigation',0)`);
  await sleep(200);
  assert.deepEqual(external, ['https://example.invalid/trusted', 'https://example.invalid/navigation']);
  console.log(
    JSON.stringify({
      receiverRequests: requests,
      dns,
      stun,
      tcp,
      browserRequests,
      browserResponses,
      downloads,
      popups,
    }),
  );
  mark('dispose windows and receivers');
  desktop.dispose();
  for (const window of windows) if (!window.isDestroyed()) window.destroy();
  server.close();
  doh.close();
  turn.close();
  udp.close();
  finished = true;
  clearTimeout(watchdog);
  log('MOD_FRAME_GUARD_ACCEPTED');
  app.exit(0);
}
void main().catch((error) => fatal('main rejected', error));
