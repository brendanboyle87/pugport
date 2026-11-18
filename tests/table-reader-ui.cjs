// Run with node; its hidden Electron child uses no application backend, accounts or computer-use tools.
const electron = require('electron');
const { electronArgs } = require('./helpers/electron-app.cjs');
const { app, BrowserWindow } = electron;
const { buildSync } = require('esbuild');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const inElectron = !!process.versions.electron;
const temporary = inElectron
  ? process.env.PUGPORT_TABLE_UI_DIR
  : fs.mkdtempSync(path.join(os.tmpdir(), 'pugport-table-ui-'));
if (!temporary) throw new Error('Run this fixture with node, which owns its temporary profile.');
const fullTemporary = path.resolve(temporary);
assert.ok(
  fullTemporary.startsWith(path.resolve(os.tmpdir()) + path.sep) &&
    path.basename(fullTemporary).startsWith('pugport-table-ui-'),
);
if (inElectron) app.setPath('userData', path.join(temporary, 'profile'));
if (!inElectron) {
  const rows = Array.from({ length: 35 }, (_, index) =>
    index === 0
      ? `| [${'wide-filename-'.repeat(18)}](<C:/fixture/root/base.tsv>) | first |`
      : `| [file${index + 1}.ts](<docs/file${index + 1}.ts>) | ${index === 34 ? '<script>window.injected=true</script>' : index} |`,
  );
  const table = '| 文件 | 内容 |\n|---|---|\n' + rows.join('\n');
  buildSync({
    stdin: {
      contents: `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {renderMarkdown} from './src/ui/markdown';
      import {ReplyPaths} from './src/ui/ReplyPaths';
      import {ParticipantBody, ParticipantHeading, ConversationExchange} from './src/ui/ParticipantReply';
      import {ReasoningStream} from './src/ui/ReasoningStream';
      import '@fontsource-variable/inter';
      import '@fontsource-variable/noto-sans-sc';
      import './src/ui/studio.css';
      import './src/ui/SideChatPanel.css';
      window.fixtureRequests=[]; window.fixtureErrors=[]; window.outsideClicks=0;
      const api=async (endpoint,body)=>{
        window.fixtureRequests.push({endpoint,body});
        return endpoint==='/api/resolve-path'?{path:'C:/fixture/root/'+body.path}:{};
      };
      const text=${JSON.stringify(table)};
      const reply=(id,side)=> <ReplyPaths projectPath="C:/fixture/root" api={api} notify={value=>window.fixtureErrors.push(value)}>
        <div className={side?'side-chat-message':'conversation-message'}>
          <div id={id} className={side?'side-chat-text markdown':'message-text markdown'} data-path-scope>
            {renderMarkdown(text,{relativePaths:true})}
          </div>
        </div>
      </ReplyPaths>;
      const root=createRoot(document.getElementById('fixture'));
      window.showLongReply=()=>root.render(
        <main style={{maxWidth:880,margin:'0 auto',padding:20}}>
          <h1>方案评审</h1>
          <ReasoningStream text="先核对需求，再检查边界条件。这是合成的思考过程。" open={false}/>
          <ConversationExchange names={['审查助手']} count={1} at="2026-10-15T12:00:00Z" preview="检查完成，已汇总到回答。">
            <ParticipantBody>合成的子任务结果，展开后可阅读。</ParticipantBody>
          </ConversationExchange>
          <article className="conversation-message message-assistant participant-card" style={{'--participant-accent':'var(--participant-rose)'}}>
            <ParticipantHeading name="架构师" kind="角色" at="2026-10-15T12:00:00Z"/>
            <ParticipantBody><div className="message-text markdown" id="long-reply">
              {renderMarkdown(Array.from({length:14},(_,i)=>'第 '+(i+1)+' 项：保留清晰的职责边界，让每个步骤都有可检查的结果。回答直接展示完整内容，阅读时无需反复展开。').join('\\n\\n'))}
              {renderMarkdown('| 检查项 | 结果 |\\n|---|---|\\n'+Array.from({length:20},(_,i)=>'| 项目 '+(i+1)+' | 已检查 |').join('\\n'))}
            </div></ParticipantBody>
          </article>
        </main>
      );
      root.render(
        <main className="split-view" style={{height:'100vh'}}>
          <section className="split-pane">
            <button id="outside" style={{width:120,margin:16}} onClick={()=>window.outsideClicks++}>其他对话控件</button>
            <div className="conversation-scroll">{reply('main-fixture',false)}</div>
          </section>
          <section className="side-chat-panel"><div className="side-chat-messages">{reply('side-fixture',true)}</div></section>
        </main>
      );`,
      resolveDir: root,
      loader: 'tsx',
    },
    bundle: true,
    platform: 'browser',
    format: 'iife',
    outfile: path.join(temporary, 'fixture.js'),
    loader: { '.woff2': 'dataurl', '.woff': 'dataurl' },
  });
  fs.writeFileSync(
    path.join(temporary, 'fixture.html'),
    '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><body><div id="fixture"></div><script src="fixture.js"></script></body></html>',
  );
  try {
    const env = { ...process.env, PUGPORT_TABLE_UI_DIR: temporary };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(electron, electronArgs(__filename), {
      env,
      windowsHide: true,
      timeout: 60_000,
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally {
    fs.rmSync(fullTemporary, { recursive: true, force: true });
  }
} else {
  let window;
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const evaluate = (source) => window.webContents.executeJavaScript(source, true);
  async function wait(source) {
    for (let i = 0; i < 50; i++) {
      if (await evaluate(source)) return;
      await pause(20);
    }
    throw new Error('Fixture condition timed out: ' + source);
  }
  async function action(id, label) {
    await evaluate(`(()=>{
    const button=[...document.querySelectorAll('#${id} > .md-table-block > .md-table-actions button')].find(button=>button.textContent==='${label}');
    if(!button)throw Error('Missing table action');button.click();
  })()`);
  }
  const visibleRows = (id) => `
  [...document.querySelectorAll('#${id} > .md-table-block > .md-table tbody tr')]
    .filter(row=>getComputedStyle(row).display!=='none').length`;

  app.disableHardwareAcceleration();
  app.whenReady().then(async () => {
    const checks = [];
    try {
      window = new BrowserWindow({
        show: false,
        width: 1280,
        height: 800,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          offscreen: true,
          backgroundThrottling: false,
        },
      });
      window.webContents.session.webRequest.onBeforeRequest((details, callback) =>
        callback({ cancel: !details.url.startsWith('file://') }),
      );
      await window.loadFile(path.join(temporary, 'fixture.html'));
      await wait(`document.querySelectorAll('.md-table-actions').length===2`);
      assert.equal(await evaluate(visibleRows('main-fixture')), 35);
      assert.equal(await evaluate(visibleRows('side-fixture')), 35);
      assert.doesNotMatch(await evaluate('document.body.innerText'), /展开全部|收起/);
      checks.push('both reply surfaces show all 35 rows without an expand control');

      for (const id of ['main-fixture', 'side-fixture']) {
        await action(id, '在侧栏阅读');
        await wait(`document.activeElement?.getAttribute('aria-label')==='关闭表格阅读'`);
        assert.equal(await evaluate(`document.querySelector('#${id} .md-table-reader tbody').rows.length`), 35);
        assert.equal(
          await evaluate(`document.querySelector('#${id} .md-table-reader thead').innerText.trim()`),
          '文件\t内容',
        );
        assert.ok(
          await evaluate(
            `(()=>{const reader=document.querySelector('#${id} .md-table-reader'),box=reader.getBoundingClientRect();return reader.closest('.reply-path-scope')!==null&&box.top>=0&&box.bottom<=innerHeight&&box.right<=innerWidth})()`,
          ),
        );
        assert.ok(
          await evaluate(
            `(()=>{const scroller=document.querySelector('#${id} .md-table-reader-content > .md-table');return scroller.scrollWidth>scroller.clientWidth&&scroller.scrollHeight>scroller.clientHeight})()`,
          ),
        );
        await evaluate(`document.querySelector('#${id} .md-table-reader-content > .md-table').scrollTop=500`);
        assert.ok(
          await evaluate(
            `(()=>{const scroller=document.querySelector('#${id} .md-table-reader-content > .md-table');return Math.abs(scroller.querySelector('th').getBoundingClientRect().top-scroller.getBoundingClientRect().top)<2})()`,
          ),
        );
        await evaluate(
          `document.querySelector('#${id} .md-table-reader [data-relative-path="docs/file35.ts"]').click()`,
        );
        await wait(
          `window.fixtureRequests.filter(item=>item.endpoint==='/api/resolve-path').length===${id === 'main-fixture' ? 1 : 3}`,
        );
        await evaluate(
          `(()=>{const reference=document.querySelector('#${id} .md-table-reader [data-relative-path="docs/file34.ts"]');reference.focus();reference.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))})()`,
        );
        await wait(
          `window.fixtureRequests.filter(item=>item.endpoint==='/api/resolve-path').length===${id === 'main-fixture' ? 2 : 4}`,
        );
        assert.ok(
          await evaluate(
            `window.fixtureRequests.filter(item=>item.endpoint==='/api/resolve-path').every(item=>item.body.bases.includes('C:/fixture/root/base.tsv'))`,
          ),
        );
        await evaluate(
          `(()=>{const button=document.querySelector('#outside');button.focus();button.click();button.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))})()`,
        );
        assert.equal(await evaluate(`document.querySelectorAll('.md-table-reader').length`), 1);
        assert.ok(
          await evaluate(
            `(()=>{const button=document.querySelector('#outside'),box=button.getBoundingClientRect();return document.elementFromPoint(box.left+box.width/2,box.top+box.height/2)===button})()`,
          ),
        );
        await evaluate(
          `(()=>{const button=document.querySelector('#${id} .md-table-reader button');button.focus();button.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))})()`,
        );
        await wait(`!document.querySelector('.md-table-reader')`);
        assert.equal(await evaluate(`document.activeElement.textContent`), '在侧栏阅读');
      }
      checks.push('full main/side readers keep hidden-row click and keyboard path resolution with original bases');
      checks.push('sticky column headers, horizontal scrolling, focus restoration and nonmodal Escape');
      await action('main-fixture', '在侧栏阅读');
      await wait(`!!document.querySelector('#main-fixture .md-table-reader')`);
      await action('side-fixture', '在侧栏阅读');
      await wait(
        `!document.querySelector('#main-fixture .md-table-reader')&&!!document.querySelector('#side-fixture .md-table-reader')`,
      );
      assert.equal(await evaluate(`document.querySelectorAll('.md-table-reader').length`), 1);
      await evaluate(`document.querySelector('#side-fixture .md-table-reader button').click()`);
      await wait(`!document.querySelector('.md-table-reader')`);
      assert.equal(await evaluate('document.activeElement.textContent'), '在侧栏阅读');
      checks.push('opening another table replaces the previous reader and explicit close restores focus');
      assert.deepEqual(await evaluate('window.fixtureErrors'), []);
      assert.equal(await evaluate('window.injected'), undefined);
      assert.equal(await evaluate('document.body.style.overflow'), '');
      assert.equal(await evaluate('window.outsideClicks'), 2);
      await evaluate('window.showLongReply()');
      await wait(`!!document.querySelector('#long-reply')`);
      await evaluate('document.fonts.ready');
      const screenshots = path.join(root, 'reports/reply-expand');
      fs.mkdirSync(screenshots, { recursive: true });
      for (const theme of ['light', 'dark']) {
        for (const width of [1280, 380]) {
          window.setContentSize(width, 900);
          await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
          await pause(150);
          const height = await evaluate('document.querySelector("main").scrollHeight');
          window.setContentSize(width, height);
          await pause(150);
          assert.equal(await evaluate('innerWidth'), width);
          assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true);
          assert.equal(await evaluate('document.querySelectorAll("#long-reply > p").length'), 14);
          assert.equal(
            await evaluate(
              `([...document.querySelectorAll('#long-reply tbody tr')].filter(row=>row.getBoundingClientRect().height>0)).length`,
            ),
            20,
          );
          assert.equal(
            await evaluate(
              `document.querySelector('#long-reply tbody tr:last-child').getBoundingClientRect().bottom<=document.querySelector('.participant-card .participant-body').getBoundingClientRect().bottom`,
            ),
            true,
          );
          assert.equal(await evaluate(`document.querySelector('.reasoning-stream').open`), false);
          assert.equal(await evaluate(`document.querySelector('.conversation-exchange').open`), false);
          assert.doesNotMatch(await evaluate('document.body.innerText'), /展开全部|收起/);
          fs.writeFileSync(
            path.join(screenshots, theme + '-' + width + '.png'),
            (await window.webContents.capturePage()).toPNG(),
          );
        }
      }
      checks.push(
        'long reply and 20-row table render in full; thinking and sub-agent stay collapsed in four screenshot layouts',
      );
      console.log(JSON.stringify({ passed: true, checks }));
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    } finally {
      window?.destroy();
      app.exit(process.exitCode ?? 0);
    }
  });
}
