// Isolated web bridge check: a local fake chat page on 127.0.0.1, a temporary Electron profile, offscreen windows.
// No real site, account or network is touched, and no window is shown on the desktop.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { electronArgs } = require('./helpers/electron-app.cjs');
const root = path.resolve(__dirname, '..');

const page = String.raw`<!doctype html><html><head><meta charset="utf-8"><title>Fake Chat</title>
<style>body{font-family:sans-serif;margin:0}#thread{padding:16px 16px 120px}.msg{margin:8px 0;padding:8px;border-radius:8px;white-space:pre-wrap}.user{background:#def}.bot{background:#eee}#composer{position:fixed;bottom:0;left:0;right:0;padding:12px;display:flex;gap:8px;background:#fff}textarea,[contenteditable]{flex:1;min-height:48px;border:1px solid #999;padding:6px}</style></head>
<body><header><nav><a href="#">New chat</a> <span id="history"></span></nav></header><main id="thread"></main><div id="composer"></div>
<script>
const mode = new URLSearchParams(location.search).get('mode') || 'textarea';
window.sent = []; window.busy = 0; window.maxBusy = 0;
const composer = document.getElementById('composer');
const thread = document.getElementById('thread');
if (['sidebar', 'junk', 'markdown'].includes(mode)) {
  thread.style.marginLeft = '240px';
  thread.style.height = '400px'; thread.style.overflowY = 'auto';
  const history = document.createElement('div'); history.id = 'side-history';
  history.style.cssText = 'position:fixed;left:0;top:0;width:220px;height:100vh;overflow:auto';
  history.innerHTML = Array.from({length:20}, (_,i) => '<div class="history-item">Old task '+i+'<div>Already checked records</div></div>').join('');
  document.body.appendChild(history);
  thread.innerHTML = '<div class="old-reply">Old answer with unchanged text</div>';
}
if (mode === 'captcha') document.body.insertAdjacentHTML('afterbegin', '<h1>Verify you are human</h1><iframe src="about:blank#captcha" title="check" width="300" height="80"></iframe>');
if (mode === 'login') composer.innerHTML = '<form><input type="email" placeholder="Email"><input type="password" placeholder="Password"><button>Log in</button></form>';
if (mode === 'none') thread.innerHTML = '<p>Nothing to type into here.</p>';
if (!['login', 'none'].includes(mode)) {
  const editable = mode === 'editable';
  const box = document.createElement(editable ? 'div' : 'textarea');
  if (editable) { box.contentEditable = 'true'; box.setAttribute('role', 'textbox'); box.setAttribute('aria-label', 'Message'); }
  else box.placeholder = 'Ask anything';
  composer.appendChild(box);
  let send = null, stop = null;
  if (!editable) { send = document.createElement('button'); send.setAttribute('aria-label', 'Send message'); send.textContent = '↑'; send.disabled = true; composer.appendChild(send); }
  const read = () => (editable ? box.innerText : box.value);
  box.addEventListener('input', () => { if (send) send.disabled = !read().trim(); });
  const submit = () => {
    const text = read().replace(/\n+$/, '').trim();
    if (!text) return;
    if (editable) box.innerHTML = ''; else box.value = '';
    if (send) send.disabled = true;
    sent.push(text); busy++; maxBusy = Math.max(maxBusy, busy);
    const user = document.createElement('div'); user.className = 'msg user'; user.textContent = text; thread.appendChild(user);
    document.getElementById('history').textContent = 'Chat ' + sent.length;
    const sidebar = document.getElementById('side-history');
    if (sidebar) sidebar.innerHTML = sidebar.innerHTML;
    stop = document.createElement('button'); stop.setAttribute('aria-label', 'Stop generating'); stop.textContent = '■'; composer.appendChild(stop);
    const ownStop = stop;
    setTimeout(() => {
      if (mode === 'junk') {
        const old = thread.querySelector('.old-reply'); old.outerHTML = old.outerHTML;
        ownStop.remove(); busy--; return;
      }
      const bot = document.createElement('div'); bot.className = 'msg bot answer'; thread.appendChild(bot);
      if (mode === 'markdown') {
        bot.innerHTML = '<h2>News</h2><p><strong>Bold</strong> and <em>italic</em><br>Next line <code>x &lt; y</code></p><ul><li>First<ul><li>Nested</li></ul></li><li>Second</li></ul><ol><li>Numbered</li></ol><pre>const x = 1;\nconsole.log(x);</pre><blockquote><p>A quote</p></blockquote><table><tr><th>Name</th><th>Value</th></tr><tr><td>Alpha</td><td>1</td></tr></table><p><a href="https://example.test/news">Safe</a> <a href="javascript:alert(1)">Unsafe</a></p><div class="cards"><div class="card"><div>Title A</div><div>Summary A</div><div>09:00</div></div><div class="card"><div>Title B</div><div>Summary B</div><div>10:00</div></div><div class="card"><div>Title C</div><div>Summary C</div><div>11:00</div></div></div><p>literal *stars* [brackets] #hash</p><img alt="Diagram" width="30" height="30"><button>Copy</button><div role="toolbar">Toolbar junk</div><p hidden>Hidden junk</p>';
        ownStop.remove(); busy--; return;
      }
      const p = document.createElement('p'); bot.appendChild(p);
      const words = ('Echo: ' + text).split(' ');
      let i = 0;
      const tick = () => {
        if (i < words.length) { p.textContent += (i ? ' ' : '') + words[i++]; setTimeout(tick, 120); }
        else if (mode === 'never') setTimeout(tick, 120);
        else { const copy = document.createElement('button'); copy.textContent = 'Copy'; bot.appendChild(copy); ownStop.remove(); busy--; }
      };
      tick();
    }, 300);
  };
  if (send) send.addEventListener('click', submit);
  box.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit(); } });
}
</script></body></html>`;

