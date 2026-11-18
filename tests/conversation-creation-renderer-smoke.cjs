// Actual Studio, hidden Electron, synthetic fetch/SSE only. No user DB, backend or model is started.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { electronArgs } = require('./helpers/electron-app.cjs');
const root = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  void (async () => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'pugport-create-chat-smoke-'));
    try {
      await fs.mkdir(path.join(fixture, 'profile'));
      await fs.writeFile(
        path.join(fixture, 'index.html'),
        '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>',
      );
      await fs.writeFile(
        path.join(fixture, 'style.css'),
        await fs.readFile(path.join(root, 'src/ui/studio.css'), 'utf8'),
      );
      await require('esbuild').build({
        stdin: {
          contents: `import React from 'react';
import {createRoot} from 'react-dom/client';
import Studio from './src/ui/Studio';
const stamp='2026-10-09T20:00:00.000Z';
const project={id:'project',name:'Fixture project',path:'C:/Fixture',createdAt:stamp,updatedAt:stamp};
const existing={id:'existing',projectId:'project',title:'Existing fixture',createdAt:stamp,updatedAt:stamp};
localStorage.setItem('agent-studio-conversation','existing');
localStorage.setItem('agent-studio-project','project');
localStorage.setItem('pugport-locale','zh-CN');
window.fixture={calls:[],posts:[],refreshes:[],created:[],holdPosts:true,stateReads:0,state:{
 app:{name:'PugPort',version:'fixture',platform:'win32',dataDir:'fixture'},
 settings:{toolApprovalMode:'auto',refreshSeconds:60,reservePercent:10,maxQuotaAgeSeconds:120,preferCli:true,designProvider:'claude',architectureProvider:'codex',routineProvider:'codex',unknownQuotaPolicy:'manual-only',defaultProjectPath:'C:/Fixture',maxConcurrentRuns:1},
 targets:[],runtimes:[],runs:[],approvals:[],plugins:[],refreshing:false,projects:[project],conversations:[existing],workflows:[],conversationMessages:[],backgroundTasks:[],tasteTests:[],conversationFolders:[]
}};
const f=window.fixture;
const response=value=>new Response(JSON.stringify(value),{status:200,headers:{'Content-Type':'application/json'}});
const clone=value=>JSON.parse(JSON.stringify(value));
window.fetch=async(url,init={})=>{
 const body=init.body?JSON.parse(init.body):undefined,method=init.method||'GET';
 f.calls.push({path:url,method,body});
 if(url==='/api/modes'){
  if(method!=='GET')throw Error('Mode catalog must use GET');
  return response({catalog:[],installed:[]});
 }
 if(url==='/api/session')return response({token:'fixture-local-only'});
 if(url==='/api/state') {
  if(f.stateReads++===0)return response(clone(f.state));
  return new Promise((resolve,reject)=>f.refreshes.push({resolve:value=>resolve(response(value)),reject}));
 }
 if(url==='/api/conversations'&&method==='POST') {
  const id='created-'+(f.posts.length+1),created={id,projectId:body.projectId||'general-'+id,title:'Created '+id,createdAt:stamp,updatedAt:stamp};
  const post={created,resolve:undefined}; f.posts.push(post);
  const result=f.holdPosts?await new Promise(resolve=>post.resolve=resolve):created;
  f.created.push(result);return response(result);
 }
 const id=String(url).split('/')[3];
 if(String(url).endsWith('/swarm'))return response({workflows:[],messages:[]});
 if(String(url).startsWith('/api/conversations/')&&method==='PATCH'){
  const created=f.created.find(item=>item.id===id);Object.assign(created,body);return response(clone(created));
 }
 if(String(url).startsWith('/api/conversations/')&&method==='GET')return response({conversation:f.created.find(item=>item.id===id)||existing,messages:[],workflows:[],runs:[]});
 throw new Error('Unexpected synthetic API request: '+method+' '+url);
};
window.EventSource=class {
 constructor(){this.listeners={};f.events=this;}
 addEventListener(name,listener){this.listeners[name]=listener;}
 close(){}
};
f.emitState=value=>f.events.listeners.state({data:JSON.stringify(value)});
f.catchUp=()=>{
 const state=clone(f.state);state.conversations.push(...clone(f.created));
 for(const item of f.created)if(!state.projects.some(p=>p.id===item.projectId))state.projects.push({...project,id:item.projectId,name:'Daily fixture',scope:'chat'});
 f.emitState(state);return state;
};
f.releasePost=index=>f.posts[index].resolve(f.posts[index].created);
createRoot(document.getElementById('root')).render(<Studio/>);`,
          resolveDir: root,
          loader: 'tsx',
        },
        bundle: true,
        platform: 'browser',
        loader: { '.png': 'dataurl', '.webp': 'dataurl', '.svg': 'dataurl', '.css': 'empty' },
        outfile: path.join(fixture, 'fixture.js'),
      });
      const env = { ...process.env, PUGPORT_CREATE_CHAT_SMOKE: fixture };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = require('node:child_process').spawn(require('electron'), electronArgs(__filename), {
        cwd: root,
        env,
        windowsHide: true,
        stdio: 'inherit',
      });
      const timeout = setTimeout(() => child.kill(), 30000);
      process.exitCode = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => resolve(code ?? 1));
      }).finally(() => clearTimeout(timeout));
    } finally {
      const temporaryRoot = await fs.realpath(os.tmpdir());
      const resolved = await fs.realpath(fixture);
      assert.equal(path.dirname(resolved).toLowerCase(), temporaryRoot.toLowerCase());
      assert.ok(path.basename(resolved).startsWith('pugport-create-chat-smoke-'));
      await fs.rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    }
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  const { app, BrowserWindow } = require('electron');
  const fixture = process.env.PUGPORT_CREATE_CHAT_SMOKE;
  assert.ok(fixture && path.basename(fixture).startsWith('pugport-create-chat-smoke-'));
  app.setPath('userData', path.join(fixture, 'profile'));
  app.disableHardwareAcceleration();
  let win;
  const evaluate = (source) => win.webContents.executeJavaScript(source);
  const frame = () => evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const title = () => evaluate("document.querySelector('.conversation-title-line strong')?.textContent");
  const postCount = () => evaluate('window.fixture.posts.length');
  const selected = () =>
    evaluate(
      "[...document.querySelectorAll('.conversation-link.selected span')].map(item=>item.textContent).filter(Boolean)",
    );
  const click = async (selector) => {
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await frame();
  };
  const selectExisting = async () => {
    await evaluate(
      "[...document.querySelectorAll('.conversation-link')].find(button=>button.textContent.includes('Existing fixture')).click()",
    );
    await frame();
  };
  void app.whenReady().then(async () => {
    try {
      win = new BrowserWindow({
        show: false,
        width: 1280,
        height: 850,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          offscreen: true,
          backgroundThrottling: false,
        },
      });
      win.webContents.session.webRequest.onBeforeRequest((details, callback) =>
        callback({ cancel: !details.url.startsWith('file://') }),
      );
      await win.loadFile(path.join(fixture, 'index.html'));
      for (let attempt = 0; attempt < 12 && (await title()) !== 'Existing fixture'; attempt++) await frame();
      assert.equal(await title(), 'Existing fixture');

      // Two actual clicks before any render must send only one POST.
      await evaluate("(()=>{const button=document.querySelector('.project-new');button.click();button.click();})()");
      await frame();
      assert.equal(await postCount(), 1);
      await evaluate('window.fixture.releasePost(0)');
      await frame();
      assert.equal(await title(), 'Created created-1', 'POST confirmation opens the title before reload resolves');
      assert.deepEqual(await selected(), ['Created created-1']);
      assert.equal(
        await evaluate(
          "document.querySelector('.conversation-link.selected').closest('.sidebar-project').querySelector('.project-name').textContent.trim()",
        ),
        'Fixture project',
      );
      assert.equal(await evaluate("Boolean(document.querySelector('#conversation-input'))"), true);
      assert.equal(await evaluate('window.fixture.refreshes.length'), 1);
      assert.equal(await evaluate("document.querySelector('.project-new').disabled"), false);

      // A late full snapshot that lacks the new ID cannot wipe the confirmed local entry.
      await evaluate('window.fixture.emitState(JSON.parse(JSON.stringify(window.fixture.state)))');
      await frame();
      assert.equal(await title(), 'Created created-1');
      assert.deepEqual(await selected(), ['Created created-1']);
      await evaluate("window.fixture.refreshes[0].reject(new Error('Fixture refresh unavailable'))");
      await frame();
      assert.equal(await title(), 'Created created-1');
      assert.equal(await postCount(), 1);
      assert.match(await evaluate('document.body.textContent'), /对话已创建，工作台刷新失败/);

      // Sequential clicks also reuse the already-confirmed blank project chat.
      await click('.project-new');
      await click('.project-new');
      assert.equal(await postCount(), 1);

      // A real composer draft makes this chat distinct; late navigation still wins over a new POST.
      await evaluate(
        `(()=>{const input=document.querySelector('#conversation-input');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'Keep this draft in the first chat');input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
      );
      await frame();
      await click('.project-new');
      assert.equal(await postCount(), 2);
      await selectExisting();
      await evaluate('window.fixture.releasePost(1)');
      await frame();
      assert.equal(await title(), 'Existing fixture');
      assert.deepEqual(await selected(), ['Existing fixture']);
      await evaluate('window.fixture.catchUp()');
      await frame();
      assert.equal(await title(), 'Existing fixture');
      assert.equal(
        await evaluate(
          "[...document.querySelectorAll('.conversation-link')].filter(button=>button.textContent.includes('Created created-1')).length",
        ),
        1,
        'server catch-up removes the temporary duplicate',
      );

      // Swarm flag changes can have equal timestamps. A successful explicit exit must update the local cache.
      await evaluate('window.fixture.holdPosts=false');
      await click('.project-new');
      await evaluate(
        "document.querySelector('.conversation-link.selected').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:120,clientY:160}))",
      );
      await frame();
      await evaluate(
        "[...document.querySelectorAll('[role=menuitem]')].find(button=>button.textContent.includes('开启蜂群模式')).click()",
      );
      await frame();
      assert.equal(await title(), 'Created created-3');
      assert.equal(await evaluate("Boolean(document.querySelector('[aria-label=蜂群成员]'))"), true);
      await click('[aria-label="切回普通对话"]');
      assert.equal(await evaluate("Boolean(document.querySelector('[aria-label=蜂群成员]'))"), false);
      assert.equal(await title(), 'Created created-3');
      await evaluate('window.fixture.catchUp()');
      await frame();
      assert.equal(await evaluate("Boolean(document.querySelector('[aria-label=蜂群成员]'))"), false);
      assert.equal(await postCount(), 3);
      console.log(
        'PASS Studio creation renderer: project POST opens title/sidebar/composer before pending reload; duplicate click, stale state, refresh failure, navigation, catch-up and same-timestamp swarm exit',
      );
      app.exit(0);
    } catch (error) {
      console.error(error);
      app.exit(1);
    }
  });
}
