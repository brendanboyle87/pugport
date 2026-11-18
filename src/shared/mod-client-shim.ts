import type { ModManifestV2 } from './mods-manifest';

/** This source runs only inside the opaque-origin frame, before any author code. */
export const MOD_CLIENT_SHIM = String.raw`
(() => {
  'use strict';
  // CSP and the desktop UDP policy do not block TURN over TCP. Mods need no WebRTC.
  const noWebRTC = [
    'RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel',
    'RTCSessionDescription', 'RTCIceCandidate', 'RTCRtpSender', 'RTCRtpReceiver',
    'RTCRtpTransceiver', 'RTCDtlsTransport', 'RTCIceTransport', 'RTCSctpTransport',
    'MediaStreamTrackProcessor', 'MediaStreamTrackGenerator'
  ];
  // window, self and globalThis alias this realm; remove inherited originals too.
  for (let scope = window; scope; scope = Object.getPrototypeOf(scope)) {
    for (const name of noWebRTC) {
      if (scope === window || Object.prototype.hasOwnProperty.call(scope, name)) {
        delete scope[name];
        Object.defineProperty(scope, name, {value:undefined, writable:false, configurable:false});
      }
    }
  }
  let port, connected = false, detached = false, nextId = 0;
  const pending = new Map(), listeners = new Map();
  const events = new Set(['ready','state','messages','run','theme','visibility','chat','detached','model','voice','connections']);
  // Choosing a file waits for the user; reading a PDF runs a local extractor.
  const timeouts = {'files.pick': 600000, 'files.pdfText': 180000, 'connections.authorize': 60000, 'connections.reconnect': 60000};
  const unavailable = () => Object.assign(new Error('Mod is unavailable.'), {code:'E_UNAVAILABLE'});
  let resolveReady;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const stop = () => {
    detached = true;
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(unavailable()); }
    pending.clear();
    if (port) { port.onmessage = null; port.close(); }
    resolveReady();
  };
  const call = async (method, params = {}) => {
    if (detached) throw unavailable();
    await ready;
    if (detached || !port) throw unavailable();
    if (pending.size >= 16) throw Object.assign(new Error('Mod request limit reached.'), {code:'E_LIMIT'});
    const id = String(++nextId);
    return new Promise((resolve,reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(unavailable()); }, timeouts[method] || 30000);
      pending.set(id, {resolve,reject,timer});
      try { port.postMessage({type:'request',id,method,params}); }
      catch { clearTimeout(timer); pending.delete(id); reject(unavailable()); }
    });
  };
  // Errors and console lines for the Mod's author: one line each, at most 200 characters and 60 lines per 10 s.
  const diagQueue = [];
  let diagWindow = 0, diagCount = 0, diagDropped = 0;
  const diagText = value => {
    if (value instanceof Error) return (value.name || 'Error') + ': ' + value.message;
    if (typeof value === 'string') return value;
    try { const json = JSON.stringify(value); return json === undefined ? String(value) : json; }
    catch { return String(value); }
  };
  const diag = (level, values) => {
    if (detached) return;
    const now = Date.now();
    if (now - diagWindow >= 10000) { diagWindow = now; diagCount = 0; }
    if (diagCount >= 60) { diagDropped++; return; }
    diagCount++;
    let text;
    try { text = values.map(diagText).join(' '); } catch { text = '[unprintable]'; }
    const item = {pugport:2, type:'diag', level, text: String(text).split(/\r?\n/)[0].slice(0, 200), at: now};
    if (diagDropped) { item.dropped = diagDropped; diagDropped = 0; }
    if (connected && port) { try { port.postMessage(item); } catch { /* The host is gone. */ } }
    else if (diagQueue.length < 60) diagQueue.push(item);
  };
  if (typeof console !== 'undefined') {
    for (const level of ['error', 'warn', 'log']) {
      const original = console[level];
      if (typeof original !== 'function') continue;
      console[level] = function (...values) { diag(level, values); return original.apply(this, values); };
    }
  }
  addEventListener('error', event => {
    // Resource load errors carry no message; script errors do.
    if (!event || typeof event.message !== 'string') return;
    const where = event.lineno ? ' (line ' + event.lineno + (event.colno ? ':' + event.colno : '') + ')' : '';
    diag('error', [(event.error instanceof Error ? diagText(event.error) : event.message) + where]);
  });
  addEventListener('unhandledrejection', event => diag('error', ['Unhandled rejection: ' + diagText(event && event.reason)]));
  const accept = event => {
    if (!event.isTrusted || event.source !== parent || connected || detached || event.data?.pugport !== 2 ||
        event.data?.type !== 'connect' || event.ports.length !== 1) return;
    connected = true;
    removeEventListener('message', accept);
    port = event.ports[0];
    port.onmessage = ({data}) => {
      if (!data || typeof data !== 'object' || detached) return;
      if (data.type === 'response' && typeof data.id === 'string') {
        const item = pending.get(data.id);
        if (!item) return;
        pending.delete(data.id); clearTimeout(item.timer);
        if (data.error) item.reject(Object.assign(new Error(data.error.message), {code:data.error.code}));
        else item.resolve(data.result);
      } else if (data.type === 'event' && events.has(data.event)) {
        if (data.event === 'ready') resolveReady();
        if (data.event === 'detached') stop();
        for (const listener of listeners.get(data.event) || []) {
          try { listener(data.data); } catch { /* An author listener cannot break the transport. */ }
        }
      }
    };
    port.onmessageerror = stop;
    port.start();
    port.postMessage({type:'request',id:'handshake',method:'host.info',params:{}});
    // Errors thrown while the page loaded, before the host connected.
    for (const item of diagQueue.splice(0)) port.postMessage(item);
  };
  addEventListener('message', accept);
  addEventListener('pagehide', stop, {once:true});
  addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'j') {
      event.preventDefault();
      if (connected && !detached) port.postMessage({type:'shortcut', name:'chat'});
    }
  });
  const on = (event, listener) => {
    if (!events.has(event) || typeof listener !== 'function') throw new TypeError('Invalid Mod event.');
    if (!listeners.has(event)) listeners.set(event,new Set());
    listeners.get(event).add(listener);
    return () => listeners.get(event)?.delete(listener);
  };
  // One call starts a voice session; the handle carries its own controls and events.
  const voiceKinds = new Set(['state','transcript','usage','error','ended']);
  const voiceHandle = result => {
    const sessionId = result && result.sessionId;
    return Object.freeze({
      sessionId, provider: result && result.provider,
      say: text => call('voice.speak',{sessionId,text}),
      instruct: text => call('voice.instruct',{sessionId,text}),
      interrupt: () => call('voice.interrupt',{sessionId}),
      stop: () => call('voice.stop',{sessionId}),
      on: (kind, listener) => {
        if (!voiceKinds.has(kind) || typeof listener !== 'function') throw new TypeError('Invalid voice event.');
        return on('voice', data => {
          if (data.sessionId !== sessionId) return;
          if (kind === 'ended' ? data.kind === 'state' && data.state === 'stopped' : data.kind === kind) listener(data);
        });
      }
    });
  };
  Object.defineProperty(window, 'pugport', {value: Object.freeze({
    host: Object.freeze({info: () => call('host.info')}),
    state: Object.freeze({get: () => call('state.get'), set: params => call('state.set',params)}),
    messages: Object.freeze({list: params => call('messages.list',params)}),
    composer: Object.freeze({insert: params => call('composer.insert',params)}),
    ui: Object.freeze({chat: params => call('ui.chat',params), setDirty: dirty => call('ui.setDirty',{dirty}), notify: message => call('ui.notify',{message})}),
    model: Object.freeze({run: params => call('model.run',params), cancel: params => call('model.cancel',params)}),
    voice: Object.freeze({
      status: () => call('voice.status'), start: params => call('voice.start',params).then(voiceHandle),
      speak: params => call('voice.speak',params), interrupt: params => call('voice.interrupt',params),
      instruct: params => call('voice.instruct',params),
      stop: params => call('voice.stop',params)
    }),
    storage: Object.freeze({
      get: params => call('storage.get',params), put: params => call('storage.put',params),
      delete: params => call('storage.delete',params), list: params => call('storage.list',params),
      usage: () => call('storage.usage')
    }),
    connections: Object.freeze({
      list: () => call('connections.list'), status: params => call('connections.status',params),
      authorize: params => call('connections.authorize',params), reconnect: params => call('connections.reconnect',params),
      sync: params => call('connections.sync',params), accounts: params => call('connections.accounts',params),
      transactions: params => call('connections.transactions',params),
      liabilities: params => call('connections.liabilities',params)
    }),
    files: Object.freeze({
      pick: params => call('files.pick',params), readText: params => call('files.readText',params),
      pdfText: params => call('files.pdfText',params)
    }),
    on
  }), writable:false, configurable:false});
})();
`;

