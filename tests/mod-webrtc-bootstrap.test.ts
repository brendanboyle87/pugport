import assert from 'node:assert/strict';
import test from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { buildModSrcDoc } from '../src/shared/mod-client-shim.ts';

const names = [
  'RTCPeerConnection',
  'webkitRTCPeerConnection',
  'RTCDataChannel',
  'RTCSessionDescription',
  'RTCIceCandidate',
  'RTCRtpSender',
  'RTCRtpReceiver',
  'RTCRtpTransceiver',
  'RTCDtlsTransport',
  'RTCIceTransport',
  'RTCSctpTransport',
  'MediaStreamTrackProcessor',
  'MediaStreamTrackGenerator',
];

function fixture(present: boolean) {
  const context = createContext({ assert });
  runInContext(
    `
    window = self = globalThis;
    const names = ${JSON.stringify(names)};
    const inherited = Object.create(Object.getPrototypeOf(window));
    const immediate = Object.create(inherited);
    Object.setPrototypeOf(window, immediate);
    if (${present}) {
      for (const scope of [window, immediate, inherited]) {
        for (const name of names) {
          Object.defineProperty(scope, name, {
            get() { throw new Error('Native entry point must be deleted without invoking its getter'); },
            configurable: true
          });
        }
      }
    }
    function checkLocked() {
      assert.equal(window, self);
      assert.equal(window, globalThis);
      for (const name of names) {
        for (const alias of [window, self, globalThis]) {
          assert.equal(alias[name], undefined, name);
          const descriptor = Object.getOwnPropertyDescriptor(alias, name);
          assert.equal(descriptor.value, undefined, name);
          assert.equal(descriptor.writable, false, name);
          assert.equal(descriptor.configurable, false, name);
          assert.equal(Reflect.deleteProperty(alias, name), false, name);
          assert.equal(Reflect.set(alias, name, function restored() {}), false, name);
          assert.throws(() => Object.defineProperty(alias, name, {value:function restored() {}}), /redefine/);
        }
        for (let scope = Object.getPrototypeOf(window); scope; scope = Object.getPrototypeOf(scope)) {
          assert.equal(scope[name], undefined, name);
          const descriptor = Object.getOwnPropertyDescriptor(scope, name);
          if (descriptor) {
            assert.equal(descriptor.value, undefined, name);
            assert.equal(descriptor.writable, false, name);
            assert.equal(descriptor.configurable, false, name);
            assert.equal(Reflect.deleteProperty(scope, name), false, name);
            assert.equal(Reflect.set(scope, name, function restored() {}), false, name);
          }
        }
      }
      assert.equal(typeof RTCPeerConnection, 'undefined');
      assert.throws(() => new RTCPeerConnection(), /not a constructor/);
    }
    let authorRan = false, htmlAttached = false;
    function addEventListener() {}
    const document = {
      createElement(tag) {
        return tag === 'template'
          ? {content: {querySelectorAll: () => []}, set innerHTML(value) { checkLocked(); }}
          : {};
      },
      getElementById: () => ({replaceChildren() { checkLocked(); htmlAttached = true; }}),
      head: {append() {}},
      body: {append(script) { executeAuthor(script.textContent); }}
    };
    `,
    context,
  );
  context.executeAuthor = (source: string) => runInContext(source, context);
  const srcdoc = buildModSrcDoc(
    {
      html: '<p>Mod content</p>',
      js: 'checkLocked(); assert.equal(htmlAttached, true); assert.equal(typeof pugport.state.get, "function"); authorRan = true;',
    },
    'a'.repeat(48),
  );
  const bootstrap = srcdoc.match(/<script nonce="[a-f0-9]+">([\s\S]*)<\/script>/)![1]!;
  return { context, srcdoc, bootstrap };
}

for (const present of [true, false]) {
  test(`bootstrap locks WebRTC before author HTML/JS, with native entries ${present ? 'present' : 'absent'}`, () => {
    const { context, bootstrap } = fixture(present);
    runInContext(bootstrap, context);
    assert.equal(runInContext('authorRan', context), true);
  });
}

test('bootstrap fails closed before author code if a native entry cannot be removed', () => {
  const { context, bootstrap } = fixture(true);
  runInContext(
    "Object.defineProperty(Object.getPrototypeOf(window), 'RTCPeerConnection', {configurable:false})",
    context,
  );
  assert.throws(() => runInContext(bootstrap, context), /Cannot delete property/);
  assert.equal(runInContext('authorRan || htmlAttached', context), false);
});

test('srcdoc explicitly denies worker and child frame loads before the bootstrap', () => {
  const { srcdoc } = fixture(false);
  const csp = srcdoc.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/)![1]!;
  for (const directive of ['worker-src', 'frame-src', 'object-src', 'connect-src']) {
    assert.ok(csp.split('; ').includes(`${directive} 'none'`), directive);
  }
  assert.ok(srcdoc.indexOf('Content-Security-Policy') < srcdoc.indexOf('<script'));
});
