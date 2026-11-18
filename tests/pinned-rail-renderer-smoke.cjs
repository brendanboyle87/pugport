// Hidden offscreen renderer with synthetic history, an in-memory pin API and a temporary profile.
// No real account, backend, database, model or agent is launched. Screenshots go to .design/pin-rail/shots/.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { electronArgs } = require('./helpers/electron-app.cjs');
const root = path.resolve(__dirname, '..');
const prefix = 'pugport-pinned-rail-smoke-';
const shots = path.join(root, '.design', 'pin-rail', 'shots');

if (!process.versions.electron) {
  void (async () => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    try {
      await fs.mkdir(path.join(fixture, 'profile'));
      await fs.writeFile(
        path.join(fixture, 'index.html'),
        '<!doctype html><html data-theme="light"><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>',
      );
      // Every stylesheet the interface ships, so the measured layout is the real one.
      const styles = (await fs.readdir(path.join(root, 'src/ui'), { recursive: true }))
        .filter((name) => name.endsWith('.css'))
        .map((name) => `import './src/ui/${name.split(path.sep).join('/')}';`)
        .join('\n');
      await require('esbuild').build({
        stdin: {
          resolveDir: root,
          loader: 'tsx',
          contents: `import React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {ConversationWorkspace} from './src/ui/Workspace';
${styles}
const now=Date.now();
const stamp=index=>new Date(now-(200-index)*60000).toISOString();
const plain=index=>({id:'m'+index,conversationId:'main',role:index%2?'assistant':'user',
 content:index%2?'已核对第 '+index+' 轮材料，结论与上一轮一致，下一步继续整理清单。':'请继续核对第 '+index+' 轮材料。',createdAt:stamp(index)});
const history=Array.from({length:60},(_,index)=>plain(index));
history[11].content='# 东京三日行程\\n\\n第一天去浅草和上野，第二天去镰仓看海，第三天在新宿购物。\\n\\n'+Array.from({length:14},(_,i)=>'- 第 '+(i+1)+' 项安排：上午出发，下午回到酒店，晚上整理照片和票据。').join('\\n')+'\\n\\n## 交通\\n\\n所有交通都用 Suica 卡，机场往返坐成田特快。\\n\\n\`\`\`text\\n预算：每天 15000 日元\\n\`\`\`';
history[24].content='整理季度报价表：把三家供应商的单价、交期和付款条件放进同一张表，并标出最便宜的组合。';
history[24].workflowId='quote';
history[35].content='数据库迁移失败的原因是缺少索引。先重建索引，再重新运行迁移脚本，最后核对行数。';
const summaries={
 m11:{title:'东京三日行程',description:'三天路线、交通卡和每日预算安排',source:'model',at:stamp(12)},
 m24:{title:'季度报价对比',description:'三家供应商单价、交期和付款条件汇总',source:'model',at:stamp(24)},
 m35:undefined,
 m41:{title:'发布检查清单',description:'上线前需要逐项确认的十个步骤',source:'model',at:stamp(42)},
 m43:{title:'会议纪要',description:'周一例会的决定和待办负责人',source:'model',at:stamp(44)},
 m45:{title:'Weekly sales recap',description:'Revenue by region and the top three deals',source:'model',at:stamp(46)},
 m47:{title:'服务器费用估算',description:'三种机型按月计费的对比',source:'model',at:stamp(48)},
 m49:{title:'论文阅读笔记',description:'方法、实验和可复现的要点',source:'model',at:stamp(50)},
};
const pin=(id,index,extra={})=>({messageId:id,pinnedAt:stamp(index),tracking:'follow-up',followUpStatus:'todo',
 ...(summaries[id]?{summary:summaries[id]}:{}),...extra});
const threePins=[pin('m11',100),pin('m24',101,{tracking:'task',followUpStatus:undefined}),pin('m35',102)];
const eightPins=[...threePins,...['m41','m43','m45','m47','m49'].map((id,i)=>pin(id,103+i))];
const workflow={id:'quote',conversationId:'main',projectId:'project',userMessageId:'m24',
 input:{content:history[24].content,mode:'chat',permissionMode:'read-only',executionPolicy:'cli-first'},
 status:'running',phase:'execute',plan:[],runIds:[],memoryRevision:0,memoryExcerpt:'',createdAt:stamp(24),updatedAt:stamp(24)};
const project={id:'project',scope:'chat',name:'Fixture',path:'C:/Fixture',createdAt:stamp(0),updatedAt:stamp(0)};
const conversation=pins=>({id:'main',projectId:'project',title:'旅行与报价整理',createdAt:stamp(0),updatedAt:stamp(59),
 pinnedMessagesRevision:1,pinnedMessages:pins});
window.fixture={history,threePins,eightPins,calls:[],notices:[],inspections:[],state:{
 app:{name:'PugPort',version:'test',platform:'win32',dataDir:'fixture'},
 settings:{toolApprovalMode:'auto',executionPolicy:'cli-only',steerOnSend:false,unknownQuotaPolicy:'manual-only'},
 targets:[],runtimes:[],approvals:[],plugins:[],projects:[project],conversations:[conversation(threePins)],
 conversationMessages:history,runs:[],workflows:[workflow],backgroundTasks:[]}};
const f=window.fixture;f.setPins=pins=>{f.state.conversations=[{...conversation(pins),pinnedMessagesRevision:f.state.conversations[0].pinnedMessagesRevision+1}];};
const reactRoot=createRoot(document.getElementById('root'));
const api=async(url,body,method)=>{
 f.calls.push({url,body,method});
 if(method==='GET'&&url==='/api/conversations/main')
  return {conversation:f.state.conversations[0],messages:f.history,workflows:f.state.workflows};
 const match=/^\\/api\\/conversations\\/main\\/messages\\/([^/]+)\\/pin$/.exec(url);
 if(match&&method==='PATCH'&&body.pinned===false){
  const pins=f.state.conversations[0].pinnedMessages.filter(item=>item.messageId!==decodeURIComponent(match[1]));
  f.setPins(pins);window.renderFixture();return f.state.conversations[0];
 }
 throw new Error('Unexpected fixture API; agents are forbidden: '+method+' '+url);
};
window.renderFixture=()=>flushSync(()=>reactRoot.render(<div className="studio-shell">
 <aside className="studio-sidebar" aria-hidden="true"/><main className="workspace-main" style={{flex:1,minWidth:0}}>
 <ConversationWorkspace state={{...f.state}} api={api} project={project} conversation={f.state.conversations[0]}
 notify={notice=>f.notices.push(notice)} onConversation={()=>{}} onAddProject={()=>{}} onMemory={()=>{}}
 onInspect={id=>f.inspections.push(id)}/></main></div>));
window.renderFixture();`,
        },
        bundle: true,
        platform: 'browser',
        outfile: path.join(fixture, 'fixture.js'),
        loader: { '.png': 'dataurl', '.svg': 'dataurl', '.woff2': 'dataurl' },
        logLevel: 'error',
      });
      const env = { ...process.env, PUGPORT_PINNED_RAIL_SMOKE: fixture };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = require('node:child_process').spawn(require('electron'), electronArgs(__filename), {
        cwd: root,
        env,
        windowsHide: true,
        stdio: 'inherit',
      });
      const timer = setTimeout(() => child.kill(), 90000);
      process.exitCode = await new Promise((done, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => done(code ?? 1));
      }).finally(() => clearTimeout(timer));
    } finally {
      const temporaryRoot = await fs.realpath(os.tmpdir());
      const resolved = await fs.realpath(fixture);
      assert.equal(path.dirname(resolved).toLowerCase(), temporaryRoot.toLowerCase());
      assert.ok(path.basename(resolved).startsWith(prefix));
      await fs.rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    }
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  const { app, BrowserWindow } = require('electron');
  const fixture = process.env.PUGPORT_PINNED_RAIL_SMOKE;
  assert.ok(fixture && path.basename(fixture).startsWith(prefix));
  app.setPath('userData', path.join(fixture, 'profile'));
  app.disableHardwareAcceleration();
  let win;
  const errors = [];
  const evaluate = (source) =>
    win.webContents.executeJavaScript(source).catch((error) => {
      throw new Error(`${error.message}\n${source.slice(0, 300)}`);
    });
  const frame = () => evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const settle = async () => {
    await frame();
    await frame();
  };
  const update = async (source) => {
    await evaluate(`(()=>{${source};window.renderFixture();})()`);
    await settle();
  };
  const click = async (selector) => {
    await evaluate(
      `(()=>{const element=document.querySelector(${JSON.stringify(selector)});if(!element)throw Error('Missing '+${JSON.stringify(selector)});element.click()})()`,
    );
    await settle();
  };
  const clickText = async (scope, text) => {
    await evaluate(`(()=>{const button=[...document.querySelectorAll(${JSON.stringify(scope)})].find(item=>item.textContent.trim()===${JSON.stringify(text)}||item.getAttribute('aria-label')===${JSON.stringify(text)});
      if(!button)throw Error('Missing '+${JSON.stringify(text)});button.click()})()`);
    await settle();
  };
  const count = (selector) => evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
  const text = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
  const historyTop = () => evaluate("document.querySelector('.conversation-scroll').scrollTop");
  const theme = (value) => evaluate(`document.documentElement.dataset.theme=${JSON.stringify(value)}`);
  const shot = async (name) => {
    for (const value of ['light', 'dark']) {
      await theme(value);
      // Let colour transitions finish so the picture shows the settled theme.
      await new Promise((resolve) => setTimeout(resolve, 350));
      await settle();
      await fs.writeFile(path.join(shots, `${name}-${value}.png`), (await win.webContents.capturePage()).toPNG());
    }
    await theme('light');
    await settle();
  };
  const resize = async (width) => {
    win.setContentSize(width, 860);
    await settle();
    await settle();
  };
  void app.whenReady().then(async () => {
    try {
      await fs.mkdir(shots, { recursive: true });
      win = new BrowserWindow({
        show: false,
        width: 1600,
        height: 860,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          offscreen: true,
          backgroundThrottling: false,
        },
      });
      win.webContents.session.webRequest.onBeforeRequest((details, callback) =>
        callback({ cancel: !details.url.startsWith('file://') && !details.url.startsWith('data:') }),
      );
      win.webContents.on('console-message', (event) => {
        if (['error', 'warning'].includes(event.level) && !event.message.includes('Electron Security Warning'))
          errors.push(event.message);
      });
      await win.loadFile(path.join(fixture, 'index.html'));
      await resize(1600);
      await evaluate("localStorage.removeItem('pugport.pinnedWindow')");

      // Wide window, three pins: full cards in the gutter, no top bar.
      assert.equal(await count('.pinned-rail'), 1, 'rail shows with pins and a wide gutter');
      assert.equal(await count('.pinned-messages'), 0, 'the top bar gives way to the rail');
      assert.equal(await count('.pinned-rail.compact'), 0);
      assert.equal(await count('.pinned-card'), 3);
      const scroller = await evaluate(
        "(()=>{const s=document.querySelector('.conversation-scroll');return {scroll:s.scrollHeight,client:s.clientHeight}})()",
      );
      assert.ok(scroller.scroll > scroller.client + 200, 'the synthetic history really scrolls');
      const titles = await evaluate("[...document.querySelectorAll('.pinned-card-title')].map(item=>item.textContent)");
      assert.deepEqual(titles, ['数据库迁移失败的原因是缺少索引', '季度报价对比', '东京三日行程'], 'newest pin first');
      assert.match(
        await text('.pinned-card:nth-child(1) .pinned-card-description'),
        /正在总结/,
        'extract while pending',
      );
      assert.match(await text('.pinned-card:nth-child(3) .pinned-card-description'), /三天路线/);
      assert.doesNotMatch(await text('.pinned-rail'), /#|```|第一天去浅草/, 'cards show summaries, not raw text');
      assert.match(
        await text('.pinned-card:nth-child(2) .pinned-card-meta'),
        /我的消息.*处理中/,
        'task status on card',
      );
      assert.match(await text('.pinned-card:nth-child(3) .pinned-card-meta'), /回答/);
      const geometry = await evaluate(`(()=>{const rail=document.querySelector('.pinned-rail').getBoundingClientRect();
        const list=document.querySelector('.message-list');const box=list.getBoundingClientRect();
        return {railRight:rail.right,text:box.left+parseFloat(getComputedStyle(list).paddingLeft),width:rail.width}})()`);
      assert.ok(geometry.railRight < geometry.text, 'the rail stays in the gutter');
      assert.ok(geometry.width <= 200);
      await shot('rail-3');

      // Opening a card neither jumps nor scrolls the history and makes no request.
      await evaluate(
        "{const s=document.querySelector('.conversation-scroll');s.scrollTop=Math.floor(s.scrollHeight/3);s.dispatchEvent(new Event('scroll'));}",
      );
      await settle();
      const top = await historyTop();
      const calls = await evaluate('window.fixture.calls.length');
      await click('.pinned-card:nth-child(3) .pinned-card-open');
      assert.equal(await count('.pinned-window'), 1);
      assert.equal(await historyTop(), top, 'the history keeps its place');
      assert.equal(await evaluate('window.fixture.calls.length'), calls, 'opening is local');
      assert.equal(await count('.pinned-jump-highlight'), 0, 'no jump');
      assert.equal(await text('.pinned-window-header strong'), '东京三日行程');
      assert.equal(await count('.pinned-card.selected'), 1);
      assert.match(await text('.pinned-window-body'), /交通.*成田特快/s, 'the full message renders');
      assert.ok(await evaluate("document.querySelector('.pinned-window-body h1, .pinned-window-body h2')!==null"));
      const body = await evaluate(
        "(()=>{const b=document.querySelector('.pinned-window-body');return {scroll:b.scrollHeight,client:b.clientHeight}})()",
      );
      assert.ok(body.scroll > body.client, 'a long reply scrolls inside the window');
      const win1 = await evaluate("document.querySelector('.pinned-window').getBoundingClientRect().toJSON()");
      assert.ok(win1.left >= geometry.railRight, 'anchored right of the rail');
      assert.ok(Math.abs(win1.width - 560) <= 1);
      // The conversation stays usable: it still scrolls with the window open.
      await evaluate("{const s=document.querySelector('.conversation-scroll');s.scrollTop=s.scrollTop+120;}");
      await settle();
      assert.equal(await historyTop(), top + 120, 'not modal: history scrolls behind it');
      await shot('window');

      // One window: another card swaps its content.
      await click('.pinned-card:nth-child(2) .pinned-card-open');
      assert.equal(await count('.pinned-window'), 1);
      assert.equal(await text('.pinned-window-header strong'), '季度报价对比');

      // Minimize: hidden, card briefly marked, then normal. Close: hidden, pin stays.
      await clickText('.pinned-window-header button', '缩小');
      assert.equal(await count('.pinned-window'), 0);
      assert.equal(await count('.pinned-card.recent'), 1, 'minimized card stays marked briefly');
      await new Promise((resolve) => setTimeout(resolve, 1400));
      await settle();
      assert.equal(await count('.pinned-card.recent'), 0);
      await click('.pinned-card:nth-child(2) .pinned-card-open');
      await clickText('.pinned-window-header button', '关闭');
      assert.equal(await count('.pinned-window'), 0);
      assert.equal(await count('.pinned-card'), 3, 'closing keeps the pin');
      assert.equal(await count('.pinned-card.recent'), 0);

      // Esc minimizes; dragging moves the window and is remembered.
      await click('.pinned-card:nth-child(3) .pinned-card-open');
      await evaluate(
        "document.querySelector('.pinned-window').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))",
      );
      await settle();
      assert.equal(await count('.pinned-window'), 0, 'Esc minimizes');
      await click('.pinned-card:nth-child(3) .pinned-card-open');
      const before = await evaluate("document.querySelector('.pinned-window').getBoundingClientRect().toJSON()");
      await evaluate(`(()=>{const header=document.querySelector('.pinned-window-header');
        const at=(type,x,y)=>header.dispatchEvent(new PointerEvent(type,{bubbles:true,button:0,pointerId:7,clientX:x,clientY:y}));
        at('pointerdown',${before.left + 120},${before.top + 18});at('pointermove',${before.left + 180},${before.top + 58});
        at('pointerup',${before.left + 180},${before.top + 58});})()`);
      await settle();
      const after = await evaluate("document.querySelector('.pinned-window').getBoundingClientRect().toJSON()");
      assert.ok(Math.abs(after.left - before.left - 60) <= 2, 'drag moves ' + JSON.stringify([before, after]));
      const wrapBox = await evaluate(
        "document.querySelector('.conversation-scroll-wrap').getBoundingClientRect().toJSON()",
      );
      assert.ok(
        after.top > before.top && after.bottom <= wrapBox.bottom + 1,
        'drag stays inside the conversation area',
      );
      assert.equal(await historyTop(), top + 120, 'dragging does not scroll the history');
      const saved = JSON.parse(await evaluate("localStorage.getItem('pugport.pinnedWindow')"));
      const wrapLeft = await evaluate(
        "document.querySelector('.conversation-scroll-wrap').getBoundingClientRect().left",
      );
      assert.ok(saved && Math.abs(saved.x + wrapLeft - after.left) <= 2, 'position remembered');
      await evaluate("localStorage.removeItem('pugport.pinnedWindow')");
      await clickText('.pinned-window-header button', '关闭');

      // Locate keeps the old jump behaviour on request only.
      await click('.pinned-card:nth-child(3) .pinned-card-open');
      await clickText('.pinned-window-footer button', '在对话中定位');
      assert.equal(await count('.pinned-window'), 0);
      assert.equal(await evaluate('document.activeElement.dataset.messageId'), 'm11', 'locate jumps to the message');
      await new Promise((resolve) => setTimeout(resolve, 1700));

      // Eight pins: compact scrollable rows with a header.
      await update('window.fixture.setPins(window.fixture.eightPins)');
      assert.equal(await count('.pinned-rail.compact'), 1, 'compact above five pins');
      assert.equal(await count('.pinned-card'), 8);
      assert.match(await text('.pinned-rail-header'), /置顶 8/);
      assert.equal(await count('.pinned-card-description'), 0, 'one line per row');
      await shot('rail-8');
      await click('.pinned-card:nth-child(8) .pinned-card-open');
      const visible =
        await evaluate(`(()=>{const list=document.querySelector('.pinned-rail-list').getBoundingClientRect();
        const row=document.querySelector('.pinned-card:nth-child(8)').getBoundingClientRect();return row.top>=list.top-1&&row.bottom<=list.bottom+1})()`);
      assert.ok(visible, 'the open row stays in view');
      await clickText('.pinned-window-header button', '关闭');

      // Unpin from the window: one PATCH, window closes, card goes.
      await click('.pinned-card:nth-child(1) .pinned-card-open');
      await clickText('.pinned-window-footer button', '取消置顶');
      assert.equal(await count('.pinned-window'), 0);
      assert.equal(await count('.pinned-card'), 7);
      assert.equal(await count('.pinned-rail.compact'), 1);

      // Narrow window: today's top bar, opening the same window without a jump.
      await update('window.fixture.setPins(window.fixture.threePins)');
      await resize(1200);
      assert.equal(await count('.pinned-rail'), 0, 'no rail without a wide gutter');
      assert.equal(await count('.pinned-messages'), 1, 'top bar on narrow windows');
      assert.match(
        await text('.pinned-messages-summary .pinned-message-preview'),
        /东京三日行程/,
        'bar shows the summary',
      );
      const narrowTop = await historyTop();
      await click('.pinned-messages-summary .pinned-message-preview');
      assert.equal(await count('.pinned-window'), 1);
      assert.equal(await historyTop(), narrowTop);
      const narrowBox = await evaluate("document.querySelector('.pinned-window').getBoundingClientRect().toJSON()");
      assert.ok(narrowBox.right <= 1200 + 1, 'the window fits a narrow window');
      await shot('narrow-window');
      await clickText('.pinned-window-header button', '关闭');
      await shot('narrow');

      // No pins: nothing at all.
      await resize(1600);
      await update('window.fixture.setPins([])');
      assert.equal(await count('.pinned-rail'), 0, 'no rail without pins');
      assert.equal(await count('.pinned-messages'), 0);

      assert.deepEqual(
        await evaluate("window.fixture.calls.filter(c=>c.method&&c.method!=='GET').map(c=>[c.method,c.url,c.body])"),
        [['PATCH', '/api/conversations/main/messages/m49/pin', { pinned: false }]],
        'opening, minimizing, closing, dragging and locating write nothing; only the explicit unpin does',
      );
      assert.deepEqual(await evaluate('window.fixture.notices'), []);
      assert.deepEqual(errors, []);
      console.log(
        'PASS pinned rail renderer: gutter rail, newest first, summaries with pending extract, window without history movement, swap, minimize, close, Esc, drag, locate, compact rows, unpin and narrow bar',
      );
      app.exit(0);
    } catch (error) {
      console.error(error);
      if (win)
        await fs
          .writeFile(path.join(shots, 'failure.png'), (await win.webContents.capturePage()).toPNG())
          .catch(() => {});
      app.exit(1);
    }
  });
}