const encoded = (value: string) =>
  JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );

export function createModNonce(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(24)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Author strings never enter the outer HTML parser or a raw-text closing-tag context. */
export function buildModSrcDoc(entry: NonNullable<ModManifestV2['ui']>['entries'][string], nonce: string): string {
  if (!/^[a-f0-9]{48}$/.test(nonce)) throw new Error('Invalid Mod nonce');
  const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'`;
  return `<!doctype html><html><head><meta http-equiv="x-dns-prefetch-control" content="off"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"></head><body><div id="mod-root"></div><script nonce="${nonce}">${MOD_CLIENT_SHIM}
(() => {
  // Template contents stay inert until hints are removed; a live-DOM observer is too late.
  const template = document.createElement('template');
  template.innerHTML = ${encoded(entry.html)};
  const clean = root => {
    for (const meta of root.querySelectorAll('meta[http-equiv]')) {
      if (meta.getAttribute('http-equiv').toLowerCase() === 'x-dns-prefetch-control') meta.remove();
    }
    for (const link of root.querySelectorAll('link[rel]')) {
      const rel = link.getAttribute('rel').split(/[\\t\\n\\f\\r ]+/).filter(value =>
        !/^(dns-prefetch|preconnect|prefetch|prerender|preload|modulepreload)$/i.test(value));
      link.setAttribute('rel', rel.join(' '));
    }
    for (const child of root.querySelectorAll('template')) {
      if (child.content) clean(child.content);
    }
  };
  clean(template.content);
  document.getElementById('mod-root').replaceChildren(template.content);
  const style = document.createElement('style');
  style.nonce = ${encoded(nonce)};
  style.textContent = ${encoded(entry.css ?? '')};
  document.head.append(style);
  const script = document.createElement('script');
  script.nonce = ${encoded(nonce)};
  script.type = 'module';
  script.textContent = ${encoded(entry.js ?? '')};
  document.body.append(script);
})();</script></body></html>`;
}