if (!process.versions.electron) {
  void (async () => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'pugport-web-bridge-smoke-'));
    try {
      await fs.mkdir(path.join(fixture, 'profile'));
      await fs.writeFile(path.join(fixture, 'chat.html'), page);
      await require('esbuild').build({
        entryPoints: [path.join(root, 'src/electron/web-bridge.ts')],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        external: ['electron'],
        outfile: path.join(fixture, 'web-bridge.cjs'),
        plugins: [
          {
            name: 'local-source',
            setup(builder) {
              // Match the unit harness: Node reads sources when the sandboxed bundler cannot walk ancestors.
              builder.onResolve({ filter: /.*/ }, (args) => {
                if (args.kind !== 'entry-point' && !args.path.startsWith('.') && !path.isAbsolute(args.path))
                  return {
                    path:
                      args.path === 'electron' || args.path.startsWith('node:')
                        ? args.path
                        : require.resolve(args.path),
                    external: true,
                  };
                const base = path.resolve(args.importer ? path.dirname(args.importer) : root, args.path);
                const found = [base, base + '.ts', base + '.js'].find((file) =>
                  require('node:fs').statSync(file, { throwIfNoEntry: false })?.isFile(),
                );
                return found ? { path: found, namespace: 'local-source' } : undefined;
              });
              builder.onLoad({ filter: /.*/, namespace: 'local-source' }, async (args) => ({
                contents: await fs.readFile(args.path, 'utf8'),
                loader: 'ts',
              }));
            },
          },
        ],
      });
      const env = { ...process.env, PUGPORT_WEB_BRIDGE_SMOKE: fixture };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = require('node:child_process').spawn(require('electron'), electronArgs(__filename), {
        cwd: root,
        env,
        windowsHide: true,
        stdio: 'inherit',
      });
      const timeout = setTimeout(() => child.kill(), 180_000);
      process.exitCode = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => resolve(code ?? 1));
      }).finally(() => clearTimeout(timeout));
    } finally {
      const temporaryRoot = await fs.realpath(os.tmpdir());
      const resolved = await fs.realpath(fixture);
      assert.equal(path.dirname(resolved).toLowerCase(), temporaryRoot.toLowerCase());
      assert.ok(path.basename(resolved).startsWith('pugport-web-bridge-smoke-'));
      await fs.rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    }
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  const { app, BrowserWindow } = require('electron');
  const http = require('node:http');
  const fixture = process.env.PUGPORT_WEB_BRIDGE_SMOKE;
  assert.ok(fixture && path.basename(fixture).startsWith('pugport-web-bridge-smoke-'));
  app.setPath('userData', path.join(fixture, 'profile'));
  app.disableHardwareAcceleration();
  app.on('window-all-closed', () => {});
  const { WebBridge } = require(path.join(fixture, 'web-bridge.cjs'));
  void app.whenReady().then(async () => {
    const server = http.createServer(async (req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(await fs.readFile(path.join(fixture, 'chat.html')));
    });
    // Chromium refuses these ports (the list in helpers/fetch-port.ts); Windows can assign them to listen(0).
    const blocked = new Set([
      1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
    ]);
    do {
      if (server.listening) await new Promise((resolve) => server.close(resolve));
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    } while (blocked.has(server.address().port));
    const origin = `http://127.0.0.1:${server.address().port}`;
    try {
      const presented = [];
      const copied = [];
      const options = {
        port: 1,
        pollMs: 100,
        present: (window) => presented.push(window.webContents.getURL()),
        clipboard: { writeText: (text) => copied.push(text) },
      };
      const bridge = new WebBridge({ ...options, windowOptions: { webPreferences: { offscreen: true } } });
      const target = (agentId, mode) => ({ agentId, name: `Fake ${agentId}`, url: `${origin}/chat.html?mode=${mode}` });
      const pageOf = (agentId) =>
        BrowserWindow.getAllWindows().find((window) => window.getTitle().startsWith(`Fake ${agentId}`)).webContents;
      const quick = { timeoutMs: 20_000, stableMs: 700 };

      // Detection on an ordinary chat page.
      const detected = await bridge.handle({ action: 'detect', ...target('chat', 'textarea') });
      assert.equal(detected.ok, true, JSON.stringify(detected));
      assert.deepEqual(detected.found, { input: true, send: true, reply: false });
      assert.match(detected.selectors.input, /textarea/);

      // Send, wait until the streamed reply stops, read it back.
      const first = await bridge.handle({
        action: 'send',
        ...target('chat', 'textarea'),
        text: 'Hello PugPort one',
        ...quick,
      });
      assert.equal(first.ok, true, JSON.stringify(first));
      assert.equal(first.reply, 'Echo: Hello PugPort one');
      assert.equal(first.partial, undefined);
      assert.ok(first.selectors.reply, 'the reply box is remembered for the site');
      // The remembered selectors are used next time.
      const second = await bridge.handle({
        action: 'send',
        ...target('chat', 'textarea'),
        selectors: first.selectors,
        text: 'And a second one',
        ...quick,
      });
      assert.equal(second.reply, 'Echo: And a second one');

      // Unlabelled edge column: re-rendered history and a saved selector must never win.
      const side = await bridge.handle({
        action: 'send',
        ...target('sidebar', 'sidebar'),
        selectors: { reply: '#side-history' },
        text: 'Fresh main answer',
        ...quick,
      });
      assert.equal(side.reply, 'Echo: Fresh main answer');
      assert.notEqual(side.selectors.reply, '#side-history');
      const junkStarted = Date.now();
      const junk = await bridge.handle({
        action: 'send',
        ...target('junk', 'junk'),
        selectors: { reply: '.old-reply' },
        text: 'No answer available',
        timeoutMs: 3000,
        stableMs: 300,
      });
      assert.equal(junk.code, 'timeout');
      assert.equal(junk.reply, undefined);
      assert.ok(Date.now() - junkStarted >= 3000, 'old text mutations cannot end the wait early');
      const rich = await bridge.handle({
        action: 'send',
        ...target('markdown', 'markdown'),
        text: 'Show structured output',
        ...quick,
      });
      assert.equal(rich.ok, true, JSON.stringify(rich));
      assert.match(rich.reply, /## News/);
      assert.match(rich.reply, /\*\*Bold\*\* and \*italic\*/);
      assert.match(rich.reply, /- First\n  - Nested\n- Second/);
      assert.match(rich.reply, /1\. Numbered/);
      assert.match(rich.reply, /const x = 1;\nconsole.log\(x\);/);
      assert.match(rich.reply, /> A quote/);
      assert.match(rich.reply, /\| Name \| Value \|\n\| --- \| --- \|/);
      assert.match(rich.reply, /\[Safe\]\(https:\/\/example.test\/news\)/);
      assert.match(rich.reply, /Unsafe/);
      assert.match(rich.reply, /- Title A · Summary A · 09:00/);
      assert.match(rich.reply, /\\\*stars\\\*/);
      assert.match(rich.reply, /Diagram/);
      assert.doesNotMatch(rich.reply, /javascript:|Toolbar junk|Hidden junk|Copy|<h2>/);

      // Two at once for the same agent: the second waits for the first reply.
      const [a, b] = await Promise.all([
        bridge.handle({ action: 'send', ...target('chat', 'textarea'), text: 'Queue first', ...quick }),
        bridge.handle({ action: 'send', ...target('chat', 'textarea'), text: 'Queue second', ...quick }),
      ]);
      assert.equal(a.reply, 'Echo: Queue first');
      assert.equal(b.reply, 'Echo: Queue second');
      const chat = pageOf('chat');
      assert.equal(await chat.executeJavaScript('window.maxBusy'), 1, 'never typed while a reply was coming');
      assert.deepEqual(await chat.executeJavaScript('window.sent'), [
        'Hello PugPort one',
        'And a second one',
        'Queue first',
        'Queue second',
      ]);

      // A rich editor without a send button: Enter sends, Shift+Enter keeps lines together.
      const editable = await bridge.handle({
        action: 'send',
        ...target('editable', 'editable'),
        text: 'Line one\nLine two',
        ...quick,
      });
      assert.equal(editable.ok, true, JSON.stringify(editable));
      assert.match(editable.reply, /^Echo: Line one\s+Line two$/);
      assert.equal((await pageOf('editable').executeJavaScript('window.sent')).length, 1);

      // A captcha or a sign-in wall stops and brings the window forward; nothing is typed.
      presented.length = 0;
      const captcha = await bridge.handle({ action: 'send', ...target('captcha', 'captcha'), text: 'hi', ...quick });
      assert.equal(captcha.code, 'human-check');
      assert.match(captcha.message, /人机验证/);
      assert.equal(presented.length, 1);
      assert.deepEqual(await pageOf('captcha').executeJavaScript('window.sent'), []);
      const login = await bridge.handle({ action: 'send', ...target('login', 'login'), text: 'hi', ...quick });
      assert.equal(login.code, 'login');
      assert.equal(presented.length, 2);

      // Nothing to type into: said plainly; the hand-off copies the text and brings the window forward.
      const none = await bridge.handle({ action: 'detect', ...target('none', 'none') });
      assert.equal(none.code, 'not-detected');
      assert.match(none.message, /交给它/);
      const handoff = await bridge.handle({ action: 'handoff', ...target('none', 'none'), text: 'Paste me' });
      assert.equal(handoff.ok, true);
      assert.deepEqual(copied, ['Paste me']);
      assert.equal(presented.length, 3);

      // A reply that never finishes: what arrived so far, marked as possibly incomplete.
      const slow = await bridge.handle({
        action: 'send',
        ...target('never', 'never'),
        text: 'Still going',
        timeoutMs: 4000,
        stableMs: 700,
      });
      assert.equal(slow.ok, true, JSON.stringify(slow));
      assert.equal(slow.partial, true);
      assert.equal(slow.reply, 'Echo: Still going');
      assert.equal(slow.message, '它还在回复，已超过等待时间；请在它的窗口里查看');

      // Only http(s) pages, and only well-formed requests.
      assert.equal((await bridge.handle({ action: 'open', agentId: 'x', name: 'X', url: 'file:///C:/' })).ok, false);
      assert.equal((await bridge.handle({ action: 'send', ...target('chat', 'textarea'), text: '' })).ok, false);
      assert.equal((await bridge.handle({ action: 'delete', ...target('chat', 'textarea') })).ok, false);

      // The real desktop setting: an ordinary hidden window (never shown here), not an offscreen one.
      const hidden = new WebBridge(options);
      const plain = await hidden.handle({
        action: 'send',
        ...target('hidden', 'textarea'),
        text: 'From a hidden window',
        ...quick,
      });
      assert.equal(plain.ok, true, JSON.stringify(plain));
      assert.equal(plain.reply, 'Echo: From a hidden window');
      assert.equal(
        BrowserWindow.getAllWindows().some((window) => window.isVisible()),
        false,
        'no window was shown',
      );

      bridge.dispose();
      hidden.dispose();
      console.log(
        'PASS web bridge: detection, send + stable reply, remembered selectors, one at a time per agent, rich editor, captcha and sign-in stop, hand-off, partial reply on timeout, request checks, hidden window',
      );
      server.close();
      app.exit(0);
    } catch (error) {
      console.error(error);
      server.close();
      app.exit(1);
    }
  });
}
