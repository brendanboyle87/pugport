// Hidden, synthetic Electron renderer; no app server, user profile, account or network access.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildSync } = require('esbuild');
const electron = require('electron');
const { electronArgs } = require('./helpers/electron-app.cjs');

const root = path.resolve(__dirname, '..');
const prefix = 'pugport-tray-resources-ui-';
const inElectron = !!process.versions.electron;
const temporary = inElectron
  ? process.env.PUGPORT_TRAY_RESOURCES_UI_DIR
  : fs.mkdtempSync(path.join(os.tmpdir(), prefix));
assert.ok(temporary, 'Run with Node to create an isolated temporary profile.');
const fullTemporary = path.resolve(temporary);
assert.equal(path.dirname(fullTemporary).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
assert.ok(path.basename(fullTemporary).startsWith(prefix));

if (!inElectron) {
  try {
    buildSync({
      stdin: {
        contents: `export {trayPopupHtml, trayResourcesHtml} from './src/electron/tray-popup';
export * from './src/electron/tray-dom';
export * from './src/electron/tray-position';
export {trayIcon, localTrayIcon} from './src/electron/tray';
export * from './src/electron/window-activity';
export {setMainLocale, translateHtml} from './src/electron/locale';`,
        resolveDir: root,
        loader: 'ts',
      },
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['electron'],
      outfile: path.join(fullTemporary, 'source.cjs'),
    });
    const env = { ...process.env, PUGPORT_TRAY_RESOURCES_UI_DIR: fullTemporary };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(electron, electronArgs(__filename), {
      cwd: root,
      env,
      windowsHide: true,
      timeout: 45_000,
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally {
    // Delete only this invocation's verified random temporary directory.
    const actual = fs.realpathSync(fullTemporary);
    assert.equal(path.dirname(actual).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(actual).startsWith(prefix));
    fs.rmSync(actual, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
} else {
  const { app, BrowserWindow, screen } = electron;
  app.setPath('userData', path.join(fullTemporary, 'profile'));
  app.disableHardwareAcceleration();
  const source = require(path.join(fullTemporary, 'source.cjs'));
  const epoch = Date.parse('2026-10-07T12:00:00Z');
  const quota = {
    running: 2,
    totals: [
      { provider: 'codex', accounts: 2, known: 2, total: 1.21 },
      { provider: 'claude', accounts: 1, known: 1, total: 0.25 },
      { provider: 'grok', accounts: 2, known: 2, total: 1.66 },
      { provider: 'cursor', accounts: 1, known: 1, total: 1 },
    ],
    lines: [
      { id: 'codex', label: 'Codex · 本机', provider: 'codex', windows: [{ name: '周', remaining: 42 }], tightest: 42 },
      {
        id: 'claude',
        label: 'Claude · 本机',
        provider: 'claude',
        windows: [
          { name: '5h', remaining: 56 },
          { name: '周', remaining: 25 },
          { name: 'Fable 周', remaining: 84 },
        ],
        tightest: 25,
      },
      { id: 'grok', label: 'Grok · 本机', provider: 'grok', windows: [{ name: '周', remaining: 100 }], tightest: 100 },
      { id: 'grok-b', label: 'Grok B', provider: 'grok', windows: [{ name: '周', remaining: 66 }], tightest: 66 },
      {
        id: 'codex-b',
        label: 'Codex B',
        provider: 'codex',
        windows: [
          { name: '5h', remaining: 77 },
          { name: '周', remaining: 82 },
        ],
        tightest: 77,
      },
      {
        id: 'cursor',
        label: 'Cursor · 本机',
        provider: 'cursor',
        windows: [
          { name: 'Cursor Models', remaining: 100 },
          { name: 'Other Models', remaining: 100 },
        ],
        tightest: 100,
      },
    ].map((line) => ({ ...line, observedAt: new Date(epoch).toISOString() })),
  };
  const resources = {
    cpuPercent: 18.4,
    gpuPercent: 42.1,
    gpuState: 'available',
    memory: { totalBytes: 32 * 1024 ** 3, usedBytes: 17.2 * 1024 ** 3, percent: 53.75 },
  };
  let window;
  const network = [];
  const evaluate = (code) => window.webContents.executeJavaScript(code);
  // Hidden native windows may throttle requestAnimationFrame even with background throttling disabled.
  const frame = async () => {
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const metrics = await evaluate('({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})');
      const [width, height] = window.getContentSize();
      const expectedDpr = screen.getDisplayMatching(window.getBounds()).scaleFactor;
      if (
        Math.abs(metrics.width - width) <= 1 &&
        Math.abs(metrics.height - height) <= 1 &&
        Math.abs(metrics.dpr - expectedDpr) < 0.01
      )
        return metrics;
    }
    throw new Error('Hidden renderer did not settle its native size and DPI.');
  };
  const checks = [];
  void app.whenReady().then(async () => {
    try {
      window = new BrowserWindow({
        show: false,
        frame: false,
        skipTaskbar: true,
        width: 340,
        height: 600,
        webPreferences: {
          sandbox: true,
          nodeIntegration: false,
          contextIsolation: true,
          backgroundThrottling: false,
        },
      });
      window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
        const allowed = details.url.startsWith('file://') || details.url.startsWith('data:');
        if (!allowed) network.push(details.url);
        callback({ cancel: !allowed });
      });
      source.setMainLocale('zh-CN', false);
      await window.loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(source.trayPopupHtml(quota, epoch, resources))}`,
      );
      await frame();
      assert.equal(await evaluate("document.querySelectorAll('.resource').length"), 3);
      assert.equal(
        await evaluate("getComputedStyle(document.querySelector('.resource-heading')).getPropertyValue('app-region')"),
        'drag',
      );
      assert.equal(
        await evaluate("getComputedStyle(document.querySelector('#tray-actions a')).getPropertyValue('app-region')"),
        'no-drag',
      );
      assert.ok(await evaluate("document.querySelector('.drag-grip').getBoundingClientRect().width>0"));
      assert.deepEqual(
        await evaluate("[...document.querySelectorAll('.resource-label b')].map(node=>node.textContent)"),
        ['18%', '42%', '54%'],
      );
      assert.match(
        await evaluate("document.querySelector('[data-resource=memory] small').textContent"),
        /17\.2 \/ 32\.0 GiB/,
      );
      const measure = await evaluate(`(()=>{
        const card=document.querySelector('.card').getBoundingClientRect();
        return {width:innerWidth,height:innerHeight,cardBottom:card.bottom,
          overflowing:[...document.querySelectorAll('.resource,.line,.windows,footer')].filter(node=>node.scrollWidth>node.clientWidth+1).map(node=>({className:node.className,scroll:node.scrollWidth,width:node.clientWidth,text:node.textContent}))};
      })()`);
      assert.equal(measure.width, 340);
      assert.ok(measure.cardBottom <= 600, `Six-account card fits 600px: ${JSON.stringify(measure)}`);
      assert.deepEqual(measure.overflowing, [], 'Resource values and six-account quota rows fit the 340px tray card');
      const names = await evaluate(`(()=>{
        return [...document.querySelectorAll('.name')].map(node=>{const range=document.createRange();range.selectNodeContents(node);return {label:node.textContent,width:node.clientWidth,textWidth:range.getBoundingClientRect().width};});
      })()`);
      assert.ok(
        names.every((name) => name.width + 1 >= name.textWidth),
        `All six short account names remain readable: ${JSON.stringify(names)}`,
      );
      checks.push('340px popup fits three resource cells, physical memory detail and six quota accounts');
      checks.push('the resource title has a visible native drag handle; footer actions are not draggable');

      // Use the current machine's native display/DPI configuration without showing or touching the real app.
      const displays = screen.getAllDisplays();
      const screenChecks = [];
      for (const display of displays) {
        const icon = {
          x: display.workArea.x + display.workArea.width - 120,
          y: display.workArea.y + display.workArea.height + 4,
          width: 24,
          height: 24,
        };
        let natural = await evaluate(source.trayPopupMeasurementScript);
        for (let attempt = 0; attempt < 5; attempt++) {
          window.setBounds(source.trayPopupBounds(icon, display, { width: 340, height: Math.ceil(natural) }));
          await new Promise((resolve) => setTimeout(resolve, 150));
          await frame();
          natural = await evaluate(source.trayPopupMeasurementScript);
          if (Math.abs(window.getBounds().height - natural) < 1) break;
        }
        const native = window.getBounds();
        const card = await evaluate(
          "(()=>{const c=document.querySelector('.card').getBoundingClientRect();return {height:innerHeight,bottom:c.bottom,dpr:devicePixelRatio};})()",
        );
        assert.ok(
          Math.abs(card.dpr - display.scaleFactor) < 0.01,
          `The hidden renderer actually follows ${display.scaleFactor}x monitor DPI`,
        );
        assert.ok(
          Math.abs(native.y + native.height - (display.workArea.y + display.workArea.height)) <= 1,
          `Native popup meets the ${display.scaleFactor}x work area: ${JSON.stringify(native)}`,
        );
        assert.ok(
          Math.abs(card.height - native.height) <= 1,
          `CSS and native DIP heights agree on ${display.scaleFactor}x screen: ${JSON.stringify({ native, card })}`,
        );
        assert.ok(
          Math.abs(card.height - card.bottom - 6) <= 2,
          `No invisible ${display.scaleFactor}x bottom strip: ${JSON.stringify(card)}`,
        );
        screenChecks.push({ scaleFactor: display.scaleFactor, native, card });
        if (display.scaleFactor !== 1)
          fs.writeFileSync(
            path.join(root, 'reports', 'tray-position-smoke.png'),
            (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG(),
          );
      }
      checks.push(
        'all native monitors, including 150% DPI and negative origins, have only the six-DIP card margin above the taskbar',
      );

      const green = source.trayIcon(path.join(root, 'assets', 'icons'), true);
      const blue = source.localTrayIcon(green);
      assert.ok(green && blue && !blue.isEmpty());
      assert.deepEqual(blue.getSize(), green.getSize());
      for (const scaleFactor of green.getScaleFactors()) {
        const before = green.toBitmap({ scaleFactor }),
          after = blue.toBitmap({ scaleFactor });
        assert.equal(after.length, before.length);
        let changed = 0;
        for (let pixel = 0; pixel < before.length; pixel += 4) {
          assert.equal(
            before[pixel + 3],
            after[pixel + 3],
            'Recoloring preserves alpha and therefore the glyph silhouette',
          );
          if (
            before[pixel] !== after[pixel] ||
            before[pixel + 1] !== after[pixel + 1] ||
            before[pixel + 2] !== after[pixel + 2]
          ) {
            changed++;
            assert.ok(
              before[pixel + 1] > before[pixel + 2] * 1.3 && before[pixel + 1] > before[pixel] * 1.05,
              'Only existing green activity pixels change',
            );
            assert.ok(
              after[pixel] > after[pixel + 1] && after[pixel + 1] > after[pixel + 2],
              'Local activity becomes blue',
            );
          }
        }
        assert.ok(changed > 0, `Activity dot recolored at ${scaleFactor}x`);
      }
      checks.push('local native blue dot preserves the bone, alpha and all installed DPI representations');
      let activityOverlay;
      const shellActivity = source.createWindowActivity({
        window,
        image: (bitmap) => {
          activityOverlay = electron.nativeImage.createFromBitmap(bitmap, { width: 16, height: 16 });
          return activityOverlay;
        },
        translate: (text) => text,
        canSetTitle: () => true,
        reducedMotion: () => true,
        windows: process.platform === 'win32',
      });
      shellActivity.update({ running: 0, localRunning: 1, localTitle: '本地媒体比对' });
      assert.equal(window.getTitle(), 'PugPort · 本地媒体比对');
      if (process.platform === 'win32') {
        assert.deepEqual(activityOverlay.getScaleFactors(), [1, 1.5, 2]);
        for (const scaleFactor of activityOverlay.getScaleFactors()) {
          const pixels = activityOverlay.toBitmap({ scaleFactor });
          const width = 16 * scaleFactor;
          assert.equal(pixels.length, width * width * 4);
          let area = 0;
          for (let y = 0; y < width; y++)
            for (let x = 0; x < width; x++) {
              const alpha = pixels[(y * width + x) * 4 + 3];
              area += alpha / 255;
              if (x < 8 * scaleFactor || y < 8 * scaleFactor)
                assert.equal(alpha, 0, 'Native taskbar overlay leaves the top and left transparent');
            }
          assert.ok(area / (width * width) < 0.12, 'Native overlay remains a small corner badge at every scale');
        }
        checks.push('taskbar badge stays in the lower-right transparent canvas at native 100%, 150% and 200% DPI');
      } else {
        assert.equal(
          activityOverlay,
          undefined,
          'this platform uses title and tray activity without a Windows taskbar overlay',
        );
        checks.push('non-Windows activity leaves the taskbar overlay unused');
      }
      shellActivity.update({ running: 2, localRunning: 1, localTitle: '本地媒体比对' });
      assert.match(window.getTitle(), /Agent.*本地媒体比对/);
      shellActivity.update({ running: 0, localRunning: 0 });
      assert.equal(window.getTitle(), 'PugPort');
      shellActivity.dispose();
      shellActivity.update({ running: 2 });
      assert.equal(window.getTitle(), 'PugPort');
      checks.push(
        'native activity APIs accept local/Agent/idle changes on the hidden test window and disposal ignores later activity',
      );
      window.setContentSize(340, 600);
      await frame();
      const screenshot = path.join(root, 'reports', 'tray-resources-smoke.png');
      fs.mkdirSync(path.dirname(screenshot), { recursive: true });
      fs.writeFileSync(
        screenshot,
        (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG(),
      );

      // Keep the live nodes as references: updates must not replace resources or quota unnecessarily.
      await evaluate(
        `window.fixtureNodes=new Map([...document.querySelectorAll('[data-resource-part]')].map(node=>[node.dataset.resourcePart,node]));window.fixtureQuota=document.querySelector('#quota-content');window.fixtureQuotaRows=[...document.querySelectorAll('#quota-content .row')];window.fixtureNavigation=0;window.addEventListener('beforeunload',()=>window.fixtureNavigation++);undefined`,
      );
      const nextResources = {
        ...resources,
        cpuPercent: 23.2,
        gpuPercent: 61.4,
        memory: { ...resources.memory, usedBytes: 18.8 * 1024 ** 3, percent: 58.75 },
      };
      const update = source.trayPopupUpdateScript;
      assert.equal(typeof update, 'function', 'Production DOM update helper is exported');
      await evaluate(update(source.translateHtml(source.trayPopupHtml(quota, epoch, nextResources))));
      await frame();
      assert.deepEqual(
        await evaluate("[...document.querySelectorAll('.resource-label b')].map(node=>node.textContent)"),
        ['23%', '61%', '59%'],
      );
      assert.equal(await evaluate("document.querySelector('[data-resource-part=cpu-bar]').style.width"), '23.2%');
      assert.equal(
        await evaluate(
          "[...window.fixtureNodes].every(([key,node])=>[...document.querySelectorAll('[data-resource-part]')].find(item=>item.dataset.resourcePart===key)===node)",
        ),
        true,
      );
      assert.equal(await evaluate("document.querySelector('#quota-content')===window.fixtureQuota"), true);
      assert.equal(
        await evaluate(
          "window.fixtureQuotaRows.every((node,index)=>document.querySelectorAll('#quota-content .row')[index]===node)",
        ),
        true,
      );
      assert.equal(await evaluate('window.fixtureNavigation'), 0);
      checks.push('live values and bars update in place with unchanged resource/quota nodes and zero navigation');
      const localQuota = {
        ...quota,
        localRunning: 1,
        localTitle: '本地媒体比对 · ' + '长任务标题'.repeat(20),
        localPhase: '预筛：正在处理当前批次，' + '长进度说明'.repeat(30),
      };
      await evaluate(update(source.trayPopupHtml(localQuota, epoch, nextResources)));
      await frame();
      assert.equal(await evaluate("document.querySelectorAll('header .live').length"), 2);
      assert.equal(
        await evaluate("getComputedStyle(document.querySelector('.live.local i')).backgroundColor"),
        'rgb(96, 165, 250)',
      );
      assert.equal(
        await evaluate("getComputedStyle(document.querySelector('.live:not(.local) i')).backgroundColor"),
        'rgb(34, 197, 94)',
      );
      assert.equal(
        await evaluate(
          "[...document.querySelectorAll('header,.local-phase')].every(node=>node.scrollWidth<=node.clientWidth+1 || getComputedStyle(node).textOverflow==='ellipsis')",
        ),
        true,
      );
      const localHeight = Math.ceil(await evaluate(source.trayPopupMeasurementScript));
      window.setContentSize(340, localHeight);
      await frame();
      fs.writeFileSync(
        path.join(root, 'reports', 'tray-activity-smoke.png'),
        (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG(),
      );
      await evaluate(update(source.trayPopupHtml(quota, epoch, nextResources)));
      window.setContentSize(340, 600);
      await frame();
      checks.push(
        'mixed green Agent/blue local activity and long progress titles fit the card without horizontal overflow',
      );

      await evaluate(
        update(
          source.translateHtml(
            source.trayPopupHtml(quota, epoch, { ...nextResources, gpuPercent: undefined, gpuState: 'unavailable' }),
          ),
        ),
      );
      await frame();
      assert.equal(await evaluate("document.querySelector('[data-resource-part=gpu-value]').textContent"), '—');
      assert.equal(await evaluate("document.querySelector('[data-resource-part=gpu-bar]').style.opacity"), '0');
      assert.match(await evaluate("document.querySelector('[data-resource-part=gpu-detail]').textContent"), /暂不可用/);
      checks.push('an unavailable GPU is labelled unknown, never reported as a fake 0%');

      const newer = {
        ...quota,
        running: 1,
        lines: quota.lines.map((line) =>
          line.id === 'codex-b'
            ? {
                ...line,
                tightest: 76,
                windows: [
                  { name: '5h', remaining: 76 },
                  { name: '周', remaining: 82 },
                ],
              }
            : line,
        ),
      };
      source.setMainLocale('en', false);
      await evaluate(update(source.translateHtml(source.trayPopupHtml(newer, epoch, nextResources))));
      await frame();
      assert.match(await evaluate("document.querySelector('#quota-content').textContent"), /76%/);
      assert.match(await evaluate("document.querySelector('#tray-actions').textContent"), /Refresh|Open/);
      assert.doesNotMatch(await evaluate("document.querySelector('#tray-actions').textContent"), /[㐀-鿿]/);
      assert.doesNotMatch(await evaluate("document.querySelector('.totals').textContent"), /[㐀-鿿]/);
      assert.equal(
        await evaluate("document.querySelector('[data-resource-part=heading]').textContent"),
        'System resources',
      );
      assert.equal(
        await evaluate("document.querySelector('#system-resources').getAttribute('aria-label')"),
        'System resources',
      );
      assert.equal(await evaluate("document.querySelector('#tray-actions a').getAttribute('href')"), 'combo://refresh');
      assert.equal(await evaluate('window.fixtureNavigation'), 0);
      assert.equal(
        await evaluate(
          "[...window.fixtureNodes].every(([key,node])=>[...document.querySelectorAll('[data-resource-part]')].find(item=>item.dataset.resourcePart===key)===node)",
        ),
        true,
      );
      const englishMeasure = await evaluate(`(()=>{
        const card=document.querySelector('.card').getBoundingClientRect();
        return {cardBottom:card.bottom,overflowing:[...document.querySelectorAll('.resource,.line,.windows,footer')].filter(node=>node.scrollWidth>node.clientWidth+1).map(node=>({className:node.className,text:node.textContent}))};
      })()`);
      assert.ok(englishMeasure.cardBottom <= 600, 'English quota and resource labels fit the card height');
      assert.deepEqual(englishMeasure.overflowing, [], 'English labels do not cause horizontal overflow');
      fs.writeFileSync(
        path.join(root, 'reports', 'tray-resources-smoke-en.png'),
        (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG(),
      );
      checks.push('quota and footer language updates preserve resource nodes and action targets');

      window.setContentSize(340, 280);
      await frame();
      const compact = await evaluate(`(()=>{
        const resource=document.querySelector('#system-resources').getBoundingClientRect();
        const footer=document.querySelector('#tray-actions').getBoundingClientRect();
        const quota=document.querySelector('#quota-content');
        return {height:innerHeight,resourceTop:resource.top,resourceBottom:resource.bottom,
          footerTop:footer.top,footerBottom:footer.bottom,quotaHeight:quota.clientHeight,quotaScroll:quota.scrollHeight,
          viewportOverflow:document.documentElement.scrollHeight>innerHeight,
          quotaOverflow:getComputedStyle(quota).overflowY};
      })()`);
      assert.ok(Math.abs(compact.height - 280) <= 1, 'Short native window height allows device-scale rounding');
      assert.ok(
        compact.resourceTop >= 0 && compact.resourceBottom <= compact.height,
        'Resource monitor remains visible on a short display',
      );
      assert.ok(
        compact.footerTop >= compact.resourceBottom && compact.footerBottom <= compact.height,
        'Tray actions stay reachable on a short display',
      );
      assert.ok(
        compact.quotaHeight > 0 && compact.quotaScroll > compact.quotaHeight,
        'Only quota rows use vertical scrolling',
      );
      assert.equal(compact.quotaOverflow, 'auto');
      assert.equal(compact.viewportOverflow, false);
      const naturalHeight = await evaluate(
        update(source.translateHtml(source.trayPopupHtml(newer, epoch, nextResources))),
      );
      assert.ok(
        naturalHeight > compact.height,
        'Native window sizing receives the full natural content height rather than the clipped card height',
      );
      fs.writeFileSync(
        path.join(root, 'reports', 'tray-resources-smoke-short.png'),
        (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG(),
      );
      checks.push('280px display keeps resources/actions visible while only quota rows scroll');

      await evaluate("document.querySelector('#quota-content').scrollTop=80");
      const oldScroll = await evaluate("document.querySelector('#quota-content').scrollTop");
      assert.ok(oldScroll > 0, 'The user can scroll through the quota accounts');
      const scrolledResources = { ...nextResources, cpuPercent: 31.2 };
      await evaluate(update(source.translateHtml(source.trayPopupHtml(newer, epoch, scrolledResources))));
      assert.equal(await evaluate("document.querySelector('#quota-content').scrollTop"), oldScroll);
      await evaluate(update(source.translateHtml(source.trayPopupHtml(newer, epoch + 120_000, scrolledResources))));
      assert.match(await evaluate("document.querySelector('#quota-content time').textContent"), /2/);
      assert.equal(
        await evaluate("document.querySelector('#quota-content').scrollTop"),
        oldScroll,
        'Updated quota timestamps preserve the reading position',
      );
      await evaluate(
        update(
          source.translateHtml(
            source.trayPopupHtml({ ...newer, lines: [newer.lines[0]], totals: [] }, epoch + 120_000, scrolledResources),
          ),
        ),
      );
      assert.equal(
        await evaluate("document.querySelector('#quota-content').scrollTop"),
        0,
        'A shorter quota list clamps scroll position to the available content',
      );
      await evaluate(update(source.translateHtml(source.trayPopupHtml(newer, epoch + 120_000, scrolledResources))));
      checks.push('live resource/quota updates preserve the quota reading position and shorter lists clamp safely');

      window.webContents.debugger.attach('1.3');
      await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
      });
      await frame();
      assert.equal(
        await evaluate("getComputedStyle(document.querySelector('.resource-bar i')).transitionDuration"),
        '0s',
      );
      window.webContents.debugger.detach();
      await evaluate("document.querySelector('#tray-actions').remove()");
      assert.equal(
        await evaluate(update(source.trayPopupHtml(newer, epoch, { ...nextResources, cpuPercent: 99 }))),
        null,
        'An incomplete renderer requests a full rebuild instead of partially mutating the card',
      );
      assert.equal(await evaluate("document.querySelector('[data-resource-part=cpu-value]').textContent"), '31%');
      checks.push('missing required DOM requests recovery without applying a partial resource update');
      assert.deepEqual(network, []);
      fs.writeFileSync(
        path.join(root, 'reports', 'tray-resources-smoke.json'),
        JSON.stringify({ passed: true, checks, measure, screenChecks }, null, 2),
      );
      console.log(JSON.stringify({ passed: true, checks }));
    } catch (error) {
      console.error(error);
      fs.mkdirSync(path.join(root, 'reports'), { recursive: true });
      fs.writeFileSync(
        path.join(root, 'reports', 'tray-resources-smoke.json'),
        JSON.stringify({ passed: false, checks, error: String(error) }, null, 2),
      );
      process.exitCode = 1;
    } finally {
      window?.destroy();
      app.exit(process.exitCode ?? 0);
    }
  });
}
